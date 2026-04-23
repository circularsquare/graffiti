import * as THREE from 'three';
import { Font } from 'three/addons/loaders/FontLoader.js';
import fontData from 'three/examples/fonts/helvetiker_bold.typeface.json';
import { gridToWorld } from './geo.js';
import { injectGridOverlay, enableGridExtensions, GRID_SHADER_CACHE_KEY } from './gridShader.js';
import { emitStreetTrisXZ } from './streetGeometry.js';

// OSM-specific load radius. Tight (150 m) because draped OSM geometry is
// by far the heaviest per-tile payload in the client — ~3–20 MB of
// positions + normals + skirts per tile — and at the old 350 m radius
// that's 25 tiles × double-digit megabytes loading in the first second
// after spawn, which crashes the tab on memory-constrained machines.
// At 150 m only the player's own tile plus partial neighbours stay
// resident (~1–4 tiles), and distant ground just reads as bare LAND-tan
// terrain — an acceptable LOD cut since fine polygon detail isn't
// readable beyond this distance anyway. UNLOAD_MARGIN keeps tiles
// around for an extra 60 m past the load edge so walking doesn't thrash.
//
// Render-distance slider (setRadiusScale) still scales this, so users
// on strong machines can raise it. Default keeps initial load safe.
const LOAD_RADIUS       = 150;
const OSM_UNLOAD_MARGIN = 60;

// Spatial index grid — mirrors TileManager's scheme.
const COARSE_GRID  = 500;
const COARSE_REACH = 2;

const MAX_CONCURRENT_LOADS = 3;

// Street width table + ribbon tessellation live in ./streetGeometry.js so the
// flat-mode builder here and the draped builder in osmWorker.js can't drift.

// Y stagger for the flat-mode mesh stack — unused in terrain mode (the
// canvas texture composites into the terrain shader instead).
const Y_LAND         = 0.02;
const Y_WATER        = 0.10;
const Y_GREEN        = 0.05;
const Y_STREET       = 0.15;
const Y_STREET_LABEL = 0.50;

// Overlay colours used by both the flat-mode mesh materials below and the
// terrain-mode draped meshes. Exported so TerrainManager can use LAND_COLOR
// as its default terrain material colour — with no OSM mesh drawn on a
// stretch of terrain, the terrain itself reads as LAND.
export const LAND_COLOR   = 0xd1c8b7;
export const WATER_COLOR  = 0x9cc4e2;
export const GREEN_COLOR  = 0xb8de92;
export const STREET_COLOR = 0xf3ecd7;

// Corner-Y drop threshold (metres) for emitting a block-edge skirt. Any
// non-zero drop at a shared edge means the union-find did NOT merge those
// corners, which means terrain has a cliff face there. 5 mm absorbs float-
// arithmetic rounding in the union-find sum/cnt division without masking
// genuine sub-block height variation.
const SKIRT_EPS = 0.005;

// Terrain-block pitch in grid space (metres). MUST match the bake:
// CELL_SIZE=125 m, SAMPLES=64 per side → step = 125/64 ≈ 1.953 m. Using a
// rounded 2.0 here would drift off the real block grid by ~5 cm per cell,
// and by 20 cells later each clip cell's centroid lands in a neighbouring
// block than the aligned one — giving a sawtooth where each sub-triangle
// picks up its own block's interpolated Y and the heights disagree cell to
// cell. If bake_terrain.py changes SAMPLES, update here.
const BLOCK_STEP = 125 / 64;

// Y offsets (metres) per layer, relative to the draped terrain surface.
// Each layer sits a few mm above terrain so it clears the terrain without
// z-fight flicker at grazing angles (polygonOffset alone gets marginal on
// long slopes), and layers are stacked so green < water < streets. Water
// is above green so reservoir/bay polygons show through overlapping park
// boundaries (e.g. Central Park's leisure=park covers the JKO Reservoir).
// All kept below paint's +0.025 m offset so graffiti painted on roads/parks
// still draws on top.
const DRAPE_Y_WATER  = 0.0024;
const DRAPE_Y_GREEN  = 0.0016;
const DRAPE_Y_STREET = 0.0032;

// Shared materials for both flat-mode (fixed-Y mesh stack) and terrain-
// mode (draped meshes). Lambert-shaded so skirts down cliff faces pick up
// the same lighting gradient as the terrain cliffs beside them. Same
// normal-bias hook the terrain material uses (SHADING_STRENGTH below) so
// vertical faces aren't darker here than on the terrain next to them —
// visual consistency between the two meshes.
// polygonOffset keeps the overlay ahead of the ground plane (flat mode)
// or terrain (terrain mode) in the z-test; larger units further up the
// stack so green < water < streets stays consistent.

// Must match TerrainManager's SHADING_STRENGTH so OSM skirts and terrain
// cliff faces shade identically. If that constant moves there, mirror it
// here — trying to share via import creates a minor circular-import risk
// (OsmManager already exports symbols TerrainManager consumes).
const SHADING_STRENGTH = 0.7;

