const TILE_ENDPOINT     = import.meta.env.VITE_PAINT_ENDPOINT ?? '/api/paint';
const BUCKET_ENDPOINT   = TILE_ENDPOINT.replace(/\/paint\/?$/, '/bucket');
const REFILL_ENDPOINT   = TILE_ENDPOINT.replace(/\/paint\/?$/, '/refill');
const SAVE_DEBOUNCE_MS   = 500;
// Two-tier pull cadence: tiles the player is currently standing in or looking
// at poll fast so newly-painted cells show up near-realtime; everything else
// polls on a slower full sweep. Caller keeps the active set tiny (≤ ~3), so
// the fast loop is cheap regardless of how many tiles are loaded.
const PULL_ACTIVE_MS     = 6_000;
const PULL_IDLE_MS       = 30_000;
const PULL_IDLE_MAX_TILES = 20; // safety cap on tiles pulled per idle tick

// Sentinel cellKey written to a tile's paint JSON once seedTileCells has
// applied every mesh's seeds without being abandoned mid-way. Presence of
// this key on the next load means the tile's seed pattern is locked; absence
// (even if other cells exist) means seeding was interrupted and the next
// visit should keep rolling. The key intentionally doesn't match the real
// cellKey shape so it can't collide with a building.
const SEED_COMPLETE_KEY = '__seed_complete__';

// Opaque per-device UUID stored in localStorage. Attached to every cell we
// paint/seed and echoed on the PATCH envelope so the server can audit
// IP↔author without mixing PII into the public paint JSON. Cleared storage
// yields a fresh identity — that's intended; anything stronger needs a login.
const AUTHOR_ID_KEY = 'graffiti_author_id';

