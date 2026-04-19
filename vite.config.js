import { defineConfig } from 'vite';
import { tilePaintPlugin } from './scripts/tile-paint-plugin.js';

export default defineConfig({
  plugins: [tilePaintPlugin()],
  server: {
    watch: {
      // Generated tile data — tens of thousands of small JSON files. Vite
      // doesn't need to watch them (they're refreshed by `npm run build-tiles`
      // / `npm run build-osm`, not by hot reload), and on Windows the cold-
      // start enumeration over public/osm in particular dominates first-load.
      ignored: ['**/public/tiles/**', '**/public/osm/**'],
    },
  },
});
