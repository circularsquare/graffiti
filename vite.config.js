import { defineConfig } from 'vite';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { tilePaintPlugin } from './scripts/tile-paint-plugin.js';

// DEV ONLY. The building manifest is ~8.6 MB of JSON loaded synchronously at
// startup. Vite's publicDir serving + the dev-gzip middleware re-gzip it on
// every request — ~4 s each in the single-threaded dev server, which dominates
// cold load (prod serves it pre-compressed + CDN-cached, so this never bites
// there). Here we gzip it ONCE, cache the bytes in memory, and serve the cached
// buffer. Pure dev-server behaviour (configureServer); the production build is
// untouched. Cache busts on mtime so `npm run build-tiles` is picked up.
const manifestCachePlugin = () => {
  let cache = null; // { mtimeMs, gz }
  const file = path.join(process.cwd(), 'public', 'tiles', 'manifest.json');
  return {
    name: 'manifest-cache',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const urlPath = req.url.split('?')[0];
        if (urlPath !== '/tiles/manifest.json') return next();
        let stat;
        try { stat = fs.statSync(file); } catch { return next(); }
        if (!cache || cache.mtimeMs !== stat.mtimeMs) {
          const raw = fs.readFileSync(file);
          cache = { mtimeMs: stat.mtimeMs, gz: zlib.gzipSync(raw) };
        }
        const accepts = (req.headers['accept-encoding'] || '').includes('gzip');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        if (accepts) {
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', cache.gz.length);
          res.end(cache.gz);
        } else {
          const raw = zlib.gunzipSync(cache.gz);
          res.setHeader('Content-Length', raw.length);
          res.end(raw);
        }
      });
    },
  };
};

// OSM tiles are stored pre-gzipped on disk (cell_*.bin.gz) and the client
// decompresses them manually via DecompressionStream. If Vite or any middleware
// in the stack sets `Content-Encoding: gzip`, the browser will auto-decompress
// the body before our code sees it, breaking the handoff. This plugin
// short-circuits those paths by serving the bytes as opaque octet-stream
// with no encoding headers.
const osmTilePlugin = () => ({
  name: 'osm-bin-gz',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url) return next();
      const q = req.url.indexOf('?');
      const urlPath = q === -1 ? req.url : req.url.slice(0, q);
      if (!urlPath.startsWith('/osm/') || !urlPath.endsWith('.bin.gz')) {
        return next();
      }
      const filePath = path.join(process.cwd(), 'public', urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type',   'application/octet-stream');
        res.setHeader('Content-Length', data.length);
        res.setHeader('Cache-Control',  'no-cache');
        res.end(data);
      });
    });
  },
});

// Vite's dev server doesn't gzip by default. We serve thousands of small
// heightmap/tile JSONs that compress very well (3-5×). Compression runs on the
// single Node thread, though, so gzipping EVERY response (the old threshold:0)
// taxed the cold-load burst — dozens of concurrent worker/module/tile requests
// all serialised behind each other's gzip, so even a 200-byte env.mjs took
// seconds. Now:
//   - threshold 1500: tiny responses (env shims, small JSON, empty tiles) skip
//     gzip entirely — the CPU cost dwarfs the few bytes saved on the LAN.
//   - filter: never gzip binary tile blobs (.bin) — Int16/Float32 packed data
//     barely compresses, so it's pure CPU waste. JSON/JS/text still compress.
// Pre-gzipped OSM `.bin.gz` and the cached manifest are intercepted upstream
// and never reach this middleware.
const devGzip = () => ({
  name: 'dev-gzip',
  configureServer(server) {
    server.middlewares.use(compression({
      threshold: 1500,
      filter: (req, res) => {
        const url = req.url || '';
        if (url.endsWith('.bin') || url.includes('.bin?')) return false;
        return compression.filter(req, res); // default: gzip text/json/js, skip already-compressed
      },
    }));
  },
});

export default defineConfig({
  // osmTilePlugin + manifestCachePlugin must run before devGzip so their
  // responses short-circuit the (slow, per-request) compression middleware.
  plugins: [osmTilePlugin(), manifestCachePlugin(), devGzip(), tilePaintPlugin()],
  server: {
    hmr: false,
    watch: {
      // Generated tile data — tens of thousands of small tile files. Vite
      // doesn't need to watch them (they're refreshed by `npm run build-tiles`
      // / `npm run build-osm` / `bake_terrain.py`, not by hot reload), and on
      // Windows the cold-start enumeration over these dirs dominates first-load.
      ignored: ['**/public/tiles/**', '**/public/osm/**', '**/public/terrain/**'],
    },
  },
});
