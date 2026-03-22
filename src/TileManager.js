import * as THREE from 'three';
import { fetchTileData, buildMeshFromBuilding } from './loadCityGML.js';

// A tile is loaded when the player is within this distance of its AABB edge.
const TILE_LOAD_RADIUS   = 200; // metres
const TILE_UNLOAD_RADIUS = 250; // metres — larger than load radius to prevent flicker

// Spatial index: coarse grid cell size. tick() checks a 5×5 neighbourhood of
// coarse cells (~2500 m reach), so up to ~25 cells × a handful of tiles each
// instead of iterating the entire manifest (5k–10k tiles) every frame.
const COARSE_GRID = 500; // metres per coarse cell
const COARSE_REACH = 2;  // cells in each direction from the player's cell

// How many tile fetches may be in flight at once. More than 1 drains the load
// queue faster when entering a new area without meaningful memory spike risk.
const MAX_CONCURRENT_LOADS = 3;

/**
 * Manages dynamic loading and unloading of building tiles as the player moves.
 *
 * Tiles are loaded when the player's position comes within TILE_LOAD_RADIUS of
 * the tile's world-space AABB, and unloaded when beyond TILE_UNLOAD_RADIUS.
 * The hysteresis gap (150 m) prevents flicker at tile boundaries.
 *
 * Paint data in localStorage is never touched on unload — graffiti survives
 * tile reload because paintStore.cells is keyed by buildingId which persists.
 */
export class TileManager {
  /**
   * @param {object} deps
   * @param {THREE.Scene}  deps.scene
   * @param {THREE.Mesh[]} deps.buildingMeshes   — master list (mutated in place)
   * @param {THREE.Mesh[]} deps.collidables       — master list (mutated in place)
   * @param {Map}          deps.buildingMeshMap   — "buildingId:meshType" → mesh
   * @param {Map}          deps.cellGeomCache     — cellKey → Float32Array
   * @param {Map}          deps.buildingPaintMeshes — "buildingId:meshType|color" → mesh
   * @param {Map}          deps.buildingPaintMeshByBuilding — "buildingId:meshType" → Set<mesh>
   * @param {THREE.Group}  deps.paintGroup
   * @param {function}     deps.onTileLoaded(meshes)  — called after tile meshes are added
   * @param {function}     deps.onTileUnloaded()      — called after tile meshes are removed
   */
  constructor(deps) {
    this._scene               = deps.scene;
    this._buildingMeshes      = deps.buildingMeshes;
    this._collidables         = deps.collidables;
    this._buildingMeshMap     = deps.buildingMeshMap;
    this._cellGeomCache       = deps.cellGeomCache;
    this._buildingPaintMeshes          = deps.buildingPaintMeshes;
    this._buildingPaintMeshByBuilding  = deps.buildingPaintMeshByBuilding;
    this._paintGroup                   = deps.paintGroup;
    this._onTileLoaded        = deps.onTileLoaded;
    this._onTileUnloaded      = deps.onTileUnloaded;

    // Map<tileId, TileState>
    this._tiles = new Map();

    // Spatial index: Map<"gx,gz", tile[]> — only tiles with finite bounds.
    // Tiles with infinite bounds (fallback synthetic tile) go in _alwaysCheck.
    this._spatialIndex = new Map();
    this._alwaysCheck  = [];

    // Concurrent load tracking.
    this._activeLoads = 0;
    this._loadQueue   = []; // tiles waiting to load
  }

