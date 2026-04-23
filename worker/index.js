const TILE_ID_RE  = /^[A-Za-z0-9_-]+$/;
const AUTHOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY   = 50 * 1024 * 1024;
const ORIGIN     = 'https://graffiti.anita.garden';
const MAX_CAS_ATTEMPTS = 5;
const AUDIT_TTL_SECONDS = 14 * 24 * 60 * 60;

const CORS = {
  'Access-Control-Allow-Origin':   ORIGIN,
  'Access-Control-Allow-Methods':  'GET, PATCH',
  'Access-Control-Allow-Headers':  'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

export default {
  async fetch(request, env) {
    const url   = new URL(request.url);
    const parts = url.pathname.replace(/^\//, '').split('/');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
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
        return new Response(null, { status: 204, headers: { ...CORS, ETag: `"${put.etag}"` } });
      }

      return new Response('conflict', { status: 409, headers: CORS });
    }

    return new Response('method not allowed', { status: 405, headers: { ...CORS, Allow: 'GET, PATCH' } });
  },
};

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
