import { wrapMeshData } from './loadCityGML.js';

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
   * @param {Map}          deps.cellGeomByBuilding — "buildingId:meshType" → Set<cellKey>
   * @param {Map}          deps.buildingPaintMeshes — "buildingId:meshType|color" → mesh
   * @param {Map}          deps.buildingPaintMeshByBuilding — "buildingId:meshType" → Set<mesh>
   * @param {THREE.Group}  deps.paintGroup
   * @param {function}     deps.onTileLoaded(meshes)     — fires when wrapped meshes are in the scene (phase 1)
   * @param {function}     deps.onTileCellData(meshes)   — fires when seed/cell data has been attached (phase 2)
   * @param {function}     deps.onTileUnloaded()         — fires after tile meshes are removed
   * @param {object}       deps.seedConfig               — { fraction, colors: number[] } forwarded to worker
   */
  constructor(deps) {
    this._scene               = deps.scene;
    this._buildingMeshes      = deps.buildingMeshes;
    this._collidables         = deps.collidables;
    this._buildingMeshMap     = deps.buildingMeshMap;
    this._cellGeomCache       = deps.cellGeomCache;
    this._cellGeomByBuilding  = deps.cellGeomByBuilding;
    this._buildingPaintMeshes          = deps.buildingPaintMeshes;
    this._buildingPaintMeshByBuilding  = deps.buildingPaintMeshByBuilding;
    this._paintGroup                   = deps.paintGroup;
    this._onTileLoaded        = deps.onTileLoaded;
    this._onTileCellData      = deps.onTileCellData;
    this._onTileUnloaded      = deps.onTileUnloaded;
    this._seedConfig          = deps.seedConfig;

    // Map<tileId, TileState>
    this._tiles = new Map();

    // Spatial index: Map<"gx,gz", tile[]> — only tiles with finite bounds.
    // Tiles with infinite bounds (fallback synthetic tile) go in _alwaysCheck.
    this._spatialIndex = new Map();
    this._alwaysCheck  = [];

    // Concurrent load tracking.
    this._activeLoads = 0;
    this._loadQueue   = []; // tiles waiting to load
    this._lastPx = 0;  // most recent player XZ, used to prioritise the queue by distance
    this._lastPz = 0;

    // Off-thread tile loader. Two phases: 'loaded' carries the mesh typed
    // arrays (fast path so the spawn gate can open), 'cellData' carries the
    // seed scan result (applied later; game is already interactive by then).
    this._worker = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
    this._pendingLoads = new Map(); // tileId → { resolve, reject }
    this._worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'loaded') {
        const pending = this._pendingLoads.get(msg.tileId);
        if (!pending) return;
        this._pendingLoads.delete(msg.tileId);
        pending.resolve(msg.meshes);
      } else if (msg.type === 'cellData') {
        this._handleCellData(msg.tileId, msg.cellData);
      } else if (msg.type === 'error') {
        const pending = this._pendingLoads.get(msg.tileId);
        if (!pending) return;
        this._pendingLoads.delete(msg.tileId);
        pending.reject(new Error(msg.error));
      }
    };
    this._worker.onerror = (e) => {
      console.error('TileManager worker error:', e.message);
    };
  }

  /**
   * Phase 2 message handler. If the main thread is still chunk-wrapping phase
   * 1 (tile.status === 'loading'), stash the payload on the tile so _doLoad
   * applies it the moment tile.meshes is populated. Otherwise apply now.
   */
  _handleCellData(tileId, cellData) {
    const tile = this._tiles.get(tileId);
    if (!tile) return;
    if (tile.status === 'unloaded') return; // abandoned mid-scan
    if (tile.status === 'loading') {
      tile._pendingCellData = cellData;
      return;
    }
    this._applyCellDataToTile(tile, cellData);
  }

  _applyCellDataToTile(tile, cellData) {
    // Match CellBundle → mesh by buildingId:meshType. Ordering between the
    // worker's and main's mesh arrays isn't guaranteed to be identical.
    const meshByKey = new Map();
    for (const m of tile.meshes) {
      meshByKey.set(`${m.userData.buildingId}:${m.userData.meshType}`, m);
    }
    for (const cd of cellData) {
      const mesh = meshByKey.get(`${cd.buildingId}:${cd.meshType}`);
      if (!mesh) continue;
      mesh.userData.cellData = {
        cellKeys:  cd.cellKeys,
        cellGeoms: cd.cellGeoms,
        seeds:     cd.seeds,
      };
    }
    if (this._onTileCellData) this._onTileCellData(tile.meshes);
  }

  _fetchTileViaWorker(tileId, file) {
    return new Promise((resolve, reject) => {
      this._pendingLoads.set(tileId, { resolve, reject });
      this._worker.postMessage({ type: 'load', tileId, file, seedConfig: this._seedConfig });
    });
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

    // The render loop's first tick (~16ms after init resolves) picks up the
    // real camera position and enqueues the correct tiles. We deliberately
    // don't tick here — an earlier incarnation called tick(0,0), which started
    // loading tiles around the origin even though the player spawns thousands
    // of metres away.
  }

  /**
   * True when every finite-bounds tile within TILE_LOAD_RADIUS of (px, pz)
   * has status === 'loaded'. Used to gate the teleport "loading" overlay so
   * we clear it when nearby buildings are actually on screen — covers the
   * edge case where the new location has fewer than TILES_NEEDED tiles in
   * range and a fixed counter would hang.
   */
  allNearbyTilesLoaded(px, pz) {
    const loadR2 = TILE_LOAD_RADIUS ** 2;
    for (const tile of this._tiles.values()) {
      const b = tile.bounds;
      if (!isFinite(b.minX)) continue;
      if (_closestDist2(px, pz, b) >= loadR2) continue;
      if (tile.status !== 'loaded') return false;
    }
    return true;
  }

  /**
   * Pick a random XZ position inside a random manifest tile with finite bounds.
   * Returns null if only the infinite fallback tile is available.
   */
  randomLocation() {
    const finite = [];
    for (const tile of this._tiles.values()) {
      const b = tile.bounds;
      if (isFinite(b.minX) && isFinite(b.maxX) && isFinite(b.minZ) && isFinite(b.maxZ)) {
        finite.push(b);
      }
    }
    if (finite.length === 0) return null;
    const b = finite[Math.floor(Math.random() * finite.length)];
    return {
      x: b.minX + Math.random() * (b.maxX - b.minX),
      z: b.minZ + Math.random() * (b.maxZ - b.minZ),
    };
  }

  /**
   * Call once per frame from the render loop. Cheap: AABB distance checks on
   * a small spatial neighbourhood instead of the full manifest.
   * Starts async loads/unloads as needed.
   */
  tick(px, pz) {
    this._lastPx = px;
    this._lastPz = pz;

    const loadR2   = TILE_LOAD_RADIUS   ** 2;
    const unloadR2 = TILE_UNLOAD_RADIUS ** 2;

    // Drop queued tiles that drifted outside the unload radius while waiting.
    // Useful when the player sprint-flies past a region before the worker
    // catches up — keeps the queue focused on what's actually nearby.
    // Active (in-flight) tiles are left to complete; they'll be unloaded on
    // the next tick if still out of range. That wastes a worker slot briefly
    // but avoids the complexity of mid-load cancellation.
    if (this._loadQueue.length > 0) {
      for (let i = this._loadQueue.length - 1; i >= 0; i--) {
        const tile = this._loadQueue[i];
        if (_closestDist2(px, pz, tile.bounds) > unloadR2) {
          tile.status = 'unloaded';
          this._loadQueue.splice(i, 1);
        }
      }
    }

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
    // Start queued tiles nearest to the player first, so the building they're
    // currently flying toward lands before buildings behind them.
    while (this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length > 0) {
      let bestI  = 0;
      let bestD2 = _closestDist2(this._lastPx, this._lastPz, this._loadQueue[0].bounds);
      for (let i = 1; i < this._loadQueue.length; i++) {
        const d2 = _closestDist2(this._lastPx, this._lastPz, this._loadQueue[i].bounds);
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
      const next = this._loadQueue.splice(bestI, 1)[0];
      if (next.status === 'loading') this._doLoad(next);
    }
  }

  async _doLoad(tile) {
    this._activeLoads++;
    const tLoad = performance.now();
    try {
      // Worker returns an array of MeshData objects with Float32Array buffers
      // already transferred in. All heavy math (UV, normals, bbox, Y-shift)
      // has already happened off-thread — we only need to wrap typed arrays
      // into a THREE.Mesh and add it to the scene.
      const meshDataList = await this._fetchTileViaWorker(tile.id, tile.file);
      const tReceived = performance.now();
      performance.measure('tile:wait', { start: tLoad, end: tReceived });

      const CHUNK  = 20;
      const meshes = [];
      for (let start = 0; start < meshDataList.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, meshDataList.length);
        for (let i = start; i < end; i++) {
          const mesh = wrapMeshData(meshDataList[i]);
          mesh.visible = false; // updateCulling() reveals in-range meshes after load
          this._scene.add(mesh);
          this._buildingMeshes.push(mesh);
          this._collidables.push(mesh);
          this._buildingMeshMap.set(
            `${mesh.userData.buildingId}:${mesh.userData.meshType}`,
            mesh,
          );
          meshes.push(mesh);
        }
        if (end < meshDataList.length) await new Promise(r => requestIdleCallback(r, { timeout: 100 }));
      }
      performance.measure('tile:wrap', { start: tReceived, end: performance.now() });

      tile.meshes = meshes;
      tile.status = 'loaded';
      this._onTileLoaded(meshes);

      // Phase 2 (cellData) may have arrived while we were chunk-wrapping.
      // Apply it now so seedTileCells runs on this tile's meshes.
      if (tile._pendingCellData) {
        const cd = tile._pendingCellData;
        tile._pendingCellData = null;
        this._applyCellDataToTile(tile, cd);
      }
    } catch (e) {
      console.error(`TileManager: failed to load tile "${tile.id}":`, e);
      tile.status = 'unloaded'; // allow retry on next tick
    } finally {
      this._drainQueue();
    }
  }

  _unload(tile) {
    const tUnload = performance.now();

    // Collect the building keys this tile owns ("buildingId:meshType") — all
    // cleanup indexes are scoped to these keys so we never scan the full maps.
    const buildingKeys = [];
    for (const mesh of tile.meshes) {
      buildingKeys.push(`${mesh.userData.buildingId}:${mesh.userData.meshType}`);
    }

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

    for (const bk of buildingKeys) {
      this._buildingMeshMap.delete(bk);

      // Clear cellGeomCache entries via the per-building index — avoids
      // scanning the full cache (tens of thousands of entries at high seed).
      const geomSet = this._cellGeomByBuilding.get(bk);
      if (geomSet) {
        for (const k of geomSet) this._cellGeomCache.delete(k);
        this._cellGeomByBuilding.delete(bk);
      }

      // Dispose paint overlay meshes via the per-building mesh set. The
      // "buildingId:meshType|colorHex" key was stashed on each mesh at
      // creation time so we can delete from _buildingPaintMeshes in O(1).
      const meshSet = this._buildingPaintMeshByBuilding.get(bk);
      if (meshSet) {
        for (const paintMesh of meshSet) {
          paintMesh.geometry.dispose();
          paintMesh.material.dispose();
          this._paintGroup.remove(paintMesh);
          this._buildingPaintMeshes.delete(paintMesh.userData.paintMeshKey);
        }
        this._buildingPaintMeshByBuilding.delete(bk);
      }
    }

    tile.meshes = [];
    tile.status = 'unloaded';
    this._onTileUnloaded();
    performance.measure('tile:unload', { start: tUnload, end: performance.now() });
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