function loadOrCreateAuthorId() {
  try {
    const existing = localStorage.getItem(AUTHOR_ID_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(AUTHOR_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private-mode Safari / no-storage contexts: ephemeral per-session id.
    return crypto.randomUUID();
  }
}

// Token bucket — mirrors server constants. The server is authoritative; these
// are defaults/optimistic values used until the first response header sync.
// One token per cell written (paint or erase); seeds are exempt.
const BUCKET_CAPACITY  = 200;
const BUCKET_REFILL_MS = 20_000;

/**
 * Stores painted cell state, sliced per tile, backed by the paint endpoint
 * (Cloudflare Worker in prod, scripts/tile-paint-plugin.js in dev).
 *
 * Cell key format: "{buildingId}:{meshType}:{cellU}:{cellV}:{planeDKey}"
 *
 * Cell data: { color (hex int), normal [nx,ny,nz], planeD (float), paintedAt (ms), authorId (string) }
 *
 * Protocol:
 *   GET    /paint/{tileId}    → { [cellKey]: cellData } (+ ETag, honors If-None-Match)
 *   PATCH  /paint/{tileId}    → diff body { __ts, __author, [cellKey]: cellData|null };
 *                               server merges with a paintedAt tiebreaker so
 *                               same-cell conflicts resolve to the later paint
 *                               by client wall-clock, and different-cell edits
 *                               across clients never overwrite each other.
 *                               __author is the client's per-device UUID, logged
 *                               with the request IP to the server's audit KV
 *                               (14-day TTL) but not merged into the paint JSON.
 *
 * Lifecycle:
 *   - TileManager calls loadTile(tileId, buildingKeys) when a tile enters load
 *     range; paintStore fetches the tile, stores its ETag, and merges cells.
 *   - paint/erase/seed/markTileSeedComplete write to local state *and* to a
 *     per-tile dirty-cell map. A debounced PATCH sends only the dirty cells.
 *   - A two-tier pull loop re-fetches tiles so other clients' writes become
 *     visible. Tiles in the caller-supplied _activeTiles set (typically the
 *     one the player is standing in / looking at) poll every PULL_ACTIVE_MS;
 *     the rest sweep every PULL_IDLE_MS. Pulls skip tiles with dirty cells or
 *     in-flight saves, and re-check after the fetch awaits, so concurrent
 *     paints can't be stomped.
 *   - TileManager calls unloadTile(tileId) when a tile leaves; paintStore
 *     flushes any pending save and drops state for the tile.
 *
 * Indexes:
 *   - _byBuilding:      "buildingId:meshType" → Set<cellKey>
 *   - _tileOfBuilding:  "buildingId:meshType" → tileId
 *   - _cellsByTile:     tileId → Set<cellKey>
 *   - _dirtyCells:      tileId → Map<cellKey, cellData|null>     (null = erase)
 *   - _tileETags:       tileId → etag string (from last GET or PATCH response)
 *   - _savesInFlight:   Set<tileId>  (pull skips these)
 */
class PaintStore {
  constructor() {
    this.cells       = new Map();  // cellKey → cellData
    this._byBuilding = new Map();  // buildingKey → Set<cellKey>
    this._cellListeners      = new Set();
    this._buildingListeners  = new Set();

    this._tileOfBuilding     = new Map();  // buildingKey → tileId
    this._cellsByTile        = new Map();  // tileId → Set<cellKey>
    this._loadedTiles        = new Set();  // tileIds we've fetched (skip re-fetch on reload)
    this._seedCompleteTiles  = new Set();  // tileIds with the seed-complete sentinel on disk

    this._dirtyCells         = new Map();  // tileId → Map<cellKey, cellData|null>
    this._seedDirtyByTile    = new Map();  // tileId → Set<cellKey> subset of dirty that came from seed()
    this._undoDirtyByTile    = new Map();  // tileId → Set<cellKey> subset of dirty that came from undo/redo
    this._tileETags          = new Map();  // tileId → etag
    this._savesInFlight      = new Set();
    this._saveTimer          = null;

    this._activeTiles        = new Set();  // tileIds polled on the fast loop (set by setActiveTiles)
    this._pullTimerActive    = null;
    this._pullTimerIdle      = null;
    this._pullCursorIdle     = null;       // last-pulled idle tileId, for round-robin fairness
    this._paused             = false;      // set by setPaused — gates both pull loops

    this._authorId = (typeof window !== 'undefined') ? loadOrCreateAuthorId() : null;

    // Token bucket: fractional tokens + baseline timestamp. getBucketState()
    // extrapolates refill from (now - _bucketRefillAt). Every PATCH response
    // header resyncs us to the server's authoritative value, and a GET on
    // init (_syncBucketOnInit) seeds state before the first paint attempt so
    // we don't lie about a full bucket. Painting is blocked until ready.
    this._bucketTokens    = BUCKET_CAPACITY;
    this._bucketRefillAt  = Date.now();
    this._bucketCapacity  = BUCKET_CAPACITY;
    this._bucketRefillMs  = BUCKET_REFILL_MS;
    this._bucketReady     = false;
    this._bucketListeners = new Set();
    if (this._authorId) this._syncBucketOnInit();

    // Beforeunload: PATCH dirty cells with keepalive so writes survive page close.
    // visibilitychange: regular async flush is fine for tab-hide.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._flushSaveBeacon());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._flushSaveAsync();
      });
    }
  }

  // ── Tile lifecycle ─────────────────────────────────────────────────────────

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

    let payload, etag;
    try {
      const res = await fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      etag    = res.headers.get('etag');
      payload = await res.json();
    } catch (e) {
      console.warn(`paintStore: fetch tile ${tileId} failed:`, e);
      return;
    }

    // The tile may have unloaded while we awaited the fetch. Apply nothing in
    // that case — unloadTile cleared _loadedTiles and dropped the mappings.
    if (!this._loadedTiles.has(tileId)) return;

    if (etag) this._tileETags.set(tileId, etag);

    let set = this._cellsByTile.get(tileId);
    if (!set) { set = new Set(); this._cellsByTile.set(tileId, set); }

    for (const k of Object.keys(payload)) {
      if (k === SEED_COMPLETE_KEY) {
        this._seedCompleteTiles.add(tileId);
        continue;
      }
      this.cells.set(k, payload[k]);
      this._indexAdd(k);
      set.add(k);
    }

    this._startPullLoop();
  }

  /** True if this tile's paint JSON carries the seed-complete sentinel. */
  isTileSeedComplete(tileId) {
    return this._seedCompleteTiles.has(tileId);
  }

  /** Mark this tile seed-complete. Schedules a save so the sentinel reaches
   *  disk; idempotent after the first call. */
  markTileSeedComplete(tileId) {
    if (this._seedCompleteTiles.has(tileId)) return;
    this._seedCompleteTiles.add(tileId);
    this._dirty(tileId).set(SEED_COMPLETE_KEY, { complete: true });
    this._markSeedDirty(tileId, SEED_COMPLETE_KEY);
    this._scheduleSave();
  }

  /** Resolve the tileId for a cell's building. Returns undefined if not registered. */
  tileIdOfBuilding(buildingKey) {
    return this._tileOfBuilding.get(buildingKey);
  }

  /** Resolve the tileId that owns a given cellKey. Returns undefined if the
   *  cell's building isn't registered (e.g. orphaned cell, unloaded tile). */
  tileIdOfCell(cellKey) {
    return this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
  }

  /**
   * Flush pending save for this tile and drop its cells from memory. Called
   * by TileManager._unload; keeps memory bounded as the player wanders.
   */
  async unloadTile(tileId, buildingKeys) {
    if ((this._dirtyCells.get(tileId)?.size ?? 0) > 0) {
      await this._flushTile(tileId);
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
    this._seedCompleteTiles.delete(tileId);
    this._dirtyCells.delete(tileId);
    this._seedDirtyByTile.delete(tileId);
    this._undoDirtyByTile.delete(tileId);
    this._tileETags.delete(tileId);
    this._savesInFlight.delete(tileId);
    this._activeTiles.delete(tileId);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  paint(cellKey, cellData) {
    if (!this._consumeBucket(1)) return;
    if (this._authorId) cellData.authorId = this._authorId;
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
    this._trackCellTile(cellKey);
    this._markDirty(cellKey, cellData);
    this._scheduleSave();
    for (const fn of this._cellListeners) fn(cellKey, cellData);
  }

  /** Paint multiple cells with a single PATCH per affected tile. */
  paintBatch(entries) {
    if (!this._consumeBucket(entries.length)) return;
    for (const [k, v] of entries) {
      if (this._authorId) v.authorId = this._authorId;
      this.cells.set(k, v);
      this._indexAdd(k);
      this._trackCellTile(k);
      this._markDirty(k, v);
    }
    this._scheduleSave();
    for (const [k, v] of entries) for (const fn of this._cellListeners) fn(k, v);
  }

  erase(cellKey) {
    if (!this.cells.has(cellKey)) return;
    if (!this._consumeBucket(1)) return;
    this.cells.delete(cellKey);
    this._indexRemove(cellKey);
    this._untrackCellTile(cellKey);
    this._markDirty(cellKey, null);
    this._scheduleSave();
    for (const fn of this._cellListeners) fn(cellKey, null);
  }

  eraseBatch(keys) {
    const present = keys.filter(k => this.cells.has(k));
    if (!present.length) return;
    if (!this._consumeBucket(present.length)) return;
    for (const k of present) {
      this.cells.delete(k);
      this._indexRemove(k);
      this._untrackCellTile(k);
      this._markDirty(k, null);
    }
    this._scheduleSave();
    for (const k of present) for (const fn of this._cellListeners) fn(k, null);
  }

  /**
   * Unmetered paint/erase: identical to paint()/erase() but skips the token
   * bucket and tags the cell as undo/redo-origin. When a flush contains only
   * undo-origin cells, the PATCH goes out with __undo:true and the server
   * exempts it from the bucket — net result: ctrl+Z/ctrl+Y are free.
   * Also usable when the bucket isn't ready yet (so a fast undo during init
   * sync still works).
   */
  paintUnmetered(cellKey, cellData) {
    if (this._authorId) cellData.authorId = this._authorId;
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
    this._trackCellTile(cellKey);
    this._markDirtyUndo(cellKey, cellData);
    this._scheduleSave();
    for (const fn of this._cellListeners) fn(cellKey, cellData);
  }

  eraseUnmetered(cellKey) {
    if (!this.cells.has(cellKey)) return;
    this.cells.delete(cellKey);
    this._indexRemove(cellKey);
    this._untrackCellTile(cellKey);
    this._markDirtyUndo(cellKey, null);
    this._scheduleSave();
    for (const fn of this._cellListeners) fn(cellKey, null);
  }

  /**
   * Populate a cell without firing listeners. Used by seedTileCells to fill
   * in stress-test cells after phase 2 — seeds persist to the server just
   * like user paint (so the first visitor's roll is shared with everyone).
   * The caller rebuilds the whole building once per mesh, so per-cell
   * listeners would be wasteful here.
   */
  seed(cellKey, cellData) {
    if (this._authorId) cellData.authorId = this._authorId;
    this.cells.set(cellKey, cellData);
    this._indexAdd(cellKey);
    this._trackCellTile(cellKey);
    this._markDirty(cellKey, cellData);
    // Mark this cell as seed-origin so _flushTile can tag the PATCH __seed:true
    // and skip the bucket charge. _markDirty already un-marks on paint/erase.
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (tileId) this._markSeedDirty(tileId, cellKey);
    // Intentionally no _scheduleSave() — markTileSeedComplete fires the save
    // after the full seed pass, so the sentinel travels on the same PATCH as
    // the seeds. A premature save without the sentinel could cause the tile
    // to re-seed on the next visit if the player moves away before the
    // second save fires.
  }

  get isDirty() {
    return this._pendingTileCount() > 0 || this._saveTimer !== null;
  }

  cellsForBuilding(buildingKey) {
    return this._byBuilding.get(buildingKey) || EMPTY_SET;
  }

  /** For the loading-indicator backlog metric in main.js. */
  get pendingTileCount() {
    return this._pendingTileCount();
  }

  // ── Listeners ──────────────────────────────────────────────────────────────

  /** Per-cell change listener: fn(cellKey, cellData | null). */
  subscribe(fn) {
    this._cellListeners.add(fn);
    return () => this._cellListeners.delete(fn);
  }

  /** Per-building bulk change listener: fn(buildingKey). Fires once per
   *  building touched by a pull, regardless of cell count. */
  subscribeBuildings(fn) {
    this._buildingListeners.add(fn);
    return () => this._buildingListeners.delete(fn);
  }

  // ── Token bucket ───────────────────────────────────────────────────────────

  /**
   * Current bucket state, extrapolated from the last known baseline.
   *   tokens:           integer 0..capacity (floored — the user has at least this much)
   *   fractionalTokens: precise float, for tight refill math
   *   capacity:         server-advertised capacity (mirrors BUCKET_CAPACITY until first sync)
   *   refillMs:         ms per token refill
   *   msUntilNext:      0 when full, else ms until the next integer token lands
   */
  getBucketState(now = Date.now()) {
    const elapsed = Math.max(0, now - this._bucketRefillAt);
    const raw = Math.min(this._bucketCapacity, this._bucketTokens + elapsed / this._bucketRefillMs);
    const frac = raw - Math.floor(raw);
    return {
      tokens:           Math.floor(raw),
      fractionalTokens: raw,
      capacity:         this._bucketCapacity,
      refillMs:         this._bucketRefillMs,
      msUntilNext:      raw >= this._bucketCapacity ? 0 : Math.ceil((1 - frac) * this._bucketRefillMs),
      ready:            this._bucketReady,
    };
  }

  /** Bucket-state change listener: fn(state). Fires on local consume, on
   *  header sync from PATCH responses, and once per second via tick() from
   *  the HUD loop (the HUD calls that itself — the store doesn't poll). */
  subscribeBucket(fn) {
    this._bucketListeners.add(fn);
    return () => this._bucketListeners.delete(fn);
  }

  /** Manual re-render trigger for UI. Call once per second from the render
   *  loop so the countdown advances — cheaper than a setInterval we'd have
   *  to tear down on page close. */
  tickBucket() {
    this._notifyBucket();
  }

  _consumeBucket(n) {
    if (n <= 0) return true;
    // Block writes until the init sync lands — otherwise we'd let the user
    // paint under the optimistic default 100/100 and only learn the real
    // balance (possibly 0) after the first PATCH response.
    if (!this._bucketReady) return false;
    const state = this.getBucketState();
    if (state.fractionalTokens < n) return false;
    // Collapse to the live fractional balance so we don't double-credit refill
    // the next time we read (refill resumes from `now`).
    this._bucketTokens   = state.fractionalTokens - n;
    this._bucketRefillAt = Date.now();
    this._notifyBucket();
    return true;
  }

  /**
   * Fire-and-forget GET /bucket on startup so the HUD + paint gate know the
   * real balance before the first cell write. Dev's tile plugin returns 204
   * with no X-Paint-* headers — that no-ops the sync, which is correct
   * (dev has no rate limit), and we still flip ready=true so painting works.
   * Any failure also flips ready=true to avoid permanently blocking writes
   * if the worker is down; the next real PATCH will either 429 or confirm.
   */
  async _syncBucketOnInit() {
    try {
      const res = await fetch(`${BUCKET_ENDPOINT}?author=${encodeURIComponent(this._authorId)}`);
      if (res.ok) this._syncBucketFromResponse(res);
    } catch (e) {
      console.warn('paintStore: bucket sync failed:', e);
    }
    this._bucketReady = true;
    this._notifyBucket();
  }

  /**
   * Cheat-code refill. Server gates on a REFILL_SECRET env var; we send
   * whatever the caller gives us as the `X-Refill-Secret` header. Returns
   * 'ok' on success, 'forbidden' when the secret is wrong (caller can
   * re-prompt), or 'error' for anything else.
   */
  async tryRefill(secret) {
    if (!this._authorId) return 'error';
    try {
      const res = await fetch(`${REFILL_ENDPOINT}?author=${encodeURIComponent(this._authorId)}`, {
        method:  'POST',
        headers: { 'X-Refill-Secret': secret },
      });
      if (res.status === 403) return 'forbidden';
      if (!res.ok) return 'error';
      this._syncBucketFromResponse(res);
      return 'ok';
    } catch (e) {
      console.warn('paintStore: refill failed:', e);
      return 'error';
    }
  }

  _syncBucketFromResponse(res) {
    const t = res.headers.get('X-Paint-Tokens');
    const r = res.headers.get('X-Paint-Refill-At');
    if (t === null || r === null) return;
    const tokens   = parseFloat(t);
    const refillAt = parseFloat(r);
    if (!Number.isFinite(tokens) || !Number.isFinite(refillAt)) return;
    this._bucketTokens   = tokens;
    this._bucketRefillAt = refillAt;
    const cap  = parseFloat(res.headers.get('X-Paint-Capacity'));
    const ms   = parseFloat(res.headers.get('X-Paint-Refill-Ms'));
    if (Number.isFinite(cap) && cap > 0) this._bucketCapacity = cap;
    if (Number.isFinite(ms)  && ms  > 0) this._bucketRefillMs = ms;
    this._notifyBucket();
  }

  _notifyBucket() {
    if (this._bucketListeners.size === 0) return;
    const s = this.getBucketState();
    for (const fn of this._bucketListeners) fn(s);
  }

  // ── Tile ↔ cell tracking ───────────────────────────────────────────────────

  _buildingKeyOf(cellKey) {
    // Buildings: "buildingId:meshType:cu:cv:centroidKey:pdKey"  (strip 4)
    // Terrain:   "terrain_gx_gz:meshType:ix:iz:iy"              (strip 3)
    // Robust against colons inside buildingId.
    const parts = cellKey.split(':');
    const trailing = cellKey.startsWith('terrain_') ? 3 : 4;
    for (let i = 0; i < trailing; i++) parts.pop();
    return parts.join(':');
  }

  _trackCellTile(cellKey) {
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (!tileId) return;
    let set = this._cellsByTile.get(tileId);
    if (!set) { set = new Set(); this._cellsByTile.set(tileId, set); }
    set.add(cellKey);
  }

  _untrackCellTile(cellKey) {
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (!tileId) return;
    const set = this._cellsByTile.get(tileId);
    if (set) set.delete(cellKey);
  }

  _markDirty(cellKey, valueOrNull) {
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (!tileId) return; // orphaned cell (building not registered) — can't attribute
    this._dirty(tileId).set(cellKey, valueOrNull);
    // Paint/erase over a seeded or undo-origin cell promotes it to user
    // origin — next flush should be charged for it.
    const seedSet = this._seedDirtyByTile.get(tileId);
    if (seedSet) seedSet.delete(cellKey);
    const undoSet = this._undoDirtyByTile.get(tileId);
    if (undoSet) undoSet.delete(cellKey);
  }

  _markDirtyUndo(cellKey, valueOrNull) {
    const tileId = this._tileOfBuilding.get(this._buildingKeyOf(cellKey));
    if (!tileId) return;
    this._dirty(tileId).set(cellKey, valueOrNull);
    // A recent undo over a seed still "replaces" that write; drop it from
    // the seed set so the envelope correctly reports the last-writer origin.
    const seedSet = this._seedDirtyByTile.get(tileId);
    if (seedSet) seedSet.delete(cellKey);
    let undoSet = this._undoDirtyByTile.get(tileId);
    if (!undoSet) { undoSet = new Set(); this._undoDirtyByTile.set(tileId, undoSet); }
    undoSet.add(cellKey);
  }

  _markSeedDirty(tileId, cellKey) {
    let set = this._seedDirtyByTile.get(tileId);
    if (!set) { set = new Set(); this._seedDirtyByTile.set(tileId, set); }
    set.add(cellKey);
  }

  _dirty(tileId) {
    let m = this._dirtyCells.get(tileId);
    if (!m) { m = new Map(); this._dirtyCells.set(tileId, m); }
    return m;
  }

  _pendingTileCount() {
    let n = 0;
    for (const m of this._dirtyCells.values()) if (m.size > 0) n++;
    return n;
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

  // ── Persistence: save ──────────────────────────────────────────────────────

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
    const tiles = [];
    for (const [tileId, m] of this._dirtyCells) if (m.size > 0) tiles.push(tileId);
    if (!tiles.length) return;
    await Promise.all(tiles.map(t => this._flushTile(t)));
  }

  /**
   * Best-effort flush during page unload. A normal await-fetch won't complete
   * reliably once the browser starts tearing down, so fire each tile's PATCH
   * with { keepalive: true } — the request survives page close.
   */
  _flushSaveBeacon() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    for (const [tileId, dirty] of this._dirtyCells) {
      if (dirty.size === 0) continue;
      const body = this._buildPatchBody(tileId, dirty);
      try {
        fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          keepalive: true,
        });
      } catch {}
      dirty.clear();
      this._seedDirtyByTile.delete(tileId);
      this._undoDirtyByTile.delete(tileId);
    }
  }

  /** Build a PATCH body from the given dirty map. Stamps __seed:true or
   *  __undo:true when every dirty entry shares that origin — the server
   *  exempts those batches from the token bucket. Seed takes precedence
   *  (can only ever be true for seed-batched flushes, never mixed). Mixed
   *  flushes (user paint + undo in the same 500ms debounce window) get
   *  neither flag and pay full price; that's rare enough to not matter. */
  _buildPatchBody(tileId, dirty) {
    const seedSet = this._seedDirtyByTile.get(tileId);
    const undoSet = this._undoDirtyByTile.get(tileId);
    const isSeedOnly = !!seedSet && seedSet.size === dirty.size;
    const isUndoOnly = !isSeedOnly && !!undoSet && undoSet.size === dirty.size;
    const body = { __ts: Date.now(), __author: this._authorId };
    if (isSeedOnly) body.__seed = true;
    if (isUndoOnly) body.__undo = true;
    for (const [k, v] of dirty) body[k] = v;
    return body;
  }

  async _flushTile(tileId) {
    const dirty = this._dirtyCells.get(tileId);
    if (!dirty || dirty.size === 0) return;

    // Snapshot & clear optimistically so further paints during the fetch
    // accumulate in a fresh dirty map. On failure we merge the snapshot back
    // (with newer writes winning, since they're already in the fresh map).
    const snapshot = dirty;
    this._dirtyCells.set(tileId, new Map());
    const body = this._buildPatchBody(tileId, snapshot);
    this._seedDirtyByTile.delete(tileId);
    this._undoDirtyByTile.delete(tileId);
    this._savesInFlight.add(tileId);

    const t = performance.now();
    try {
      const res = await fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      this._syncBucketFromResponse(res);
      if (res.status === 429) {
        // Server rejected the batch (rate-limited). Local bucket was just
        // re-synced to the server's view; the optimistic paints we applied
        // locally are now phantom — the next pull loop reconciles them.
        // Don't re-queue.
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get('etag');
      if (etag) this._tileETags.set(tileId, etag);
    } catch (e) {
      console.warn(`paintStore: save tile ${tileId} failed:`, e);
      const current = this._dirtyCells.get(tileId);
      for (const [k, v] of snapshot) if (!current.has(k)) current.set(k, v);
      this._scheduleSave();
    } finally {
      this._savesInFlight.delete(tileId);
      performance.measure('paint:save', { start: t, end: performance.now() });
    }
  }

  // ── Persistence: pull ──────────────────────────────────────────────────────

  /**
   * Set the tiles that should poll on the fast (PULL_ACTIVE_MS) loop. Typically
   * 1–3 tiles: the tile the player is standing in, their current terrain tile,
   * and the tile containing the cell under the crosshair. Every other loaded
   * tile polls on the slower PULL_IDLE_MS loop. Called frequently; cheap.
   */
  setActiveTiles(iterable) {
    this._activeTiles = iterable instanceof Set ? iterable : new Set(iterable);
  }

  /**
   * Pause or resume the pull loops. Used to stop burning server requests when
   * the pointer isn't locked (user is on the menu / afk). Save flushes are
   * NOT paused — pending edits still reach the server. On resume, kicks one
   * fast + one idle pull immediately so the player sees fresh state without
   * waiting out a full interval.
   */
  setPaused(paused) {
    paused = !!paused;
    if (this._paused === paused) return;
    this._paused = paused;
    if (!paused && this._loadedTiles.size > 0) {
      this._pullActive();
      this._pullIdle();
    }
  }

  _startPullLoop() {
    if (!this._pullTimerActive) {
      const tick = async () => {
        this._pullTimerActive = null;
        try { await this._pullActive(); }
        finally {
          if (this._loadedTiles.size > 0) {
            this._pullTimerActive = setTimeout(tick, PULL_ACTIVE_MS);
          }
        }
      };
      this._pullTimerActive = setTimeout(tick, PULL_ACTIVE_MS);
    }
    if (!this._pullTimerIdle) {
      const tick = async () => {
        this._pullTimerIdle = null;
        try { await this._pullIdle(); }
        finally {
          if (this._loadedTiles.size > 0) {
            this._pullTimerIdle = setTimeout(tick, PULL_IDLE_MS);
          }
        }
      };
      this._pullTimerIdle = setTimeout(tick, PULL_IDLE_MS);
    }
  }

  async _pullActive() {
    if (this._paused) return;
    for (const t of this._activeTiles) {
      if (this._loadedTiles.has(t)) await this._pullTile(t);
    }
  }

  async _pullIdle() {
    if (this._paused) return;
    // Round-robin through non-active loaded tiles. With PULL_IDLE_MAX_TILES=20
    // and typical 25-tile load set, every idle tile is pulled within 1–2 ticks
    // (20–40 s). Excluding active tiles avoids double-polling the fast set.
    const all = [];
    for (const t of this._loadedTiles) if (!this._activeTiles.has(t)) all.push(t);
    if (!all.length) return;
    let start = 0;
    if (this._pullCursorIdle) {
      const idx = all.indexOf(this._pullCursorIdle);
      if (idx >= 0) start = (idx + 1) % all.length;
    }
    const take = Math.min(PULL_IDLE_MAX_TILES, all.length);
    for (let i = 0; i < take; i++) {
      const t = all[(start + i) % all.length];
      this._pullCursorIdle = t;
      await this._pullTile(t);
    }
  }

  async _pullTile(tileId) {
    if (!this._loadedTiles.has(tileId)) return;
    if (this._savesInFlight.has(tileId)) return;
    if ((this._dirtyCells.get(tileId)?.size ?? 0) > 0) return;

    const etag = this._tileETags.get(tileId);
    let res;
    try {
      res = await fetch(`${TILE_ENDPOINT}/${encodeURIComponent(tileId)}`, {
        headers: etag ? { 'if-none-match': etag } : {},
      });
    } catch { return; }

    if (res.status === 304) return;
    if (!res.ok) return;

    const newETag = res.headers.get('etag');
    let server;
    try { server = await res.json(); } catch { return; }

    // Re-check after awaits: if a save started or a paint landed while we
    // were fetching, drop this pull — next cycle catches up with a fresh ETag.
    if (!this._loadedTiles.has(tileId)) return;
    if (this._savesInFlight.has(tileId)) return;
    if ((this._dirtyCells.get(tileId)?.size ?? 0) > 0) return;

    this._applyServerState(tileId, server);
    if (newETag) this._tileETags.set(tileId, newETag);
  }

  _applyServerState(tileId, server) {
    let localSet = this._cellsByTile.get(tileId);
    if (!localSet) { localSet = new Set(); this._cellsByTile.set(tileId, localSet); }

    const seen = new Set();
    const touched = new Set();

    // Forward pass: apply server → local for every server-known cell.
    // The dirty-set guard in _pullTile has already filtered out tiles with
    // pending writes, so we don't re-check per-cell here.
    for (const k in server) {
      if (k === SEED_COMPLETE_KEY) {
        this._seedCompleteTiles.add(tileId);
        continue;
      }
      seen.add(k);
      const v = server[k];
      const local = this.cells.get(k);
      // Server's own merge uses the paintedAt tiebreaker already, so anything
      // we receive is server-canonical. Skip redundant writes to avoid a
      // useless rebuild of a building whose paint didn't actually change.
      if (local &&
          local.color     === v.color &&
          local.paintedAt === v.paintedAt) continue;
      this.cells.set(k, v);
      this._indexAdd(k);
      localSet.add(k);
      touched.add(this._buildingKeyOf(k));
    }

    // Reverse pass: delete local cells the server no longer has.
    for (const k of [...localSet]) {
      if (seen.has(k)) continue;
      this.cells.delete(k);
      this._indexRemove(k);
      localSet.delete(k);
      touched.add(this._buildingKeyOf(k));
    }

    for (const bk of touched) {
      for (const fn of this._buildingListeners) fn(bk);
    }
  }
}

const EMPTY_SET = new Set();

export const paintStore = new PaintStore();
