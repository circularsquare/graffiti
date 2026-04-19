import * as THREE from 'three';

// Terrain streams per-cell heightmaps from public/terrain/cell_{gx}_{gz}.json.
// Unlike building / OSM tiles we don't download a manifest — cells live on a
// uniform 125 m grid with deterministic URLs, and we treat a 404 as "no
// terrain for this cell" and cache the miss. Saves ~10 MB of startup download
// plus the 55 K-entry spatial index build.
//
// See scripts/bake_terrain.py for the emit side.

// Must match scripts/bake_terrain.py::GRID_SIZE.
const CELL_SIZE = 125;

// NODATA sentinel from bake_terrain.py. Samples with this value sat outside
// DEM coverage; we render them at 0 m (close to NAVD88 sea level) so the
// mesh stays closed — the alternative is a crater.
const NODATA_CM = -32768;

const DEFAULT_LOAD_RADIUS     = 650;
const TERRAIN_RADIUS_SCALE    = 1.5;
const TERRAIN_MIN_LOAD_RADIUS = 650;
const TERRAIN_UNLOAD_MARGIN   = 100;

// Terrain tiles are small (~4 KB) and the mesh build is trivial, so we keep
// more in flight than the building/OSM pipelines (which pay worker round-trips
// + multi-megabyte parses per load).
const MAX_CONCURRENT_LOADS = 6;

// Base colour for the "outside OSM coverage" terrain surface (matches the
// main.js FLOOR_Y ground). Inside coverage, the OSM canvas is sampled in
// the fragment shader and composited over this colour.
const TERRAIN_COLOR = 0x9b9b9e;

// 1×1 fully-transparent placeholder used before a tile's covering OSM
// texture is available. alpha=0 means the shader's mix(terrain, osm, a)
// leaves terrain colour untouched.
const EMPTY_OSM_TEXTURE = (() => {
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
})();

// Shared onBeforeCompile for every terrain material. Each material carries
// its own uniforms on userData — the shader program is shared across all
// tiles (via customProgramCacheKey), the uniform values differ per tile.
const _onTerrainCompile = function (shader) {
  const u = this.userData.uniforms;
  shader.uniforms.uOsmMap      = u.uOsmMap;
  shader.uniforms.uOsmOriginXZ = u.uOsmOriginXZ;
  shader.uniforms.uOsmSizeXZ   = u.uOsmSizeXZ;

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>',
      '#include <common>\nvarying vec3 vWorldPosT;')
    .replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvWorldPosT = (modelMatrix * vec4(position, 1.0)).xyz;');

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>',
      `#include <common>
       uniform sampler2D uOsmMap;
       uniform vec2 uOsmOriginXZ;
       uniform vec2 uOsmSizeXZ;
       varying vec3 vWorldPosT;`)
    .replace('#include <map_fragment>',
      `#include <map_fragment>
       float osmAlpha = 0.0;
       vec2 osmUV = (vWorldPosT.xz - uOsmOriginXZ) / uOsmSizeXZ;
       if (osmUV.x >= 0.0 && osmUV.x <= 1.0 && osmUV.y >= 0.0 && osmUV.y <= 1.0) {
         vec4 osm = texture2D(uOsmMap, osmUV);
         diffuseColor.rgb = mix(diffuseColor.rgb, osm.rgb, osm.a);
         osmAlpha = osm.a;
       }
       // Hydroflat water fallback: NYC rivers/harbours are always -1.34 m in
       // the DEM. Anywhere below -0.5 m that the OSM canvas didn't cover is
       // essentially sea level — tint it water-blue so rivers read as water
       // even outside the OSM coverage radius.
       if (osmAlpha < 0.5 && vWorldPosT.y < -0.5) {
         diffuseColor.rgb = vec3(0.498, 0.702, 0.851);
       }`);
};

function _createTerrainMaterial() {
  const mat = new THREE.MeshLambertMaterial({
    color: TERRAIN_COLOR,
    side:  THREE.FrontSide,
  });
  mat.userData.uniforms = {
    uOsmMap:      { value: EMPTY_OSM_TEXTURE },
    uOsmOriginXZ: { value: new THREE.Vector2(0, 0) },
    uOsmSizeXZ:   { value: new THREE.Vector2(1, 1) },
  };
  mat.onBeforeCompile = _onTerrainCompile;
  // Shared program cache key — every terrain tile compiles once, reuses.
  mat.customProgramCacheKey = () => 'graffiti-terrain-osm';
  return mat;
}

