// Diagnostic for the OSM drape memory issue. Decodes every OSM tile in a
// list, counts source tris, and simulates _tessellateTri / skirt emission
// against a hypothetical "fully hilly" terrain to bound the worst case.
//
// Not optimized — meant to be run from the project root:
//   node scripts/survey_osm_drape.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BIN_MAGIC   = 0x4D534F47; // 'GOSM' little-endian
const BIN_VERSION = 1;
const BIN_GRID    = 250;          // OSM tile side, metres
const BLOCK_STEP  = 125 / 64;     // terrain block pitch, grid space

// Rotation between world <-> grid (Manhattan grid); matches geo.js
const MANHATTAN_GRID_DEG = 29.0;
const GRID_A   = MANHATTAN_GRID_DEG * Math.PI / 180;
const GRID_COS = Math.cos(GRID_A);
const GRID_SIN = Math.sin(GRID_A);
function worldToGrid(x, z) {
  return [x * GRID_COS + z * GRID_SIN, -x * GRID_SIN + z * GRID_COS];
}

function decodeOsmTile(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  const magic = view.getUint32(p, true); p += 4;
  if (magic !== BIN_MAGIC) throw new Error('bad magic');
  p += 1; p += 1; // version, reserved
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

  // Streets
  const streetCount = view.getUint32(p, true); p += 4;
  const streets = [];
  for (let i = 0; i < streetCount; i++) {
    const typeIdx = view.getUint8(p); p += 1;
    const nameLen = view.getUint8(p); p += 1;
    const pointCount = view.getUint16(p, true); p += 2;
    p += nameLen;
    p = (p + 3) & ~3;
    const pts = [];
    for (let k = 0; k < pointCount; k++) {
      pts.push([originX + view.getInt32(p, true) * 0.1, originZ + view.getInt32(p + 4, true) * 0.1]);
      p += 8;
    }
    streets.push({ points: pts });
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
  return { gx, gz, streets, water, green };
}

// Count blocks a triangle's bbox covers (upper bound on sub-tris). The
// actual clip can be zero for corner blocks, but the per-block emission is
// always at least one top quad's worth (2 tris via diagonal split).
function triBlockBbox(a, b, c) {
  const [u0, v0] = worldToGrid(a[0], a[1]);
  const [u1, v1] = worldToGrid(b[0], b[1]);
  const [u2, v2] = worldToGrid(c[0], c[1]);
  const minU = Math.min(u0,u1,u2), maxU = Math.max(u0,u1,u2);
  const minV = Math.min(v0,v1,v2), maxV = Math.max(v0,v1,v2);
  const nU = Math.max(1, Math.floor((maxU - 1e-6) / BLOCK_STEP) - Math.floor(minU / BLOCK_STEP) + 1);
  const nV = Math.max(1, Math.floor((maxV - 1e-6) / BLOCK_STEP) - Math.floor(minV / BLOCK_STEP) + 1);
  return nU * nV;
}

// Rough: fraction of the bbox that a source tri actually covers. Triangle
// is half of its bbox, so the fraction of blocks touched is ~0.5 for large
// tris, but for tiny tris it's closer to 1.0 (they fit in 1–2 blocks). Use
// 0.6 as a smoothed mid-estimate.
const TRI_BBOX_COVERAGE = 0.6;

// Street width (metres) per polyline → ribbon area. Simplified default.
function streetRibbonTris(pts, width = 8) {
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i+1][0] - pts[i][0];
    const dz = pts[i+1][1] - pts[i][1];
    totalLen += Math.hypot(dx, dz);
  }
  // (N-1) segments × 2 tris per segment
  return { segTris: (pts.length - 1) * 2, area: totalLen * width };
}

