#!/usr/bin/env node
/**
 * Swap a backup folder's contents into data/paint/ so `npm run dev` serves it.
 * Used to verify a backup looks right by flying around in dev mode.
 *
 *   node scripts/use_backup_for_dev.mjs <backup-folder>
 *   npm run use-backup -- <backup-folder>
 *
 * Wipes data/paint/ first. The dev plugin (scripts/tile-paint-plugin.js)
 * reads from there. Anything you paint in dev afterwards is also saved there
 * (and lost the next time you swap in another backup).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const backupDir = process.argv[2];
if (!backupDir) {
  console.error('Usage: node scripts/use_backup_for_dev.mjs <backup-folder>');
  process.exit(1);
}

const DEV_DIR = 'data/paint';

const stat = await fs.stat(backupDir).catch(() => null);
if (!stat || !stat.isDirectory()) {
  console.error(`Not a directory: ${backupDir}`);
  process.exit(1);
}

await fs.rm(DEV_DIR, { recursive: true, force: true });
await fs.mkdir(DEV_DIR, { recursive: true });

const files = (await fs.readdir(backupDir)).filter(f => f.endsWith('.json') && f !== 'manifest.json');
for (const f of files) {
  await fs.copyFile(path.join(backupDir, f), path.join(DEV_DIR, f));
}

console.log(`Copied ${files.length} tile files from ${backupDir} → ${DEV_DIR}`);
console.log('Now run: npm run dev');
