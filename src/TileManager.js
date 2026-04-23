import * as THREE from 'three';
import { wrapMeshData } from './loadCityGML.js';
import { paintStore } from './paintStore.js';

// Admit radius. Tiles are admitted when inside MIN and unloaded via sticky
// hysteresis past (admit + UNLOAD_MARGIN), capped at MAX — so a tile you
// entered at the far edge doesn't evict the moment you stand still a few
// metres past it. The cell-budget adaptation that used to stretch the admit
// distance between MIN and MAX was dropped once terrain seeding added a flat
// per-tile cost and the density-sensitive radius felt more confusing than
// useful. The slider (setRadiusScale) scales both MIN and MAX linearly.
const MIN_LOAD_RADIUS = 150; // metres — admit tiles closer than this
const MAX_LOAD_RADIUS = 250; // metres — sticky ceiling (past this, always unload)
const UNLOAD_MARGIN   = 50;  // metres of hysteresis past a tile's admit distance

// Spatial index: coarse grid cell size. tick() checks a 5×5 neighbourhood of
// coarse cells (~2500 m reach), so up to ~25 cells × a handful of tiles each
// instead of iterating the entire manifest (5k–10k tiles) every frame.
const COARSE_GRID = 500; // metres per coarse cell
const COARSE_REACH = 2;  // cells in each direction from the player's cell

// How many tile fetches may be in flight at once. More than 1 drains the load
// queue faster when entering a new area without meaningful memory spike risk.
const MAX_CONCURRENT_LOADS = 4;

// Size of the worker pool. A single worker serialises all tile scans on one
// thread; with 2 workers the fetch+scan pipelines for two tiles run in
// parallel, which cuts initial-burst load time roughly in half on multi-core
// machines. Raising further shows diminishing returns because the main thread
// becomes the bottleneck for mesh-wrap + GPU upload.
const NUM_WORKERS = 2;

/**
 * Manages dynamic loading and unloading of building tiles as the player moves.
 *
 * Tiles within MIN_LOAD_RADIUS × radiusScale load; per-tile sticky hysteresis
 * keeps them loaded up to (admit + UNLOAD_MARGIN), capped at MAX_LOAD_RADIUS,
 * so grazing passes don't thrash and the slider can trim the outer band
 * cleanly.
 *
 * Paint data is fetched per tile from /api/paint/:tileId when a tile loads
 * (see paintStore.loadTile) and flushed back with a PUT when a tile unloads,
 * so graffiti survives reloads without round-tripping through the client.
 */