function _applyOsmToMaterial(mat, osmTile) {
  const u = mat.userData.uniforms;
  const b = osmTile.bounds;
  u.uOsmMap.value = osmTile.texture;
  u.uOsmOriginXZ.value.set(b.minX, b.minZ);
  u.uOsmSizeXZ.value.set(b.maxX - b.minX, b.maxZ - b.minZ);
}

function _clearOsmFromMaterial(mat) {
  mat.userData.uniforms.uOsmMap.value = EMPTY_OSM_TEXTURE;
}

// Cell state in `_cells`:
//   undefined  — never attempted
//   'loading'  — fetch in flight
//   'empty'    — 404, don't retry
//   object     — { mesh, samples, res, bounds }

export class TerrainManager {
  constructor({ scene, group, getLoadRadius, osmLookup } = {}) {
    this._scene = scene;
    this._group = group ?? new THREE.Group();
    if (!group && scene) scene.add(this._group);
    this._getLoadRadius = getLoadRadius ?? null;
    // Optional: (x, z) → OSM tile or null. Used at terrain-tile load time
    // to wire up the tile's material with the covering OSM texture. Live
    // OSM load/unload events go through applyOsmTile / removeOsmTile.
    this._osmLookup = osmLookup ?? null;

    this._cells       = new Map();    // "gx,gz" → state
    this._loadQueue   = [];           // [{ gx, gz, key }, …]
    this._activeLoads = 0;
    this._lastPx      = 0;
    this._lastPz      = 0;
  }

