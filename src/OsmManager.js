import * as THREE from 'three';

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

// Tiny Y stagger so layers don't z-fight. Ground is at y = 0.
const Y_WATER   = 0.02;
const Y_GREEN   = 0.03;
const Y_STREET  = 0.05;

// Shared materials — unlit so they read as "map paint" against the cel-shaded buildings.
const WATER_MAT = new THREE.MeshBasicMaterial({
  color:       0x7fb3d9,
  side:        THREE.DoubleSide,
  depthWrite:  false,
});
const GREEN_MAT = new THREE.MeshBasicMaterial({
  color:       0xbcd69c,
  side:        THREE.DoubleSide,
  depthWrite:  false,
});
const STREET_MAT = new THREE.MeshBasicMaterial({
  color:       0xe8dfc2,
  side:        THREE.DoubleSide,
  depthWrite:  false,
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
        id:     entry.id,
        file:   entry.file,
        bounds: entry.bounds,
        status: 'unloaded',
        group:  null, // THREE.Group of per-type meshes, added to _group on load
      };
      this._tiles.set(tile.id, tile);
      this._indexTile(tile);
    }

    this.tick(0, 0);
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

      const waterMesh = _buildPolygonMesh(data.water || [], Y_WATER, WATER_MAT);
      if (waterMesh) group.add(waterMesh);

      const greenMesh = _buildPolygonMesh(data.green || [], Y_GREEN, GREEN_MAT);
      if (greenMesh) group.add(greenMesh);

      const streetMesh = _buildStreetMesh(data.streets || [], Y_STREET, STREET_MAT);
      if (streetMesh) group.add(streetMesh);

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
        if (child.geometry) child.geometry.dispose();
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
// one BufferGeometry + Mesh at the given Y plane.
function _buildPolygonMesh(polygons, y, material) {
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
  mesh.renderOrder = 0;
  return mesh;
}

// Street polylines → extruded ribbon quads at the given Y plane.
function _buildStreetMesh(streets, y, material) {
  if (!streets.length) return null;

  // Count segments up front so we can size a typed array.
  let segCount = 0;
  for (const s of streets) if (s.points && s.points.length >= 2) segCount += s.points.length - 1;
  if (segCount === 0) return null;

  // 6 verts × 3 floats per segment (two triangles per ribbon rect).
  const positions = new Float32Array(segCount * 6 * 3);
  let o = 0;

  for (const s of streets) {
    const half = (TYPE_WIDTH[s.type] ?? DEFAULT_WIDTH) * 0.5;
    const pts  = s.points;
    if (!pts || pts.length < 2) continue;

    for (let i = 0; i < pts.length - 1; i++) {
      const x0 = pts[i][0],   z0 = pts[i][1];
      const x1 = pts[i + 1][0], z1 = pts[i + 1][1];
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len === 0) {
        // Zero-length segment — write degenerate triangles so we don't
        // shift the offset out of sync with segCount. Harmless to render.
        for (let k = 0; k < 18; k++) positions[o++] = 0;
        continue;
      }
      // Perpendicular in XZ plane × half-width.
      const nx = (-dz / len) * half;
      const nz = ( dx / len) * half;

      // Two triangles (v0, v1, v3) and (v0, v3, v2).
      //   v0 = p0 + n, v1 = p0 - n, v2 = p1 + n, v3 = p1 - n
      // Write tri 1
      positions[o++] = x0 + nx; positions[o++] = y; positions[o++] = z0 + nz;
      positions[o++] = x0 - nx; positions[o++] = y; positions[o++] = z0 - nz;
      positions[o++] = x1 - nx; positions[o++] = y; positions[o++] = z1 - nz;
      // Write tri 2
      positions[o++] = x0 + nx; positions[o++] = y; positions[o++] = z0 + nz;
      positions[o++] = x1 - nx; positions[o++] = y; positions[o++] = z1 - nz;
      positions[o++] = x1 + nx; positions[o++] = y; positions[o++] = z1 + nz;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 1; // after water/green
  return mesh;
}