  /**
   * Load the tile manifest and kick off the initial tick.
   * Falls back to a single synthetic tile (/buildings.json) if the manifest
   * is missing — keeps the game working before build_tiles.py has been run.
   */
  async init(manifestUrl = '/tiles/manifest.json') {
    let entries;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = await res.json();
    } catch (e) {
      console.warn(`TileManager: manifest not found (${e.message}), falling back to /buildings.json`);
      entries = [{
        id:    'fallback',
        file:  '/buildings.json',
        bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity },
        buildingCount: 0,
      }];
    }

    for (const entry of entries) {
      const tile = {
        id:     entry.id,
        file:   entry.file,
        bounds: entry.bounds,
        status: 'unloaded', // 'unloaded' | 'loading' | 'loaded'
        meshes: [],
      };
      this._tiles.set(entry.id, tile);
      this._indexTile(tile);
    }

    // Trigger an immediate load check at the origin (player spawn).
    this.tick(0, 0);
  }

  /**
   * Call once per frame from the render loop. Cheap: AABB distance checks on
   * a small spatial neighbourhood instead of the full manifest.
   * Starts async loads/unloads as needed.
   */
  tick(px, pz) {
    const loadR2   = TILE_LOAD_RADIUS   ** 2;
    const unloadR2 = TILE_UNLOAD_RADIUS ** 2;

    const pgx = Math.floor(px / COARSE_GRID);
    const pgz = Math.floor(pz / COARSE_GRID);

    // Collect candidate tiles from the coarse neighbourhood, deduped.
    const visited = new Set();

    for (let dx = -COARSE_REACH; dx <= COARSE_REACH; dx++) {
      for (let dz = -COARSE_REACH; dz <= COARSE_REACH; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (visited.has(tile)) continue;
          visited.add(tile);
          this._checkTile(tile, loadR2, unloadR2, px, pz);
        }
      }
    }

    // Always check tiles with infinite/special bounds (fallback tile).
    for (const tile of this._alwaysCheck) {
      this._checkTile(tile, loadR2, unloadR2, px, pz);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** Insert a tile into the spatial index (or _alwaysCheck for infinite bounds). */
  _indexTile(tile) {
    const { minX, maxX, minZ, maxZ } = tile.bounds;
    if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minZ) || !isFinite(maxZ)) {
      this._alwaysCheck.push(tile);
      return;
    }
    const gx0 = Math.floor(minX / COARSE_GRID);
    const gx1 = Math.floor(maxX / COARSE_GRID);
    const gz0 = Math.floor(minZ / COARSE_GRID);
    const gz1 = Math.floor(maxZ / COARSE_GRID);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = `${gx},${gz}`;
        let bucket = this._spatialIndex.get(key);
        if (!bucket) { bucket = []; this._spatialIndex.set(key, bucket); }
        bucket.push(tile);
      }
    }
  }

  _checkTile(tile, loadR2, unloadR2, px, pz) {
    const d2 = _closestDist2(px, pz, tile.bounds);
    if (tile.status === 'unloaded' && d2 < loadR2) {
      this._enqueueLoad(tile);
    } else if (tile.status === 'loaded' && d2 > unloadR2) {
      this._unload(tile);
    }
    // 'loading' tiles are left alone until their promise resolves.
  }

  _enqueueLoad(tile) {
    tile.status = 'loading'; // mark immediately so tick() doesn't re-queue it
    if (this._activeLoads < MAX_CONCURRENT_LOADS) {
      this._doLoad(tile);
    } else {
      this._loadQueue.push(tile);
    }
  }

  _drainQueue() {
    this._activeLoads--;
    // Start as many queued tiles as the concurrency limit allows.
    while (this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length > 0) {
      const next = this._loadQueue.shift();
      // Skip tiles that were unloaded while waiting in the queue.
      if (next.status === 'loading') this._doLoad(next);
    }
  }

  async _doLoad(tile) {
    this._activeLoads++;
    try {
      const data = await fetchTileData(tile.file);

      // Build meshes in small chunks so geometry construction (UV, normals, etc.)
      // doesn't block the main thread for the full tile at once.
      const CHUNK  = 3; // buildings per frame
      const meshes = [];
      for (let start = 0; start < data.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, data.length);
        for (let i = start; i < end; i++) {
          for (const mesh of buildMeshFromBuilding(data[i])) meshes.push(mesh);
        }
        if (end < data.length) await new Promise(r => requestIdleCallback(r, { timeout: 100 }));
      }

      // Add all built meshes to the scene in one synchronous batch.
      // If the player moved away while building, _unload() fires on the next tick().
      for (const mesh of meshes) {
        mesh.geometry.computeBoundingBox();
        const center = new THREE.Vector3();
        mesh.geometry.boundingBox.getCenter(center);
        mesh.userData.center = center;

        mesh.visible = false; // updateCulling() will reveal in-range meshes after load
        this._scene.add(mesh);
        this._buildingMeshes.push(mesh);
        this._collidables.push(mesh);
        this._buildingMeshMap.set(
          `${mesh.userData.buildingId}:${mesh.userData.meshType}`,
          mesh,
        );
      }

      tile.meshes = meshes;
      tile.status = 'loaded';
      this._onTileLoaded(meshes);
    } catch (e) {
      console.error(`TileManager: failed to load tile "${tile.id}":`, e);
      tile.status = 'unloaded'; // allow retry on next tick
    } finally {
      this._drainQueue();
    }
  }

  _unload(tile) {
    // Collect the buildingId strings for this tile so we can clean up caches.
    const buildingIds = new Set(tile.meshes.map(m => m.userData.buildingId));

    // Remove meshes from scene and dispose GPU resources.
    for (const mesh of tile.meshes) {
      this._scene.remove(mesh);
      mesh.geometry.dispose();
      // Materials are shared (ROOF_MAT / WALL_MAT) — do not dispose them.
    }

    // Splice tile meshes out of the shared arrays (filter by identity).
    const tileSet = new Set(tile.meshes);
    const keep = m => !tileSet.has(m);
    this._buildingMeshes.splice(0, Infinity, ...this._buildingMeshes.filter(keep));
    this._collidables.splice(0, Infinity,    ...this._collidables.filter(keep));

    // Remove from buildingMeshMap and buildingPaintMeshByBuilding.
    for (const mesh of tile.meshes) {
      const bk = `${mesh.userData.buildingId}:${mesh.userData.meshType}`;
      this._buildingMeshMap.delete(bk);
      this._buildingPaintMeshByBuilding.delete(bk);
    }

    // Clear cellGeomCache for this tile's buildings.
    // Keys start with "buildingId:" so split on ':' and check first segment.
    for (const key of this._cellGeomCache.keys()) {
      if (buildingIds.has(key.split(':')[0])) this._cellGeomCache.delete(key);
    }

    // Remove paint overlay meshes for this tile's buildings.
    // Keys are "buildingId:meshType|colorHex"; split on ':' for first segment.
    for (const [key, paintMesh] of this._buildingPaintMeshes) {
      if (buildingIds.has(key.split(':')[0])) {
        paintMesh.geometry.dispose();
        paintMesh.material.dispose();
        this._paintGroup.remove(paintMesh);
        this._buildingPaintMeshes.delete(key);
      }
    }

    tile.meshes = [];
    tile.status = 'unloaded';
    this._onTileUnloaded();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Squared distance from point (px, pz) to the nearest point on AABB bounds.
 * Returns 0 when the point is inside the AABB.
 */
function _closestDist2(px, pz, bounds) {
  const cx = Math.max(bounds.minX, Math.min(px, bounds.maxX));
  const cz = Math.max(bounds.minZ, Math.min(pz, bounds.maxZ));
  return (px - cx) ** 2 + (pz - cz) ** 2;
}
