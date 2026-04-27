#!/usr/bin/env node
/**
 * Backup every paint blob from prod R2 to local disk.
 *
 *   node scripts/backup_paint.mjs
 *
 * Reads the worker URL from PAINT_API_BASE (default: https://api.anita.garden)
 * and the admin secret from REFILL_SECRET. Both are required.
 *
 * Writes to data/paint-backups/<ISO-date>/<tileId>.json plus a manifest.json
 * with run metadata.
 *
 * Run on a schedule (cron / Task Scheduler) — each run creates a new
 * timestamped folder so you keep history. Old folders are NOT auto-pruned;
 * delete them manually when you're satisfied nothing's amiss.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const BACKUP_ROOT = path.join(REPO_ROOT, 'data', 'paint-backups');

const API_BASE = process.env.PAINT_API_BASE || 'https://api.anita.garden';
const SECRET   = process.env.REFILL_SECRET;
const LIMIT    = 100;

if (!SECRET) {
  console.error('ERROR: REFILL_SECRET env var not set.');
  console.error('Get it from: wrangler secret list, or your password manager.');
  console.error('Then run:    REFILL_SECRET=... node scripts/backup_paint.mjs');
  process.exit(1);
}

async function main() {
  const startedAt = new Date();
  // Folder name is date-time slug, sortable, filesystem-safe.
  const slug = startedAt.toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(BACKUP_ROOT, slug);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Backup destination: ${outDir}`);

  let cursor = null;
  let totalTiles = 0;
  let totalCells = 0;
  let calls = 0;
  const tileIds = [];

  do {
    const url = new URL(`${API_BASE}/backup_chunk`);
    url.searchParams.set('limit', String(LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'x-refill-secret': SECRET },
    });
    if (!res.ok) {
      throw new Error(`backup_chunk failed: HTTP ${res.status} ${await res.text()}`);
    }
    const j = await res.json();
    calls++;

    for (const [tileId, data] of Object.entries(j.tiles)) {
      const file = path.join(outDir, `${tileId}.json`);
      await fs.writeFile(file, JSON.stringify(data));
      totalTiles++;
      const cellCount = Object.keys(data).filter(k => k !== '__seed_complete__').length;
      totalCells += cellCount;
      tileIds.push({ tileId, cellCount });
    }
    process.stdout.write(`  call ${calls}: ${j.count} tiles ${j.truncated ? '(more pages …)' : '(done)'}\n`);
    cursor = j.truncated ? j.cursor : null;
  } while (cursor);

  const finishedAt = new Date();
  const manifest = {
    startedAt:  startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    apiBase:    API_BASE,
    totalTiles,
    totalCells,
    chunks:     calls,
    tileIds:    tileIds.sort((a, b) => a.tileId.localeCompare(b.tileId)),
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('');
  console.log(`Done. ${totalTiles} tiles, ${totalCells} cells, ${calls} chunks, ${(finishedAt - startedAt) / 1000}s.`);
  console.log(`Manifest: ${path.join(outDir, 'manifest.json')}`);
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