export class TileManager {
  /**
   * @param {object} deps
   * @param {THREE.Scene}  deps.scene
   * @param {THREE.Mesh[]} deps.buildingMeshes   — master list (mutated in place)
   * @param {THREE.Mesh[]} deps.collidables       — master list (mutated in place)
   * @param {Map}          deps.buildingMeshMap   — "buildingId:meshType" → mesh
   * @param {Map}          deps.cellGeomCache     — cellKey → Float32Array
   * @param {Map}          deps.cellGeomByBuilding — "buildingId:meshType" → Set<cellKey>
   * @param {Map}          deps.cellGroups        — cellKey → shared Set<cellKey> (paint group)
   * @param {Map}          deps.cellGroupKeysByBuilding — "buildingId:meshType" → Set<cellKey> (for unload cleanup)
   * @param {Map}          deps.buildingPaintMeshes — "buildingId:meshType" → mesh
   * @param {Map}          deps.buildingPaintMeshByBuilding — "buildingId:meshType" → Set<mesh>
   * @param {THREE.Group}  deps.paintGroup
   * @param {function}     deps.onTileLoaded(meshes)     — fires when wrapped meshes are in the scene (phase 1)
   * @param {function}     deps.onTileCellData(meshes)   — fires when seed/cell data has been attached (phase 2)
   * @param {function}     deps.onTileUnloaded()         — fires after tile meshes are removed
   * @param {object}       deps.seedConfig               — { fraction, colors: number[] } forwarded to worker
   * @param {function}     [deps.resolveTileInjection]   — optional (tileId) =>
   *      null                                — load normally, no injection.
   *      'pending'                           — defer this tile until next tick (e.g. landmark Y not yet resolved).
   *      { injectedBuildings, hideBuildingIds } — load with this payload forwarded to the worker.
   *      Used by the landmark override layer (see src/landmarks.js).
   */
  constructor(deps) {
    this._scene               = deps.scene;
    this._buildingMeshes      = deps.buildingMeshes;
    this._collidables         = deps.collidables;
    this._buildingMeshMap     = deps.buildingMeshMap;
    this._cellGeomCache       = deps.cellGeomCache;
    this._cellGeomByBuilding  = deps.cellGeomByBuilding;
    this._cellGroups               = deps.cellGroups;
    this._cellGroupKeysByBuilding  = deps.cellGroupKeysByBuilding;
    this._buildingPaintMeshes          = deps.buildingPaintMeshes;
    this._buildingPaintMeshByBuilding  = deps.buildingPaintMeshByBuilding;
    this._paintGroup                   = deps.paintGroup;
    this._onTileLoaded        = deps.onTileLoaded;
    this._onTileCellData      = deps.onTileCellData;
    this._onTileUnloaded      = deps.onTileUnloaded;
    this._seedConfig          = deps.seedConfig;
    this._resolveTileInjection = deps.resolveTileInjection ?? null;

    // Map<tileId, TileState>
    this._tiles = new Map();

    // Spatial index: Map<"gx,gz", tile[]>.
    this._spatialIndex = new Map();

    this._manifestLoaded = false;

    // Concurrent load tracking.
    this._activeLoads = 0;
    this._loadQueue   = []; // tiles waiting to load
    this._lastPx = 0;  // most recent player XZ, used to prioritise the queue by distance
    this._lastPz = 0;

    // Effective load radius exposed to main.js for fog / camera.far / cull.
    // Normally equals MIN_LOAD_RADIUS × _radiusScale, but extended each tick
    // to cover the farthest corner of any sticky-held tile past that band so
    // loaded meshes never sit outside the cull radius.
    this._effectiveLoadRadius = MIN_LOAD_RADIUS;

    // User-facing render-distance multiplier. 1 = defaults above. Scales MIN
    // and MAX linearly.
    this._radiusScale = 1;

    // Scratch container reused across ticks to avoid per-frame allocation.
    this._tickCandidates = [];

    // Track currently-loaded tiles so tick() can skim them for "outside the
    // candidate window" (e.g. after a teleport) without iterating the full
    // manifest — which is 5k–10k entries.
    this._loadedTiles = new Set();

    // Off-thread tile loader. Two phases: 'loaded' carries the mesh typed
    // arrays (fast path so the spawn gate can open), 'cellData' carries the
    // seed scan result (applied later; game is already interactive by then).
    //
    // A pool of NUM_WORKERS runs tile scans in parallel. Each incoming load
    // goes to the worker with the fewest in-flight tiles (ties break to the
    // lowest index). The worker is considered busy from dispatch until its
    // 'cellData' (or 'error') arrives — that's the end of the sync work in
    // onLoadMessage. A single _pendingLoads map is safe because tileIds are
    // globally unique; the worker-index is tracked separately so we know
    // which slot to free on completion.
    this._pendingLoads = new Map(); // tileId → { resolve, reject }
    this._tileToWorker = new Map(); // tileId → workerIdx (cleared on 'cellData'/'error')
    this._workers      = [];
    this._workerLoad   = []; // per-worker in-flight count, drives least-loaded dispatch
    for (let i = 0; i < NUM_WORKERS; i++) {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._handleWorkerMessage(e);
      w.onerror   = (e) => console.error(`TileManager worker ${i} error:`, e.message);
      this._workers.push(w);
      this._workerLoad.push(0);
    }
  }

