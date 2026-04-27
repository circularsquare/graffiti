// Only legitimate tile names from the client: cell_<gx>_<gz> for buildings,
// terrain_<gx>_<gz> for terrain. Both gx/gz can be negative. Rejecting
// anything else stops PATCHes that create top-level R2 blobs with arbitrary
// names (e.g. /paint/<buildingId>), which legit clients never produce.
const TILE_ID_RE  = /^(cell|terrain)_-?\d+_-?\d+$/;
const AUTHOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// CellKeys are colon-joined strings of alphanumerics, underscores, hyphens,
// digits and minus signs. Capped at 200 chars — real keys top out around 60.
const CELL_KEY_RE = /^[A-Za-z0-9_:\-]{1,200}$/;
const MAX_BODY    = 1 * 1024 * 1024; // 1 MB — full-tile rewrites are ~hundreds of KB
// Paint timestamps further than this in the future are rejected. Allows
// modest client clock skew without giving attackers a way to perma-win merge
// tiebreakers by claiming year 9999.
const PAINTED_AT_FUTURE_TOLERANCE_MS = 60_000;
// Max cell entries per PATCH. Sized so a user who painted offline for ~10
// minutes (their full 500-token bucket plus refill) still fits, with margin.
// Stops a single hand-crafted request from rewriting an entire tile in one
// shot.
const MAX_CELLS_PER_PATCH = 1200;
const ORIGIN     = 'https://graffiti.anita.garden';
const MAX_CAS_ATTEMPTS = 5;
const AUDIT_TTL_SECONDS = 14 * 24 * 60 * 60;

// Token bucket: capacity N, refill one token per REFILL_MS. Applied per cell
// write (paint or erase). Seeds are exempt (__seed flag). Bucket state lives
// on the AUDIT KV under `bucket:<authorId>`; after BUCKET_TTL_SECONDS of
// inactivity it vanishes and the user gets a fresh full bucket next visit.
const BUCKET_CAPACITY = 500;
const BUCKET_REFILL_MS = 10_000;
const BUCKET_TTL_SECONDS = 7 * 24 * 60 * 60;
const SEED_COMPLETE_KEY = '__seed_complete__';

