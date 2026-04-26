import * as THREE from 'three';
import { netReady, reportNetFailure, reportNetSuccess } from './netHealth.js';

const CELL_SIZE     = 150;  // world-space metres per tile — must match build_trees.py
const LOAD_RADIUS   = 150;
const UNLOAD_MARGIN =  50;
const MAX_LOADS     =   6;
const MAX_HEIGHT_M  =  12;  // outlier cap (some LiDAR records go to 70 m)
const MAX_CANOPY_R  =   5;
const SIZE_SCALE    = 0.8;  // trees are background detail — shrink a bit so they don't dominate

// Sorted light → dark. Each tree's colour is picked by combining a smooth
// regional tone (value noise on a ~100 m grid) with per-tree jitter, then
// sliced through a weighted CDF. Globally the distribution matches `w`; locally
// neighbouring trees cluster around the same tone. Pink is rare and only lands
// in the lightest regions; yellow is half the weight of any green.
const COLORS = [
  { c: new THREE.Color('#e8a0b8'), w: 0.35 }, // pink
  { c: new THREE.Color('#c8d030'), w: 1.0  }, // yellow
  { c: new THREE.Color('#a8c050'), w: 2.0  },
  { c: new THREE.Color('#78a040'), w: 2.0  },
  { c: new THREE.Color('#6a9040'), w: 2.0  },
  { c: new THREE.Color('#6a8f3a'), w: 2.0  },
  { c: new THREE.Color('#5a8040'), w: 2.0  },
  { c: new THREE.Color('#4a7a30'), w: 2.0  },
];
const COLOR_CDF = (() => {
  const total = COLORS.reduce((s, e) => s + e.w, 0);
  const out = new Float32Array(COLORS.length);
  let a = 0;
  for (let i = 0; i < COLORS.length; i++) { a += COLORS[i].w / total; out[i] = a; }
  return out;
})();

const NOISE_SCALE  = 1 / 60; // world m per noise-grid cell → regional clusters ~70 m across
const TONE_JITTER  = 0.6;     // per-tree offset span (±TONE_JITTER/2) around the regional tone, in CDF units

function hash01(ix, iz) {
  let h = Math.imul(ix | 0, 73856093) ^ Math.imul(iz | 0, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h >>> 0) & 0xffffff) / 0x1000000;
}

function regionTone(x, z) {
  const px = x * NOISE_SCALE, pz = z * NOISE_SCALE;
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = px - ix, fz = pz - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix,     iz    );
  const b = hash01(ix + 1, iz    );
  const c = hash01(ix,     iz + 1);
  const d = hash01(ix + 1, iz + 1);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

// Returns a palette index. The darkest green (last entry) is rendered as a cone
// instead of an ellipsoid, so callers check the index — not just the colour.
function pickColorIdx(x, z) {
  const m = regionTone(x, z);
  // Jitter hash uses shifted inputs so it doesn't correlate with the regional grid.
  const u = hash01(Math.floor(x * 10) + 17, Math.floor(z * 10) - 23);
  let t = m + (u - 0.5) * TONE_JITTER;
  // Reflect rather than clip — clipping piles up mass at 0 and 1, which would
  // overrepresent the two end colours (esp. pink). Reflection keeps t uniform
  // on [0, 1] globally so the CDF weights stay true frequencies, while still
  // concentrating end colours in regions whose tone is near that end.
  if (t < 0) t = -t; else if (t > 1) t = 2 - t;
  for (let i = 0; i < COLOR_CDF.length - 1; i++) {
    if (t < COLOR_CDF[i]) return i;
  }
  return COLORS.length - 1;
}
const CONE_COLOR_IDX = COLORS.length - 1;

const _dummy = new THREE.Object3D();

export class TreeManager {
  constructor({ scene, terrain }) {
    this._scene   = scene;
    this._terrain = terrain;

    // Shared geometry + materials — allocated once, reused by every tile's
    // InstancedMesh. instanceColor lives on each mesh, not the material.
    this._trunkGeo  = new THREE.CylinderGeometry(0.75, 1, 1, 6);
    this._canopyGeo = new THREE.SphereGeometry(1, 7, 5);
    // Cone with a rounded base edge and a small flat top face. Profile runs
    // bottom→top (base centre → base edge → 135° fillet → slanted side → top
    // edge → top centre). Bottom-up order is what LatheGeometry expects for
    // outward-facing normals; reversing flips the winding and we end up
    // looking at the back faces through the (culled) front.
    this._coneGeo   = new THREE.LatheGeometry([
      new THREE.Vector2(0,     -0.500), // base centre
      new THREE.Vector2(0.807, -0.500), // fillet end (on base plane)
      new THREE.Vector2(0.864, -0.477),
      new THREE.Vector2(0.887, -0.420),
      new THREE.Vector2(0.864, -0.363), // fillet start (end of slanted side)
      new THREE.Vector2(0.050,  0.500), // top edge — small flat top instead of a point
      new THREE.Vector2(0,      0.500), // top centre
    ], 8);
    this._trunkMat  = new THREE.MeshLambertMaterial({ color: 0x6b4423 });
    this._canopyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

    this._tiles       = new Map();
    this._emptyTiles  = new Set();
    this._loadQueue   = [];
    this._enqueued    = new Set();   // O(1) dedup for pending load keys
    this._activeLoads = 0;
  }