// Apply the same normal-bias as the terrain's Lambert hook: blend each
// vertex normal toward world-up by (1 − SHADING_STRENGTH), compressing
// NoL variation so vertical skirts don't read noticeably darker than
// their draped top faces. Also inject the shared block-grid overlay so the
// grid sits above draped OSM fills — desired stack is terrain → OSM → grid
// → paint. Bias runs first so the grid captures the pre-bias geometric
// normal (see gridShader.js for the ordering contract).
const _onOsmCompile = function (shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
       objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), objectNormal, ${SHADING_STRENGTH.toFixed(3)}));`);
  injectGridOverlay(shader);
};
const _OSM_CACHE_KEY = `graffiti-osm-lambert-v2-${GRID_SHADER_CACHE_KEY}`;

function _makeOsmMaterial(color, polygonOffsetUnits) {
  const mat = new THREE.MeshLambertMaterial({
    color, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits,
  });
  mat.onBeforeCompile = _onOsmCompile;
  mat.customProgramCacheKey = () => _OSM_CACHE_KEY;
  enableGridExtensions(mat);
  return mat;
}

const LAND_MAT         = _makeOsmMaterial(0xd1c8b7, -1);
const GREEN_MAT        = _makeOsmMaterial(0xb8de92, -2);
const WATER_MAT        = _makeOsmMaterial(0x9cc4e2, -4);
const STREET_MAT       = _makeOsmMaterial(0xf3ecd7, -6);

// Skirt meshes are coplanar with the terrain cliff face (yOffset shift is parallel to the face), so they need real perpendicular separation — see SKIRT_OUT_* below. polygonOffset here is just a belt-and-braces backup; ordering matches tops (street > water > green > terrain).
const GREEN_SKIRT_MAT  = _makeOsmMaterial(GREEN_COLOR,  -10);
const WATER_SKIRT_MAT  = _makeOsmMaterial(WATER_COLOR,  -16);
const STREET_SKIRT_MAT = _makeOsmMaterial(STREET_COLOR, -22);

// Horizontal push (metres) applied to each skirt's XZ at emit time, outward from the cliff face. This is the primary depth separator between layers and the terrain cliff — polygonOffset alone can't carry this at close range because `r * units` shrinks with depth-buffer precision.
const SKIRT_OUT_GREEN  = 0.002;
const SKIRT_OUT_WATER  = 0.004;
const SKIRT_OUT_STREET = 0.006;

// Street-label tuning. Labels are built from real font glyph outlines via
// ShapeGeometry so they stay crisp at any viewing distance — no texture,
// no resolution ceiling.
const LABEL_HEIGHT_M        = 2.5;
const MIN_LABELED_STREET_M  = 40;   // don't bother labelling tiny service stubs
const MIN_LABEL_SCALE       = 0.45; // drop labels that would shrink below this to fit
// Labels only render when the player is within this many metres of them —
// at a distance they compress to unreadable scribble and waste fill rate.
const LABEL_VISIBILITY_RANGE_M = 300;

const _font = new Font(fontData);

// ── Binary tile decoder ───────────────────────────────────────────────────────
//
// Mirrors scripts/fetch_osm_features.py::encode_tile_binary. See that
// function for the on-disk layout. Coords are stored as int32 decimetres
// relative to each tile's world origin (gx*125, gz*125); we undo the shift
// at decode so downstream rasterisation/meshing code sees the same world-space
// floats the old JSON path delivered.
const BIN_MAGIC   = 0x4D534F47;  // 'GOSM' little-endian
const BIN_VERSION = 1;
const BIN_GRID_SIZE = 125;
const BIN_INV_SCALE = 0.1;       // 1 decimetre → 1 metre

async function _fetchOsmTile(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Pipe response bytes through the browser's gzip decompressor. Using the
  // streaming API avoids buffering the compressed blob separately.
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return _decodeOsmTile(await new Response(stream).arrayBuffer());
}

function _decodeOsmTile(buffer) {
  const view = new DataView(buffer);
  const td   = new TextDecoder();
  let p = 0;

  const magic = view.getUint32(p, true); p += 4;
  if (magic !== BIN_MAGIC) throw new Error(`OSM tile: bad magic 0x${magic.toString(16)}`);
  const version = view.getUint8(p); p += 1;
  if (version !== BIN_VERSION) throw new Error(`OSM tile: unsupported version ${version}`);
  p += 1;                                              // reserved
  const gx = view.getInt16(p, true); p += 2;
  const gz = view.getInt16(p, true); p += 2;
  const typeCount = view.getUint8(p); p += 1;
  p += 1;                                              // reserved

  const types = new Array(typeCount);
  for (let i = 0; i < typeCount; i++) {
    const len = view.getUint8(p); p += 1;
    types[i] = td.decode(new Uint8Array(buffer, p, len));
    p += len;
  }
  p = (p + 3) & ~3;                                    // pad to 4B

  const originX = gx * BIN_GRID_SIZE;
  const originZ = gz * BIN_GRID_SIZE;

  // Streets
  const streetCount = view.getUint32(p, true); p += 4;
  const streets = new Array(streetCount);
  for (let i = 0; i < streetCount; i++) {
    const typeIdx    = view.getUint8(p); p += 1;
    const nameLen    = view.getUint8(p); p += 1;
    const pointCount = view.getUint16(p, true); p += 2;
    const name = nameLen > 0 ? td.decode(new Uint8Array(buffer, p, nameLen)) : '';
    p += nameLen;
    p = (p + 3) & ~3;
    // p is 4-byte-aligned here, so the Int32Array view is safe.
    const coords = new Int32Array(buffer, p, pointCount * 2);
    p += pointCount * 8;
    const pts = new Array(pointCount);
    for (let k = 0; k < pointCount; k++) {
      pts[k] = [
        originX + coords[k * 2]     * BIN_INV_SCALE,
        originZ + coords[k * 2 + 1] * BIN_INV_SCALE,
      ];
    }
    const s = { type: types[typeIdx], points: pts };
    if (name) s.name = name;
    streets[i] = s;
  }

  // Water + green share the same per-polygon layout.
  const water = _decodePolyList(view, buffer, p, originX, originZ);
  p = water.end;
  const green = _decodePolyList(view, buffer, p, originX, originZ);

  return { streets, water: water.polys, green: green.polys };
}

function _decodePolyList(view, buffer, startP, originX, originZ) {
  let p = startP;
  const count = view.getUint32(p, true); p += 4;
  const polys = new Array(count);
  for (let i = 0; i < count; i++) {
    const n = view.getUint32(p, true); p += 4;
    const coords = new Int32Array(buffer, p, n);
    p += n * 4;
    const flat = new Array(n);
    for (let k = 0; k < n; k += 2) {
      flat[k]     = originX + coords[k]     * BIN_INV_SCALE;
      flat[k + 1] = originZ + coords[k + 1] * BIN_INV_SCALE;
    }
    polys[i] = flat;
  }
  return { polys, end: p };
}

// Shared material for every label — depthWrite off + polygonOffset biases
// labels camera-ward so they reliably win over the street layer.
const LABEL_MAT = new THREE.MeshBasicMaterial({
  color:               0x6a6a6a,
  side:                THREE.DoubleSide,
  depthWrite:          false,
  polygonOffset:       true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits:  -8,
});

// Cached per-name label geometry, shared across all tiles. Keyed by street name
// so two "Water Street" segments reuse one ShapeGeometry. Never disposed —
// unique-name count is O(few hundred) in FiDi, memory is bounded.
const _labelCache = new Map();      // name → { geometry, width, height }

/**
 * Loads OSM "map overlay" tiles (streets, water, green) on the same 125 m grid
 * as building tiles, and renders them as flat meshes at ground level.
 *
 * Each tile renders up to three meshes (streets / water / green), grouped
 * under a single Three.js Group passed in by the caller.
 *
 * Polygons (water, green) may extend past their assigned cell's AABB because
 * we assign by the bbox of the full polygon — that's intentional. The load
 * radius is wider than the cell size so every polygon that would be visible
 * near the player has its tile loaded, and adjacent tiles stay loaded well
 * past the cell boundary thanks to the unload hysteresis.
 */
export class OsmManager {
  constructor({ scene, group, terrain, flatMode, showLabels, onTileReady, onTileUnready } = {}) {
    this._scene = scene;
    this._group = group ?? new THREE.Group();
    if (!group && scene) scene.add(this._group);

    // Optional TerrainManager — used only for label drape now (labels stay
    // as geometry so text renders crisply). The land/water/green/street
    // layers are rasterised to a per-tile texture and composited by the
    // terrain shader, so no mesh-time drape is needed for them.
    this._terrain = terrain ?? null;

    // Fired after a tile finishes loading (texture created) / before it
    // unloads (texture about to be disposed). TerrainManager listens so it
    // can swap the OSM texture sampled by tiles inside this OSM footprint.
    this._onTileReady   = onTileReady   ?? null;
    this._onTileUnready = onTileUnready ?? null;

    // Flat mode — when terrain is disabled (VITE_TERRAIN=0). Each loaded
    // tile gets its own flat textured plane at y≈0.1 so the overlay is
    // still visible without a terrain shader to composite into.
    this._flatMode = !!flatMode;

    // Whether to draw street-name labels as geometry on top of terrain/ground.
    // Default true preserves old behaviour. Blocky terrain sets false to avoid
    // "painting" streets visually while still letting random-teleport use
    // OSM street data.
    this._showLabels = showLabels ?? true;

    this._tiles        = new Map();           // tileId → TileState
    this._spatialIndex = new Map();           // "gx,gz" → Tile[]
    this._loadQueue    = [];
    this._activeLoads  = 0;
    this._lastPx       = 0;
    this._lastPz       = 0;

    // User-facing render-distance multiplier applied to LOAD_RADIUS in tick().
    this._radiusScale  = 1;

    // Set to true once init() completes (success or 404). The startup/teleport
    // gate checks this before querying allNearbySettled().
    this._manifestSettled = false;

    // Raw streets cache for random-spawn sampling. Stores the in-flight Promise
    // so two concurrent callers share one fetch; resolved value replaces it.
    this._streetsCache = new Map();           // tileId → Array<street> | Promise

    // Tessellation worker. Main posts raw source polygons/streets; worker
    // returns interleaved 7-float-per-vertex `topXz` arrays plus the list of
    // terrain blocks each layer covers. Main still runs skirt emission and
    // Y resolution because both need live terrain state. Only used in
    // terrain mode; flat mode stays entirely on main.
    this._worker = new Worker(new URL('./osmWorker.js', import.meta.url), { type: 'module' });
    this._pendingBuilds = new Map(); // jobId → { resolve, reject }
    this._nextJobId = 1;
    this._worker.onmessage = (e) => {
      const msg = e.data;
      const pending = this._pendingBuilds.get(msg.jobId);
      if (!pending) return;
      this._pendingBuilds.delete(msg.jobId);
      if (msg.type === 'drapeResult') pending.resolve(msg);
      else if (msg.type === 'error')  pending.reject(new Error(msg.error));
    };
    this._worker.onerror = (e) => {
      console.error('OsmManager worker error:', e.message);
    };
  }

  _postDrapeJob(payload) {
    const jobId = this._nextJobId++;
    return new Promise((resolve, reject) => {
      this._pendingBuilds.set(jobId, { resolve, reject });
      this._worker.postMessage({ type: 'buildDrape', jobId, ...payload });
    });
  }

  setRadiusScale(s) { this._radiusScale = s; }

  /**
   * Toggle each loaded tile's street labels on/off based on the player's XZ
   * distance to the label's anchor. Call from the caller's cull-update hook —
   * it already runs with hysteresis so per-frame cost isn't an issue.
   */
  updateLabelVisibility(px, pz) {
    const r2 = LABEL_VISIBILITY_RANGE_M * LABEL_VISIBILITY_RANGE_M;
    for (const tile of this._tiles.values()) {
      if (tile.status !== 'loaded' || !tile.labels) continue;
      for (const mesh of tile.labels) {
        const dx = mesh.userData.anchorX - px;
        const dz = mesh.userData.anchorZ - pz;
        mesh.visible = dx * dx + dz * dz < r2;
      }
    }
  }

  async init(manifestUrl = '/osm/manifest.json') {
    let entries;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = await res.json();
    } catch (e) {
      console.warn(`OsmManager: manifest not found (${e.message}) — skipping OSM overlay`);
      this._manifestSettled = true;
      return;
    }

    for (const entry of entries) {
      const tile = {
        id:          entry.id,
        // Manifest no longer stores `file` — it's deterministic from `id`.
        // Accept the old field for forward/backward compatibility.
        file:        entry.file ?? `${import.meta.env.VITE_CDN_BASE ?? ''}/osm/${entry.id}.bin.gz`,
        bounds:      entry.bounds,
        streetCount: entry.streetCount ?? 0,
        status:      'unloaded',
        group:       null, // THREE.Group of per-type meshes, added to _group on load
      };
      this._tiles.set(tile.id, tile);
      this._indexTile(tile);
    }

    this._manifestSettled = true;
    this.tick(0, 0);
  }

  /**
   * Return the loaded OSM tile covering (x, z), or null. Terrain uses this
   * at tile-load time to find the covering OSM texture so the shader can
   * sample it.
   */
  getLoadedTileAt(x, z) {
    const bucket = this._spatialIndex.get(
      `${Math.floor(x / COARSE_GRID)},${Math.floor(z / COARSE_GRID)}`,
    );
    if (!bucket) return null;
    for (const tile of bucket) {
      if (tile.status !== 'loaded') continue;
      const b = tile.bounds;
      if (x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ) return tile;
    }
    return null;
  }

  // True when the nearest GATE_TILES OSM tiles within LOAD_RADIUS of (px, pz)
  // have all settled (loaded or failed). Returns true immediately if the
  // manifest hasn't loaded yet (would block forever) — callers check
  // _manifestSettled separately for the startup gate.
  allNearbySettled(px, pz) {
    if (!this._manifestSettled) return false;
    if (this._tiles.size === 0) return true;
    const GATE_TILES = 2;
    const maxR2 = (LOAD_RADIUS * this._radiusScale) ** 2;
    const pgx = Math.floor(px / COARSE_GRID);
    const pgz = Math.floor(pz / COARSE_GRID);
    const nearest = [];
    const seen = new Set();
    for (let dx = -COARSE_REACH; dx <= COARSE_REACH; dx++) {
      for (let dz = -COARSE_REACH; dz <= COARSE_REACH; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          const d2 = _closestDist2(px, pz, tile.bounds);
          if (d2 > maxR2) continue;
          nearest.push({ tile, d2 });
        }
      }
    }
    if (nearest.length === 0) return true;
    nearest.sort((a, b) => a.d2 - b.d2);
    const count = Math.min(GATE_TILES, nearest.length);
    for (let i = 0; i < count; i++) {
      const s = nearest[i].tile.status;
      if (s !== 'loaded' && s !== 'failed') return false;
    }
    return true;
  }

  /**
   * Return all loaded water meshes (tops + skirts). Used by the paint raycast
   * to reject aim points over water — since water is draped ~2.4 mm above
   * terrain, a ray that hits water will always hit it before the terrain
   * underneath, so a simple "first hit is water" check works per-cell.
   */
  waterMeshes() {
    const out = [];
    for (const tile of this._tiles.values()) {
      if (tile.status !== 'loaded' || !tile.group) continue;
      for (const child of tile.group.children) {
        if (child.userData.isWater) out.push(child);
      }
    }
    return out;
  }

  /**
   * Return water meshes for the single OSM cell at (gx, gz), or null if that
   * cell is in the manifest but not yet loaded+draped. An empty array means
   * "cell is known to have no water" (or isn't in the manifest at all, i.e.
   * off-coverage — nothing to wait for).
   *
   * Used by the terrain seeder to decide whether to skip water cells: if the
   * return is null the seed pass bails without marking the tile complete so
   * it retries on the next reload once OSM has caught up.
   */
  waterMeshesForCell(gx, gz) {
    const tile = this._tiles.get(`cell_${gx}_${gz}`);
    if (!tile) return [];
    if (tile.status !== 'loaded' || !tile.drapeComplete) return null;
    const out = [];
    if (tile.group) {
      for (const child of tile.group.children) {
        if (child.userData.isWater) out.push(child);
      }
    }
    return out;
  }

  /** Manifest tiles that report at least one street. Used by the random-spawn picker. */
  tilesWithStreets() {
    const out = [];
    for (const tile of this._tiles.values()) {
      if (tile.streetCount > 0) out.push(tile);
    }
    return out;
  }

  /**
   * Resolves to the `streets` array for the given manifest tile. Caches the
   * result (and dedupes concurrent fetches) so repeat calls are free. Returns
   * [] if the tile is unknown or has no streets; throws if the fetch fails.
   */
  async fetchStreets(tileId) {
    const cached = this._streetsCache.get(tileId);
    if (cached !== undefined) return cached;
    const tile = this._tiles.get(tileId);
    if (!tile) return [];
    const promise = (async () => {
      const data = await _fetchOsmTile(tile.file);
      const streets = data.streets || [];
      this._streetsCache.set(tileId, streets);
      return streets;
    })().catch(e => {
      this._streetsCache.delete(tileId);
      throw e;
    });
    this._streetsCache.set(tileId, promise);
    return promise;
  }

  _indexTile(tile) {
    const { minX, maxX, minZ, maxZ } = tile.bounds;
    const gx0 = Math.floor(minX / COARSE_GRID);
    const gx1 = Math.floor(maxX / COARSE_GRID);
    const gz0 = Math.floor(minZ / COARSE_GRID);
    const gz1 = Math.floor(maxZ / COARSE_GRID);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = `${gx},${gz}`;
        let bucket = this._spatialIndex.get(k);
        if (!bucket) { bucket = []; this._spatialIndex.set(k, bucket); }
        bucket.push(tile);
      }
    }
  }

  /** Call once per frame with the player's XZ. */
  tick(px, pz) {
    this._lastPx = px; this._lastPz = pz;

    const loadR    = LOAD_RADIUS * this._radiusScale;
    const unloadR  = loadR + OSM_UNLOAD_MARGIN;
    const loadR2   = loadR   ** 2;
    const unloadR2 = unloadR ** 2;

    // Drop queued tiles that drifted out of range while waiting.
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
    const seen = new Set();
    const toEnqueue = [];
    for (let dx = -COARSE_REACH; dx <= COARSE_REACH; dx++) {
      for (let dz = -COARSE_REACH; dz <= COARSE_REACH; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          const d2 = _closestDist2(px, pz, tile.bounds);
          if (tile.status === 'unloaded' && d2 < loadR2) toEnqueue.push({ tile, d2 });
          else if (tile.status === 'loaded' && d2 > unloadR2) this._unload(tile);
        }
      }
    }
    toEnqueue.sort((a, b) => a.d2 - b.d2);
    for (const { tile } of toEnqueue) this._enqueueLoad(tile);
  }

  _enqueueLoad(tile) {
    tile.status = 'loading';
    if (this._activeLoads < MAX_CONCURRENT_LOADS) this._doLoad(tile);
    else this._loadQueue.push(tile);
  }

  async _doLoad(tile) {
    this._activeLoads++;
    try {
      const data = await _fetchOsmTile(tile.file);
      // Cache decoded source on the tile so `redrapeOverBounds` can rebuild
      // the drape meshes (not just re-sample Y) when a covering terrain
      // cell arrives after OSM — skirts are only emitted at build time, so
      // a tile built before its terrain arrives needs a full rebuild to
      // recover missing cliff-face coverage. Tiny memory cost (~kB per
      // tile, ~4 tiles loaded).
      tile.sourceData = data;

      // If terrain is present but hasn't settled for this tile's centre yet
      // (still in-flight or never requested), skip the initial mesh build so
      // we never flash flat y=0 geometry. redrapeOverBounds will call
      // _rebuildTile once the covering terrain cell lands.
      const cx = (tile.bounds.minX + tile.bounds.maxX) / 2;
      const cz = (tile.bounds.minZ + tile.bounds.maxZ) / 2;
      if (this._terrain && !this._terrain.isCellSettled(cx, cz)) {
        tile.drapeComplete = false;
      } else {
        await this._buildTileMeshes(tile);
      }

      // Tile could have been cancelled mid-build if we later add that path; for
      // now status stays 'loading' until here, but guard defensively.
      if (tile.status === 'unloaded') return;
      tile.status = 'loaded';
      if (this._onTileReady) this._onTileReady(tile);
    } catch (e) {
      console.error(`OsmManager: failed to load ${tile.id}:`, e);
      tile._failures = (tile._failures ?? 0) + 1;
      // After 2 failures treat the tile as permanently absent so the
      // startup/teleport gate can proceed rather than retrying forever.
      tile.status = tile._failures >= 2 ? 'failed' : 'unloaded';
    } finally {
      this._drainQueue();
    }
  }

  /**
   * Build all the meshes for a tile from its cached `sourceData`. Called by
   * `_doLoad` on first load, and by `redrapeOverBounds` when a terrain cell
   * arrives under an OSM tile whose drape was marked incomplete (i.e. built
   * before some of its covering terrain was loaded, so skirts were skipped).
   * Rebuilds set `tile.drapeComplete` to whether the new build managed to
   * sample all needed terrain — if still false, a future terrain arrival
   * will trigger another rebuild.
   */
  async _buildTileMeshes(tile) {
    const data = tile.sourceData;
    if (!data) return;

    const group = new THREE.Group();
    const labels = [];
    if (this._showLabels) _buildStreetLabels(data.streets || [], group, this._terrain, labels);
    tile.labels = labels;

    if (this._flatMode) {
      // Pre-terrain rendering path: flat stacked meshes at Y_LAND..Y_STREET.
      // Used when terrain is disabled (`VITE_TERRAIN=0`) so no canvas
      // texture or terrain shader is needed.
      group.add(_buildLandMesh(tile.bounds));
      const water = _buildPolygonMesh(data.water  || [], Y_WATER,  WATER_MAT,  2);
      if (water)   { water.userData.isWater = true; group.add(water); }
      const green = _buildPolygonMesh(data.green  || [], Y_GREEN,  GREEN_MAT,  1);
      if (green)   group.add(green);
      const streets = _buildStreetMesh(data.streets || [], Y_STREET, STREET_MAT, 3);
      if (streets) group.add(streets);
      tile.drapeComplete = true;
    } else {
      // Terrain mode: worker tessellates each source triangle down to the 2 m
      // block grid, returning interleaved 7-float-per-vertex top arrays + the
      // list of covered blocks. Main then emits skirts (needs terrain state)
      // and finalizes meshes. Skirt emission and Y resolution both live on
      // main because both depend on live `terrain.getBlockCorners` lookups.
      tile.drapables = [];
      const result = await this._postDrapeJob({
        water:      data.water   || [],
        green:      data.green   || [],
        streets:    data.streets || [],
        hasTerrain: !!this._terrain,
      });

      // Bail if the tile was unloaded during the worker roundtrip (keeps us
      // from attaching meshes to a disposed group).
      if (tile.status === 'unloaded') return;

      _applyDrapeLayer(result.water,   WATER_MAT,  WATER_SKIRT_MAT,  2, this._terrain, DRAPE_Y_WATER,  tile.drapables, group, SKIRT_OUT_WATER,  true);
      _applyDrapeLayer(result.green,   GREEN_MAT,  GREEN_SKIRT_MAT,  1, this._terrain, DRAPE_Y_GREEN,  tile.drapables, group, SKIRT_OUT_GREEN,  false);
      _applyDrapeLayer(result.streets, STREET_MAT, STREET_SKIRT_MAT, 3, this._terrain, DRAPE_Y_STREET, tile.drapables, group, SKIRT_OUT_STREET, false);

      // `stats.missingTerrain` used to live here but was never written; the
      // drape is considered complete after any build. If partial-terrain
      // tracking comes back, hook it into `_applyDrapeLayer` / the drape
      // sampler and set `drapeComplete` accordingly.
      tile.drapeComplete = true;
    }

    if (group.children.length > 0) {
      this._group.add(group);
      tile.group = group;
    }
  }

  /**
   * Dispose the tile's current meshes so `_buildTileMeshes` can rebuild
   * from scratch. Does not touch tile.sourceData (we need it to rebuild)
   * and does not toggle tile.status (tile is still logically loaded).
   */
  _disposeTileMeshes(tile) {
    if (tile.group) {
      for (const child of tile.group.children) {
        if (child.geometry && !child.userData.sharedGeometry) child.geometry.dispose();
      }
      this._group.remove(tile.group);
      tile.group = null;
    }
    tile.drapables = null;
    tile.labels = null;
  }

  _drainQueue() {
    this._activeLoads--;
    while (this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length > 0) {
      // Nearest-first priority so the tile the player is flying toward
      // lands before ones behind them.
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

  _unload(tile) {
    if (this._onTileUnready) this._onTileUnready(tile);
    this._disposeTileMeshes(tile);
    tile.sourceData = null;
    tile.drapeComplete = false;
    tile.status = 'unloaded';
  }

  /**
   * Fire-and-forget rebuild. Coalesces rapid repeat requests: if a rebuild is
   * already in flight when we're called, we don't stack — we flag a
   * follow-up and trigger it once the current one settles. Used by the
   * redrape path where many terrain cells can land in quick succession.
   */
  _rebuildTile(tile) {
    if (tile.rebuildInFlight) { tile.rebuildQueued = true; return; }
    tile.rebuildInFlight = true;
    this._disposeTileMeshes(tile);
    this._buildTileMeshes(tile).catch(e => {
      console.error(`OsmManager: rebuild ${tile.id} failed:`, e);
    }).finally(() => {
      tile.rebuildInFlight = false;
      if (tile.rebuildQueued && tile.status === 'loaded') {
        tile.rebuildQueued = false;
        this._rebuildTile(tile);
      } else {
        tile.rebuildQueued = false;
      }
    });
  }

  /**
   * Called by main.js when a TerrainManager cell finishes loading.
   *
   * Two paths per overlapping OSM tile:
   *   - tile.drapeComplete: just re-sample Ys on the existing mesh (fast,
   *     in-place position-buffer rewrite). Covers the common case where
   *     terrain arrives later under a tile whose drape already had full
   *     terrain coverage at build.
   *   - !tile.drapeComplete: dispose + rebuild from cached sourceData via
   *     `_rebuildTile` (fire-and-forget, coalesces concurrent requests).
   *
   * `bounds` is expected in WORLD space. Callers (main.js::onTerrainLoaded)
   * convert from terrain's grid-space bounds via gridToWorld corners first.
   */
  redrapeOverBounds(bounds, gridBounds) {
    if (!this._terrain) return;
    // Grid-space block range of the terrain tile that just landed — used by
    // `_drapeIntoPositions` to skip verts owned by neighbouring tiles. Falls
    // back to a null range (process everything) if the caller didn't supply
    // gridBounds, preserving the pre-D behaviour for older callers.
    let blockRange = null;
    if (gridBounds) {
      blockRange = {
        gxMin: Math.round(gridBounds.minX / BLOCK_STEP),
        gxMax: Math.round(gridBounds.maxX / BLOCK_STEP),
        gzMin: Math.round(gridBounds.minZ / BLOCK_STEP),
        gzMax: Math.round(gridBounds.maxZ / BLOCK_STEP),
      };
    }
    for (const tile of this._tiles.values()) {
      if (tile.status !== 'loaded') continue;
      const b = tile.bounds;
      if (b.maxX <= bounds.minX || b.minX >= bounds.maxX ||
          b.maxZ <= bounds.minZ || b.minZ >= bounds.maxZ) continue;

      if (tile.drapeComplete) {
        if (tile.drapables) {
          for (const drap of tile.drapables) _redrapeMesh(drap, this._terrain, blockRange);
        }
      } else {
        // Full rebuild — drape was incomplete at last build. _buildTileMeshes
        // flips tile.drapeComplete based on whether this build managed to
        // sample all needed terrain; if still false, the next terrain-cell
        // arrival will trigger another rebuild.
        this._rebuildTile(tile);
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _closestDist2(px, pz, b) {
  const cx = Math.max(b.minX, Math.min(px, b.maxX));
  const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

// Sample the terrain at (x, z) and add the overlay's stack offset. If the
// covering terrain tile hasn't loaded yet, return offset directly. For
// terrain-mode OSM overlays, OsmManager.redrapeOverBounds rewrites these
// vertices when the covering terrain tile lands.
//
// Uses sampleTriangulated (not sample) so each vertex lands on the exact
// rendered surface — sampleTriangulated honours the NW-SE diagonal split
// the terrain renderer uses. Combined with block-granular rasterization
// (_emitCoveredBlock emits both diagonal halves using the same 4 corner
// Ys), the drape is perfectly coplanar with the terrain's block top.
function drapeY(terrain, x, z, offset) {
  if (!terrain) return offset;
  const t = terrain.sampleTriangulated
    ? terrain.sampleTriangulated(x, z)
    : terrain.sample(x, z);
  return (t !== null ? t : 0) + offset;
}

// ── Terrain-mode draped builders ──────────────────────────────────────────────
//
// For each source triangle (water/green tri or street ribbon segment),
// clip to each 2 m block it touches, split along the NW-SE diagonal (so
// each sub-poly lies inside one terrain triangle), and fan-triangulate.
// Vertices land at polygon-edge intersection points, preserving polygon-
// edge detail on the block top — a block can show multiple polygon
// colours with sharp boundaries between them. Each vertex samples the
// terrain via sampleTriangulated at its exact position, so the drape sits
// coplanar with the terrain's rendered block top.
//
// Tessellation (clip/fan-triangulate/emit) lives in osmWorker.js so the
// main thread doesn't spike 500+ ms on tile load. Main keeps the skirt
// emit + Y-resolution + mesh-finalize stages below, because all three
// depend on live `terrain.getBlockCorners` lookups that would be ugly to
// snapshot and ship into the worker.
//
// Vertex layout in the returned `topXz`: 7 floats per vertex:
//   [0]   posX    world X
//   [1]   posZ    world Z
//   [2]   gridU   terrain-grid U of this vertex
//   [3]   gridV   terrain-grid V of this vertex
//   [4]   blockGx global block index in U direction (integer stored as float)
//   [5]   blockGz global block index in V direction
//   [6]   keepNE  1.0 → NE triangle half (tx > tz), 0.0 → SW half (tx ≤ tz)
// _drapeIntoPositions reads these back and computes Y directly from
// terrain.getBlockCorners() using the exact same bilinear formula that
// terrainWorker uses for sampleTriangulated — no world→grid round-trip.

// Emit one skirt vertex (7 floats) into `outXZ`. `u, v` is the grid-space
// position on the block edge; blockGx/blockGz identify which block's corner
// to look up; cornerIdx selects the corner: 0=NW, 1=NE, 2=SE, 3=SW.
// Stored as typeFlag = 2 + cornerIdx (≥ 2 signals "skirt" to _drapeIntoPositions).
// gridU/gridV slots are unused for skirt vertices (always 0).
function _emitSkirtVert(u, v, blockGx, blockGz, cornerIdx, outXZ) {
  const [wx, wz] = gridToWorld(u, v);
  outXZ.push(wx, wz, 0, 0, blockGx, blockGz, 2.0 + cornerIdx);
}

// For each block in `coveredBlocks`, check all four edges. If the home
// block's corner is higher than the adjacent block's shared corner by more
// than SKIRT_EPS, emit a vertical quad matching the terrain's cliff face.
// The threshold mirrors the union-find invariant: if adjacent corners ended
// up in the same component (no cliff), they have the exact same Y value and
// the drop is 0 — well below SKIRT_EPS. Any positive drop ≥ SKIRT_EPS means
// terrain emits a side face there, and we need to cover it with OSM colour.
//
// `coveredBlocks` is a flat Int32Array of [gx0, gz0, gx1, gz1, ...] pairs —
// the worker packs the Set into this layout so the whole buffer ships as a
// transferable instead of getting deep-cloned.
function _emitBlockSkirts(coveredBlocks, terrain, outXZ, outwardPush = 0) {
  if (!terrain?.getBlockCorners || !coveredBlocks) return;
  for (let bi = 0; bi < coveredBlocks.length; bi += 2) {
    const gx = coveredBlocks[bi];
    const gz = coveredBlocks[bi + 1];
    const home = terrain.getBlockCorners(gx, gz);
    if (!home) continue;
    const { yNW, yNE, ySE, ySW } = home;
    const u0 = gx * BLOCK_STEP, u1 = (gx + 1) * BLOCK_STEP;
    const v0 = gz * BLOCK_STEP, v1 = (gz + 1) * BLOCK_STEP;

    // North edge — home NW/NE vs nbr (gx, gz-1) SW/SE. Outward = -V.
    const nN = terrain.getBlockCorners(gx, gz - 1);
    if (nN && (yNW - nN.ySW > SKIRT_EPS || yNE - nN.ySE > SKIRT_EPS)) {
      const vP = v0 - outwardPush;
      _emitSkirtVert(u0, vP, gx,     gz,     0, outXZ);  // home NW  top-L
      _emitSkirtVert(u1, vP, gx,     gz,     1, outXZ);  // home NE  top-R
      _emitSkirtVert(u1, vP, gx,     gz - 1, 2, outXZ);  // nbr  SE  bot-R
      _emitSkirtVert(u0, vP, gx,     gz,     0, outXZ);  // home NW  top-L
      _emitSkirtVert(u1, vP, gx,     gz - 1, 2, outXZ);  // nbr  SE  bot-R
      _emitSkirtVert(u0, vP, gx,     gz - 1, 3, outXZ);  // nbr  SW  bot-L
    }

    // South edge — home SW/SE vs nbr (gx, gz+1) NW/NE. Outward = +V.
    const nS = terrain.getBlockCorners(gx, gz + 1);
    if (nS && (ySW - nS.yNW > SKIRT_EPS || ySE - nS.yNE > SKIRT_EPS)) {
      const vP = v1 + outwardPush;
      _emitSkirtVert(u1, vP, gx,     gz,     2, outXZ);  // home SE  top-R
      _emitSkirtVert(u0, vP, gx,     gz,     3, outXZ);  // home SW  top-L
      _emitSkirtVert(u0, vP, gx,     gz + 1, 0, outXZ);  // nbr  NW  bot-L
      _emitSkirtVert(u1, vP, gx,     gz,     2, outXZ);  // home SE  top-R
      _emitSkirtVert(u0, vP, gx,     gz + 1, 0, outXZ);  // nbr  NW  bot-L
      _emitSkirtVert(u1, vP, gx,     gz + 1, 1, outXZ);  // nbr  NE  bot-R
    }

    // West edge — home NW/SW vs nbr (gx-1, gz) NE/SE. Outward = -U.
    const nW = terrain.getBlockCorners(gx - 1, gz);
    if (nW && (yNW - nW.yNE > SKIRT_EPS || ySW - nW.ySE > SKIRT_EPS)) {
      const uP = u0 - outwardPush;
      _emitSkirtVert(uP, v1, gx,     gz,     3, outXZ);  // home SW  top-L
      _emitSkirtVert(uP, v0, gx,     gz,     0, outXZ);  // home NW  top-R
      _emitSkirtVert(uP, v0, gx - 1, gz,     1, outXZ);  // nbr  NE  bot-R
      _emitSkirtVert(uP, v1, gx,     gz,     3, outXZ);  // home SW  top-L
      _emitSkirtVert(uP, v0, gx - 1, gz,     1, outXZ);  // nbr  NE  bot-R
      _emitSkirtVert(uP, v1, gx - 1, gz,     2, outXZ);  // nbr  SE  bot-L
    }

    // East edge — home NE/SE vs nbr (gx+1, gz) NW/SW. Outward = +U.
    const nE = terrain.getBlockCorners(gx + 1, gz);
    if (nE && (yNE - nE.yNW > SKIRT_EPS || ySE - nE.ySW > SKIRT_EPS)) {
      const uP = u1 + outwardPush;
      _emitSkirtVert(uP, v0, gx,     gz,     1, outXZ);  // home NE  top-L
      _emitSkirtVert(uP, v1, gx,     gz,     2, outXZ);  // home SE  top-R
      _emitSkirtVert(uP, v1, gx + 1, gz,     3, outXZ);  // nbr  SW  bot-R
      _emitSkirtVert(uP, v0, gx,     gz,     1, outXZ);  // home NE  top-L
      _emitSkirtVert(uP, v1, gx + 1, gz,     3, outXZ);  // nbr  SW  bot-R
      _emitSkirtVert(uP, v0, gx + 1, gz,     0, outXZ);  // nbr  NW  bot-L
    }
  }
}

// Build a draped THREE.Mesh from an interleaved per-vertex 7-float array
// (see the "Vertex layout" comment up top for the field breakdown). `xzOwn`
// is kept on the returned mesh's drapable record so we can rewrite Y
// values later when a covering terrain tile streams in.
function _finalizeDrapedMesh(xzOwn, material, renderOrder, terrain, yOffset, drapables) {
  if (xzOwn.length === 0) return null;
  const vertCount = xzOwn.length / 7;
  const positions = new Float32Array(vertCount * 3);
  _drapeIntoPositions(xzOwn, terrain, yOffset, positions);
  const geo = new THREE.BufferGeometry();
  // DynamicDrawUsage: redrapeOverBounds rewrites Y on every terrain-cell
  // load, so position is updated frequently. Default StaticDrawUsage makes
  // some WebGL drivers allocate fresh VBOs per update, accumulating stale
  // buffers — contributes to memory bloat during the initial terrain
  // stream when dozens of cells arrive in quick succession.
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  // Non-indexed triangle soup → each tri gets its own face normal on
  // all three of its verts (flat shading). Every drape vertex is a top
  // face so normals come out (0, 1, 0) modulo the per-block tilt.
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = renderOrder;
  drapables.push({ mesh, xz: xzOwn, yOffset });
  return mesh;
}

// Walk the 7-float-per-vertex array and write XYZ into `positions` (3
// floats/vert). typeFlag (slot [6]) distinguishes two vertex kinds:
//   < 2 → top vertex: bilinear interpolation from home block's 4 corners.
//         0.0 = SW half (tx ≤ tz), 1.0 = NE half (tx > tz).
//   ≥ 2 → skirt vertex: look up one corner directly.
//         2=NW, 3=NE, 4=SE, 5=SW of the block stored in slots [4..5].
//
// `blockRange` (optional) narrows work to verts whose home block falls inside
// [gxMin, gxMax) × [gzMin, gzMax). Used by redrape to skip verts whose Y
// can't have changed because a different terrain tile owns their block. Omit
// (or pass null) to process every vert — initial build uses the null path so
// it populates the whole buffer.
function _drapeIntoPositions(xzOwn, terrain, yOffset, positions, blockRange) {
  const vertCount = xzOwn.length / 7;
  const gxMin = blockRange ? blockRange.gxMin : 0;
  const gxMax = blockRange ? blockRange.gxMax : 0;
  const gzMin = blockRange ? blockRange.gzMin : 0;
  const gzMax = blockRange ? blockRange.gzMax : 0;
  for (let i = 0; i < vertCount; i++) {
    const b = i * 7;
    const posX     = xzOwn[b    ];
    const posZ     = xzOwn[b + 1];
    const gridU    = xzOwn[b + 2];
    const gridV    = xzOwn[b + 3];
    const blockGx  = xzOwn[b + 4];
    const blockGz  = xzOwn[b + 5];
    const typeFlag = xzOwn[b + 6];

    // Skip verts outside the terrain tile that just landed — their Y is owned
    // by a different terrain tile and didn't change. Leaves the existing
    // `positions` entry as-is, which is correct because redrape calls hit an
    // already-populated buffer.
    if (blockRange &&
        (blockGx < gxMin || blockGx >= gxMax || blockGz < gzMin || blockGz >= gzMax)) {
      continue;
    }

    let y = yOffset;
    if (terrain) {
      const corners = terrain.getBlockCorners
        ? terrain.getBlockCorners(blockGx, blockGz)
        : null;
      if (corners !== null) {
        if (typeFlag < 2.0) {
          // Top vertex — bilinear over the home block's two triangles.
          const tx = (gridU - blockGx * BLOCK_STEP) / BLOCK_STEP;
          const tz = (gridV - blockGz * BLOCK_STEP) / BLOCK_STEP;
          const { yNW, yNE, ySE, ySW } = corners;
          y = (typeFlag > 0.5
            ? yNW + (yNE - yNW) * tx + (ySE - yNE) * tz
            : yNW + (ySE - ySW) * tx + (ySW - yNW) * tz
          ) + yOffset;
        } else {
          // Skirt vertex — single corner direct lookup.
          // cornerIdx: 0=NW, 1=NE, 2=SE, 3=SW
          const ci = Math.round(typeFlag) - 2;
          y = [corners.yNW, corners.yNE, corners.ySE, corners.ySW][ci] + yOffset;
        }
      }
    }

    const pi = i * 3;
    positions[pi    ] = posX;
    positions[pi + 1] = y;
    positions[pi + 2] = posZ;
  }
}

// Apply one layer's worker output (topXz + covered-block list) to the scene.
// Emits the layer's skirt quads against live terrain state, finalizes both
// tops and skirts as THREE meshes, and adds them to `group`. Used for all
// three layers (water/green/streets) — the caller routes materials +
// skirtOut to pick the right stack ordering.
function _applyDrapeLayer(layer, topMat, skirtMat, renderOrder, terrain, yOffset, drapables, group, skirtOut, isWater) {
  const topXz = layer.topXz;
  const skirtXz = [];
  _emitBlockSkirts(layer.coveredBlocks, terrain, skirtXz, skirtOut);
  const topMesh = topXz.length > 0
    ? _finalizeDrapedMesh(topXz, topMat, renderOrder, terrain, yOffset, drapables)
    : null;
  const skirtMesh = skirtXz.length > 0
    ? _finalizeDrapedMesh(new Float32Array(skirtXz), skirtMat, renderOrder, terrain, yOffset, drapables)
    : null;
  if (topMesh)   { if (isWater) topMesh.userData.isWater   = true; group.add(topMesh); }
  if (skirtMesh) { if (isWater) skirtMesh.userData.isWater = true; group.add(skirtMesh); }
}

// Re-sample terrain at every xz pair and rewrite the mesh's Y column in
// place. Called from redrapeOverBounds when a new terrain tile lands under
// an OSM tile that was already loaded.
//
// We deliberately DON'T recompute vertex normals here — it's an O(N) walk
// per tile and gets triggered on every terrain-cell load, so a full
// radius of streaming terrain fires it hundreds of times at hundreds of
// KB each. The initial normals (computed at mesh build) stay close
// enough as Y values shift by a few cm from the initial guess.
function _redrapeMesh({ mesh, xz, yOffset }, terrain, blockRange) {
  const pos = mesh.geometry.attributes.position;
  _drapeIntoPositions(xz, terrain, yOffset, pos.array, blockRange);
  pos.needsUpdate = true;
}

// ── Flat-mode mesh builders (pre-terrain behaviour) ───────────────────────────
//
// Flat 2-triangle LAND rectangle covering the tile. Adjacent tiles abut
// exactly (no gap, no overlap) since bounds are the grid cell edges.
function _buildLandMesh(bounds) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const positions = new Float32Array([
    minX, Y_LAND, minZ,  maxX, Y_LAND, minZ,  maxX, Y_LAND, maxZ,
    minX, Y_LAND, minZ,  maxX, Y_LAND, maxZ,  minX, Y_LAND, maxZ,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, LAND_MAT);
  mesh.renderOrder = 0;
  return mesh;
}

// Flat XZ triangle lists (each entry is [x,z,x,z,...] for one polygon) → one
// BufferGeometry at the given Y plane. renderOrder ensures overlays draw
// after the ground / buildings pass so they don't flicker.
function _buildPolygonMesh(polygons, y, material, renderOrder) {
  if (!polygons.length) return null;
  let total = 0;
  for (const tri of polygons) total += tri.length / 2;
  if (total === 0) return null;

  const positions = new Float32Array(total * 3);
  let o = 0;
  for (const tri of polygons) {
    for (let i = 0; i < tri.length; i += 2) {
      positions[o++] = tri[i];
      positions[o++] = y;
      positions[o++] = tri[i + 1];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = renderOrder;
  return mesh;
}

// Flat-mode wrapper around emitStreetTrisXZ (see ./streetGeometry.js): plants
// every vertex at the given Y plane. Terrain mode uses `_buildDrapedStreetMesh`
// instead, which runs the same tessellation inside osmWorker.js.
function _buildStreetMesh(streets, y, material, renderOrder) {
  if (!streets.length) return null;
  const xz = [];
  emitStreetTrisXZ(streets, xz);
  if (xz.length === 0) return null;
  const vertCount = xz.length / 2;
  const positions = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3    ] = xz[i * 2];
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = xz[i * 2 + 1];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = renderOrder;
  return mesh;
}

// (Canvas2D rasterisation helpers lived here — removed with the class-ID
// texture approach. If we ever want raster debug overlays again, pull
// _drawTriangleList / _drawStreets back from git.)

// Build (or fetch cached) flat ShapeGeometry for a street name. Glyphs come
// from the bundled typeface font so text stays sharp at any zoom — unlike a
// CanvasTexture, which ceilings out at its rasterized resolution.
function _getLabelAsset(name) {
  let entry = _labelCache.get(name);
  if (entry) return entry;

  const shapes = _font.generateShapes(name, 1.0);
  const geometry = new THREE.ShapeGeometry(shapes);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  // Capture extents in the glyph-native XY plane *before* transforming —
  // translate/rotate update boundingBox in place, and after rotateX the Y
  // extent collapses to the (zero) thickness of the flat shape.
  const width  = bb.max.x - bb.min.x;
  const height = bb.max.y - bb.min.y;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cy = (bb.min.y + bb.max.y) * 0.5;
  // Center the glyph run on origin, then lay it flat on XZ so +X runs along
  // the street direction and the label reads correctly when viewed top-down.
  geometry.translate(-cx, -cy, 0);
  geometry.rotateX(-Math.PI / 2);

  entry = { geometry, width, height };
  _labelCache.set(name, entry);
  return entry;
}

// For each named street, pick its longest segment and lay a flat label plane
// along it. One mesh per street — the material/texture come from the shared
// _labelCache, so repeat names across tiles add only geometry cost. Pushes
// each created mesh into `outLabels` (with its anchor XZ stamped on userData)
// so OsmManager.updateLabelVisibility can toggle them by player distance.
function _buildStreetLabels(streets, parentGroup, terrain, outLabels) {
  for (const s of streets) {
    if (!s.name) continue;
    const pts = s.points;
    if (!pts || pts.length < 2) continue;

    // Longest segment — we anchor the label on the straightest-looking piece
    // so the baseline lines up with the street rather than cutting a corner.
    let bestLen2 = 0;
    let bestIdx  = -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0];
      const dz = pts[i + 1][1] - pts[i][1];
      const len2 = dx * dx + dz * dz;
      if (len2 > bestLen2) { bestLen2 = len2; bestIdx = i; }
    }
    if (bestIdx < 0 || bestLen2 < MIN_LABELED_STREET_M * MIN_LABELED_STREET_M) continue;

    const p0  = pts[bestIdx];
    const p1  = pts[bestIdx + 1];
    const len = Math.sqrt(bestLen2);
    let dx = (p1[0] - p0[0]) / len;
    let dz = (p1[1] - p0[1]) / len;
    // Flip direction so text reads right (+X side). Without this, half the
    // labels in every tile would render upside-down when viewed north-up.
    if (dx < 0 || (dx === 0 && dz < 0)) { dx = -dx; dz = -dz; }

    const { geometry, width, height } = _getLabelAsset(s.name);
    // Target "LABEL_HEIGHT_M tall" as a base scale; shrink further if the
    // resulting run would overflow the segment.
    const baseScale = LABEL_HEIGHT_M / height;
    let scale = baseScale;
    const worldW = width * scale;
    if (worldW > len * 0.85) scale *= (len * 0.85) / worldW;
    if (scale / baseScale < MIN_LABEL_SCALE) continue;

    const mesh = new THREE.Mesh(geometry, LABEL_MAT);
    const cx = (p0[0] + p1[0]) * 0.5;
    const cz = (p0[1] + p1[1]) * 0.5;
    mesh.position.set(cx, drapeY(terrain, cx, cz, Y_STREET_LABEL), cz);
    mesh.rotation.y  = Math.atan2(-dz, dx);
    mesh.scale.set(scale, scale, scale);
    mesh.renderOrder = 4;
    mesh.userData.sharedGeometry = true;
    mesh.userData.anchorX = cx;
    mesh.userData.anchorZ = cz;
    parentGroup.add(mesh);
    outLabels.push(mesh);
  }
}
