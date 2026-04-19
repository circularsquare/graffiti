const TILE_ENDPOINT    = '/api/paint';
const SAVE_DEBOUNCE_MS  = 1500;

/**
 * Stores painted cell state, sliced per tile, backed by the dev server's
 * file-based paint endpoint (see scripts/tile-paint-plugin.js).
 *
 * Cell key format: "{buildingId}:{meshType}:{cellU}:{cellV}:{planeDKey}"
 *
 * Cell data: { color (hex int), normal [nx,ny,nz], planeD (float), paintedAt (ms) }
 *
 * Lifecycle:
 *   - TileManager calls loadTile(tileId, buildingKeys) when a tile enters
 *     load range; paintStore fetches GET /api/paint/{tileId}, merges the
 *     returned cells into memory, and remembers which cells belong to which
 *     tile.
 *   - paint/erase resolve the owning tile from the buildingKey and mark that
 *     tile dirty. A debounced PUT flushes the tile's full cell map.
 *   - TileManager calls unloadTile(tileId) when a tile leaves; paintStore
 *     flushes any pending save for that tile and drops its cells from memory.
 *
 * Indexes:
 *   - _byBuilding:      "buildingId:meshType" → Set<cellKey>
 *   - _tileOfBuilding:  "buildingId:meshType" → tileId
 *   - _cellsByTile:     tileId → Set<cellKey>
 *
 * Multiplayer-ready: subscribe() listeners receive every paint event, and the
 * PUT endpoint is the natural seam to swap for a hosted server later.
 */
