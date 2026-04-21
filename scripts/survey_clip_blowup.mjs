// Independent check: what's the actual bake-time data-size impact of
// clipping each source OSM triangle to its tile's 250m bbox before
// bucketing? Decodes existing tiles, clips each triangle, fan-triangulates,
// and reports the pre/post byte count.
//
// Usage:  node scripts/survey_clip_blowup.mjs [sampleCount]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BIN_MAGIC   = 0x4D534F47;
const BIN_GRID    = 250;     // OSM tile side, metres
const BLEED_M     = 5;       // matches fetch_osm_features.py

function decodeOsmTile(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  const magic = view.getUint32(p, true); p += 4;
  if (magic !== BIN_MAGIC) throw new Error('bad magic');
  p += 2;
  const gx = view.getInt16(p, true); p += 2;
  const gz = view.getInt16(p, true); p += 2;
  const typeCount = view.getUint8(p); p += 1; p += 1;
  for (let i = 0; i < typeCount; i++) {
    const len = view.getUint8(p); p += 1;
    p += len;
  }
  p = (p + 3) & ~3;

  const originX = gx * BIN_GRID;
  const originZ = gz * BIN_GRID;

  // Skip streets (we're only measuring water+green; street ribbons are
  // client-generated from polylines so their clip strategy differs).
  const streetCount = view.getUint32(p, true); p += 4;
  for (let i = 0; i < streetCount; i++) {
    p += 1; const nameLen = view.getUint8(p); p += 1;
    const pointCount = view.getUint16(p, true); p += 2;
    p += nameLen;
    p = (p + 3) & ~3;
    p += pointCount * 8;
  }
  const decodePolys = () => {
    const n = view.getUint32(p, true); p += 4;
    const polys = [];
    for (let i = 0; i < n; i++) {
      const cn = view.getUint32(p, true); p += 4;
      const flat = new Array(cn);
      for (let k = 0; k < cn; k += 2) {
        flat[k]   = originX + view.getInt32(p, true) * 0.1;
        flat[k+1] = originZ + view.getInt32(p + 4, true) * 0.1;
        p += 8;
      }
      polys.push(flat);
    }
    return polys;
  };
  const water = decodePolys();
  const green = decodePolys();
  return { gx, gz, water, green };
}

// Clip a convex polygon against axis-aligned bounds. Returns the clipped
// convex polygon as a flat [x,z,x,z,...] array (length divisible by 2),
// or empty array if the polygon is fully outside.
function clipPolyToBox(flat, xMin, xMax, zMin, zMax) {
  const clipAxis = (poly, axis, boundary, sign) => {
    if (poly.length < 6) return [];
    const out = [];
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = poly[i*2], az = poly[i*2+1];
      const bx = poly[((i+1) % n) * 2], bz = poly[((i+1) % n) * 2 + 1];
      const aVal = axis === 0 ? ax : az;
      const bVal = axis === 0 ? bx : bz;
      const aIn = (aVal - boundary) * sign >= -1e-9;
      const bIn = (bVal - boundary) * sign >= -1e-9;
      if (aIn) out.push(ax, az);
      if (aIn !== bIn) {
        const denom = bVal - aVal;
        const t = denom !== 0 ? (boundary - aVal) / denom : 0;
        out.push(ax + t * (bx - ax), az + t * (bz - az));
      }
    }
    return out;
  };
  let poly = flat;
  poly = clipAxis(poly, 0, xMin, 1);
  poly = clipAxis(poly, 0, xMax, -1);
  poly = clipAxis(poly, 1, zMin, 1);
  poly = clipAxis(poly, 1, zMax, -1);
  return poly;
}

function fanTris(poly) {
  if (poly.length < 6) return 0;
  return poly.length / 2 - 2; // n verts → n-2 tris
}

function main() {
  const osmDir = path.resolve('public/osm');
  const sample = parseInt(process.argv[2]) || 500;
  const manifest = JSON.parse(fs.readFileSync(path.join(osmDir, 'manifest.json'), 'utf8'));
  const pick = manifest
    .filter(e => (e.streetCount ?? 0) > 0)
    .sort((a, b) => (b.streetCount ?? 0) - (a.streetCount ?? 0))
    .slice(0, sample);

  const BYTES_PER_TRI = 24;   // 3 verts × 2 int32s × 4 B
  let sourceTris = 0, clippedTris = 0;
  let sourceBytes = 0, clippedBytes = 0;
  let tilesGrew = 0, tilesShrank = 0;
  let worstTile = null;

  for (const entry of pick) {
    const gzPath = path.join(osmDir, `${entry.id}.bin.gz`);
    if (!fs.existsSync(gzPath)) continue;
    const buf = zlib.gunzipSync(fs.readFileSync(gzPath));
    const t = decodeOsmTile(buf);

    const cellXMin = t.gx * BIN_GRID - BLEED_M;
    const cellXMax = (t.gx + 1) * BIN_GRID + BLEED_M;
    const cellZMin = t.gz * BIN_GRID - BLEED_M;
    const cellZMax = (t.gz + 1) * BIN_GRID + BLEED_M;

    let ts = 0, tc = 0;
    for (const flat of [...t.water, ...t.green]) {
      for (let i = 0; i < flat.length; i += 6) {
        ts++;
        const poly = clipPolyToBox(
          [flat[i], flat[i+1], flat[i+2], flat[i+3], flat[i+4], flat[i+5]],
          cellXMin, cellXMax, cellZMin, cellZMax,
        );
        tc += fanTris(poly);
      }
    }
    sourceTris += ts;
    clippedTris += tc;
    sourceBytes += ts * BYTES_PER_TRI;
    clippedBytes += tc * BYTES_PER_TRI;
    if (tc > ts) tilesGrew++;
    if (tc < ts) tilesShrank++;
    const ratio = ts > 0 ? tc / ts : 1;
    if (!worstTile || ratio > worstTile.ratio) worstTile = { id: entry.id, ts, tc, ratio };
  }

  console.log(`Surveyed ${pick.length} OSM tiles (top by streetCount), water + green only`);
  console.log(``);
  console.log(`Source tris:  ${sourceTris.toLocaleString()}  (${(sourceBytes/1024).toFixed(1)} KB raw coords)`);
  console.log(`Clipped tris: ${clippedTris.toLocaleString()}  (${(clippedBytes/1024).toFixed(1)} KB raw coords)`);
  console.log(`Global multiplier: ${(clippedTris/sourceTris).toFixed(3)}×`);
  console.log(``);
  console.log(`Tiles where clipping grew tri count:   ${tilesGrew}`);
  console.log(`Tiles where clipping shrank tri count: ${tilesShrank} (triangles fully outside tile bleed bbox)`);
  console.log(``);
  console.log(`Worst-tile multiplier: ${worstTile.ratio.toFixed(3)}× (${worstTile.id}, ${worstTile.ts} → ${worstTile.tc} tris)`);
}

main();
