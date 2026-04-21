import * as THREE from 'three';
import { paintStore } from './paintStore.js';
import { LAND_COLOR } from './OsmManager.js';
import { worldToGrid } from './geo.js';
import { injectGridOverlay, enableGridExtensions, GRID_SHADER_CACHE_KEY } from './gridShader.js';

// The 5 paintable face types exposed per block: the top quad plus the four
// cardinal sides (only emitted by the worker when the block is taller than
// the neighbour on that side). Terrain paint cells key off these five names
// exactly the way building cells key off 'roof' / 'wall'.
export const TERRAIN_MESH_TYPES = ['top', 'sideN', 'sideS', 'sideE', 'sideW'];

// Terrain streams per-cell heightmaps from public/terrain/cell_{gx}_{gz}.bin.
// Unlike building / OSM tiles we don't download a manifest — cells live on a
// uniform 125 m grid with deterministic URLs, and we treat a 404 as "no
// terrain for this cell" and cache the miss. Saves ~10 MB of startup download
// plus the 55 K-entry spatial index build.
//
// Rendering is blocky: each DEM sample becomes a rectangular prism. Adjacent
// cells within a 20 % slope share averaged corner heights, so gentle slopes
// read as tilted quads instead of 23 cm steps; cliffs keep their vertical
// drop. All geometry is built in terrainWorker.js so the main thread only
// wraps the returned typed arrays into THREE geometry and handles material /
// OSM wiring. See terrainWorker.js for the slope-smoothing algorithm.

// Must match scripts/bake_terrain.py::GRID_SIZE and terrainWorker.js::CELL_SIZE.
const CELL_SIZE = 125;
// Per-block size in metres — a cell is subdivided into BLOCKS_PER_CELL² blocks,
// each a rectangular prism. Must match scripts/bake_terrain.py::SAMPLES.
const BLOCKS_PER_CELL = 64;
const BLOCK_SIZE      = CELL_SIZE / BLOCKS_PER_CELL; // ≈ 1.953 m

// Fixed load radius — terrain is cheap and its extent is not logically tied to
// building density, so we don't follow the adaptive building radius. Sized to
// match the building MAX so ~10% seeded paint cells on terrain top faces stay
// bounded (at 350m it reached ~10k extra paint quads).
// UNLOAD_MARGIN is hysteresis past the load edge.
const LOAD_RADIUS           = 250;
const TERRAIN_UNLOAD_MARGIN = 60;

// Terrain tiles are small (~4 KB) and the mesh build is trivial, so we keep
// more in flight than the building/OSM pipelines (which pay worker round-trips
// + multi-megabyte parses per load).
const MAX_CONCURRENT_LOADS = 6;

// Terrain's default base colour is LAND — any stretch of terrain with no
// draped water/green/street mesh on top reads as land. Keeps the old "OSM
// paints everywhere" behaviour working without a shader overlay.

// Flattened shading — before Lambert runs, each vertex's normal is biased
// toward world-up by (1 − SHADING_STRENGTH). With the current knob, the
// shading normal sits partway between the true face normal and (0,1,0), so
// NoL variation across faces shrinks. This compresses contrast without
// shifting overall brightness (the sun still lights the scene; adjacent
// faces just differ less). 1.0 = stock shading, 0 = no shading.
//
// (The OSM overlay used to be composited in this shader via a class-ID
// texture + marching-squares AA. That approach was swapped for draped
// vector-geometry overlays in OsmManager — see _buildDrapedPolygonMesh —
// so this shader only owns terrain lighting now.)
const SHADING_STRENGTH = 0.7;

