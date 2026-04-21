import { defineConfig } from 'vite';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { tilePaintPlugin } from './scripts/tile-paint-plugin.js';

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
// heightmap/tile JSONs and, starting with .bin terrain, Int16 sample blobs —
// both compress very well (3-5×) and the middleware is trivial. threshold=0
// so even small payloads compress (Vite sometimes ships tiny responses).
// OSM `.bin.gz` tiles are intercepted by osmTilePlugin above, so they never
// reach this middleware.
const devGzip = () => ({
  name: 'dev-gzip',
  configureServer(server) {
    server.middlewares.use(compression({ threshold: 0 }));
  },
});

export default defineConfig({
  // osmTilePlugin must run before devGzip so its response short-circuits
  // the compression middleware.
  plugins: [osmTilePlugin(), devGzip(), tilePaintPlugin()],
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
