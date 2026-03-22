const STORAGE_KEY = 'graffiti_paint_v2';

/**
 * Stores painted cell state with localStorage persistence.
 *
 * Cell key format: "{buildingId}:{meshType}:{cellU}:{cellV}"
 *   - buildingId: from CityGML (mesh.userData.buildingId)
 *   - meshType:   'roof' | 'wall'
 *   - cellU/V:    Math.floor(intersection.uv) — 1 unit = 2 m grid cell
 *
 * Cell data: { color (hex int), worldPos [x,y,z], normal [nx,ny,nz], paintedAt (ms timestamp) }
 *
 * Multiplayer-ready: subscribe() listeners receive every paint event.
 * To add real-time sync, emit incoming server messages through paint()
 * and broadcast outgoing ones inside it — no caller changes needed.
 */
class PaintStore {
  constructor() {
    this.cells = new Map(); // cellKey → cellData
    this._listeners = new Set();
    this._load();
  }

  paint(cellKey, cellData) {
    this.cells.set(cellKey, cellData);
    this._save();
    for (const fn of this._listeners) fn(cellKey, cellData);
  }

  /** Paint multiple cells with a single localStorage write. */
  paintBatch(entries) {
    for (const [k, v] of entries) this.cells.set(k, v);
    this._save();
    for (const [k, v] of entries) for (const fn of this._listeners) fn(k, v);
  }

  /** Erase multiple cells with a single localStorage write. */
  eraseBatch(keys) {
    const present = keys.filter(k => this.cells.has(k));
    if (!present.length) return;
    for (const k of present) this.cells.delete(k);
    this._save();
    for (const k of present) for (const fn of this._listeners) fn(k, null);
  }

  erase(cellKey) {
    if (!this.cells.has(cellKey)) return;
    this.cells.delete(cellKey);
    this._save();
    for (const fn of this._listeners) fn(cellKey, null);
  }

  /** Returns an unsubscribe function. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) this.cells.set(k, v);
    } catch {}
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.cells)));
    } catch {}
  }
}

export const paintStore = new PaintStore();
