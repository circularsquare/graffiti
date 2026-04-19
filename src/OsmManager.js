import * as THREE from 'three';
import { Font } from 'three/addons/loaders/FontLoader.js';
import fontData from 'three/examples/fonts/helvetiker_bold.typeface.json';

// Default load radius used when the caller doesn't pass a getLoadRadius()
// function (fallback path if TileManager hasn't wired itself up yet).
const DEFAULT_LOAD_RADIUS   = 650;
const DEFAULT_UNLOAD_RADIUS = 750;

// Scale factor applied to the building-tile load radius to get the OSM load
// radius. OSM tiles are cheap (flat meshes, no paint), so we lean long so
// streets/water already exist the moment buildings pop in.
const OSM_RADIUS_SCALE = 1.5;
// Minimum OSM load radius — decoupled from buildings so the LAND-vs-void
// boundary falls into fog even in dense areas where building radius is at
// its MIN_LOAD_RADIUS (200 m). Without this, dense areas would show a hard
// ring of OSM coverage only ~300 m away (200 × 1.5).
const OSM_MIN_LOAD_RADIUS = 650;
// Extra metres before an OSM tile unloads past its load radius — mirrors
// TileManager's hysteresis so we don't thrash at the boundary.
const OSM_UNLOAD_MARGIN = 100;

// Spatial index grid — mirrors TileManager's scheme.
const COARSE_GRID  = 500;
const COARSE_REACH = 2;

const MAX_CONCURRENT_LOADS = 3;

// Approximate road width (metres) per OSM `highway` value. Defaults for
// anything unlisted is DEFAULT_WIDTH.
const TYPE_WIDTH = {
  motorway: 11, motorway_link: 8,
  trunk: 10,    trunk_link: 7,
  primary: 9,   primary_link: 6,
  secondary: 8, secondary_link: 5,
  tertiary: 7,  tertiary_link: 5,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  service: 4,
  pedestrian: 4,
  footway: 2.5,
  cycleway: 2.5,
  path: 2,
  steps: 2,
  track: 3,
};
const DEFAULT_WIDTH = 5;

// Y stagger for the flat-mode mesh stack — unused in terrain mode (the
// canvas texture composites into the terrain shader instead).
const Y_LAND         = 0.02;
const Y_WATER        = 0.05;
const Y_GREEN        = 0.10;
const Y_STREET       = 0.15;
const Y_STREET_LABEL = 0.20;

// Canvas resolution for each tile's OSM raster (terrain mode only).
// 250 m / 512 px ≈ 0.49 m/px — plenty sharp for streets and polygon edges
// without ballooning VRAM. ~40 active tiles × 512² × 4 B ≈ 40 MB.
const TILE_TEXTURE_SIZE = 512;

// Overlay colours. CSS strings for Canvas2D raster (terrain mode);
// mirrored as THREE.Color values on the mesh materials below (flat mode).
const LAND_COLOR   = '#c4b9a2';
const WATER_COLOR  = '#7fb3d9';
const GREEN_COLOR  = '#bcd69c';
const STREET_COLOR = '#efe6cc';