const CORS = {
  'Access-Control-Allow-Origin':   ORIGIN,
  'Access-Control-Allow-Methods':  'GET, PATCH, POST',
  'Access-Control-Allow-Headers':  'Content-Type, If-None-Match, X-Refill-Secret',
  'Access-Control-Expose-Headers': 'ETag, X-Paint-Tokens, X-Paint-Refill-At, X-Paint-Capacity, X-Paint-Refill-Ms',
};

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      // Any uncaught throw (R2 hiccup, KV timeout, etc.) would otherwise
      // surface as Cloudflare's CORS-less error page — which the browser
      // mislabels as a CORS failure. Return a proper 500 with CORS so the
      // client's circuit breaker sees a real HTTP error and retries cleanly.
      return new Response(JSON.stringify({ error: 'internal', message: String(e?.message ?? e) }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function handle(request, env) {
    const url   = new URL(request.url);
    const parts = url.pathname.replace(/^\//, '').split('/');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
    }

    // GET /bucket?author=<uuid> — read-only peek at the token bucket.
    // Client hits this on init so the HUD never lies about the starting
    // balance. One KV read, no writes.
    if (parts[0] === 'bucket' && request.method === 'GET') {
      const authorId = url.searchParams.get('author');
      if (!authorId || !AUTHOR_ID_RE.test(authorId)) {
        return new Response('invalid author', { status: 400, headers: CORS });
      }
      const state = await peekBucket(env, authorId);
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'X-Paint-Tokens':    String(state.tokens),
          'X-Paint-Refill-At': String(state.refillAt),
          'X-Paint-Capacity':  String(BUCKET_CAPACITY),
          'X-Paint-Refill-Ms': String(BUCKET_REFILL_MS),
        },
      });
    }

    // POST /refill?author=<uuid> — one-shot set of tokens to capacity. Gated on
    // the REFILL_SECRET env var (set via `wrangler secret put REFILL_SECRET`).
    // Intended as a personal cheat code; shared-secret model, not ACL-scoped
    // to a specific authorId.
    if (parts[0] === 'refill' && request.method === 'POST') {
      const authorId = url.searchParams.get('author');
      if (!authorId || !AUTHOR_ID_RE.test(authorId)) {
        return new Response('invalid author', { status: 400, headers: CORS });
      }
      const secret = request.headers.get('x-refill-secret');
      if (!env.REFILL_SECRET || !secret || secret !== env.REFILL_SECRET) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
      const now = Date.now();
      if (env.AUDIT) {
        try {
          await env.AUDIT.put(`bucket:${authorId}`, JSON.stringify({ tokens: BUCKET_CAPACITY, refillAt: now }), {
            expirationTtl: BUCKET_TTL_SECONDS,
          });
        } catch {}
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'X-Paint-Tokens':    String(BUCKET_CAPACITY),
          'X-Paint-Refill-At': String(now),
          'X-Paint-Capacity':  String(BUCKET_CAPACITY),
          'X-Paint-Refill-Ms': String(BUCKET_REFILL_MS),
        },
      });
    }

    // POST /strip_orphan_blobs?dry_run=true&cursor=&limit=N — admin: walk R2
    // and delete entire blobs whose key isn't a legitimate tileId. Catches the
    // case where someone PATCHed `/paint/<arbitrary-id>` and the worker
    // created a top-level blob with that name. The stricter TILE_ID_RE now
    // prevents new ones, but old strays sit in R2 forever otherwise.
    if (parts[0] === 'strip_orphan_blobs' && request.method === 'POST') {
      const secret = request.headers.get('x-refill-secret');
      if (!env.REFILL_SECRET || !secret || secret !== env.REFILL_SECRET) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
      const dryRun = url.searchParams.get('dry_run') === 'true';
      const cursor = url.searchParams.get('cursor') || undefined;
      const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const listed = await env.PAINT.list({ cursor, limit });
      const orphans = [];
      for (const meta of listed.objects) {
        if (!meta.key.endsWith('.json')) continue;
        const tileId = meta.key.replace(/\.json$/, '');
        if (TILE_ID_RE.test(tileId)) continue;
        orphans.push({ key: meta.key, size: meta.size });
        if (!dryRun) await env.PAINT.delete(meta.key);
      }
      return new Response(JSON.stringify({
        dryRun,
        scanned:   listed.objects.length,
        orphanCount: orphans.length,
        orphans,
        truncated: listed.truncated,
        cursor:    listed.cursor || null,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // POST /backup_chunk?cursor=<r2-cursor>&limit=N — admin: paginated dump of
    // every paint blob in R2 for offsite backup. Returns { tiles: {tileId:
    // jsonContents}, cursor, truncated }. Gated on REFILL_SECRET.
    //
    // Pair with scripts/backup_paint.mjs which calls this in a loop and writes
    // each tile to data/paint-backups/<timestamp>/<tileId>.json on disk.
    if (parts[0] === 'backup_chunk' && request.method === 'POST') {
      const secret = request.headers.get('x-refill-secret');
      if (!env.REFILL_SECRET || !secret || secret !== env.REFILL_SECRET) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
      const cursor = url.searchParams.get('cursor') || undefined;
      const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
      const listed = await env.PAINT.list({ cursor, limit });
      const tiles  = {};
      for (const meta of listed.objects) {
        if (!meta.key.endsWith('.json')) continue;
        const tileId = meta.key.replace(/\.json$/, '');
        if (!TILE_ID_RE.test(tileId)) continue;
        const obj = await env.PAINT.get(meta.key);
        if (!obj) continue;
        try { tiles[tileId] = JSON.parse(await obj.text()); }
        catch { /* skip malformed */ }
      }
      return new Response(JSON.stringify({
        tiles,
        cursor:    listed.cursor || null,
        truncated: listed.truncated,
        count:     Object.keys(tiles).length,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // POST /strip_strays?cursor=<r2-cursor>&limit=N — admin: walk R2 paint blobs
    // and remove cellKeys that don't legitimately belong in that file. One-shot
    // cleanup for cross-tile injection that landed before the PATCH validation
    // was added. Gated on REFILL_SECRET.
    //
    // Stripping rules differ by tile type:
    //   - Terrain tiles (`terrain_<gx>_<gz>`): cellKeys embed the tileId, so
    //     anything not prefixed `${tileId}:` is a stray.
    //   - Building tiles (`cell_<gx>_<gz>`): cellKeys are
    //     `${buildingId}:${meshType}:…` — buildingId↔tileId mapping isn't
    //     known server-side, so we can ONLY strip the obvious cross-pollution
    //     case (a terrain key inside a building tile). Building↔building
    //     mis-routing is invisible from here and stays.
    //
    // Paginated: a single call processes up to `limit` (default 50) blobs and
    // returns {scanned, removed, truncated, cursor}; pass `cursor` back in to
    // continue. Call repeatedly until truncated:false.
    if (parts[0] === 'strip_strays' && request.method === 'POST') {
      const secret = request.headers.get('x-refill-secret');
      if (!env.REFILL_SECRET || !secret || secret !== env.REFILL_SECRET) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
      const cursor = url.searchParams.get('cursor') || undefined;
      const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      // ?only=terrain | building — restrict cleanup to one tile type. Useful
      // when you only trust the cleanup logic on terrain (cellKey embeds tileId)
      // and want to skip building tiles this pass. Omit for both.
      const onlyType = url.searchParams.get('only') || null;
      if (onlyType && onlyType !== 'terrain' && onlyType !== 'building') {
        return new Response('only must be "terrain" or "building"', { status: 400, headers: CORS });
      }
      // ?dry_run=true — preview only, no R2 writes. Returns the same {removed,
      // sample, …} response so callers can verify counts before committing.
      const dryRun = url.searchParams.get('dry_run') === 'true';
      const listed = await env.PAINT.list({ cursor, limit });
      let totalScanned = 0, totalRemoved = 0, filesTouched = 0, totalSkippedByFilter = 0;
      const sample = []; // first few stray keys we saw, for audit
      for (const meta of listed.objects) {
        if (!meta.key.endsWith('.json')) continue;
        const tileId = meta.key.replace(/\.json$/, '');
        if (!TILE_ID_RE.test(tileId)) continue;
        const isTerrainTile = tileId.startsWith('terrain_');
        if (onlyType === 'terrain' && !isTerrainTile) { totalSkippedByFilter++; continue; }
        if (onlyType === 'building' && isTerrainTile) { totalSkippedByFilter++; continue; }
        const obj = await env.PAINT.get(meta.key);
        if (!obj) continue;
        let data;
        try { data = JSON.parse(await obj.text()); } catch { continue; }
        const expectedPrefix = `${tileId}:`;
        const stripped = {};
        let removed = 0;
        for (const k in data) {
          if (k === SEED_COMPLETE_KEY) {
            stripped[k] = data[k];
            continue;
          }
          const isStray = isTerrainTile
            ? !k.startsWith(expectedPrefix)
            : k.startsWith('terrain_'); // only strip cross-type pollution in building tiles
          if (isStray) {
            removed++;
            if (sample.length < 10) sample.push({ tile: tileId, key: k });
          } else {
            stripped[k] = data[k];
          }
        }
        if (removed > 0) {
          if (!dryRun) {
            await env.PAINT.put(meta.key, JSON.stringify(stripped), {
              httpMetadata: { contentType: 'application/json' },
            });
          }
          totalRemoved += removed;
          filesTouched++;
        }
        totalScanned++;
      }
      return new Response(JSON.stringify({
        dryRun,
        scanned: totalScanned,
        filesTouched,
        removed: totalRemoved,
        skippedByFilter: totalSkippedByFilter,
        truncated: listed.truncated,
        cursor: listed.cursor || null,
        sample,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    if (parts[0] !== 'paint' || !parts[1]) {
      return new Response('not found', { status: 404 });
    }

    const tileId = parts[1];
    if (!TILE_ID_RE.test(tileId)) {
      return new Response('invalid tileId', { status: 400 });
    }

    const key = `${tileId}.json`;

    if (request.method === 'GET') {
      const ifNoneMatch = request.headers.get('if-none-match')?.replace(/"/g, '') ?? null;
      const obj = await env.PAINT.get(key, ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : undefined);

      // R2 precondition semantics: with etagDoesNotMatch, a match returns an
      // R2Object (metadata only, no body / no .text()). Detect that and 304.
      if (obj && ifNoneMatch && typeof obj.text !== 'function') {
        return new Response(null, { status: 304, headers: { ...CORS, ETag: `"${obj.etag}"` } });
      }
      const etag = obj?.etag ?? null;
      const body = obj ? await obj.text() : '{}';
      const headers = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (etag) headers.ETag = `"${etag}"`;
      return new Response(body, { headers });
    }

    if (request.method === 'PATCH') {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return new Response('body too large', { status: 413, headers: CORS });
      let diff;
      try { diff = JSON.parse(raw); } catch { return new Response('invalid JSON', { status: 400, headers: CORS }); }
      if (!diff || typeof diff !== 'object' || Array.isArray(diff)) {
        return new Response('invalid JSON', { status: 400, headers: CORS });
      }

      // __ts is the client's wall-clock time of the flush, used as the
      // paintedAt for erase tombstones (null values have no paintedAt of
      // their own). Strip it out of the merge loop.
      const eraseTs = typeof diff.__ts === 'number' ? diff.__ts : Date.now();
      delete diff.__ts;

      // __author carries the client's localStorage UUID. Kept off the paint JSON;
      // written (with the client IP) to the AUDIT KV so moderation can answer
      // "who is this author?" / "what IPs has this author used lately?".
      const authorId = typeof diff.__author === 'string' && AUTHOR_ID_RE.test(diff.__author)
        ? diff.__author
        : null;
      delete diff.__author;

      // __seed marks a flush produced by the tile-seeding pass (procedural,
      // not user intent). __undo marks a flush produced by ctrl+Z / ctrl+Y
      // — those just revert prior state, so they don't charge either. Both
      // are trustable-enough: an abuser faking the flag still shows up in
      // the audit log with abnormal volume and can be banned manually.
      const isSeedBatch = diff.__seed === true;
      const isUndoBatch = diff.__undo === true;
      delete diff.__seed;
      delete diff.__undo;

      // Validate every diff entry. Normal browser clients can't produce
      // any of these failure cases — these checks block direct API abuse:
      //   - Cross-tile injection on terrain tiles (cellKey embeds the
      //     terrain tileId, so we can verify it matches). For building
      //     tiles the cellKey carries a buildingId, not the tileId, so we
      //     can't do an exact-match check; we instead block obvious
      //     mixing (terrain key into a building tile or vice versa).
      //   - Malformed cellKey shape (junk that accumulates in R2 forever).
      //   - Cells-per-PATCH cap.
      //   - Future-stamped paintedAt that would lock cells against future
      //     legitimate paints by always winning the merge tiebreaker.
      //   - Malformed cellData (color out of range, normal not a 3-array,
      //     planeD non-numeric).
      const isTerrainTile = tileId.startsWith('terrain_');
      const expectedPrefix = `${tileId}:`;
      const serverNow = Date.now();
      const maxPaintedAt = serverNow + PAINTED_AT_FUTURE_TOLERANCE_MS;
      let cellCount = 0;
      for (const k in diff) {
        if (k === SEED_COMPLETE_KEY) continue;
        cellCount++;
        if (cellCount > MAX_CELLS_PER_PATCH) {
          return new Response(`too many cells in PATCH (max ${MAX_CELLS_PER_PATCH})`, {
            status: 413, headers: CORS,
          });
        }
        if (!CELL_KEY_RE.test(k)) {
          return new Response(`malformed cellKey: ${k.slice(0, 80)}`, { status: 400, headers: CORS });
        }
        if (isTerrainTile) {
          // Terrain cellKeys embed the tileId — exact prefix match required.
          if (!k.startsWith(expectedPrefix)) {
            return new Response(`cellKey ${k} does not belong to tile ${tileId}`, {
              status: 400, headers: CORS,
            });
          }
        } else {
          // Building tile — cellKey is `${buildingId}:${meshType}:…`. We
          // can't exact-match because buildingId↔tileId mapping lives only
          // on the client. Reject obvious cross-pollution (terrain key into
          // a building tile).
          if (k.startsWith('terrain_')) {
            return new Response(`terrain cellKey ${k} not allowed in building tile ${tileId}`, {
              status: 400, headers: CORS,
            });
          }
        }
        const v = diff[k];
        if (v === null) continue; // erase tombstone — no body to validate
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          return new Response(`cellData for ${k} must be an object`, { status: 400, headers: CORS });
        }
        if (typeof v.color !== 'number' || !Number.isInteger(v.color) || v.color < 0 || v.color > 0xffffff) {
          return new Response(`cellData.color for ${k} must be uint24 (0..0xffffff)`, { status: 400, headers: CORS });
        }
        if (typeof v.paintedAt !== 'number' || !Number.isFinite(v.paintedAt) || v.paintedAt > maxPaintedAt) {
          return new Response(`cellData.paintedAt for ${k} is missing or too far in the future`, { status: 400, headers: CORS });
        }
        if (!Array.isArray(v.normal) || v.normal.length !== 3 ||
            !v.normal.every(n => typeof n === 'number' && Number.isFinite(n))) {
          return new Response(`cellData.normal for ${k} must be a 3-array of finite numbers`, { status: 400, headers: CORS });
        }
        if (typeof v.planeD !== 'number' || !Number.isFinite(v.planeD)) {
          return new Response(`cellData.planeD for ${k} must be a finite number`, { status: 400, headers: CORS });
        }
      }

      // Cost = count of cell writes that aren't the seed-complete sentinel.
      // Paint and erase both count; sentinel + seed/undo-flagged batches are free.
      let cost = 0;
      if (!isSeedBatch && !isUndoBatch) {
        for (const k in diff) if (k !== SEED_COMPLETE_KEY) cost++;
      }
      const bucket = await chargeBucket(env, authorId, cost);
      if (bucket && !bucket.allowed) {
        return new Response(JSON.stringify({
          error:       'rate_limited',
          tokens:      bucket.tokens,
          refillAt:    bucket.refillAt,
          capacity:    BUCKET_CAPACITY,
          refillMs:    BUCKET_REFILL_MS,
          needed:      cost,
        }), {
          status: 429,
          headers: {
            ...CORS,
            'Content-Type':         'application/json',
            'X-Paint-Tokens':       String(bucket.tokens),
            'X-Paint-Refill-At':    String(bucket.refillAt),
            'X-Paint-Capacity':     String(BUCKET_CAPACITY),
            'X-Paint-Refill-Ms':    String(BUCKET_REFILL_MS),
          },
        });
      }

      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const obj  = await env.PAINT.get(key);
        const etag = obj?.etag ?? null;
        let existing = {};
        if (obj) {
          try { existing = JSON.parse(await obj.text()); } catch { existing = {}; }
        }

        for (const k in diff) {
          const v    = diff[k];
          const prev = existing[k];

          if (v === null) {
            // Erase. Honor only if our erase is at least as recent as whatever's there.
            // Missing prev.paintedAt (e.g. the seed-complete sentinel) is treated as
            // "no timestamp" → erase wins; the sentinel should never be null-diffed
            // anyway, so this is defensive.
            if (!prev || !prev.paintedAt || eraseTs >= prev.paintedAt) {
              delete existing[k];
            }
          } else {
            // Paint. Same tiebreaker: newer paintedAt wins. The __seed_complete__
            // sentinel has no paintedAt — the `!prev.paintedAt` clause lets it
            // through unconditionally, so once it lands it stays.
            if (!prev || !prev.paintedAt || !v.paintedAt || v.paintedAt >= prev.paintedAt) {
              existing[k] = v;
            }
          }
        }

        const put = await env.PAINT.put(key, JSON.stringify(existing), {
          httpMetadata: { contentType: 'application/json' },
          onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
        });
        if (!put) continue; // CAS lost — someone else wrote between our get/put. Retry.

        await logAudit(env, authorId, request);
        const headers = { ...CORS, ETag: `"${put.etag}"` };
        if (bucket) {
          headers['X-Paint-Tokens']    = String(bucket.tokens);
          headers['X-Paint-Refill-At'] = String(bucket.refillAt);
          headers['X-Paint-Capacity']  = String(BUCKET_CAPACITY);
          headers['X-Paint-Refill-Ms'] = String(BUCKET_REFILL_MS);
        }
        return new Response(null, { status: 204, headers });
      }

      return new Response('conflict', { status: 409, headers: CORS });
    }

    return new Response('method not allowed', { status: 405, headers: { ...CORS, Allow: 'GET, PATCH' } });
}

// Read-only view of the current bucket. Returns full capacity when the AUDIT
// binding is absent (no rate limit configured) or no row exists yet (fresh
// user). Never writes.
async function peekBucket(env, authorId) {
  const now = Date.now();
  if (!env.AUDIT) return { tokens: BUCKET_CAPACITY, refillAt: now };
  try {
    const prev = await env.AUDIT.get(`bucket:${authorId}`, { type: 'json' });
    if (prev && typeof prev.tokens === 'number' && typeof prev.refillAt === 'number') {
      const elapsed = Math.max(0, now - prev.refillAt);
      const tokens  = Math.min(BUCKET_CAPACITY, prev.tokens + elapsed / BUCKET_REFILL_MS);
      return { tokens: Math.floor(tokens), refillAt: now };
    }
  } catch {}
  return { tokens: BUCKET_CAPACITY, refillAt: now };
}

// Token bucket for rate-limiting cell writes. Returns:
//   null                              — binding missing / no authorId (limits skipped)
//   { allowed: true, tokens, refillAt } — charged and persisted; `tokens` is the
//                                         post-charge balance, `refillAt` the
//                                         timestamp it was computed (client
//                                         extrapolates refill from there)
//   { allowed: false, tokens, refillAt } — insufficient tokens; not charged
// Persistence uses read-then-write on KV. It's racy across concurrent PATCHes
// from the same author (multi-tab), but the worst case is a few extra
// tokens granted — acceptable for this layer.
async function chargeBucket(env, authorId, cost) {
  if (!env.AUDIT || !authorId) return null;
  if (cost <= 0) return null;

  const key = `bucket:${authorId}`;
  const now = Date.now();
  let tokens   = BUCKET_CAPACITY;
  let refillAt = now;
  try {
    const prev = await env.AUDIT.get(key, { type: 'json' });
    if (prev && typeof prev.tokens === 'number' && typeof prev.refillAt === 'number') {
      const elapsed = Math.max(0, now - prev.refillAt);
      tokens   = Math.min(BUCKET_CAPACITY, prev.tokens + elapsed / BUCKET_REFILL_MS);
      refillAt = now;
    }
  } catch {}

  if (tokens < cost) {
    return { allowed: false, tokens: Math.floor(tokens), refillAt };
  }

  tokens -= cost;
  try {
    await env.AUDIT.put(key, JSON.stringify({ tokens, refillAt }), {
      expirationTtl: BUCKET_TTL_SECONDS,
    });
  } catch {}
  return { allowed: true, tokens: Math.floor(tokens), refillAt };
}

// Audit log: one KV key per (authorId, ip) pair, TTL-refreshed every PATCH.
// After 14 days of inactivity the row self-deletes — that's the retention
// promise. Absence of an AUDIT binding is a no-op so local dev / preview
// deployments don't need the namespace wired up.
async function logAudit(env, authorId, request) {
  if (!env.AUDIT || !authorId) return;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return;
  const key = `audit:${authorId}:${ip}`;
  const now = Date.now();
  let firstSeen = now;
  try {
    const prev = await env.AUDIT.get(key, { type: 'json' });
    if (prev && typeof prev.firstSeen === 'number') firstSeen = prev.firstSeen;
  } catch {}
  try {
    await env.AUDIT.put(key, JSON.stringify({ firstSeen, lastSeen: now }), {
      expirationTtl: AUDIT_TTL_SECONDS,
    });
  } catch {}
}
