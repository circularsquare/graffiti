// Pre-bakes the 10% random graffiti seeds that used to roll client-side in
// tileWorker.scanCells. Walks every tile in public/tiles/manifest.json, runs
// the same scan pipeline the worker does, rolls seeds, and writes them to
// data/paint/<tileId>.json in the server's paint format.
//
// Once this has run, paintStore.loadTile picks the seeds up like any other
// saved cell, and seedTileCells's own roll is suppressed by SEED_FRACTION=0.
// Result: every player sees the same starter graffiti instead of a fresh
// per-client roll.
//
// Usage:
//   npm run bake-seeds            # skips tiles whose paint file already has cells
//   npm run bake-seeds -- --force # overwrites every tile (wipes user paint)
//   npm run bake-seeds -- --flat  # bake for flat/no-terrain mode (shifts Y=0)
//
// Note: cellKeys depend on face planeD, which depends on whether buildings
// were Y-shifted to sit at y=0 (flat mode) or left at their NAVD88 elevation
// (terrain mode). Bake matches the mode you play in — default is terrain.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeTile,
  buildMeshDataFromBuilding,
  scanCells,
} from '../src/tileWorker.js';

const ROOT      = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST  = path.join(ROOT, 'public', 'tiles', 'manifest.json');
const TILE_DIR  = path.join(ROOT, 'public', 'tiles');
const PAINT_DIR = path.join(ROOT, 'data', 'paint');

const SEED_FRACTION = 0.1;
// Mirrors COLORS in src/main.js (erase stripped). If the palette changes there,
// mirror here — there's no runtime import because main.js has browser-only deps.
const SEED_COLORS = [
  0x1d1b24, 0x46464d, 0x7a7576, 0xcec7b1, 0xedefe2,
  0xf594aa, 0xd6403a,
  0xe68556, 0xd66c1c,
  0xe1bf7d, 0x936a4d, 0x5e3b2f,
  0xe0a41c, 0xf7d020, 0xb9d850, 0x5fc242, 0x66a650, 0x325c4e,
  0x82dcd7, 0x22b4ac, 0x1c7aa0, 0x2d4068, 0x3058d4,
  0xac90cc, 0x4a2058, 0xa04070, 0x6d2047,
];

const args   = new Set(process.argv.slice(2));
const force  = args.has('--force');
const shiftY = args.has('--flat'); // terrain-on default → shiftBuildingsY=false

async function tilePaintHasData(paintFile) {
  try {
    const raw = await fs.readFile(paintFile, 'utf8');
    const obj = JSON.parse(raw);
    return Object.keys(obj).length > 0;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

async function bakeTile(entry) {
  const tileId    = `cell_${entry.gx}_${entry.gz}`;
  const tileFile  = path.join(TILE_DIR,  `${tileId}.bin`);
  const paintFile = path.join(PAINT_DIR, `${tileId}.json`);

  if (!force && await tilePaintHasData(paintFile)) {
    return { skipped: true, seeded: 0 };
  }

  const buf = await fs.readFile(tileFile);
  // Fresh ArrayBuffer view — Node Buffer.buffer can cover more than just this
  // file's bytes if it came from an internal pool. decodeTile uses DataView
  // offsets assuming byteLength = file size.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const buildings = decodeTile(ab);

  const seedConfig = { fraction: SEED_FRACTION, colors: SEED_COLORS };
  const paintedAt  = Date.now();
  const out        = {};

  for (const b of buildings) {
    const perType = buildMeshDataFromBuilding(b, shiftY);
    for (const { meshData: m, faceInfo } of perType) {
      const r = scanCells(
        m.position, m.uv, m.buildingId, m.meshType,
        seedConfig, faceInfo.faces, faceInfo.triFace, m.horizU,
      );
      for (const s of r.seeds) {
        out[r.cellKeys[s.idx]] = {
          color:  s.color,
          normal: s.normal,
          planeD: s.planeD,
          paintedAt,
        };
      }
    }
  }

  await fs.writeFile(paintFile, JSON.stringify(out));
  return { skipped: false, seeded: Object.keys(out).length };
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
  await fs.mkdir(PAINT_DIR, { recursive: true });

  console.log(
    `baking seeds for ${manifest.length} tiles ` +
    `(force=${force}, shiftY=${shiftY}, fraction=${SEED_FRACTION})`,
  );

  const t0 = Date.now();
  let done = 0, skipped = 0, failed = 0, totalSeeds = 0;

  for (const entry of manifest) {
    try {
      const r = await bakeTile(entry);
      if (r.skipped) skipped++;
      else totalSeeds += r.seeded;
    } catch (e) {
      failed++;
      console.error(`  cell_${entry.gx}_${entry.gz}: ${e.message}`);
    }
    done++;
    if (done % 100 === 0 || done === manifest.length) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate    = done / elapsed;
      const eta     = Math.round((manifest.length - done) / Math.max(rate, 0.001));
      console.log(
        `  ${done}/${manifest.length}  ${rate.toFixed(1)} tiles/s  ` +
        `eta ${eta}s  (skipped=${skipped} failed=${failed} seeds=${totalSeeds})`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\ndone in ${elapsed}s — ${done} tiles, ${skipped} skipped, ` +
    `${failed} failed, ${totalSeeds} seed cells written`,
  );
}

main().catch(e => { console.error(e); process.exit(1); });