class PaintStore {
  constructor() {
    this.cells       = new Map();  // cellKey → cellData — all cells in loaded tiles
    this._byBuilding = new Map();  // buildingKey → Set<cellKey>
    this._listeners  = new Set();

    this._tileOfBuilding     = new Map();  // buildingKey → tileId
    this._cellsByTile        = new Map();  // tileId → Set<cellKey>
    this._loadedTiles        = new Set();  // tileIds we've fetched (skip re-fetch on reload)
    this._tilesWithSavedData = new Set();  // tileIds whose GET returned a non-empty payload
    this._dirtyTiles         = new Set();  // tiles with unsaved changes
    this._saveTimer          = null;

    // Make sure an in-flight debounced save doesn't get lost on tab close/hide.
    // beforeunload uses sendBeacon so the PUT reaches the server even as the
    // page unloads; visibilitychange can await normally.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._flushSaveBeacon());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._flushSaveAsync();
      });
    }
  }

  /**
   * Fetch and apply any server-saved cells for this tile. Idempotent:
   * re-registers the building→tile mapping but skips the network fetch on
   * re-entry (the in-memory cells are still there).
   *
   * Does NOT fire listeners: the caller (TileManager) awaits this before
   * phase 2 cellData is applied, and seedTileCells issues one rebuild per
   * mesh, which renders server cells and fresh seeds together.
   */
  async loadTile(tileId, buildingKeys) {
    for (const bk of buildingKeys) this._tileOfBuilding.set(bk, tileId);
    if (this._loadedTiles.has(tileId)) return;
    this._loadedTiles.add(tileId);

    let payload;
    try {
      const res = await fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (e) {
      console.warn(`paintStore: fetch tile ${tileId} failed:`, e);
      return;
    }

    // The tile may have unloaded while we awaited the fetch. Apply nothing in
    // that case — unloadTile cleared _loadedTiles and dropped the mappings.
    if (!this._loadedTiles.has(tileId)) return;

    const keys = Object.keys(payload);
    if (keys.length > 0) this._tilesWithSavedData.add(tileId);

    let set = this._cellsByTile.get(tileId);
    if (!set) { set = new Set(); this._cellsByTile.set(tileId, set); }

    for (const k of keys) {
      this.cells.set(k, payload[k]);
      this._indexAdd(k);
      set.add(k);
    }
  }

  /** True if this tile's GET returned at least one cell. Used by seedTileCells
   *  to skip new seed rolls on tiles whose pattern is already locked in on disk. */
  tileHasSavedData(tileId) {
    return this._tilesWithSavedData.has(tileId);
  }

  /** Resolve the tileId for a cell's building. Returns undefined if not registered. */
  tileIdOfBuilding(buildingKey) {
    return this._tileOfBuilding.get(buildingKey);
  }

  /**
   * Flush pending save for this tile and drop its cells from memory. Called
   * by TileManager._unload; keeps memory bounded as the player wanders.
   */
  async unloadTile(tileId, buildingKeys) {
    if (this._dirtyTiles.has(tileId)) {
      await this._writeTile(tileId);
      this._dirtyTiles.delete(tileId);
    }

    const set = this._cellsByTile.get(tileId);
    if (set) {
      for (const k of set) {
        this.cells.delete(k);
        this._indexRemove(k);
      }
      this._cellsByTile.delete(tileId);
    }
    for (const bk of buildingKeys) this._tileOfBuilding.delete(bk);
    this._loadedTiles.delete(tileId);
    this._tilesWithSavedData.delete(tileId);
  }

  paint(cellKey, cellData) {
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
    this._trackCellTile(cellKey);
    this._scheduleSave();
    for (const fn of this._listeners) fn(cellKey, cellData);
  }

  /** Paint multiple cells with a single PUT per affected tile. */
  paintBatch(entries) {
    for (const [k, v] of entries) {
      this.cells.set(k, v);
      this._indexAdd(k);
      this._trackCellTile(k);
    }
    this._scheduleSave();
    for (const [k, v] of entries) for (const fn of this._listeners) fn(k, v);
  }

  erase(cellKey) {
    if (!this.cells.has(cellKey)) return;
    this.cells.delete(cellKey);
    this._indexRemove(cellKey);
    this._untrackCellTile(cellKey);
    this._scheduleSave();
    for (const fn of this._listeners) fn(cellKey, null);
  }

  eraseBatch(keys) {
    const present = keys.filter(k => this.cells.has(k));
    if (!present.length) return;
    for (const k of present) {
      this.cells.delete(k);
      this._indexRemove(k);
      this._untrackCellTile(k);
    }
    this._scheduleSave();
    for (const k of present) for (const fn of this._listeners) fn(k, null);
  }

  /**
   * Populate a cell without firing listeners. Used by seedTileCells to fill
   * in stress-test cells after phase 2 — seeds persist to the server just
   * like user paint (so the first visitor's roll is shared with everyone).
   * The caller rebuilds the whole building once per mesh, so per-cell
   * listeners would be wasteful here.
   */
  seed(cellKey, cellData) {
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
    this._trackCellTile(cellKey);
    this._scheduleSave();
  }

  cellsForBuilding(buildingKey) {
    return this._byBuilding.get(buildingKey) || EMPTY_SET;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ── Tile ↔ cell tracking ───────────────────────────────────────────────────

  _buildingKeyOf(cellKey) {
    // "buildingId:meshType:cu:cv:pdKey" — strip last three segments to recover
    // "buildingId:meshType". Robust against colons inside buildingId.
    const parts = cellKey.split(':');
    parts.pop(); parts.pop(); parts.pop();
    return parts.join(':');
  }

  _trackCellTile(cellKey) {
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (!tileId) return; // building not yet registered — cell is orphaned until loadTile
    let set = this._cellsByTile.get(tileId);
    if (!set) { set = new Set(); this._cellsByTile.set(tileId, set); }
    set.add(cellKey);
    this._dirtyTiles.add(tileId);
  }

  _untrackCellTile(cellKey) {
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (!tileId) return;
    const set = this._cellsByTile.get(tileId);
    if (set) set.delete(cellKey);
    this._dirtyTiles.add(tileId);
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
      this._flushSaveAsync();
    }, SAVE_DEBOUNCE_MS);
  }

  async _flushSaveAsync() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirtyTiles.size === 0) return;
    const tiles = [...this._dirtyTiles];
    this._dirtyTiles.clear();
    await Promise.all(tiles.map(t => this._writeTile(t)));
  }

  /**
   * Best-effort flush during page unload. A normal await-fetch won't complete
   * reliably once the browser starts tearing down, so fire each tile's PUT
   * with { keepalive: true } — the request survives page close.
   */
  _flushSaveBeacon() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirtyTiles.size === 0) return;
    for (const tileId of this._dirtyTiles) {
      const body = JSON.stringify(this._payloadForTile(tileId));
      try {
        fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`, {
          method: 'PUT',
          body,
          headers: { 'content-type': 'application/json' },
          keepalive: true,
        });
      } catch {}
    }
    this._dirtyTiles.clear();
  }

  _payloadForTile(tileId) {
    const set = this._cellsByTile.get(tileId);
    const out = {};
    if (!set) return out;
    for (const k of set) {
      const v = this.cells.get(k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  async _writeTile(tileId) {
    const t = performance.now();
    const body = JSON.stringify(this._payloadForTile(tileId));
    try {
      const res = await fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.warn(`paintStore: save tile ${tileId} failed:`, e);
      // Re-mark dirty so the next scheduled save retries. If the failure is
      // persistent the user will see paint flicker back to pre-save state
      // on reload — acceptable for dev; the hosted server will add retries.
      this._dirtyTiles.add(tileId);
    }
    performance.measure('paint:save', { start: t, end: performance.now() });
  }
}

const EMPTY_SET = new Set();

export const paintStore = new PaintStore();
