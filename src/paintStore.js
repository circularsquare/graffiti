const STORAGE_KEY = 'graffiti_paint_v2';

// Persist writes lazily — paint feels instant because the overlay rebuild is
// detached from localStorage. The real write is batched to idle time.
const SAVE_DEBOUNCE_MS = 1500;

/**
 * Stores painted cell state with localStorage persistence.
 *
 * Cell key format: "{buildingId}:{meshType}:{cellU}:{cellV}:{planeDKey}"
 *
 * Cell data: { color (hex int), normal [nx,ny,nz], planeD (float), paintedAt (ms) }
 *
 * Two secondary indexes keep lookups O(building) instead of O(all cells):
 *   - _byBuilding: "buildingId:meshType" → Set<cellKey>
 *     Used by main.js#rebuildBuildingPaint so each rebuild only visits cells
 *     on the building being rebuilt — critical when seedTileCells has inflated
 *     the map to tens of thousands of entries.
 *
 * Persistence is debounced: paint()/erase() schedule a save rather than doing
 * it synchronously. Flushed immediately on tab visibility changes so painted
 * cells aren't lost when the player alt-tabs or closes the tab.
 *
 * Multiplayer-ready: subscribe() listeners receive every paint event.
 */
class PaintStore {
  constructor() {
    this.cells = new Map();        // cellKey → cellData — all cells (user + seeded)
    this._byBuilding = new Map();  // buildingKey → Set<cellKey>
    this._persistedKeys = new Set(); // subset of `cells` that should survive a reload
    this._listeners = new Set();
    this._saveTimer = null;
    this._load();

    // Make sure an in-flight debounced save doesn't get lost on tab close / hide.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload',  () => this._flushSave());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._flushSave();
      });
    }
  }

  paint(cellKey, cellData) {
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
    this._persistedKeys.add(cellKey);
    this._scheduleSave();
    for (const fn of this._listeners) fn(cellKey, cellData);
  }

  /** Paint multiple cells with a single localStorage write. */
  paintBatch(entries) {
    for (const [k, v] of entries) {
      this.cells.set(k, v);
      this._indexAdd(k);
      this._persistedKeys.add(k);
    }
    this._scheduleSave();
    for (const [k, v] of entries) for (const fn of this._listeners) fn(k, v);
  }

  erase(cellKey) {
    if (!this.cells.has(cellKey)) return;
    this.cells.delete(cellKey);
    this._indexRemove(cellKey);
    this._persistedKeys.delete(cellKey);
    this._scheduleSave();
    for (const fn of this._listeners) fn(cellKey, null);
  }

  /** Erase multiple cells with a single localStorage write. */
  eraseBatch(keys) {
    const present = keys.filter(k => this.cells.has(k));
    if (!present.length) return;
    for (const k of present) {
      this.cells.delete(k);
      this._indexRemove(k);
      this._persistedKeys.delete(k);
    }
    this._scheduleSave();
    for (const k of present) for (const fn of this._listeners) fn(k, null);
  }

  /**
   * Populate a cell without persisting or firing listeners.
   *
   * Used by seedTileCells to fill in random coloured cells for visual stress
   * testing. Seeded cells live only in memory — deliberately not added to
   * `_persistedKeys`, so `_writeToStorage` skips them. They don't round-trip
   * through localStorage and they don't fire per-cell rebuild events (the
   * caller rebuilds the whole building once after seeding).
   */
  seed(cellKey, cellData) {
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
  }

  /** Returns the Set of cell keys on a building, or an empty iterable. */
  cellsForBuilding(buildingKey) {
    return this._byBuilding.get(buildingKey) || EMPTY_SET;
  }

  /** Returns an unsubscribe function. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  // Cell keys look like "buildingId:meshType:cu:cv:pdKey". Strip the last three
  // segments to recover "buildingId:meshType" — robust against colons inside
  // buildingId (none today, but the seed-scan code already uses this split).
  _buildingKeyOf(cellKey) {
    const parts = cellKey.split(':');
    parts.pop(); parts.pop(); parts.pop();
    return parts.join(':');
  }

  _indexAdd(cellKey) {
    const bk = this._buildingKeyOf(cellKey);
    let set = this._byBuilding.get(bk);
    if (!set) { set = new Set(); this._byBuilding.set(bk, set); }
    set.add(cellKey);
  }

  _indexRemove(cellKey) {
    const bk = this._buildingKeyOf(cellKey);
    const set = this._byBuilding.get(bk);
    if (!set) return;
    set.delete(cellKey);
    if (set.size === 0) this._byBuilding.delete(bk);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeToStorage();
    }, SAVE_DEBOUNCE_MS);
  }

  _flushSave() {
    if (this._saveTimer === null) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._writeToStorage();
  }

  _writeToStorage() {
    const t = performance.now();
    try {
      // Serialise only persisted keys. With SEED_FRACTION high, `cells` can
      // hold 50k–100k ephemeral seed entries; stringifying all of them on
      // every debounce tick blocks the main thread for hundreds of ms.
      const out = {};
      for (const k of this._persistedKeys) {
        const v = this.cells.get(k);
        if (v !== undefined) out[k] = v;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {}
    performance.measure('paint:save', { start: t, end: performance.now() });
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      for (const [k, v] of Object.entries(JSON.parse(raw))) {
        this.cells.set(k, v);
        this._indexAdd(k);
        this._persistedKeys.add(k); // anything loaded from storage is, by definition, persisted
      }
    } catch {}
  }
}

const EMPTY_SET = new Set();

export const paintStore = new PaintStore();
