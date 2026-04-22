import * as THREE from 'three';

const CELL_SIZE     = 150;  // world-space metres per tile — must match build_trees.py
const LOAD_RADIUS   = 150;
const UNLOAD_MARGIN =  50;
const MAX_LOADS     =   6;
const MAX_HEIGHT_M  =  12;  // outlier cap (some LiDAR records go to 70 m)
const MAX_CANOPY_R  =   5;
const SIZE_SCALE    = 0.8;  // trees are background detail — shrink a bit so they don't dominate

// Same greens we had as species colors — LiDAR has no species, so they're
// now picked pseudo-randomly per tree by a position hash (deterministic).
const COLORS = [
  new THREE.Color('#a8c050'),
  new THREE.Color('#6a8f3a'),
  new THREE.Color('#5a8040'),
  new THREE.Color('#4a7a30'),
  new THREE.Color('#c8d030'),
  new THREE.Color('#6a9040'),
];

function colorIdx(x, z) {
  let h = (Math.floor(x * 10) * 73856093) ^ (Math.floor(z * 10) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h >>> 0) % COLORS.length;
}

const _dummy = new THREE.Object3D();

export class TreeManager {
  constructor({ scene, terrain }) {
    this._scene   = scene;
    this._terrain = terrain;

    // Shared geometry + materials — allocated once, reused by every tile's
    // InstancedMesh. instanceColor lives on each mesh, not the material.
    this._trunkGeo  = new THREE.CylinderGeometry(0.75, 1, 1, 6);
    this._canopyGeo = new THREE.SphereGeometry(1, 7, 5);
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
    } catch {
      this._emptyTiles.add(key);
      return;
    }
    if (!data.length) { this._emptyTiles.add(key); return; }

    const n = data.length / 5; // flat [x,z,h,r,y_abs, ...] (y_abs=0 → use terrain)

    const trunks = new THREE.InstancedMesh(this._trunkGeo, this._trunkMat, n);
    trunks.frustumCulled = false;

    const canopies = new THREE.InstancedMesh(this._canopyGeo, this._canopyMat, n);
    canopies.frustumCulled = false;

    // Start with 0 visible instances. _place writes into slots 0..count-1
    // and bumps count, so unplaced trees cost nothing on CPU or GPU.
    trunks.count   = 0;
    canopies.count = 0;

    this._scene.add(trunks);
    this._scene.add(canopies);

    const pending = new Set();
    for (let i = 0; i < n; i++) pending.add(i);
    const state = { gx, gz, data, trunks, canopies, pending };
    this._tiles.set(key, state);
    this._place(state);
  }

  _place(state) {
    const { data, trunks, canopies, pending } = state;
    let changed = false;

    for (const i of pending) {
      const base = i * 5;
      const tx = data[base];
      const tz = data[base + 1];
      const th = data[base + 2];
      const tr = data[base + 3];
      const ty = data[base + 4]; // 0 = ground tree (use terrain), >0 = rooftop abs Y
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
      const trunkR  = Math.max(0.08, canopyR * 0.09); // scales with crown mass, not height

      _dummy.rotation.set(0, 0, 0);

      const slot = trunks.count; // dense packing — unplaced trees never occupy a slot

      _dummy.position.set(tx, y + trunkH * 0.5, tz);
      _dummy.scale.set(trunkR, trunkH, trunkR);
      _dummy.updateMatrix();
      trunks.setMatrixAt(slot, _dummy.matrix);

      _dummy.position.set(tx, y + trunkH + canopyR * 0.55, tz);
      _dummy.scale.set(canopyR, canopyR * 1.15, canopyR);
      _dummy.updateMatrix();
      canopies.setMatrixAt(slot, _dummy.matrix);

      canopies.setColorAt(slot, COLORS[colorIdx(tx, tz)]);

      trunks.count++;
      canopies.count++;

      pending.delete(i);
      changed = true;
    }

    if (changed) {
      trunks.instanceMatrix.needsUpdate   = true;
      canopies.instanceMatrix.needsUpdate  = true;
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    }
  }

  _unload(key, state) {
    this._scene.remove(state.trunks);
    this._scene.remove(state.canopies);
    // Geometry + material are shared — don't dispose them.
    this._tiles.delete(key);
  }
}