  tick(px, pz) {
    this._lastPx = px; this._lastPz = pz;

    const loadR = this._getLoadRadius
      ? Math.max(TERRAIN_MIN_LOAD_RADIUS, this._getLoadRadius() * TERRAIN_RADIUS_SCALE)
      : DEFAULT_LOAD_RADIUS;
    const unloadR  = loadR + TERRAIN_UNLOAD_MARGIN;
    const loadR2   = loadR   * loadR;
    const unloadR2 = unloadR * unloadR;

    const minGx = Math.floor((px - loadR) / CELL_SIZE);
    const maxGx = Math.floor((px + loadR) / CELL_SIZE);
    const minGz = Math.floor((pz - loadR) / CELL_SIZE);
    const maxGz = Math.floor((pz + loadR) / CELL_SIZE);

    // Enqueue any in-range cell we haven't tried yet.
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gz = minGz; gz <= maxGz; gz++) {
        if (_cellDist2(px, pz, gx, gz) >= loadR2) continue;
        const key = `${gx},${gz}`;
        if (this._cells.has(key)) continue;
        this._enqueueLoad(gx, gz, key);
      }
    }

    // Drop queued loads that drifted out of range while waiting.
    if (this._loadQueue.length > 0) {
      for (let i = this._loadQueue.length - 1; i >= 0; i--) {
        const q = this._loadQueue[i];
        if (_cellDist2(px, pz, q.gx, q.gz) > unloadR2) {
          this._cells.delete(q.key);
          this._loadQueue.splice(i, 1);
        }
      }
    }

    // Unload loaded cells that are now far. Also prune 'empty' entries so
    // we don't carry them forever — if the player comes back we can re-404
    // once and recache.
    for (const [key, state] of this._cells) {
      if (state === 'loading') continue;
      const [gx, gz] = _parseKey(key);
      if (_cellDist2(px, pz, gx, gz) <= unloadR2) continue;
      if (state === 'empty') {
        this._cells.delete(key);
      } else if (state && state.mesh) {
        this._group.remove(state.mesh);
        state.mesh.geometry.dispose();
        state.mesh.material.dispose();
        this._cells.delete(key);
        // Neighbours previously saw this tile as context for edge
        // smoothing; re-smooth them so their borders don't freeze with
        // stale data. Clamping kicks in for the side that just unloaded.
        for (const [dx, dz] of _NEIGHBOUR_OFFSETS) {
          this._rebuildSmoothed(gx + dx, gz + dz);
        }
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
      const res = await fetch(`/terrain/cell_${gx}_${gz}.json`);
      // Vite's dev server serves /index.html for missing files (200 OK
      // with text/html). Treat a non-JSON content-type and true 404s as
      // "no terrain here" — cache and don't retry.
      const ct = res.headers.get('content-type') || '';
      if (res.status === 404 || !ct.includes('json')) {
        this._cells.set(key, 'empty');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rawSamples = Int16Array.from(data.samples);
      fillNoData(rawSamples, data.res); // local neighbor-fill so gaps don't punch holes to y=0
      // Mesh starts with raw Y values; _rebuildSmoothed will overwrite with
      // the neighbour-padded Gaussian result right below.
      const mesh   = buildTerrainMesh(gx, gz, data.res, rawSamples);
      this._group.add(mesh);
      const bounds = _cellBounds(gx, gz);
      const state = {
        mesh,
        rawSamples,
        samples:    rawSamples.slice(), // smoothed values overwrite below
        res:        data.res,
        bounds,
        osmTileId:  null,
      };
      this._cells.set(key, state);

      // Smooth this tile with any already-loaded neighbour context, then
      // re-smooth each cardinal+corner neighbour so their edges pick up the
      // new data coming from this tile.
      this._rebuildSmoothed(gx, gz);
      for (const [dx, dz] of _NEIGHBOUR_OFFSETS) {
        this._rebuildSmoothed(gx + dx, gz + dz);
      }

      // If the covering OSM tile is already loaded, wire up the texture now.
      // Otherwise applyOsmTile will fire when it finishes.
      if (this._osmLookup) {
        const cx = (bounds.minX + bounds.maxX) * 0.5;
        const cz = (bounds.minZ + bounds.maxZ) * 0.5;
        const osmTile = this._osmLookup(cx, cz);
        if (osmTile) {
          _applyOsmToMaterial(mesh.material, osmTile);
          state.osmTileId = osmTile.id;
        }
      }
    } catch (e) {
      console.error(`TerrainManager: failed to load cell ${gx},${gz}:`, e);
      this._cells.delete(key); // allow retry on next tick
    } finally {
      this._activeLoads--;
      this._drainQueue();
    }
  }

  _drainQueue() {
    while (this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length > 0) {
      // Pop nearest-to-player first.
      let bestI = 0;
      let bestD2 = _cellDist2(this._lastPx, this._lastPz,
                              this._loadQueue[0].gx, this._loadQueue[0].gz);
      for (let i = 1; i < this._loadQueue.length; i++) {
        const q = this._loadQueue[i];
        const d2 = _cellDist2(this._lastPx, this._lastPz, q.gx, q.gz);
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
      const { gx, gz, key } = this._loadQueue.splice(bestI, 1)[0];
      this._doLoad(gx, gz, key);
    }
  }

  /**
   * Called by OsmManager when an OSM tile finishes loading. Every terrain
   * cell whose centre falls inside the OSM tile's bounds gets its material
   * rewired to sample the new texture.
   */
  applyOsmTile(osmTile) {
    const ob = osmTile.bounds;
    for (const state of this._cells.values()) {
      if (!state || typeof state !== 'object' || !state.mesh) continue;
      const b = state.bounds;
      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;
      if (cx >= ob.minX && cx < ob.maxX && cz >= ob.minZ && cz < ob.maxZ) {
        _applyOsmToMaterial(state.mesh.material, osmTile);
        state.osmTileId = osmTile.id;
      }
    }
  }

  /** Called before an OSM tile unloads; clears the texture from terrain materials. */
  removeOsmTile(osmTile) {
    for (const state of this._cells.values()) {
      if (!state || typeof state !== 'object') continue;
      if (state.osmTileId === osmTile.id) {
        _clearOsmFromMaterial(state.mesh.material);
        state.osmTileId = null;
      }
    }
  }

  /**
   * Re-run the Gaussian smoothing for a loaded tile using the 8 neighbour
   * tiles' raw samples for the padding strip — so the kernel spans the
   * tile boundary instead of clamping at it. Called on any tile load /
   * unload that could change the context around (gx, gz). Cheap (~10K
   * ops per tile) so we fire it for every neighbour unconditionally.
   */
  _rebuildSmoothed(gx, gz) {
    const state = this._cells.get(`${gx},${gz}`);
    if (!state || typeof state !== 'object' || !state.mesh) return;

    const res  = state.res;
    const raw  = state.rawSamples;
    const PAD  = 2;
    const pRes = res + 2 * PAD;
    const padded = new Float32Array(pRes * pRes);

    const getRaw = (dx, dz) => {
      const s = this._cells.get(`${gx + dx},${gz + dz}`);
      return (s && typeof s === 'object' && s.rawSamples) ? s.rawSamples : null;
    };
    const NW = getRaw(-1, -1), N  = getRaw(0, -1), NE = getRaw( 1, -1);
    const W  = getRaw(-1,  0),                     E  = getRaw( 1,  0);
    const SW = getRaw(-1,  1), S  = getRaw(0,  1), SE = getRaw( 1,  1);

    for (let pz = 0; pz < pRes; pz++) {
      for (let px = 0; px < pRes; px++) {
        padded[pz * pRes + px] = _lookupWithNeighbours(
          raw, res, px - PAD, pz - PAD, W, E, N, S, NW, NE, SW, SE,
        );
      }
    }

    // Separable 5-tap Gaussian over the padded buffer.
    const tmp = new Float32Array(padded.length);
    for (let iz = 0; iz < pRes; iz++) {
      for (let ix = 0; ix < pRes; ix++) {
        let sum = 0, w = 0;
        for (let k = 0; k < 5; k++) {
          const nx = ix + k - 2;
          if (nx < 0 || nx >= pRes) continue;
          sum += padded[iz * pRes + nx] * _GAUSS[k];
          w   += _GAUSS[k];
        }
        tmp[iz * pRes + ix] = sum / w;
      }
    }
    for (let iz = 0; iz < pRes; iz++) {
      for (let ix = 0; ix < pRes; ix++) {
        let sum = 0, w = 0;
        for (let k = 0; k < 5; k++) {
          const nz = iz + k - 2;
          if (nz < 0 || nz >= pRes) continue;
          sum += tmp[nz * pRes + ix] * _GAUSS[k];
          w   += _GAUSS[k];
        }
        padded[iz * pRes + ix] = sum / w;
      }
    }

    // Write the center back to the mesh's position attribute.
    const geom = state.mesh.geometry;
    const pos  = geom.attributes.position.array;
    const smoothed = state.samples;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const v = Math.round(padded[(iz + PAD) * pRes + (ix + PAD)]);
        smoothed[iz * res + ix] = v;
        pos[(iz * res + ix) * 3 + 1] = _decode(v);
      }
    }

    // Edge matching: the mesh stretches cell-centred samples to span the
    // full cell bounds, so tile A's rightmost vertex sits at the cell
    // boundary but carries a Y value sampled 2 m *inside* A, while tile B's
    // leftmost vertex does the same on its side. Smoothing alone can't
    // close that gap because each side's kernel is centred at a different
    // world position. Here we overwrite shared-edge vertices with a
    // deterministic average of both tiles' raw samples — identical formula
    // on both sides so the seam closes to the bit. Raw (not smoothed) so
    // we don't depend on neighbour propagation order.
    const setY = (ix, iz, cm) => {
      smoothed[iz * res + ix] = cm;
      pos[(iz * res + ix) * 3 + 1] = _decode(cm);
    };
    // 4-tap kernel [1, 4, 4, 1] / 10 centred on the shared boundary. Uses
    // two samples from each tile (nearest + one interior step). Weighted
    // like the interior Gaussian so the edge-to-interior transition is
    // smooth, while remaining a deterministic formula over raw samples so
    // both tiles' edge vertices meet exactly.
    const edgeK = (a1, a2, b1, b2) => Math.round((a1 + 4 * a2 + 4 * b1 + b2) / 10);
    if (W) {
      for (let iz = 0; iz < res; iz++) {
        setY(0, iz, edgeK(
          W  [iz * res + res - 2], W  [iz * res + res - 1],
          raw[iz * res + 0      ], raw[iz * res + 1      ],
        ));
      }
    }
    if (E) {
      for (let iz = 0; iz < res; iz++) {
        setY(res - 1, iz, edgeK(
          raw[iz * res + res - 2], raw[iz * res + res - 1],
          E  [iz * res + 0      ], E  [iz * res + 1      ],
        ));
      }
    }
    if (N) {
      for (let ix = 0; ix < res; ix++) {
        setY(ix, 0, edgeK(
          N  [(res - 2) * res + ix], N  [(res - 1) * res + ix],
          raw[ 0        * res + ix], raw[ 1        * res + ix],
        ));
      }
    }
    if (S) {
      for (let ix = 0; ix < res; ix++) {
        setY(ix, res - 1, edgeK(
          raw[(res - 2) * res + ix], raw[(res - 1) * res + ix],
          S  [ 0        * res + ix], S  [ 1        * res + ix],
        ));
      }
    }
    // Corners — average with up to 3 other tiles. Same deterministic logic:
    // every participating tile computes the same mean over the same set of
    // raw samples, so all four corners meet exactly.
    const cornerAvg = (myIx, myIz, contribs) => {
      let sum = raw[myIz * res + myIx], n = 1;
      for (const [nb, nIx, nIz] of contribs) {
        if (!nb) continue;
        sum += nb[nIz * res + nIx]; n++;
      }
      if (n > 1) setY(myIx, myIz, Math.round(sum / n));
    };
    cornerAvg(0,       0,       [[W, res - 1, 0],       [N, 0,       res - 1], [NW, res - 1, res - 1]]);
    cornerAvg(res - 1, 0,       [[E, 0,       0],       [N, res - 1, res - 1], [NE, 0,       res - 1]]);
    cornerAvg(0,       res - 1, [[W, res - 1, res - 1], [S, 0,       0],       [SW, res - 1, 0      ]]);
    cornerAvg(res - 1, res - 1, [[E, 0,       res - 1], [S, res - 1, 0],       [SE, 0,       0      ]]);

    geom.attributes.position.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
  }

  /** Loaded terrain meshes — used as raycast targets for player collision. */
  meshes() {
    const out = [];
    for (const state of this._cells.values()) {
      if (state && typeof state === 'object' && state.mesh) out.push(state.mesh);
    }
    return out;
  }

  /**
   * Bilinear-sampled elevation in metres at local (x, z). Returns null if
   * the covering cell isn't loaded.
   */
  sample(x, z) {
    const gx = Math.floor(x / CELL_SIZE);
    const gz = Math.floor(z / CELL_SIZE);
    const state = this._cells.get(`${gx},${gz}`);
    if (!state || typeof state !== 'object') return null;

    const { samples, res, bounds: b } = state;
    const half = CELL_SIZE / (2 * res);
    const fx = (x - (b.minX + half)) / (CELL_SIZE - 2 * half) * (res - 1);
    const fz = (z - (b.minZ + half)) / (CELL_SIZE - 2 * half) * (res - 1);
    const ix0 = Math.max(0, Math.min(res - 1, Math.floor(fx)));
    const iz0 = Math.max(0, Math.min(res - 1, Math.floor(fz)));
    const ix1 = Math.min(res - 1, ix0 + 1);
    const iz1 = Math.min(res - 1, iz0 + 1);
    const tx  = Math.max(0, Math.min(1, fx - ix0));
    const tz  = Math.max(0, Math.min(1, fz - iz0));

    const v00 = _decode(samples[iz0 * res + ix0]);
    const v01 = _decode(samples[iz0 * res + ix1]);
    const v10 = _decode(samples[iz1 * res + ix0]);
    const v11 = _decode(samples[iz1 * res + ix1]);
    const top = v00 * (1 - tx) + v01 * tx;
    const bot = v10 * (1 - tx) + v11 * tx;
    return top * (1 - tz) + bot * tz;
  }
}