  _handleWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'loaded') {
      const pending = this._pendingLoads.get(msg.tileId);
      if (!pending) return;
      this._pendingLoads.delete(msg.tileId);
      pending.resolve(msg.meshes);
    } else if (msg.type === 'cellData') {
      this._releaseWorkerSlot(msg.tileId);
      this._handleCellData(msg.tileId, msg.cellData);
    } else if (msg.type === 'error') {
      this._releaseWorkerSlot(msg.tileId);
      const pending = this._pendingLoads.get(msg.tileId);
      if (!pending) return;
      this._pendingLoads.delete(msg.tileId);
      pending.reject(new Error(msg.error));
    }
  }

  _releaseWorkerSlot(tileId) {
    const idx = this._tileToWorker.get(tileId);
    if (idx === undefined) return;
    this._tileToWorker.delete(tileId);
    this._workerLoad[idx]--;
  }

  /**
   * Phase 2 message handler. If the main thread is still chunk-wrapping phase
   * 1 (tile.status === 'loading'), stash the payload on the tile so _doLoad
   * applies it the moment tile.meshes is populated. Otherwise apply now.
   */
  _handleCellData(tileId, cellData) {
    const tile = this._tiles.get(tileId);
    if (!tile) return;
    if (tile.status === 'unloaded') return; // abandoned mid-scan
    if (tile.status === 'loading') {
      tile._pendingCellData = cellData;
      return;
    }
    this._applyCellDataToTile(tile, cellData);
  }

  async _applyCellDataToTile(tile, cellData) {
    // One merged mesh per building now holds both meshTypes (tileWorker
    // buildMergedMeshData). Match CellBundle → mesh by buildingId only, and
    // stash per-meshType cellData as `cellDataByType[meshType]` so
    // seedTileCells can iterate both without overwriting.
    const meshByBuildingId = new Map();
    for (const m of tile.meshes) {
      meshByBuildingId.set(m.userData.buildingId, m);
    }
    for (const cd of cellData) {
      const mesh = meshByBuildingId.get(cd.buildingId);
      if (!mesh) continue;
      if (!mesh.userData.cellDataByType) mesh.userData.cellDataByType = {};
      mesh.userData.cellDataByType[cd.meshType] = {
        cellKeys:   cd.cellKeys,
        cellGeoms:  cd.cellGeoms,
        seeds:      cd.seeds,
        cellGroups: cd.cellGroups,
      };
    }

    // Wait for server-saved paint to land before letting seedTileCells run —
    // otherwise fresh seeds get saved as authoritative state and any cells
    // that were already stored on the server would be overwritten.
    if (tile._paintLoadPromise) {
      try { await tile._paintLoadPromise; }
      catch (e) { console.warn(`TileManager: paint load for ${tile.id} failed:`, e); }
    }
    if (tile.status === 'unloaded') return; // drifted out of range while we awaited

    if (this._onTileCellData) this._onTileCellData(tile.meshes);
  }

  _fetchTileViaWorker(tileId, file, injection) {
    return new Promise((resolve, reject) => {
      this._pendingLoads.set(tileId, { resolve, reject });
      let idx = 0;
      for (let i = 1; i < this._workers.length; i++) {
        if (this._workerLoad[i] < this._workerLoad[idx]) idx = i;
      }
      this._workerLoad[idx]++;
      this._tileToWorker.set(tileId, idx);
      // Landmark tris ride as a structured clone (not transferred) so the
      // landmarks.js cache stays intact across tile reload cycles. A landmark
      // is a few hundred floats — the memcpy is in the noise.
      this._workers[idx].postMessage({
        type: 'load', tileId, file,
        seedConfig:        this._seedConfig,
        hideBuildingIds:   injection?.hideBuildingIds,
        injectedBuildings: injection?.injectedBuildings,
      });
    });
  }

  /**
   * Load the tile manifest and kick off the initial tick.
   */
  async init(manifestUrl = '/tiles/manifest.json') {
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`TileManager: manifest fetch failed (HTTP ${res.status})`);
    const entries = await res.json();

    for (const entry of entries) {
      // The manifest carries only (gx, gz, bounds); id and file are derived
      // from the grid coord since tiles live on a deterministic URL.
      const id   = `cell_${entry.gx}_${entry.gz}`;
      const file = `${import.meta.env.VITE_CDN_BASE ?? ''}/tiles/cell_${entry.gx}_${entry.gz}.bin`;
      const tile = {
        id,
        file,
        bounds: entry.bounds,
        status: 'unloaded', // 'unloaded' | 'loading' | 'loaded'
        meshes: [],
      };
      this._tiles.set(id, tile);
      this._indexTile(tile);
    }
    this._manifestLoaded = true;

    // The render loop's first tick (~16ms after init resolves) picks up the
    // real camera position and enqueues the correct tiles. We deliberately
    // don't tick here — an earlier incarnation called tick(0,0), which started
    // loading tiles around the origin even though the player spawns thousands
    // of metres away.
  }

  /**
   * Current effective load radius (metres). Exposed so main.js can match
   * CULL_RADIUS, fog, and camera.far to it, and OsmManager can scale its own
   * radius in proportion.
   */
  getLoadRadius() { return this._effectiveLoadRadius; }

  /**
   * Set the user-facing render-distance multiplier (see _radiusScale). A
   * shrinking scale forcibly unloads tiles outside the new scaled radius
   * (bypassing sticky hysteresis) — sticky hysteresis is there to smooth
   * grazing passes, not deliberate user actions.
   */
  setRadiusScale(s) {
    const shrinking = s < this._radiusScale;
    this._radiusScale = s;
    if (shrinking) {
      const cutoff = (MAX_LOAD_RADIUS * s + UNLOAD_MARGIN) ** 2;
      const doomed = [];
      for (const tile of this._loadedTiles) {
        if (!isFinite(tile.bounds.minX)) continue;
        const d2 = _closestDist2(this._lastPx, this._lastPz, tile.bounds);
        if (d2 > cutoff) doomed.push(tile);
      }
      for (const tile of doomed) this._unload(tile);
    }
  }

  /**
   * True when the TELEPORT_GATE_TILES finite-bounds tiles nearest (px, pz) are
   * all loaded (or fewer exist within the admit range, in which case all of
   * them). Range matches MIN_LOAD_RADIUS × scale — the tick's admit distance —
   * so tiles sitting in the sticky band (150–250 m) don't block the gate
   * forever waiting to load, since tick won't admit them in the first place.
   */
  allNearbyTilesLoaded(px, pz) {
    const TELEPORT_GATE_TILES = 2;
    const maxR2 = (MIN_LOAD_RADIUS * this._radiusScale) ** 2;
    const pgx = Math.floor(px / COARSE_GRID);
    const pgz = Math.floor(pz / COARSE_GRID);
    const nearest = [];
    const seen = new Set();
    for (let dx = -COARSE_REACH; dx <= COARSE_REACH; dx++) {
      for (let dz = -COARSE_REACH; dz <= COARSE_REACH; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          const d2 = _closestDist2(px, pz, tile.bounds);
          if (d2 > maxR2) continue;
          nearest.push({ tile, d2 });
        }
      }
    }
    if (nearest.length === 0) return true; // open water / no tiles within reach
    nearest.sort(_byDist2);
    const count = Math.min(TELEPORT_GATE_TILES, nearest.length);
    for (let i = 0; i < count; i++) {
      const s = nearest[i].tile.status;
      if (s !== 'loaded' && s !== 'missing') return false;
    }
    return true;
  }

  /** Pick a random XZ position inside a random manifest tile. */
  randomLocation() {
    const tiles = [...this._tiles.values()];
    if (tiles.length === 0) return null;
    const b = tiles[Math.floor(Math.random() * tiles.length)].bounds;
    return {
      x: b.minX + Math.random() * (b.maxX - b.minX),
      z: b.minZ + Math.random() * (b.maxZ - b.minZ),
    };
  }

  /**
   * Shortest distance (metres) from (x, z) to the AABB of any finite-bounds
   * manifest tile. Building tile AABBs are tight around their buildings, so
   * this doubles as a "is this point near a building?" proxy — used by the
   * street-spawn picker to reject points stranded in open space. Queries a
   * 3×3 neighbourhood of the coarse spatial index; Infinity if none in range.
   */
  distanceToNearestBuildingTile(x, z) {
    const pgx = Math.floor(x / COARSE_GRID);
    const pgz = Math.floor(z / COARSE_GRID);
    let min2 = Infinity;
    const seen = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          const b = tile.bounds;
          if (!isFinite(b.minX)) continue;
          const d2 = _closestDist2(x, z, b);
          if (d2 < min2) min2 = d2;
        }
      }
    }
    return Math.sqrt(min2);
  }

  /**
   * Call once per frame from the render loop. Cheap: AABB distance checks on
   * a small spatial neighbourhood instead of the full manifest.
   * Starts async loads/unloads as needed.
   */
  tick(px, pz) {
    this._lastPx = px;
    this._lastPz = pz;

    // ── Pass 1: collect finite-bounds candidates from the coarse neighbourhood
    // inside MIN_LOAD_RADIUS, paired with their squared distance. We reuse a
    // scratch array to avoid per-frame allocation on the hot path.
    const candidates = this._tickCandidates;
    candidates.length = 0;

    const scale     = this._radiusScale;
    const scaledMin = MIN_LOAD_RADIUS * scale;
    const scaledMax = MAX_LOAD_RADIUS * scale;
    const minR2     = scaledMin ** 2;
    const pgx = Math.floor(px / COARSE_GRID);
    const pgz = Math.floor(pz / COARSE_GRID);
    const visited = new Set();
    for (let dx = -COARSE_REACH; dx <= COARSE_REACH; dx++) {
      for (let dz = -COARSE_REACH; dz <= COARSE_REACH; dz++) {
        const bucket = this._spatialIndex.get(`${pgx + dx},${pgz + dz}`);
        if (!bucket) continue;
        for (const tile of bucket) {
          if (visited.has(tile)) continue;
          visited.add(tile);
          const d2 = _closestDist2(px, pz, tile.bounds);
          if (d2 > minR2) continue;
          candidates.push({ tile, d2 });
        }
      }
    }

    // Drop queued tiles that drifted past their own admit-based sticky
    // threshold while waiting. Active (in-flight) tiles are left to complete.
    if (this._loadQueue.length > 0) {
      for (let i = this._loadQueue.length - 1; i >= 0; i--) {
        const tile = this._loadQueue[i];
        const qd2 = _closestDist2(px, pz, tile.bounds);
        if (qd2 > _stickyUnloadR2(tile, scaledMax)) {
          tile.status = 'unloaded';
          tile.admittedAtD2 = 0;
          tile.lastUnloadD2 = qd2;
          this._loadQueue.splice(i, 1);
        }
      }
    }

    // ── Pass 2: enqueue unloaded candidates; sticky-unload tiles that fell
    // outside the admit-distance threshold. Each tile records its admit
    // distance on enqueue, and is only unloaded when the player has moved
    // past admitDistance + UNLOAD_MARGIN (capped at MAX).
    //
    // Re-admit gate (lastUnloadD2): a tile that just unloaded at distance D is
    // blocked from re-admission until the player is closer than D. Without
    // this, flying past a tile can trigger render → unload (sticky) → render
    // again, because the unload threshold (admit + UNLOAD_MARGIN) sits inside
    // MIN and pass 1 happily re-admits.
    //
    // Sort nearest-first so the first MAX_CONCURRENT_LOADS slots go to the
    // closest tiles, not arbitrary ones from the spatial index bucket order.
    candidates.sort(_byDist2);
    for (let i = 0; i < candidates.length; i++) {
      const { tile, d2 } = candidates[i];
      if (tile.status === 'unloaded') {
        if (tile.lastUnloadD2 != null && d2 >= tile.lastUnloadD2) continue;
        // Resolve landmark injection before admitting. 'pending' means a
        // landmark in this tile is still waiting on its terrain Y — defer
        // the load and try again next tick. Skipping here is safer than
        // racing the load against landmark prep.
        let injection = null;
        if (this._resolveTileInjection) {
          injection = this._resolveTileInjection(tile.id);
          if (injection === 'pending') continue;
        }
        tile._injection = injection;
        this._enqueueLoad(tile, d2);
      }
    }

    // Loaded tiles past their sticky threshold unload. Scans _loadedTiles
    // (not candidates) so teleported-away tiles outside the coarse window
    // still get evicted.
    for (const tile of this._loadedTiles) {
      const d2 = _closestDist2(px, pz, tile.bounds);
      if (d2 > _stickyUnloadR2(tile, scaledMax)) this._unload(tile);
    }

    // Publish the effective radius AFTER unload decisions, extended to cover
    // any sticky-loaded tiles that sit past the nominal radius. main.js uses
    // this for the cull radius, fog density, and camera.far.
    //
    // Use each loaded tile's FARTHEST AABB corner, not the closest point. The
    // per-mesh cull in main.js compares mesh *center* distance to r; a mesh
    // center is inside its tile's AABB, so its distance ≥ the AABB's closest
    // distance. If r only covered the closest point, a boundary tile's meshes
    // would sit right at (or past) r and flicker in/out as small player
    // motion shifted r by a few metres. Covering the farthest corner
    // guarantees r ≥ any mesh center within any loaded tile.
    let effectiveR2 = minR2;
    for (const tile of this._loadedTiles) {
      const d2 = _farthestDist2(px, pz, tile.bounds);
      if (d2 > effectiveR2) effectiveR2 = d2;
    }
    this._effectiveLoadRadius = Math.sqrt(effectiveR2);
  }

  /**
   * Iterate loaded tiles — yields `{ bounds, group, meshes }` via the tile
   * state object. Used by main.js#updateCulling to short-circuit out-of-range
   * tiles at the group level before walking individual meshes.
   */
  *tiles() {
    for (const tile of this._tiles.values()) {
      if (tile.status === 'loaded' && tile.group) yield tile;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** Insert a tile into the spatial index. */
  _indexTile(tile) {
    const { minX, maxX, minZ, maxZ } = tile.bounds;
    const gx0 = Math.floor(minX / COARSE_GRID);
    const gx1 = Math.floor(maxX / COARSE_GRID);
    const gz0 = Math.floor(minZ / COARSE_GRID);
    const gz1 = Math.floor(maxZ / COARSE_GRID);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = `${gx},${gz}`;
        let bucket = this._spatialIndex.get(key);
        if (!bucket) { bucket = []; this._spatialIndex.set(key, bucket); }
        bucket.push(tile);
      }
    }
  }

  _checkTile(tile, loadR2, unloadR2, d2) {
    if (tile.status === 'unloaded' && d2 < loadR2) {
      this._enqueueLoad(tile);
    } else if (tile.status === 'loaded' && d2 > unloadR2) {
      this._unload(tile);
    }
    // 'loading' tiles are left alone until their promise resolves.
  }

  _enqueueLoad(tile, d2) {
    tile.status = 'loading'; // mark immediately so tick() doesn't re-queue it
    // Sticky admit distance: the unload check uses this, so a tile stays
    // loaded until the player has genuinely moved past (admit + UNLOAD_MARGIN)
    // from its AABB.
    tile.admittedAtD2 = d2;
    if (this._activeLoads < MAX_CONCURRENT_LOADS) {
      this._doLoad(tile);
    } else {
      this._loadQueue.push(tile);
    }
  }

  _drainQueue() {
    this._activeLoads--;
    // Start queued tiles nearest to the player first, so the building they're
    // currently flying toward lands before buildings behind them.
    while (this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length > 0) {
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

  async _doLoad(tile) {
    this._activeLoads++;
    const tLoad = performance.now();
    try {
      // Worker returns an array of MeshData objects with Float32Array buffers
      // already transferred in. All heavy math (UV, normals, bbox, Y-shift)
      // has already happened off-thread — we only need to wrap typed arrays
      // into a THREE.Mesh and add it to the scene.
      // tile._injection (if any) was stashed by tick() at admit time — see
      // the resolveTileInjection contract.
      const meshDataList = await this._fetchTileViaWorker(tile.id, tile.file, tile._injection);
      tile._injection = null;
      const tReceived = performance.now();
      performance.measure('tile:wait', { start: tLoad, end: tReceived });

      // If the player flew past this tile's sticky threshold while the worker
      // was busy, adding the meshes would cause a load→immediate-unload flash.
      // Bail before touching the scene; the pass-2 re-admit gate (lastUnloadD2)
      // then keeps us from re-queuing this tile while still flying away.
      const d2Now = _closestDist2(this._lastPx, this._lastPz, tile.bounds);
      const scaledMax = MAX_LOAD_RADIUS * this._radiusScale;
      if (d2Now > _stickyUnloadR2(tile, scaledMax)) {
        tile.status = 'unloaded';
        tile.admittedAtD2 = 0;
        tile.lastUnloadD2 = d2Now;
        tile._pendingCellData = null;
        return;
      }

      // One Group per tile lets the renderer short-circuit scene traversal for
      // out-of-range tiles via a single group.visible=false (main.js#updateCulling),
      // instead of walking every invisible mesh individually every frame.
      const tileGroup = new THREE.Group();
      tileGroup.name = `tile:${tile.id}`;
      tile.group = tileGroup;
      this._scene.add(tileGroup);

      const CHUNK  = 20;
      const meshes = [];
      for (let start = 0; start < meshDataList.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, meshDataList.length);
        for (let i = start; i < end; i++) {
          const mesh = wrapMeshData(meshDataList[i]);
          mesh.visible = false; // updateCulling() reveals in-range meshes after load
          tileGroup.add(mesh);
          this._buildingMeshes.push(mesh);
          this._collidables.push(mesh);
          // One merged mesh covers both meshTypes; register each buildingKey
          // so rebuildBuildingPaint(bk) lookups still resolve to the mesh.
          for (const bk of mesh.userData.buildingKeys) {
            this._buildingMeshMap.set(bk, mesh);
          }
          meshes.push(mesh);
        }
        if (end < meshDataList.length) await new Promise(r => requestIdleCallback(r, { timeout: 100 }));
      }
      performance.measure('tile:wrap', { start: tReceived, end: performance.now() });

      tile.meshes = meshes;
      tile.status = 'loaded';
      tile.lastUnloadD2 = null;
      this._loadedTiles.add(tile);

      // Kick off the paint fetch in parallel with phase 2. _applyCellDataToTile
      // awaits this promise before calling onTileCellData, so seedTileCells
      // runs with server-saved paint already populated in paintStore.
      const loadBuildingKeys = meshes.flatMap(m => m.userData.buildingKeys);
      tile._paintLoadPromise = paintStore.loadTile(tile.id, loadBuildingKeys);

      this._onTileLoaded(meshes);

      // Phase 2 (cellData) may have arrived while we were chunk-wrapping.
      // Apply it now so seedTileCells runs on this tile's meshes.
      if (tile._pendingCellData) {
        const cd = tile._pendingCellData;
        tile._pendingCellData = null;
        this._applyCellDataToTile(tile, cd);
      }
    } catch (e) {
      if (e.message === 'NOT_READY') {
        // Tile file hasn't been built yet (e.g. build_tiles.py still running).
        // Mark 'missing' so tick() won't keep retrying, and log once per tile.
        tile.status = 'missing';
        if (!this._warnedMissing) this._warnedMissing = new Set();
        if (!this._warnedMissing.has(tile.id)) {
          this._warnedMissing.add(tile.id);
          console.warn(`TileManager: tile "${tile.id}" not built yet — skipping`);
        }
      } else {
        console.error(`TileManager: failed to load tile "${tile.id}":`, e);
        tile.status = 'unloaded'; // allow retry on next tick
      }
    } finally {
      this._drainQueue();
    }
  }

  _unload(tile) {
    const tUnload = performance.now();

    // Collect the building keys this tile owns ("buildingId:meshType") — all
    // cleanup indexes are scoped to these keys so we never scan the full maps.
    // Each merged mesh covers multiple buildingKeys; read them from userData.
    const buildingKeys = [];
    for (const mesh of tile.meshes) {
      for (const bk of mesh.userData.buildingKeys) buildingKeys.push(bk);
    }

    // Dispose GPU resources; removing the tile's group from the scene orphans
    // all meshes in one shot. BUILDING_MAT is shared across all tiles — do
    // not dispose it.
    for (const mesh of tile.meshes) mesh.geometry.dispose();
    if (tile.group) {
      this._scene.remove(tile.group);
      tile.group = null;
    }

    // Splice tile meshes out of the shared arrays (filter by identity).
    const tileSet = new Set(tile.meshes);
    const keep = m => !tileSet.has(m);
    this._buildingMeshes.splice(0, Infinity, ...this._buildingMeshes.filter(keep));
    this._collidables.splice(0, Infinity,    ...this._collidables.filter(keep));

    for (const bk of buildingKeys) {
      this._buildingMeshMap.delete(bk);

      // Clear cellGeomCache entries via the per-building index — avoids
      // scanning the full cache (tens of thousands of entries at high seed).
      const geomSet = this._cellGeomByBuilding.get(bk);
      if (geomSet) {
        for (const k of geomSet) this._cellGeomCache.delete(k);
        this._cellGeomByBuilding.delete(bk);
      }

      // Same pattern for cellGroups: drop this building's paint-group entries.
      const groupSet = this._cellGroupKeysByBuilding.get(bk);
      if (groupSet) {
        for (const k of groupSet) this._cellGroups.delete(k);
        this._cellGroupKeysByBuilding.delete(bk);
      }

      // Dispose paint overlay meshes via the per-building mesh set. The
      // buildingKey is stashed on each mesh at creation time so we can delete
      // from _buildingPaintMeshes in O(1). Material is shared — never dispose.
      const meshSet = this._buildingPaintMeshByBuilding.get(bk);
      if (meshSet) {
        for (const paintMesh of meshSet) {
          paintMesh.geometry.dispose();
          this._paintGroup.remove(paintMesh);
          this._buildingPaintMeshes.delete(paintMesh.userData.paintMeshKey);
        }
        this._buildingPaintMeshByBuilding.delete(bk);
      }
    }

    tile.meshes = [];
    tile.status = 'unloaded';
    tile.admittedAtD2 = 0;
    tile.lastUnloadD2 = _closestDist2(this._lastPx, this._lastPz, tile.bounds);
    this._loadedTiles.delete(tile);

    // Flush any pending save for this tile and drop its cells from paintStore.
    // Fire-and-forget: the PUT completes in the background; the next loadTile
    // will re-fetch the server state if the player comes back.
    tile._paintLoadPromise = null;
    paintStore.unloadTile(tile.id, buildingKeys);

    this._onTileUnloaded();
    performance.measure('tile:unload', { start: tUnload, end: performance.now() });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Squared distance from point (px, pz) to the nearest point on AABB bounds.
 * Returns 0 when the point is inside the AABB.
 */
function _closestDist2(px, pz, bounds) {
  const cx = Math.max(bounds.minX, Math.min(px, bounds.maxX));
  const cz = Math.max(bounds.minZ, Math.min(pz, bounds.maxZ));
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

/**
 * Squared distance from point (px, pz) to the *farthest* corner of AABB
 * bounds. Used to compute a cull radius that covers every mesh center inside
 * every loaded tile — see the effective-radius comment in tick().
 */
function _farthestDist2(px, pz, bounds) {
  const dx = Math.max(Math.abs(px - bounds.minX), Math.abs(px - bounds.maxX));
  const dz = Math.max(Math.abs(pz - bounds.minZ), Math.abs(pz - bounds.maxZ));
  return dx * dx + dz * dz;
}

function _byDist2(a, b) { return a.d2 - b.d2; }

/**
 * Squared sticky unload threshold for a tile: (admit_distance + UNLOAD_MARGIN)².
 * A tile is only unloaded when the player has moved past this, so tiles you
 * entered at the far edge don't evict the moment you stand still a few metres
 * from their boundary.
 *
 * `maxR` caps the admit distance at the current scaled MAX_LOAD_RADIUS.
 * Without this cap, dropping the render-distance slider wouldn't drop
 * already-loaded far tiles: their historical admit distance would keep the
 * threshold inflated indefinitely.
 *
 * Tiles that were never admitted (admittedAtD2 is 0/undefined) fall back to
 * UNLOAD_MARGIN², which matches the prior behaviour at the inner edge.
 */
function _stickyUnloadR2(tile, maxR) {
  const admittedR = Math.min(Math.sqrt(tile.admittedAtD2 || 0), maxR);
  const r = admittedR + UNLOAD_MARGIN;
  return r * r;
}
