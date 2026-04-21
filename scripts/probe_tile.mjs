// Decode one OSM tile and report what's inside it — counts + bbox per
// feature, plus a dump of polygon extents. Handy when a specific tile
// looks wrong in-game.
//
// Usage:  node scripts/probe_tile.mjs <gx> <gz>

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BIN_MAGIC = 0x4D534F47;
const BIN_GRID  = 250;

function decodeOsmTile(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  if (view.getUint32(p, true) !== BIN_MAGIC) throw new Error('bad magic');
  p += 4; p += 2;
  const gx = view.getInt16(p, true); p += 2;
  const gz = view.getInt16(p, true); p += 2;
  const typeCount = view.getUint8(p); p += 1; p += 1;
  const types = [];
  const td = new TextDecoder();
  for (let i = 0; i < typeCount; i++) {
    const len = view.getUint8(p); p += 1;
    types.push(td.decode(new Uint8Array(buffer.buffer, buffer.byteOffset + p, len)));
    p += len;
  }
  p = (p + 3) & ~3;

  const originX = gx * BIN_GRID;
  const originZ = gz * BIN_GRID;

  const streetCount = view.getUint32(p, true); p += 4;
  const streets = [];
  for (let i = 0; i < streetCount; i++) {
    const typeIdx = view.getUint8(p); p += 1;
    const nameLen = view.getUint8(p); p += 1;
    const pointCount = view.getUint16(p, true); p += 2;
    const name = nameLen > 0
      ? td.decode(new Uint8Array(buffer.buffer, buffer.byteOffset + p, nameLen))
      : '';
    p += nameLen;
    p = (p + 3) & ~3;
    const pts = [];
    for (let k = 0; k < pointCount; k++) {
      pts.push([
        originX + view.getInt32(p, true) * 0.1,
        originZ + view.getInt32(p + 4, true) * 0.1,
      ]);
      p += 8;
    }
    streets.push({ type: types[typeIdx], name, pts });
  }

  const decodePolys = () => {
    const n = view.getUint32(p, true); p += 4;
    const polys = [];
    for (let i = 0; i < n; i++) {
      const cn = view.getUint32(p, true); p += 4;
      const flat = [];
      for (let k = 0; k < cn; k += 2) {
        flat.push(originX + view.getInt32(p,     true) * 0.1);
        flat.push(originZ + view.getInt32(p + 4, true) * 0.1);
        p += 8;
      }
      polys.push(flat);
    }
    return polys;
  };

  return { gx, gz, streets, water: decodePolys(), green: decodePolys() };
}

function polyArea(flat) {
  // Sum of signed triangle areas for a flat tri list (6 floats/tri).
  let a = 0;
  for (let i = 0; i < flat.length; i += 6) {
    const ax = flat[i], az = flat[i+1];
    const bx = flat[i+2], bz = flat[i+3];
    const cx = flat[i+4], cz = flat[i+5];
    a += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
  }
  return a;
}

function polyBbox(flat) {
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] < minX) minX = flat[i];
    if (flat[i] > maxX) maxX = flat[i];
    if (flat[i+1] < minZ) minZ = flat[i+1];
    if (flat[i+1] > maxZ) maxZ = flat[i+1];
  }
  return { minX, maxX, minZ, maxZ };
}

const [gxStr, gzStr] = process.argv.slice(2);
const gx = parseInt(gxStr);
const gz = parseInt(gzStr);
const file = path.resolve(`public/osm/cell_${gx}_${gz}.bin.gz`);
if (!fs.existsSync(file)) {
  console.log(`no tile at ${gx},${gz}`);
  process.exit(1);
}
const t = decodeOsmTile(zlib.gunzipSync(fs.readFileSync(file)));

const tileArea = 250 * 250;
console.log(`Cell (${t.gx}, ${t.gz})  world bbox [${t.gx*250}..${(t.gx+1)*250}, ${t.gz*250}..${(t.gz+1)*250}]`);
console.log(`  streets: ${t.streets.length}   water polys: ${t.water.length}   green polys: ${t.green.length}`);
console.log('');

const showPolys = (label, polys) => {
  console.log(`${label}:`);
  let total = 0;
  for (let i = 0; i < polys.length; i++) {
    const a = polyArea(polys[i]);
    const bb = polyBbox(polys[i]);
    total += a;
    console.log(`  [${i}] ${polys[i].length/6} tris, area ${a.toFixed(1)} m²  bbox x[${bb.minX.toFixed(1)}..${bb.maxX.toFixed(1)}] z[${bb.minZ.toFixed(1)}..${bb.maxZ.toFixed(1)}]`);
  }
  console.log(`  total area: ${total.toFixed(1)} m² / tile ${tileArea} m² = ${(total/tileArea*100).toFixed(1)}% coverage`);
  console.log('');
};

showPolys('water', t.water);
showPolys('green', t.green);
console.log('street names:', [...new Set(t.streets.map(s => s.name).filter(Boolean))].slice(0, 20).join(', '));