  tick(px, pz) {
    const r        = Math.ceil(LOAD_RADIUS / CELL_SIZE);
    const cx       = Math.floor(px / CELL_SIZE);
    const cz       = Math.floor(pz / CELL_SIZE);
    const loadR2   = LOAD_RADIUS * LOAD_RADIUS;
    const unloadR2 = (LOAD_RADIUS + UNLOAD_MARGIN) ** 2;

    // Collect new candidates with cached squared distance, then sort once.
    // Skip enqueueing entirely when the network breaker is open, otherwise
    // we'd re-push the same unfetched cells every frame and _drain would
    // immediately drop them — wasted churn.
    if (netReady()) {
      const toEnqueue = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const gx = cx + dx;
          const gz = cz + dz;
          const wx = (gx + 0.5) * CELL_SIZE;
          const wz = (gz + 0.5) * CELL_SIZE;
          const d2 = (px - wx) ** 2 + (pz - wz) ** 2;
          if (d2 > loadR2) continue;
          const key = `${gx},${gz}`;
          if (this._tiles.has(key) || this._emptyTiles.has(key)) continue;
          if (this._enqueued.has(key)) continue;
          toEnqueue.push({ gx, gz, key, d2 });
        }
      }
      toEnqueue.sort((a, b) => a.d2 - b.d2);
      for (const e of toEnqueue) {
        this._loadQueue.push(e);
        this._enqueued.add(e.key);
      }
    }

    // Unload distant loaded tiles.
    for (const [key, state] of this._tiles) {
      const wx = (state.gx + 0.5) * CELL_SIZE;
      const wz = (state.gz + 0.5) * CELL_SIZE;
      if ((px - wx) ** 2 + (pz - wz) ** 2 > unloadR2) {
        this._unload(key, state);
      }
    }

    // Also prune queue entries that have drifted out of range (player moved away
    // before we got to them). Back-to-front to keep indices valid during splice.
    for (let i = this._loadQueue.length - 1; i >= 0; i--) {
      const e  = this._loadQueue[i];
      const wx = (e.gx + 0.5) * CELL_SIZE;
      const wz = (e.gz + 0.5) * CELL_SIZE;
      if ((px - wx) ** 2 + (pz - wz) ** 2 > unloadR2) {
        this._loadQueue.splice(i, 1);
        this._enqueued.delete(e.key);
      }
    }

    this._drain();
  }

  onTerrainCellLoaded() {
    for (const state of this._tiles.values()) {
      if (state.pending.size) this._place(state);
    }
  }

  _drain() {
    while (this._activeLoads < MAX_LOADS && this._loadQueue.length > 0) {
      const entry = this._loadQueue.shift();
      if (this._tiles.has(entry.key) || this._emptyTiles.has(entry.key)) {
        this._enqueued.delete(entry.key);
        continue;
      }
      // Circuit breaker open: stop draining. The entry we just shifted
      // stays out of _enqueued (tick will re-queue it) so recovery happens
      // naturally once the breaker closes.
      if (!netReady()) { this._enqueued.delete(entry.key); continue; }
      this._activeLoads++;
      // Keep the key in _enqueued until the fetch completes — otherwise
      // tick()s during the fetch window would see the tile as "not loaded,
      // not empty, not queued" and enqueue it again, causing duplicate loads.
      this._load(entry).finally(() => {
        this._enqueued.delete(entry.key);
        this._activeLoads--;
        this._drain();
      });
    }
  }

  async _load({ gx, gz, key }) {
    let data;
    try {
      const res = await fetch(`${import.meta.env.VITE_CDN_BASE ?? ''}/trees/cell_${gx}_${gz}.json`);
      if (!res.ok) { this._emptyTiles.add(key); return; }
      data = await res.json();
      reportNetSuccess();
    } catch (e) {
      if (e instanceof TypeError) {
        // Transport failure — do NOT mark _emptyTiles (that would stick
        // until reload). Route to the shared breaker; tick will re-enqueue
        // this cell once the breaker closes.
        reportNetFailure('load tree tile');
        return;
      }
      // Anything else (bad JSON, etc.) is a real content error for this
      // tile — treat as empty so we don't retry indefinitely.
      this._emptyTiles.add(key);
      return;
    }
    if (!data.length) { this._emptyTiles.add(key); return; }

    const n = data.length / 5; // flat [x,z,h,r,y_abs, ...] (y_abs=0 → use terrain)

    const trunks = new THREE.InstancedMesh(this._trunkGeo, this._trunkMat, n);
    trunks.frustumCulled = false;

    const canopies = new THREE.InstancedMesh(this._canopyGeo, this._canopyMat, n);
    canopies.frustumCulled = false;

    // Dark-green trees use this mesh instead of the sphere canopy. Over-allocated
    // (sized for n) since we don't know the cone/sphere split until _place runs.
    const cones = new THREE.InstancedMesh(this._coneGeo, this._canopyMat, n);
    cones.frustumCulled = false;

    // Start with 0 visible instances. _place writes into slots 0..count-1
    // and bumps count, so unplaced trees cost nothing on CPU or GPU.
    trunks.count   = 0;
    canopies.count = 0;
    cones.count    = 0;

    this._scene.add(trunks);
    this._scene.add(canopies);
    this._scene.add(cones);

    const pending = new Set();
    for (let i = 0; i < n; i++) pending.add(i);
    const state = { gx, gz, data, trunks, canopies, cones, pending };
    this._tiles.set(key, state);
    this._place(state);
  }

  _place(state) {
    const { data, trunks, canopies, cones, pending } = state;
    let changed = false;

    for (const i of pending) {
      const base = i * 5;
      const tx = data[base];
      const tz = data[base + 1];
      const th = data[base + 2];
      const tr = data[base + 3];
      const ty = data[base + 4]; // 0 = ground tree (use terrain), >0 = rooftop abs Y
      // Skinny-canopy trees look like floating sticks — drop them permanently.
      // (Older tile JSON still contains them; the generator culls them now too.)
      if (tr < 2.0) { pending.delete(i); continue; }
      let y;
      if (ty > 0) {
        y = ty;
      } else {
        y = this._terrain.sample(tx, tz);
        if (y === null) continue;
      }

      const height  = Math.min(th, MAX_HEIGHT_M) * SIZE_SCALE;
      const canopyR = Math.min(tr, MAX_CANOPY_R) * SIZE_SCALE;
      const trunkH  = height * 0.62;
      const trunkR  = Math.max(0.12, canopyR * 0.135); // scales with crown mass, not height

      _dummy.rotation.set(0, 0, 0);

      const colorIdx = pickColorIdx(tx, tz);
      const isCone   = colorIdx === CONE_COLOR_IDX;

      const trunkSlot = trunks.count;
      _dummy.position.set(tx, y + trunkH * 0.5, tz);
      _dummy.scale.set(trunkR, trunkH, trunkR);
      _dummy.updateMatrix();
      trunks.setMatrixAt(trunkSlot, _dummy.matrix);
      trunks.count++;

      // Canopy half-height must be ≥ 0.32·height + 0.55·canopyR so exposed trunk
      // stays at ≤ 30% of the tree's height. (trunkH = 0.62·height; the 0.55·c
      // term comes from the canopy's centre offset above the trunk top.)
      const minHalfH = 0.32 * height + 0.55 * canopyR;

      if (isCone) {
        // Conifer shape: base tucks ~0.7·canopyR below trunk top, tip ~1.8·canopyR
        // above at the 1.25× baseline; stretched further for lollipop-prone trees.
        const halfH = Math.max(canopyR * 1.25, minHalfH);
        const slot = cones.count;
        _dummy.position.set(tx, y + trunkH + canopyR * 0.55, tz);
        _dummy.scale.set(canopyR, halfH * 2, canopyR);
        _dummy.updateMatrix();
        cones.setMatrixAt(slot, _dummy.matrix);
        cones.setColorAt(slot, COLORS[colorIdx].c);
        cones.count++;
      } else {
        const halfH = Math.max(canopyR * 1.15, minHalfH);
        const slot = canopies.count;
        _dummy.position.set(tx, y + trunkH + canopyR * 0.55, tz);
        _dummy.scale.set(canopyR, halfH, canopyR);
        _dummy.updateMatrix();
        canopies.setMatrixAt(slot, _dummy.matrix);
        canopies.setColorAt(slot, COLORS[colorIdx].c);
        canopies.count++;
      }

      pending.delete(i);
      changed = true;
    }

    if (changed) {
      trunks.instanceMatrix.needsUpdate   = true;
      canopies.instanceMatrix.needsUpdate = true;
      cones.instanceMatrix.needsUpdate    = true;
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
      if (cones.instanceColor)    cones.instanceColor.needsUpdate    = true;
    }
  }

  _unload(key, state) {
    this._scene.remove(state.trunks);
    this._scene.remove(state.canopies);
    this._scene.remove(state.cones);
    // Geometry + material are shared — don't dispose them.
    this._tiles.delete(key);
  }
}