// Grid overlay is shared with OsmManager so the grid draws on top of draped
// OSM meshes too — see src/gridShader.js.
//
// Ordering matters: injectGridOverlay captures objectNormal immediately after
// <beginnormal_vertex>, so the bias must already be inserted there *before*
// we call the helper. Calling in the other order would put the bias between
// the include and the grid capture, making the grid sample the flattened
// normal instead of the true geometric one.
const _onTerrainCompile = function (shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
       objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), objectNormal, ${SHADING_STRENGTH.toFixed(3)}));`);
  injectGridOverlay(shader);
};

function _createTerrainMaterial() {
  const mat = new THREE.MeshLambertMaterial({
    color: LAND_COLOR,
    side:  THREE.FrontSide,
  });
  mat.onBeforeCompile = _onTerrainCompile;
  mat.customProgramCacheKey = () => `graffiti-terrain-lambert-v6-${GRID_SHADER_CACHE_KEY}`;
  enableGridExtensions(mat);
  return mat;
}

// Cell state in `_cells`:
//   undefined  — never attempted
//   'loading'  — worker fetch/build in flight
//   'empty'    — 404, don't retry
//   object     — { mesh, res, bounds, nwY, neY, seY, swY }

export class TerrainManager {
  constructor({
    scene, group,
    // Paint plumbing — all optional so the terrain-off null-object in main.js
    // doesn't need to supply them. When present, terrain tiles participate in
    // the shared paint caches so painting on the ground / cliff sides works
    // exactly like painting on buildings.
    buildingMeshMap,
    buildingPaintMeshes,
    buildingPaintMeshByBuilding,
    paintGroup,
    onTerrainLoaded,
    onTerrainUnloaded,
  } = {}) {
    this._scene = scene;
    this._group = group ?? new THREE.Group();
    if (!group && scene) scene.add(this._group);

    this._buildingMeshMap              = buildingMeshMap             ?? null;
    this._buildingPaintMeshes          = buildingPaintMeshes         ?? null;
    this._buildingPaintMeshByBuilding  = buildingPaintMeshByBuilding ?? null;
    this._paintGroup                   = paintGroup                  ?? null;
    this._onTerrainLoaded              = onTerrainLoaded              ?? null;
    this._onTerrainUnloaded            = onTerrainUnloaded            ?? null;

    this._cells       = new Map();    // "gx,gz" → state
    this._loadQueue   = [];           // [{ gx, gz, key }, …]
    this._activeLoads = 0;
    this._lastPx      = 0;
    this._lastPz      = 0;
    // User-facing render-distance multiplier applied to LOAD_RADIUS in tick().
    this._radiusScale = 1;
    // key → [resolve,…] for callers blocking on a specific cell's load
    // (teleport pre-fetch in sampleAsync). Resolved in _doLoad's finally.
    this._waiters     = new Map();

    this._worker = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
    this._pendingLoads = new Map(); // key → { resolve, reject }
    this._worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'loaded') {
        const pending = this._pendingLoads.get(msg.key);
        if (!pending) return;
        this._pendingLoads.delete(msg.key);
        pending.resolve(msg);
      } else if (msg.type === 'error') {
        const pending = this._pendingLoads.get(msg.key);
        if (!pending) return;
        this._pendingLoads.delete(msg.key);
        pending.reject(new Error(msg.error));
      }
    };
    this._worker.onerror = (e) => {
      console.error('TerrainManager worker error:', e.message);
    };
  }

  setRadiusScale(s) { this._radiusScale = s; }

  tick(px, pz) {
    this._lastPx = px; this._lastPz = pz;

    const loadR    = LOAD_RADIUS * this._radiusScale;
    const unloadR  = loadR + TERRAIN_UNLOAD_MARGIN;
    const loadR2   = loadR   * loadR;
    const unloadR2 = unloadR * unloadR;

    // Cells are indexed in grid space (rotated from world by MANHATTAN_GRID_DEG)
    // so enumerate in grid space too. A circle of radius loadR in world space
    // is still a circle of radius loadR in grid space — rotation preserves
    // distance — so the bbox-of-circle enumeration is unchanged apart from
    // using the rotated player position.
    const [pu, pv] = worldToGrid(px, pz);
    const minGx = Math.floor((pu - loadR) / CELL_SIZE);
    const maxGx = Math.floor((pu + loadR) / CELL_SIZE);
    const minGz = Math.floor((pv - loadR) / CELL_SIZE);
    const maxGz = Math.floor((pv + loadR) / CELL_SIZE);

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gz = minGz; gz <= maxGz; gz++) {
        if (_cellDist2(pu, pv, gx, gz) >= loadR2) continue;
        const key = `${gx},${gz}`;
        if (this._cells.has(key)) continue;
        this._enqueueLoad(gx, gz, key);
      }
    }

    if (this._loadQueue.length > 0) {
      for (let i = this._loadQueue.length - 1; i >= 0; i--) {
        const q = this._loadQueue[i];
        if (_cellDist2(pu, pv, q.gx, q.gz) > unloadR2) {
          this._cells.delete(q.key);
          this._loadQueue.splice(i, 1);
        }
      }
    }

    for (const [key, state] of this._cells) {
      if (state === 'loading') continue;
      const [gx, gz] = _parseKey(key);
      if (_cellDist2(pu, pv, gx, gz) <= unloadR2) continue;
      if (state === 'empty') {
        this._cells.delete(key);
      } else if (state && state.mesh) {
        this._disposePaintArtifacts(state);
        this._group.remove(state.mesh);
        state.mesh.geometry.dispose();
        state.mesh.material.dispose();
        this._cells.delete(key);
        if (this._buildingMeshMap) {
          // Flush pending PUT + drop in-memory cells for this tile. Fire-and-
          // forget; the next loadTile call re-fetches from the server.
          paintStore.unloadTile(state.tileId, state.buildingKeys);
        }
        if (this._onTerrainUnloaded) this._onTerrainUnloaded(state);
      }
    }
  }

  /**
   * Dispose paint overlays + mesh-map entries for a terrain tile being
   * unloaded. Scoped to the tile's 5 buildingKeys so cleanup is O(keys),
   * never a full cache scan — mirrors TileManager._unload's per-buildingKey
   * loop. No-ops if paint wiring wasn't provided (terrain-off null object).
   */
  _disposePaintArtifacts(state) {
    if (!this._buildingMeshMap) return;
    for (const bk of state.buildingKeys) {
      this._buildingMeshMap.delete(bk);
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
  }

  _enqueueLoad(gx, gz, key) {
    this._cells.set(key, 'loading');
    if (this._activeLoads < MAX_CONCURRENT_LOADS) this._doLoad(gx, gz, key);
    else this._loadQueue.push({ gx, gz, key });
  }

  async _doLoad(gx, gz, key) {
    this._activeLoads++;
    try {
      const built = await this._fetchCellViaWorker(gx, gz, key);
      if (built.empty) {
        this._cells.set(key, 'empty');
        return;
      }
      const bounds = _cellBounds(gx, gz);
      const tileId = `terrain_${gx}_${gz}`;
      const buildingKeys = TERRAIN_MESH_TYPES.map(t => `${tileId}:${t}`);
      const mesh = this._wrapTerrainMesh(built, { gx, gz, bounds, tileId, buildingKeys });
      // Per-face-type lookup from (ix, iz) → first-vertex index into the mesh's
      // position attribute, or -1 if that face isn't emitted on this block.
      // Only built when paint wiring is present — the null-object path (terrain
      // off) doesn't need it. Worker emits faces in 6-vert quads (2 tris each)
      // with normals constant across the quad, so one scan classifies each face.
      const faceStarts = this._buildingMeshMap
        ? _buildFaceIndex(built, bounds, built.res)
        : null;
      const state = {
        mesh,
        gx, gz,
        nwY:       built.nwY,
        neY:       built.neY,
        seY:       built.seY,
        swY:       built.swY,
        res:       built.res,
        bounds,
        faceStarts,
        tileId,
        buildingKeys,
        paintLoadPromise: null,
      };
      this._group.add(mesh);
      this._cells.set(key, state);

      // Paint wiring is all-or-nothing: either main.js supplied the shared
      // maps + callbacks (terrain-on path) or it didn't (terrain-off null
      // object never reaches this code). Register the 5 buildingKey → mesh
      // lookups and kick the paint fetch in one block so we never leave
      // half-initialised state that unloadTile would have to clean up.
      if (this._buildingMeshMap) {
        for (const bk of buildingKeys) this._buildingMeshMap.set(bk, mesh);

        // Load the tile's persisted cells, then fire onTerrainLoaded so
        // main.js can rebuild overlays once server state is in paintStore.
        // Matches TileManager's phase-2 ordering.
        state.paintLoadPromise = paintStore.loadTile(tileId, buildingKeys);
        state.paintLoadPromise
          .catch(e => console.warn(`TerrainManager: paint load for ${tileId} failed:`, e))
          .then(() => {
            // Tile may have been unloaded while we awaited the fetch.
            if (this._cells.get(key) !== state) return;
            if (this._onTerrainLoaded) this._onTerrainLoaded(state);
          });
      }

    } catch (e) {
      console.error(`TerrainManager: failed to load cell ${gx},${gz}:`, e);
      this._cells.delete(key);
    } finally {
      this._activeLoads--;
      const waiters = this._waiters.get(key);
      if (waiters) {
        this._waiters.delete(key);
        for (const resolve of waiters) resolve();
      }
      this._drainQueue();
    }
  }

  _fetchCellViaWorker(gx, gz, key) {
    return new Promise((resolve, reject) => {
      this._pendingLoads.set(key, { resolve, reject });
      this._worker.postMessage({ type: 'load', gx, gz, key, file: `/terrain/cell_${gx}_${gz}.bin` });
    });
  }

  _wrapTerrainMesh(built, meta) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(built.position, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(built.normal, 3));
    geom.setAttribute('blockCenter', new THREE.BufferAttribute(built.blockCenter, 2));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    const mesh = new THREE.Mesh(geom, _createTerrainMaterial());
    mesh.name = 'terrain';
    // Stash per-tile identity on userData so the paint raycast can recover
    // the block index from a hit point without consulting a central lookup.
    // `buildingKeys` lets updateCulling toggle overlay visibility in O(keys)
    // rather than scanning the paint mesh maps.
    mesh.userData.terrainKey   = `${meta.gx},${meta.gz}`;
    mesh.userData.terrainGX    = meta.gx;
    mesh.userData.terrainGZ    = meta.gz;
    mesh.userData.terrainTileId = meta.tileId;
    mesh.userData.bounds       = meta.bounds;
    mesh.userData.buildingKeys = meta.buildingKeys;
    return mesh;
  }

  _drainQueue() {
    while (this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length > 0) {
      let bestI = 0;
      let bestD2 = _cellDist2(this._lastPx, this._lastPz,
                              this._loadQueue[0].gx, this._loadQueue[0].gz);
      for (let i = 1; i < this._loadQueue.length; i++) {
        const q = this._loadQueue[i];
        const d2 = _cellDist2(this._lastPx, this._lastPz, q.gx, q.gz);
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
      const { gx, gz, key } = this._loadQueue.splice(bestI, 1)[0];
      if (this._cells.get(key) === 'loading') this._doLoad(gx, gz, key);
    }
  }

  // (applyOsmTile/removeOsmTile removed — OSM is now draped vector geometry
  // owned by OsmManager, not a texture composited into this material.)

  meshes() {
    const out = [];
    for (const state of this._cells.values()) {
      if (state && typeof state === 'object' && state.mesh) out.push(state.mesh);
    }
    return out;
  }

  /**
   * Loaded tile state for (gx, gz), or null if not currently loaded. Used by
   * main.js#buildTerrainCellGeometry to read the block's 4 corner heights
   * when producing paint-overlay vertices. State is live — callers must not
   * retain it past a frame (the tile may unload).
   */
  getState(gx, gz) {
    const state = this._cells.get(`${gx},${gz}`);
    if (!state || typeof state !== 'object') return null;
    return state;
  }

  /**
   * Debug: return the tile + intra-tile sample the given local (x, z) lands
   * on, plus that sample's 4 smoothed corner Ys. `null` if the tile isn't
   * loaded. Used by the F3 HUD — not on any hot path.
   */
  probe(x, z) {
    // Cell addressing is in grid space; rotate the world-space input first.
    const [u, v] = worldToGrid(x, z);
    const gx = Math.floor(u / CELL_SIZE);
    const gz = Math.floor(v / CELL_SIZE);
    const state = this._cells.get(`${gx},${gz}`);
    if (!state || typeof state !== 'object') return null;
    const { nwY, neY, seY, swY, res, bounds: b } = state;
    const step = CELL_SIZE / res;
    let ix = Math.floor((u - b.minX) / step);
    let iz = Math.floor((v - b.minZ) / step);
    if (ix < 0) ix = 0; else if (ix >= res) ix = res - 1;
    if (iz < 0) iz = 0; else if (iz >= res) iz = res - 1;
    const i = iz * res + ix;
    return { gx, gz, ix, iz, res, nw: nwY[i], ne: neY[i], se: seY[i], sw: swY[i] };
  }

  /**
   * Elevation in metres at world (x, z), bilinearly interpolated over the
   * containing cell's 4 corner heights so the player walks smoothly up a
   * slope cluster and still snaps to a flat top on stepped cells (there all
   * 4 corners equal the cell centre). Cell addressing happens in grid space.
   */
  sample(x, z) {
    const [u, v] = worldToGrid(x, z);
    const gx = Math.floor(u / CELL_SIZE);
    const gz = Math.floor(v / CELL_SIZE);
    const state = this._cells.get(`${gx},${gz}`);
    if (!state || typeof state !== 'object') return null;

    const { nwY, neY, seY, swY, res, bounds: b } = state;
    const step = CELL_SIZE / res;
    let ix = Math.floor((u - b.minX) / step);
    let iz = Math.floor((v - b.minZ) / step);
    if (ix < 0) ix = 0; else if (ix >= res) ix = res - 1;
    if (iz < 0) iz = 0; else if (iz >= res) iz = res - 1;

    const i = iz * res + ix;
    const tx = (u - (b.minX + ix * step)) / step;
    const tz = (v - (b.minZ + iz * step)) / step;
    const yN = nwY[i] * (1 - tx) + neY[i] * tx;
    const yS = swY[i] * (1 - tx) + seY[i] * tx;
    return yN * (1 - tz) + yS * tz;
  }

  /**
   * Like sample() but returns the Y of the terrain's actual triangulated
   * top surface instead of the bilinear approximation — i.e. the Y
   * *rendered* by the terrain mesh at this world-space (x, z), computed
   * from whichever of the block's two per-cell triangles contains the
   * point. The terrain emits each block top as two triangles split along
   * the NW-SE diagonal (see terrainWorker.js emitQuad: NW-SW-SE and
   * NW-SE-NE). Inside the NW-SW-SE triangle (tx ≤ tz) we interpolate Y
   * linearly across those three corners; inside NW-SE-NE (tx > tz) across
   * the other three.
   *
   * Use this (instead of sample()) for draping overlay meshes that need
   * to sit exactly on the rendered terrain surface — bilinear and
   * triangulated Ys agree only at cell corners and along the diagonal;
   * elsewhere they disagree by up to the cell's height variation, which
   * on a tilted cell is enough to make overlay polygons pierce through
   * the terrain or float above it.
   */
  sampleTriangulated(x, z) {
    const [u, v] = worldToGrid(x, z);
    const gx = Math.floor(u / CELL_SIZE);
    const gz = Math.floor(v / CELL_SIZE);
    const state = this._cells.get(`${gx},${gz}`);
    if (!state || typeof state !== 'object') return null;

    const { nwY, neY, seY, swY, res, bounds: b } = state;
    const step = CELL_SIZE / res;
    let ix = Math.floor((u - b.minX) / step);
    let iz = Math.floor((v - b.minZ) / step);
    if (ix < 0) ix = 0; else if (ix >= res) ix = res - 1;
    if (iz < 0) iz = 0; else if (iz >= res) iz = res - 1;

    const i = iz * res + ix;
    const tx = (u - (b.minX + ix * step)) / step;
    const tz = (v - (b.minZ + iz * step)) / step;
    const yNW = nwY[i], yNE = neY[i], ySE = seY[i], ySW = swY[i];
    if (tx <= tz) {
      // NW-SW-SE triangle (diagonal = NW-SE, SW side)
      return yNW + (ySE - ySW) * tx + (ySW - yNW) * tz;
    }
    // NW-SE-NE triangle (diagonal = NW-SE, NE side)
    return yNW + (yNE - yNW) * tx + (ySE - yNE) * tz;
  }

  /**
   * Like sample() but waits for the cell at (x, z) to finish loading before
   * reading. Used by teleport to know the spawn Y before revealing the view.
   * If the cell has never been seen, kicks off a priority load that bypasses
   * the load queue (a one-off teleport fetch won't meaningfully contend with
   * the streaming pipeline). Resolves to null if the cell is a 404.
   */
  async sampleAsync(x, z) {
    const [u, v] = worldToGrid(x, z);
    const gx = Math.floor(u / CELL_SIZE);
    const gz = Math.floor(v / CELL_SIZE);
    const key = `${gx},${gz}`;
    const state = this._cells.get(key);

    if (state && typeof state === 'object') return this.sample(x, z);
    if (state === 'empty') return null;

    if (state === undefined) {
      // Never touched — start the load directly. Bypassing _enqueueLoad's
      // MAX_CONCURRENT_LOADS gate is intentional; teleport latency trumps
      // keeping the streamer's concurrency limit pristine for one fetch.
      this._cells.set(key, 'loading');
      this._doLoad(gx, gz, key);
    }
    // state === 'loading' → already in flight or queued; fall through and wait.

    await new Promise(resolve => {
      let arr = this._waiters.get(key);
      if (!arr) { arr = []; this._waiters.set(key, arr); }
      arr.push(resolve);
    });

    return this.sample(x, z);
  }

  /**
   * Return the 4 union-find-smoothed corner Ys for the terrain block at
   * global block indices (bx, bz) — the same integer coordinate system
   * OsmManager's tessellator uses for `gx/gz`. Returns null if the
   * covering terrain cell isn't loaded yet.
   *
   * Block → cell mapping: cellGx = floor(bx / BLOCKS_PER_CELL), and
   * local ix = bx − cellGx * BLOCKS_PER_CELL.  Integer indices up to
   * ~2000 are safely representable as Float32, so callers may pass values
   * read back from a Float32Array without precision loss.
   */
  getBlockCorners(bx, bz) {
    const ibx = Math.round(bx);
    const ibz = Math.round(bz);
    const cellGx = Math.floor(ibx / BLOCKS_PER_CELL);
    const cellGz = Math.floor(ibz / BLOCKS_PER_CELL);
    const state = this._cells.get(`${cellGx},${cellGz}`);
    if (!state || typeof state !== 'object') return null;
    const ix = ibx - cellGx * BLOCKS_PER_CELL;
    const iz = ibz - cellGz * BLOCKS_PER_CELL;
    const i  = iz * state.res + ix;
    return {
      yNW: state.nwY[i],
      yNE: state.neY[i],
      ySE: state.seY[i],
      ySW: state.swY[i],
    };
  }
}

/**
 * Classify each 6-vertex quad emitted by terrainWorker.buildBlockyTerrainGeometry
 * by face type and owning block, and return a `{ top, sideN, sideS, sideE, sideW }`
 * dict of Int32Arrays mapping `iz*res+ix` → first vertex index (or -1). This is
 * the only per-face identity the paint pipeline needs — the actual vertex
 * positions come straight out of the mesh's position attribute at paint time.
 */
function _buildFaceIndex(built, bounds, res) {
  const pos = built.position;
  const nrm = built.normal;
  const bc  = built.blockCenter;
  const step = CELL_SIZE / res;

  const idx = {};
  for (const t of TERRAIN_MESH_TYPES) {
    idx[t] = new Int32Array(res * res);
    idx[t].fill(-1);
  }

  // Normals and block centres are in world space (the worker rotates them at
  // emit). `bounds` is grid space. To classify side faces by cardinal
  // direction and to compute (ix, iz) from the block centre, inverse-rotate
  // both back to grid space — that's what worldToGrid does.
  const QUAD_VERTS = 6;
  const nQuads = (pos.length / 3) / QUAD_VERTS;
  for (let q = 0; q < nQuads; q++) {
    const vi = q * QUAD_VERTS;
    const wnx = nrm[vi * 3], ny = nrm[vi * 3 + 1], wnz = nrm[vi * 3 + 2];
    const [gnx, gnz] = worldToGrid(wnx, wnz);
    const [gcx, gcz] = worldToGrid(bc[vi * 2], bc[vi * 2 + 1]);
    const ix = Math.floor((gcx - bounds.minX) / step);
    const iz = Math.floor((gcz - bounds.minZ) / step);
    if (ix < 0 || ix >= res || iz < 0 || iz >= res) continue;

    let type;
    if      (ny  >  0.5) type = 'top';
    else if (gnx < -0.5) type = 'sideW';
    else if (gnx >  0.5) type = 'sideE';
    else if (gnz < -0.5) type = 'sideN';
    else                 type = 'sideS';

    idx[type][iz * res + ix] = vi;
  }
  return idx;
}

function _cellBounds(gx, gz) {
  return {
    minX:  gx * CELL_SIZE,
    maxX: (gx + 1) * CELL_SIZE,
    minZ:  gz * CELL_SIZE,
    maxZ: (gz + 1) * CELL_SIZE,
  };
}

function _cellDist2(px, pz, gx, gz) {
  const minX = gx * CELL_SIZE, maxX = (gx + 1) * CELL_SIZE;
  const minZ = gz * CELL_SIZE, maxZ = (gz + 1) * CELL_SIZE;
  const cx = Math.max(minX, Math.min(px, maxX));
  const cz = Math.max(minZ, Math.min(pz, maxZ));
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz;
}

function _parseKey(key) {
  const i = key.indexOf(',');
  return [+key.slice(0, i), +key.slice(i + 1)];
}
