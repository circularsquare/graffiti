import * as THREE from 'three';
import { Font } from 'three/addons/loaders/FontLoader.js';
import fontData from 'three/examples/fonts/helvetiker_bold.typeface.json';

// Loaded when the player is within this distance of a tile's AABB edge.
const LOAD_RADIUS   = 300;
const UNLOAD_RADIUS = 400;

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

// Y stagger so layers don't z-fight. Ground is at y = 0; each overlay is a
// clear 5 cm above the previous so GPU depth precision at the horizon is
// still enough to keep them stacked correctly.
const Y_WATER        = 0.05;
const Y_GREEN        = 0.10;
const Y_STREET       = 0.15;
const Y_STREET_LABEL = 0.20;

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

// Shared materials — unlit so they read as "map paint" against the cel-shaded
// buildings. We keep depthWrite on: without it, the overlays sort
// unpredictably against the ground/building pass and flicker on/off for a
// frame as the player moves.
//
// polygonOffset biases each overlay's depth values toward the camera during
// rasterization so they reliably win the depth test against the ground plane
// even at far distances where perspective-depth precision collapses Y=0 and
// Y=0.15 into the same bucket. Larger offsets for layers further up the
// stack so water < green < streets stays consistent too.
const WATER_MAT = new THREE.MeshBasicMaterial({
  color:               0x7fb3d9,
  side:                THREE.DoubleSide,
  polygonOffset:       true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits:  -2,
});
const GREEN_MAT = new THREE.MeshBasicMaterial({
  color:               0xbcd69c,
  side:                THREE.DoubleSide,
  polygonOffset:       true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits:  -4,
});
const STREET_MAT = new THREE.MeshBasicMaterial({
  color:               0xefe6cc,
  side:                THREE.DoubleSide,
  polygonOffset:       true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits:  -6,
});

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
  constructor({ scene, group } = {}) {
    this._scene = scene;
    this._group = group ?? new THREE.Group();
    if (!group && scene) scene.add(this._group);

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

    const loadR2   = LOAD_RADIUS   ** 2;
    const unloadR2 = UNLOAD_RADIUS ** 2;

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

      const waterMesh = _buildPolygonMesh(data.water || [], Y_WATER, WATER_MAT, 1);
      if (waterMesh) group.add(waterMesh);

      const greenMesh = _buildPolygonMesh(data.green || [], Y_GREEN, GREEN_MAT, 2);
      if (greenMesh) group.add(greenMesh);

      const streetMesh = _buildStreetMesh(data.streets || [], Y_STREET, STREET_MAT, 3);
      if (streetMesh) group.add(streetMesh);

      _buildStreetLabels(data.streets || [], group);

      this._group.add(group);
      tile.group  = group;
      tile.status = 'loaded';
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
    if (tile.group) {
      for (const child of tile.group.children) {
        // Label geometry is shared across tiles via _labelCache — skip it.
        if (child.geometry && !child.userData.sharedGeometry) child.geometry.dispose();
      }
      this._group.remove(tile.group);
      tile.group = null;
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

// Flat XZ triangle lists (each entry is [x,z,x,z,x,z,...] for one polygon) →
// one BufferGeometry + Mesh at the given Y plane. `renderOrder` ensures the
// overlays always draw after the ground / buildings pass so they don't flicker.
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

  // Scratch arrays for per-vertex miter offsets; reused across streets.
  const offX = [];
  const offZ = [];

  for (const s of streets) {
    const width = TYPE_WIDTH[s.type] ?? DEFAULT_WIDTH;
    const half  = width * 0.5;
    // Each polyline's first/last vertex is pushed this far along the adjacent
    // segment so independent OSM ways meeting at an intersection overlap and
    // cover the butt-cap triangular gap at the corners.
    const endExtend = width * 0.1;
    const pts  = s.points;
    if (!pts || pts.length < 2) continue;
    const N = pts.length;
    offX.length = N;
    offZ.length = N;

    // Compute the miter offset (perpendicular × miter-length) at each vertex.
    // Tangent = normalized bisector of incoming+outgoing edges; miter length
    // = half / cos(bend/2) so the outer edge of the ribbon stays a consistent
    // width through the turn.
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

      // Bisector. At endpoints fall back to the single available direction.
      let tx, tz;
      if (hasIn && hasOut) { tx = inX + outX; tz = inZ + outZ; }
      else if (hasIn)      { tx = inX;        tz = inZ; }
      else                 { tx = outX;       tz = outZ; }
      const tlen = Math.hypot(tx, tz);
      if (tlen < 1e-6) {
        // 180° reversal (or degenerate) — fall back to outgoing perpendicular.
        tx = hasOut ? outX : inX;
        tz = hasOut ? outZ : inZ;
      } else {
        tx /= tlen; tz /= tlen;
      }
      // Left-hand perpendicular (90° CCW in XZ).
      const px = -tz, pz = tx;

      // Miter length scales with 1/cos(half_bend). Clamp to 4× half-width so
      // a near-180° turn doesn't produce a spike off to infinity.
      let miter = half;
      if (hasIn && hasOut) {
        const inPx = -inZ, inPz = inX;   // perpendicular of incoming edge
        const c = px * inPx + pz * inPz; // cos(half_bend); sign = which side
        if (Math.abs(c) > 0.2) miter = half / c;
        else                   miter = (c >= 0 ? 4 : -4) * half;
      }
      const maxMiter = 4 * half;
      if (miter >  maxMiter) miter =  maxMiter;
      if (miter < -maxMiter) miter = -maxMiter;

      offX[i] = px * miter;
      offZ[i] = pz * miter;
    }

    // Emit two triangles per segment using the shared miter offsets at both ends.
    for (let i = 0; i < N - 1; i++) {
      let x0 = pts[i][0],     z0 = pts[i][1];
      let x1 = pts[i + 1][0], z1 = pts[i + 1][1];
      // Extend the first vertex backward along its outgoing segment, and the
      // last vertex forward along its incoming segment. Offsets are unchanged
      // because they depend only on direction, not position.
      if (i === 0) {
        const dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) {
          x0 -= (dx / len) * endExtend;
          z0 -= (dz / len) * endExtend;
        }
      }
      if (i + 1 === N - 1) {
        const dx = pts[N - 1][0] - pts[N - 2][0], dz = pts[N - 1][1] - pts[N - 2][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) {
          x1 += (dx / len) * endExtend;
          z1 += (dz / len) * endExtend;
        }
      }
      const o0x = offX[i],     o0z = offZ[i];
      const o1x = offX[i + 1], o1z = offZ[i + 1];

      // tri 1: (p0 + o0), (p0 − o0), (p1 − o1)
      positions[o++] = x0 + o0x; positions[o++] = y; positions[o++] = z0 + o0z;
      positions[o++] = x0 - o0x; positions[o++] = y; positions[o++] = z0 - o0z;
      positions[o++] = x1 - o1x; positions[o++] = y; positions[o++] = z1 - o1z;

      // tri 2: (p0 + o0), (p1 − o1), (p1 + o1)
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
function _buildStreetLabels(streets, parentGroup) {
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
    mesh.position.set((p0[0] + p1[0]) * 0.5, Y_STREET_LABEL, (p0[1] + p1[1]) * 0.5);
    mesh.rotation.y  = Math.atan2(-dz, dx);
    mesh.scale.set(scale, scale, scale);
    mesh.renderOrder = 4;
    mesh.userData.sharedGeometry = true;
    parentGroup.add(mesh);
  }
}