// Shared materials for the flat-mode mesh stack. polygonOffset biases each
// overlay's depth toward the camera so it wins the depth test against the
// flat ground plane even at horizon distances. Larger units further up the
// stack so water < green < streets stays consistent.
const LAND_MAT = new THREE.MeshBasicMaterial({
  color: 0xc4b9a2, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
const WATER_MAT = new THREE.MeshBasicMaterial({
  color: 0x7fb3d9, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
});
const GREEN_MAT = new THREE.MeshBasicMaterial({
  color: 0xbcd69c, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
});
const STREET_MAT = new THREE.MeshBasicMaterial({
  color: 0xefe6cc, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6,
});

// Street-label tuning. Labels are built from real font glyph outlines via
// ShapeGeometry so they stay crisp at any viewing distance — no texture,
// no resolution ceiling.
const LABEL_HEIGHT_M        = 2.5;
const MIN_LABELED_STREET_M  = 40;   // don't bother labelling tiny service stubs
const MIN_LABEL_SCALE       = 0.45; // drop labels that would shrink below this to fit

const _font = new Font(fontData);

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
 * Loads OSM "map overlay" tiles (streets, water, green) on the same 250 m grid
 * as building tiles, and renders them as flat meshes at ground level.
 *
 * Each tile renders up to three meshes (streets / water / green), grouped
 * under a single Three.js Group passed in by the caller.
 *
 * Polygons (water, green) may extend past their assigned cell's AABB because
 * we assign by the bbox of the full polygon — that's intentional. The load
 * radius (300 m) is wider than the cell size (250 m) so every polygon that
 * would be visible near the player has its tile loaded, and adjacent tiles
 * stay loaded well past the cell boundary thanks to the unload hysteresis.
 */
export class OsmManager {
  constructor({ scene, group, getLoadRadius, terrain, flatMode, onTileReady, onTileUnready } = {}) {
    this._scene = scene;
    this._group = group ?? new THREE.Group();
    if (!group && scene) scene.add(this._group);
    // Optional: function returning the building-tile load radius in metres.
    // When provided, OSM radius tracks it (scaled by OSM_RADIUS_SCALE) so
    // streets/water adapt to the same sparsity signal as buildings.
    this._getLoadRadius = getLoadRadius ?? null;

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

    this._tiles        = new Map();           // tileId → TileState
    this._spatialIndex = new Map();           // "gx,gz" → Tile[]
    this._loadQueue    = [];
    this._activeLoads  = 0;
    this._lastPx       = 0;
    this._lastPz       = 0;

    // Raw streets cache for random-spawn sampling. Stores the in-flight Promise
    // so two concurrent callers share one fetch; resolved value replaces it.
    this._streetsCache = new Map();           // tileId → Array<street> | Promise
  }

  async init(manifestUrl = '/osm/manifest.json') {
    let entries;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = await res.json();
    } catch (e) {
      console.warn(`OsmManager: manifest not found (${e.message}) — skipping OSM overlay`);
      return;
    }

    for (const entry of entries) {
      const tile = {
        id:          entry.id,
        file:        entry.file,
        bounds:      entry.bounds,
        streetCount: entry.streetCount ?? 0,
        status:      'unloaded',
        group:       null, // THREE.Group of per-type meshes, added to _group on load
      };
      this._tiles.set(tile.id, tile);
      this._indexTile(tile);
    }

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
      const res = await fetch(tile.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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

    const loadR = this._getLoadRadius
      ? Math.max(OSM_MIN_LOAD_RADIUS, this._getLoadRadius() * OSM_RADIUS_SCALE)
      : DEFAULT_LOAD_RADIUS;
    const unloadR = this._getLoadRadius
      ? loadR + OSM_UNLOAD_MARGIN
      : DEFAULT_UNLOAD_RADIUS;
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
    for (let dx = -COARSE_REACH; dx <= COARSE_REACH; dx++) {
      for (let dz = -COARSE_REACH; dz <= COARSE_REACH; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          const d2 = _closestDist2(px, pz, tile.bounds);
          if (tile.status === 'unloaded' && d2 < loadR2) this._enqueueLoad(tile);
          else if (tile.status === 'loaded' && d2 > unloadR2) this._unload(tile);
        }
      }
    }
  }

  _enqueueLoad(tile) {
    tile.status = 'loading';
    if (this._activeLoads < MAX_CONCURRENT_LOADS) this._doLoad(tile);
    else this._loadQueue.push(tile);
  }

  async _doLoad(tile) {
    this._activeLoads++;
    try {
      const res = await fetch(tile.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const group = new THREE.Group();
      _buildStreetLabels(data.streets || [], group, this._terrain);

      if (this._flatMode) {
        // Pre-terrain rendering path: flat stacked meshes at Y_LAND..Y_STREET.
        // Used when terrain is disabled (`VITE_TERRAIN=0`) so no canvas
        // texture or terrain shader is needed.
        group.add(_buildLandMesh(tile.bounds));
        const water = _buildPolygonMesh(data.water  || [], Y_WATER,  WATER_MAT,  1);
        if (water)   group.add(water);
        const green = _buildPolygonMesh(data.green  || [], Y_GREEN,  GREEN_MAT,  2);
        if (green)   group.add(green);
        const streets = _buildStreetMesh(data.streets || [], Y_STREET, STREET_MAT, 3);
        if (streets) group.add(streets);
      } else {
        // Terrain mode: rasterise features to a top-down canvas; the terrain
        // shader samples it per-fragment so no overlay geometry is needed.
        const canvas  = _rasterizeTile(tile.bounds, data);
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS     = THREE.ClampToEdgeWrapping;
        texture.wrapT     = THREE.ClampToEdgeWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.flipY     = false; // canvas row 0 = minZ, matches shader uv.y=0
        tile.texture = texture;
      }

      if (group.children.length > 0) {
        this._group.add(group);
        tile.group = group;
      }

      tile.status = 'loaded';
      if (this._onTileReady) this._onTileReady(tile);
    } catch (e) {
      console.error(`OsmManager: failed to load ${tile.id}:`, e);
      tile.status = 'unloaded';
    } finally {
      this._drainQueue();
    }
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
    if (tile.group) {
      for (const child of tile.group.children) {
        // Label geometry is shared via _labelCache; all overlay materials
        // (LAND_MAT / WATER_MAT / GREEN_MAT / STREET_MAT / LABEL_MAT) are
        // shared too. Only per-tile geometry gets disposed here.
        if (child.geometry && !child.userData.sharedGeometry) child.geometry.dispose();
      }
      this._group.remove(tile.group);
      tile.group = null;
    }
    if (tile.texture) {
      tile.texture.dispose();
      tile.texture = null;
    }
    tile.status = 'unloaded';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _closestDist2(px, pz, b) {
  const cx = Math.max(b.minX, Math.min(px, b.maxX));
  const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

// Sample the terrain at (x, z) and add the overlay's stack offset. If the
// covering terrain tile hasn't loaded yet, return offset directly — the
// mesh will drape later as tiles stream in (for now, rebuild-on-ready isn't
// wired, so the vertex sits at y=offset until the OSM tile itself reloads).
function drapeY(terrain, x, z, offset) {
  if (!terrain) return offset;
  const t = terrain.sample(x, z);
  return (t !== null ? t : 0) + offset;
}

// ── Tile rasterisation ────────────────────────────────────────────────────────
//
// Rasterise one OSM tile's features to a top-down Canvas2D. Order matters:
// LAND fills the whole canvas first (opaque), then water + green polygons
// overdraw where they exist, then streets stroke on top. The resulting
// CanvasTexture is sampled by the terrain shader at each terrain fragment's
// world XZ, so coordinates in this function correspond 1:1 to the terrain
// surface underneath — no polygon offsets, no z-fighting.

function _rasterizeTile(bounds, data) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const SIZE = TILE_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // World XZ → canvas pixel coords (flipY=false on the texture, so row 0 is
  // minZ, row N is maxZ).
  const sx = SIZE / w;
  const sz = SIZE / d;
  const wx2px = (x) => (x - minX) * sx;
  const wz2py = (z) => (z - minZ) * sz;

  // LAND base — opaque fill makes the tile read as "inside OSM coverage"
  // wherever water/green/streets aren't drawn on top.
  ctx.fillStyle = LAND_COLOR;
  ctx.fillRect(0, 0, SIZE, SIZE);

  if (data.water && data.water.length) {
    ctx.fillStyle = WATER_COLOR;
    _drawTriangleList(ctx, data.water, wx2px, wz2py);
  }

  if (data.green && data.green.length) {
    ctx.fillStyle = GREEN_COLOR;
    _drawTriangleList(ctx, data.green, wx2px, wz2py);
  }

  if (data.streets && data.streets.length) {
    _drawStreets(ctx, data.streets, wx2px, wz2py, sx);
  }

  return canvas;
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

// Street polylines → extruded ribbon with miter joins at each interior vertex.
// Without joins, adjacent rectangles leave V-shaped gaps on the outside of a
// turn — very visible on curved roads approximated by short straight segments.
function _buildStreetMesh(streets, y, material, renderOrder) {
  if (!streets.length) return null;

  let segCount = 0;
  for (const s of streets) if (s.points && s.points.length >= 2) segCount += s.points.length - 1;
  if (segCount === 0) return null;

  // 2 triangles × 3 verts × 3 floats per segment. Miter joins still produce
  // exactly 2 tris per segment — they just shift the shared vertex outward.
  const positions = new Float32Array(segCount * 18);
  let o = 0;
  const offX = [];
  const offZ = [];

  for (const s of streets) {
    const width = TYPE_WIDTH[s.type] ?? DEFAULT_WIDTH;
    const half  = width * 0.5;
    const endExtend = width * 0.1;
    const pts  = s.points;
    if (!pts || pts.length < 2) continue;
    const N = pts.length;
    offX.length = N;
    offZ.length = N;

    for (let i = 0; i < N; i++) {
      let inX = 0,  inZ = 0;
      let outX = 0, outZ = 0;
      let hasIn = false, hasOut = false;
      if (i > 0) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dz = pts[i][1] - pts[i - 1][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { inX = dx / len; inZ = dz / len; hasIn = true; }
      }
      if (i < N - 1) {
        const dx = pts[i + 1][0] - pts[i][0];
        const dz = pts[i + 1][1] - pts[i][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { outX = dx / len; outZ = dz / len; hasOut = true; }
      }

      let tx, tz;
      if (hasIn && hasOut) { tx = inX + outX; tz = inZ + outZ; }
      else if (hasIn)      { tx = inX;        tz = inZ; }
      else                 { tx = outX;       tz = outZ; }
      const tlen = Math.hypot(tx, tz);
      if (tlen < 1e-6) {
        tx = hasOut ? outX : inX;
        tz = hasOut ? outZ : inZ;
      } else {
        tx /= tlen; tz /= tlen;
      }
      const px = -tz, pz = tx;

      let miter = half;
      if (hasIn && hasOut) {
        const inPx = -inZ, inPz = inX;
        const c = px * inPx + pz * inPz;
        if (Math.abs(c) > 0.2) miter = half / c;
        else                   miter = (c >= 0 ? 4 : -4) * half;
      }
      const maxMiter = 4 * half;
      if (miter >  maxMiter) miter =  maxMiter;
      if (miter < -maxMiter) miter = -maxMiter;

      offX[i] = px * miter;
      offZ[i] = pz * miter;
    }

    for (let i = 0; i < N - 1; i++) {
      let x0 = pts[i][0],     z0 = pts[i][1];
      let x1 = pts[i + 1][0], z1 = pts[i + 1][1];
      if (i === 0) {
        const dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { x0 -= (dx / len) * endExtend; z0 -= (dz / len) * endExtend; }
      }
      if (i + 1 === N - 1) {
        const dx = pts[N - 1][0] - pts[N - 2][0], dz = pts[N - 1][1] - pts[N - 2][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { x1 += (dx / len) * endExtend; z1 += (dz / len) * endExtend; }
      }
      const o0x = offX[i],     o0z = offZ[i];
      const o1x = offX[i + 1], o1z = offZ[i + 1];

      positions[o++] = x0 + o0x; positions[o++] = y; positions[o++] = z0 + o0z;
      positions[o++] = x0 - o0x; positions[o++] = y; positions[o++] = z0 - o0z;
      positions[o++] = x1 - o1x; positions[o++] = y; positions[o++] = z1 - o1z;

      positions[o++] = x0 + o0x; positions[o++] = y; positions[o++] = z0 + o0z;
      positions[o++] = x1 - o1x; positions[o++] = y; positions[o++] = z1 - o1z;
      positions[o++] = x1 + o1x; positions[o++] = y; positions[o++] = z1 + o1z;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = renderOrder;
  return mesh;
}

function _drawTriangleList(ctx, polygons, wx2px, wz2py) {
  for (const flat of polygons) {
    for (let i = 0; i < flat.length; i += 6) {
      ctx.beginPath();
      ctx.moveTo(wx2px(flat[i]),     wz2py(flat[i + 1]));
      ctx.lineTo(wx2px(flat[i + 2]), wz2py(flat[i + 3]));
      ctx.lineTo(wx2px(flat[i + 4]), wz2py(flat[i + 5]));
      ctx.closePath();
      ctx.fill();
    }
  }
}

function _drawStreets(ctx, streets, wx2px, wz2py, pxPerM) {
  ctx.strokeStyle = STREET_COLOR;
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  for (const s of streets) {
    const pts = s.points;
    if (!pts || pts.length < 2) continue;
    const width = TYPE_WIDTH[s.type] ?? DEFAULT_WIDTH;
    ctx.lineWidth = Math.max(1, width * pxPerM);
    ctx.beginPath();
    ctx.moveTo(wx2px(pts[0][0]), wz2py(pts[0][1]));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(wx2px(pts[i][0]), wz2py(pts[i][1]));
    }
    ctx.stroke();
  }
}

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
// _labelCache, so repeat names across tiles add only geometry cost.
function _buildStreetLabels(streets, parentGroup, terrain) {
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
    parentGroup.add(mesh);
  }
}
