import fs from 'node:fs/promises';
import path from 'node:path';

// Vite dev-server middleware: GET/PUT per-tile paint JSON under data/paint/.
//
// Routes:
//   GET  /api/paint/:tileId → { [cellKey]: cellData } (empty object if missing)
//   PUT  /api/paint/:tileId → body is the full cell map; server overwrites the file
//
// Tile IDs are restricted to [A-Za-z0-9_-] so they can't escape DATA_DIR.
// This is a dev-only stepping stone toward a hosted multiplayer server — the
// client already fetches per tile, so swapping this plugin for a real server
// is just a URL change.

const DATA_DIR    = 'data/paint';
const TILE_ID_RE  = /^[A-Za-z0-9_-]+$/;
const ROUTE       = '/api/paint/';
const MAX_BODY    = 50 * 1024 * 1024; // 50 MB hard cap — a tile with every cell seeded is ~10 MB

export function tilePaintPlugin() {
  return {
    name: 'tile-paint',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';
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
            try {
              const raw = await fs.readFile(file, 'utf8');
              res.setHeader('content-type', 'application/json');
              res.end(raw);
            } catch (e) {
              if (e.code === 'ENOENT') {
                res.setHeader('content-type', 'application/json');
                res.end('{}');
                return;
              }
              throw e;
            }
          } else if (req.method === 'PUT') {
            const body = await readBody(req, MAX_BODY);
            try { JSON.parse(body); }
            catch { res.statusCode = 400; res.end('invalid JSON'); return; }
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(file, body);
            res.statusCode = 204;
            res.end();
          } else {
            res.statusCode = 405;
            res.setHeader('allow', 'GET, PUT');
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
