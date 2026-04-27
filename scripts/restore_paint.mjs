#!/usr/bin/env node
/**
 * Restore paint blobs from a local backup folder to prod R2.
 *
 *   node scripts/restore_paint.mjs <backup-folder> [--dry-run]
 *
 * Folder layout matches what backup_paint.mjs produces:
 *   <backup-folder>/manifest.json
 *   <backup-folder>/cell_X_Y.json
 *   <backup-folder>/terrain_X_Y.json
 *   ...
 *
 * Each tile is uploaded by chunked PATCH with __seed:true so the bucket isn't
 * charged. Server merge tiebreaker (paintedAt >= existing) means newer cells
 * already on the server win — restore won't trample current paint, only
 * fill in cells that were lost or are older than the backup.
 *
 * --dry-run prints what would be sent without actually PATCHing.
 *
 * Required env: REFILL_SECRET (admin secret). PAINT_API_BASE (default:
 * https://api.anita.garden).
 *
 * MAKE SURE the worker has the latest validation deployed before running:
 *   - validates cellKey shape and tile-prefix
 *   - validates paintedAt sanity
 *   - validates cellData shape
 * If any of these reject, restore aborts that tile and continues with others.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = process.env.PAINT_API_BASE || 'https://api.anita.garden';
const SECRET   = process.env.REFILL_SECRET;
const CHUNK    = 1000; // server cap is 1200; leave headroom

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const backupDir = args.find(a => !a.startsWith('--'));

if (!backupDir) {
  console.error('Usage: node scripts/restore_paint.mjs <backup-folder> [--dry-run]');
  process.exit(1);
}
if (!SECRET && !dryRun) {
  console.error('ERROR: REFILL_SECRET env var not set (only optional with --dry-run).');
  process.exit(1);
}

async function main() {
  const stat = await fs.stat(backupDir);
  if (!stat.isDirectory()) throw new Error(`${backupDir} is not a directory`);

  const files = (await fs.readdir(backupDir)).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  console.log(`Found ${files.length} tile files in ${backupDir}`);
  if (dryRun) console.log('(--dry-run: nothing will be sent)');

  let totalTiles = 0, totalCells = 0, totalChunks = 0, totalSkipped = 0;
  const failures = [];

  for (const file of files) {
    const tileId = file.replace(/\.json$/, '');
    const data = JSON.parse(await fs.readFile(path.join(backupDir, file), 'utf8'));
    const allKeys = Object.keys(data).filter(k => k !== '__seed_complete__');
    if (allKeys.length === 0) { totalSkipped++; continue; }

    for (let i = 0; i < allKeys.length; i += CHUNK) {
      const chunk = allKeys.slice(i, i + CHUNK);
      const body = { __ts: Date.now(), __seed: true };
      for (const k of chunk) body[k] = data[k];

      if (dryRun) {
        console.log(`  [dry] ${tileId} chunk ${i / CHUNK + 1}: ${chunk.length} cells`);
      } else {
        // PATCH with __seed:true bypasses the token bucket. No header secret
        // needed — bucket-bypass goes through the public endpoint.
        const res = await fetch(`${API_BASE}/paint/${tileId}`, {
          method:  'PATCH',
          body:    JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        });
        if (!res.ok) {
          const txt = await res.text();
          console.error(`  ✗ ${tileId} chunk ${i / CHUNK + 1}: HTTP ${res.status} ${txt.slice(0, 200)}`);
          failures.push({ tileId, chunk: i / CHUNK + 1, status: res.status, message: txt.slice(0, 200) });
          continue;
        }
      }
      totalChunks++;
      totalCells += chunk.length;
    }
    totalTiles++;
    if (totalTiles % 20 === 0) console.log(`  progress: ${totalTiles}/${files.length} tiles`);
  }

  console.log('');
  console.log(`Done. ${totalTiles} tiles, ${totalCells} cells, ${totalChunks} chunks, ${totalSkipped} empty tiles skipped.`);
  if (failures.length) {
    console.warn(`${failures.length} chunk failures:`);
    for (const f of failures) console.warn(' ', f);
    process.exit(2);
  }
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