function _decode(cm) {
  return cm === NODATA_CM ? 0 : cm * 0.01;
}

/**
 * Replace NODATA samples in-place by iteratively averaging each hole's up-to-4
 * filled neighbours. Gaps from a lidar's water-classified pixel fill with a
 * value that flows smoothly with the surrounding terrain, instead of punching
 * a hole to y=0 (where OSM at y=0.15 would poke through). Converges in
 * O(max-gap-width) passes — for scattered shoreline specks that's 1-2.
 *
 * Falls back to cell-mean for any NODATA the dilation can't reach (e.g. an
 * entire missing row at a tile edge — rare but possible).
 */
function fillNoData(samples, res) {
  let remaining = 0;
  let sum = 0, count = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] === NODATA_CM) remaining++;
    else { sum += samples[i]; count++; }
  }
  if (remaining === 0) return;
  if (count === 0) { samples.fill(0); return; }

  let guard = 0;
  while (remaining > 0 && guard++ < 32) {
    let filled = 0;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const i = iz * res + ix;
        if (samples[i] !== NODATA_CM) continue;
        let s = 0, c = 0, v;
        if (ix > 0)       { v = samples[i - 1];     if (v !== NODATA_CM) { s += v; c++; } }
        if (ix < res - 1) { v = samples[i + 1];     if (v !== NODATA_CM) { s += v; c++; } }
        if (iz > 0)       { v = samples[i - res];   if (v !== NODATA_CM) { s += v; c++; } }
        if (iz < res - 1) { v = samples[i + res];   if (v !== NODATA_CM) { s += v; c++; } }
        if (c > 0) { samples[i] = Math.round(s / c); filled++; }
      }
    }
    if (filled === 0) break;
    remaining -= filled;
  }
  if (remaining > 0) {
    const mean = Math.round(sum / count);
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] === NODATA_CM) samples[i] = mean;
    }
  }
}

