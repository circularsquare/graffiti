const TILE_ID_RE  = /^[A-Za-z0-9_-]+$/;
const AUTHOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY   = 50 * 1024 * 1024;
const ORIGIN     = 'https://graffiti.anita.garden';
const MAX_CAS_ATTEMPTS = 5;
const AUDIT_TTL_SECONDS = 14 * 24 * 60 * 60;

// Token bucket: capacity N, refill one token per REFILL_MS. Applied per cell
// write (paint or erase). Seeds are exempt (__seed flag). Bucket state lives
// on the AUDIT KV under `bucket:<authorId>`; after BUCKET_TTL_SECONDS of
// inactivity it vanishes and the user gets a fresh full bucket next visit.
const BUCKET_CAPACITY = 200;
const BUCKET_REFILL_MS = 20_000;
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
      if (!obj && ifNoneMatch) {
        return new Response(null, { status: 304, headers: { ...CORS, ETag: `"${ifNoneMatch}"` } });
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
  },
};

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
