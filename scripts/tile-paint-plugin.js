import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Vite dev-server middleware: GET/PATCH per-tile paint JSON under data/paint/.
// Mirrors the production Cloudflare Worker (worker/index.js) so local dev
// exercises the same conflict-resolution path.
//
// Routes:
//   GET   /api/paint/:tileId   → { [cellKey]: cellData } (empty object if missing).
//                                Honors If-None-Match with a 304.
//   PATCH /api/paint/:tileId   → body: { __ts, [cellKey]: cellData | null }.
//                                Merge-on-server with a paintedAt tiebreaker.
//                                null values are erase tombstones timestamped
//                                by body.__ts (falling back to Date.now()).
//
// Concurrent PATCHes to the same tile are serialized through a per-tile
// promise chain so one request's read+merge+write can't interleave with
// another's. This is the dev equivalent of the worker's R2-ETag CAS loop.
//
// Tile IDs are restricted to [A-Za-z0-9_-] so they can't escape DATA_DIR.

const DATA_DIR    = 'data/paint';
const TILE_ID_RE  = /^[A-Za-z0-9_-]+$/;
const ROUTE       = '/api/paint/';
const BUCKET_ROUTE = '/api/bucket';
const REFILL_ROUTE = '/api/refill';
const MAX_BODY    = 50 * 1024 * 1024;

// tileId → Promise — tail of this tile's serialized operations.
const tileLocks = new Map();

export function tilePaintPlugin() {
  return {
    name: 'tile-paint',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';

        // Dev has no rate limit; the bucket endpoint exists only so the
        // client init sync gets a 204 instead of 404. Emitting no X-Paint-*
        // headers leaves the client's default bucket intact (effectively
        // unlimited locally). Clients still flip _bucketReady → true.
        if (url.startsWith(BUCKET_ROUTE) && req.method === 'GET') {
          res.statusCode = 204;
          res.end();
          return;
        }

        // Dev stub for the cheat-code refill. No secret gating — locally
        // there's no rate limit to bypass. Echoes a synthetic full-bucket
        // so the client's tryRefill() returns 'ok' and the HUD flashes.
        if (url.startsWith(REFILL_ROUTE) && req.method === 'POST') {
          res.statusCode = 204;
          res.setHeader('x-paint-tokens',    '200');
          res.setHeader('x-paint-refill-at', String(Date.now()));
          res.setHeader('x-paint-capacity',  '200');
          res.setHeader('x-paint-refill-ms', '20000');
          res.end();
          return;
        }

        if (!url.startsWith(ROUTE)) return next();

        const tileId = url.slice(ROUTE.length).split('?')[0];
        if (!TILE_ID_RE.test(tileId)) {
          res.statusCode = 400;
          res.end('invalid tileId');
          return;
        }

        const file = path.join(DATA_DIR, `${tileId}.json`);

        try {
          if (req.method === 'GET') {
            await handleGet(file, req, res);
          } else if (req.method === 'PATCH') {
            await withTileLock(tileId, () => handlePatch(file, req, res));
          } else {
            res.statusCode = 405;
            res.setHeader('allow', 'GET, PATCH');
            res.end();
          }
        } catch (e) {
          console.error(`[tile-paint] ${req.method} ${tileId}:`, e);
          res.statusCode = 500;
          res.end('server error');
        }
      });
    },
  };
}

async function handleGet(file, req, res) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    throw e;
  }
  const etag = etagOf(raw);
  const ifNoneMatch = (req.headers['if-none-match'] || '').replace(/"/g, '');
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.statusCode = 304;
    res.setHeader('etag', `"${etag}"`);
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.setHeader('etag', `"${etag}"`);
  res.setHeader('cache-control', 'no-store');
  res.end(raw);
}

async function handlePatch(file, req, res) {
  const raw = await readBody(req, MAX_BODY);
  let diff;
  try { diff = JSON.parse(raw); }
  catch { res.statusCode = 400; res.end('invalid JSON'); return; }
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) {
    res.statusCode = 400; res.end('invalid JSON'); return;
  }

  const eraseTs = typeof diff.__ts === 'number' ? diff.__ts : Date.now();
  delete diff.__ts;
  // __author / __seed / __undo are prod-only worker hooks (audit + rate-
  // limit exemptions). Strip so the client↔server envelope matches between
  // dev and prod. Dev has no rate limit — every write lands unchecked.
  delete diff.__author;
  delete diff.__seed;
  delete diff.__undo;

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  for (const k in diff) {
    const v    = diff[k];
    const prev = existing[k];
    if (v === null) {
      if (!prev || !prev.paintedAt || eraseTs >= prev.paintedAt) delete existing[k];
    } else {
      if (!prev || !prev.paintedAt || !v.paintedAt || v.paintedAt >= prev.paintedAt) existing[k] = v;
    }
  }

  const body = JSON.stringify(existing);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, body);

  res.statusCode = 204;
  res.setHeader('etag', `"${etagOf(body)}"`);
  res.end();
}

function etagOf(body) {
  return crypto.createHash('sha1').update(body).digest('hex');
}

async function withTileLock(tileId, fn) {
  const prev = tileLocks.get(tileId) || Promise.resolve();
  const settled = prev.then(() => {}, () => {});        // don't propagate prev's errors
  const next    = settled.then(fn);
  const tail    = next.catch(() => {});                 // map holds an always-resolving tail
  tileLocks.set(tileId, tail);
  try { return await next; }
  finally {
    // Only clear if nothing else has queued behind us.
    if (tileLocks.get(tileId) === tail) tileLocks.delete(tileId);
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