// Separable 5-tap Gaussian kernel. Weights [1,4,6,4,1] give a
// rotationally-symmetric low-pass when applied horizontally then
// vertically — the smoothing is grid-orientation-agnostic, which is what
// hides PlaneGeometry's consistent diagonal triangulation on slopes.
// Used by _rebuildSmoothed on a padded buffer so the kernel spans tile
// seams instead of clamping at them.
const _GAUSS = [1, 4, 6, 4, 1];

// The 8 neighbouring-cell deltas in (gx, gz) order. Used by rebuild loops
// so a new tile refreshes the smoothing of its neighbours' edges.
const _NEIGHBOUR_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

// Fetch a sample at (ix, iz) in a tile-local coordinate system where
// [0, res) is the tile itself and values outside that range come from the
// appropriate neighbour's raw samples (remapped to its own 0..res-1). If
// the neighbour isn't loaded we clamp to this tile's edge — the Gaussian
// just degrades to the previous "no-context" behaviour at that side.
function _lookupWithNeighbours(raw, res, ix, iz, W, E, N, S, NW, NE, SW, SE) {
  let src, lix = ix, liz = iz;
  if      (ix < 0   && iz < 0  ) { src = NW; lix = ix + res; liz = iz + res; }
  else if (ix >= res && iz < 0 ) { src = NE; lix = ix - res; liz = iz + res; }
  else if (ix < 0   && iz >= res) { src = SW; lix = ix + res; liz = iz - res; }
  else if (ix >= res && iz >= res) { src = SE; lix = ix - res; liz = iz - res; }
  else if (ix < 0   )            { src = W;  lix = ix + res;                }
  else if (ix >= res)            { src = E;  lix = ix - res;                }
  else if (iz < 0   )            { src = N;  liz = iz + res;                }
  else if (iz >= res)            { src = S;  liz = iz - res;                }
  else                           { src = raw; }

  if (!src) {
    const cix = ix < 0 ? 0 : ix >= res ? res - 1 : ix;
    const ciz = iz < 0 ? 0 : iz >= res ? res - 1 : iz;
    return raw[ciz * res + cix];
  }
  return src[liz * res + lix];
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

function buildTerrainMesh(gx, gz, res, samples) {
  const b = _cellBounds(gx, gz);
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const geom = new THREE.PlaneGeometry(w, d, res - 1, res - 1);
  geom.rotateX(-Math.PI / 2);

  const pos = geom.attributes.position.array;
  for (let i = 0, n = res * res; i < n; i++) {
    pos[i * 3 + 1] = _decode(samples[i]);
  }

  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();

  const mesh = new THREE.Mesh(geom, _createTerrainMaterial());
  mesh.position.set(
    (b.minX + b.maxX) / 2,
    0,
    (b.minZ + b.maxZ) / 2,
  );
  mesh.name = 'terrain';
  return mesh;
}