function surveyTile(buffer) {
  const t = decodeOsmTile(buffer);
  let s = {
    gx: t.gx, gz: t.gz,
    streetCount: t.streets.length,
    waterPolys: t.water.length,
    greenPolys: t.green.length,
    srcTris: 0,
    bboxBlocksTouched: 0,       // upper bound on top sub-tris (each block = 2 sub-tris)
    maxTriBlocks: 0,            // worst single-triangle bbox (signals huge ocean tris)
    hugeTris: 0,                // tris whose bbox > 10000 blocks (>~200m on a side)
    monsterTris: 0,             // tris whose bbox > 1M blocks (>~2km on a side)
  };

  const tallyTri = (a, b, c) => {
    s.srcTris++;
    const n = triBlockBbox(a, b, c);
    s.bboxBlocksTouched += n;
    if (n > s.maxTriBlocks) s.maxTriBlocks = n;
    if (n > 10_000)   s.hugeTris++;
    if (n > 1_000_000) s.monsterTris++;
  };
  for (const flat of t.water) {
    for (let i = 0; i < flat.length; i += 6) {
      tallyTri(
        [flat[i], flat[i+1]], [flat[i+2], flat[i+3]], [flat[i+4], flat[i+5]],
      );
    }
  }
  for (const flat of t.green) {
    for (let i = 0; i < flat.length; i += 6) {
      tallyTri(
        [flat[i], flat[i+1]], [flat[i+2], flat[i+3]], [flat[i+4], flat[i+5]],
      );
    }
  }
  for (const st of t.streets) {
    const { segTris } = streetRibbonTris(st.points);
    s.srcTris += segTris;
    // Rough: each 2-tri segment covers ~ (segLen * width) / blockArea blocks.
    // We approximate by reusing the triangle bbox on each segment tri.
    for (let k = 0; k < st.points.length - 1; k++) {
      const a = st.points[k], b = st.points[k+1];
      // Pretend a fat 8m ribbon segment is a triangle with 8m wide bbox.
      const bboxA = [a[0] - 4, a[1] - 4];
      const bboxB = [a[0] + 4, a[1] + 4];
      const bboxC = [b[0] + 4, b[1] + 4];
      s.bboxBlocksTouched += triBlockBbox(bboxA, bboxB, bboxC);
    }
  }
  return s;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const osmDir = path.resolve('public/osm');
  const args = process.argv.slice(2);
  const sample = args[0] ? parseInt(args[0]) : 200;  // tiles to survey
  const areaFilter = args[1] || null;  // 'fidi' | 'manhattan-north' | null
  const manifest = JSON.parse(fs.readFileSync(path.join(osmDir, 'manifest.json'), 'utf8'));

  // Pick tiles with highest streetCount and biggest file size — those are
  // the memory worst-cases we care about. Optionally restrict to an area.
  const parseCell = (id) => { const m = /cell_(-?\d+)_(-?\d+)/.exec(id); return m ? [+m[1], +m[2]] : [0,0]; };
  const inArea = (gx, gz) => {
    if (!areaFilter) return true;
    // OSM grid = 250m cells; FiDi origin is world (0,0) which is cell (0,0).
    if (areaFilter === 'fidi')            return gx >= -5 && gx <= 5  && gz >= -5 && gz <= 5;
    if (areaFilter === 'manhattan-north') return gx >= -15 && gx <= 5 && gz >= -50 && gz <= -15;
    return true;
  };

  const named = manifest
    .map(e => {
      const [gx, gz] = parseCell(e.id);
      return { id: e.id, streetCount: e.streetCount ?? 0, gx, gz };
    })
    .filter(e => e.streetCount > 0 && inArea(e.gx, e.gz));
  named.sort((a, b) => b.streetCount - a.streetCount);
  const pick = named.slice(0, sample);

  let agg = {
    tilesSurveyed: 0,
    srcTris: 0,
    bboxBlocksTouched: 0,
    hugeTrisTotal: 0,
    monsterTrisTotal: 0,
    tilesWithMonster: 0,
    worstTile: null,
  };

  for (const entry of pick) {
    const gzPath = path.join(osmDir, `${entry.id}.bin.gz`);
    if (!fs.existsSync(gzPath)) continue;
    const gz = fs.readFileSync(gzPath);
    const buf = zlib.gunzipSync(gz);
    const s = surveyTile(buf);
    agg.tilesSurveyed++;
    agg.srcTris += s.srcTris;
    agg.bboxBlocksTouched += s.bboxBlocksTouched;
    agg.hugeTrisTotal += s.hugeTris;
    agg.monsterTrisTotal += s.monsterTris;
    if (s.monsterTris > 0) agg.tilesWithMonster++;
    if (!agg.worstTile || s.bboxBlocksTouched > agg.worstTile.bboxBlocksTouched) {
      agg.worstTile = s;
    }
  }

  // Memory model:
  // - Each sub-tri = 3 verts × (24 B xzOwn kept in JS + 12 B position + 12 B normal) = 144 B
  // - Flat terrain: 2 sub-tris per covered block (diagonal split)
  // - Hilly terrain: +skirts. Up to 4 edges per sub-poly × 2 tris = 8 extra tris per cell edge.
  //   Realistic hilly: ~50% of sub-poly edges emit skirts (~4 skirt tris per covered block).
  const BYTES_PER_TRI = 144;
  const TRIS_FLAT = 2;
  const TRIS_HILLY = 2 + 4;    // moderate hilly
  const TRIS_WORST = 2 + 8;    // every edge is a cliff

  const avg = {
    srcTrisPerTile:    agg.srcTris / agg.tilesSurveyed,
    bboxBlocksPerTile: agg.bboxBlocksTouched / agg.tilesSurveyed,
  };
  const coveredBlocksPerTile = avg.bboxBlocksPerTile * TRI_BBOX_COVERAGE;

  console.log(`Surveyed ${agg.tilesSurveyed} OSM tiles (top by streetCount)`);
  console.log(``);
  console.log(`Per-tile averages:`);
  console.log(`  source tris:          ${avg.srcTrisPerTile.toFixed(0)}`);
  console.log(`  bbox-blocks touched:  ${avg.bboxBlocksPerTile.toFixed(0)}  (upper bound on covered blocks)`);
  console.log(`  est covered blocks:   ${coveredBlocksPerTile.toFixed(0)}  (bbox × ${TRI_BBOX_COVERAGE} coverage)`);
  console.log(``);
  console.log(`Predicted drape geometry per tile (all streets+water+green):`);
  console.log(`  flat terrain:     ${(coveredBlocksPerTile * TRIS_FLAT).toFixed(0)} tris  /  ${humanBytes(coveredBlocksPerTile * TRIS_FLAT * BYTES_PER_TRI)}`);
  console.log(`  moderate hilly:   ${(coveredBlocksPerTile * TRIS_HILLY).toFixed(0)} tris  /  ${humanBytes(coveredBlocksPerTile * TRIS_HILLY * BYTES_PER_TRI)}`);
  console.log(`  worst-case hilly: ${(coveredBlocksPerTile * TRIS_WORST).toFixed(0)} tris  /  ${humanBytes(coveredBlocksPerTile * TRIS_WORST * BYTES_PER_TRI)}`);
  console.log(``);
  console.log(`Huge triangles across sample:`);
  console.log(`  tris with bbox > 10,000 blocks (>200m/side): ${agg.hugeTrisTotal}`);
  console.log(`  tris with bbox >  1,000,000 blocks (>2km/side): ${agg.monsterTrisTotal}`);
  console.log(`  tiles containing ≥1 monster tri: ${agg.tilesWithMonster} / ${agg.tilesSurveyed}`);
  console.log(``);
  console.log(`Worst tile in sample: cell ${agg.worstTile.gx},${agg.worstTile.gz}`);
  console.log(`  streets:  ${agg.worstTile.streetCount}, water polys: ${agg.worstTile.waterPolys}, green polys: ${agg.worstTile.greenPolys}`);
  console.log(`  src tris: ${agg.worstTile.srcTris}, bbox-blocks: ${agg.worstTile.bboxBlocksTouched}`);
  console.log(`  max single-tri bbox-blocks: ${agg.worstTile.maxTriBlocks}  (= ${Math.sqrt(agg.worstTile.maxTriBlocks * 4).toFixed(0)} m/side)`);
  console.log(`  huge tris (>10k): ${agg.worstTile.hugeTris}, monster tris (>1M): ${agg.worstTile.monsterTris}`);
  const w = agg.worstTile.bboxBlocksTouched * TRI_BBOX_COVERAGE;
  console.log(`  worst-tile hilly mem:     ${humanBytes(w * TRIS_HILLY * BYTES_PER_TRI)}`);
  console.log(`  worst-tile very-hilly:    ${humanBytes(w * TRIS_WORST * BYTES_PER_TRI)}`);
  console.log(``);

  // 100m load radius = at most ~4 tiles in flight (tile is 250m so usually 1-4).
  // With the render-distance slider up or on boundary spawn, can hit 4-9 tiles.
  const LOADED_TILES_TYPICAL = 4;
  const LOADED_TILES_MAX = 9;
  console.log(`Steady-state client memory (OSM drape only):`);
  console.log(`  ${LOADED_TILES_TYPICAL} tiles × moderate hilly:   ${humanBytes(LOADED_TILES_TYPICAL * coveredBlocksPerTile * TRIS_HILLY * BYTES_PER_TRI)}`);
  console.log(`  ${LOADED_TILES_MAX} tiles × worst-case hilly: ${humanBytes(LOADED_TILES_MAX * coveredBlocksPerTile * TRIS_WORST * BYTES_PER_TRI)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
