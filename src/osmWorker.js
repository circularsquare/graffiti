// OSM drape tessellation worker. Main thread posts a tile's source polygons +
// streets; the worker returns interleaved 7-float-per-vertex `topXz` arrays
// (one per layer: water/green/streets) plus the set of terrain blocks each
// layer covers. Main thread still owns terrain sampling, so skirt emission
// and Y resolution (`_drapeIntoPositions`) stay on main after the roundtrip.
//
// See OsmManager.js for the full comment on the vertex layout and how the
// 7-float layout flows back into `_drapeIntoPositions` for Y lookup.

import { worldToGrid, gridToWorld } from './geo.js';
import { emitStreetTrisXZ } from './streetGeometry.js';

const BLOCK_STEP = 125 / 64;

// ── Polygon clipping (convex, Sutherland–Hodgman style) ──────────────────────
//
// Hot path — called once per (source triangle × covered cell × 4 cell edges +
// 2 diagonal halves). Previously allocated a fresh `[]` and `[u,v]` tuples per
// clip edge and per intersection, which showed up as ~12% combined
// Major+C++ GC in the per-tile-load spike. These scratch buffers reuse the
// same memory across every triangle — we're in a worker so there's no
// re-entrancy to worry about. `_triBuf` holds the source triangle read-only
// across all cells it covers; `_polyA`/`_polyB` flip-flop as the clip
// pipeline's input and output. Max fill after 4 cell clips + 1 diagonal clip
// starting from 3 verts is 3+5=8 verts; sized to 16 × 2 for headroom.
const _triBuf = new Float32Array(32);
const _polyA  = new Float32Array(32);
const _polyB  = new Float32Array(32);

// `src` and `dst` are interleaved u,v pairs; `srcLen`/return-value are vertex
// counts. Returns the number of vertices written into `dst` (0–srcLen+1).
function _clipHalfPlaneInto(src, srcLen, dst, axis, boundary, sign) {
  if (srcLen === 0) return 0;
  let dstLen = 0;
  for (let i = 0; i < srcLen; i++) {
    const ai = i * 2;
    const bi = ((i + 1) % srcLen) * 2;
    const aAxis = src[ai + axis];
    const bAxis = src[bi + axis];
    const aIn = (aAxis - boundary) * sign >= -1e-9;
    const bIn = (bAxis - boundary) * sign >= -1e-9;
    if (aIn) {
      dst[dstLen * 2    ] = src[ai    ];
      dst[dstLen * 2 + 1] = src[ai + 1];
      dstLen++;
    }
    if (aIn !== bIn) {
      const denom = bAxis - aAxis;
      const t = denom !== 0 ? (boundary - aAxis) / denom : 0;
      dst[dstLen * 2    ] = src[ai    ] + t * (src[bi    ] - src[ai    ]);
      dst[dstLen * 2 + 1] = src[ai + 1] + t * (src[bi + 1] - src[ai + 1]);
      dstLen++;
    }
  }
  return dstLen;
}

// Clip along the cell's NW-SE diagonal (u - v = boundary). See the removed
// `_clipAlongDiagonal` note in the Git history for why this split is needed
// — each sub-poly must sit inside one of the terrain's two per-cell
// triangles so the drape matches `sampleTriangulated` exactly.
function _clipDiagonalInto(src, srcLen, dst, gx, gz, keepNE) {
  if (srcLen === 0) return 0;
  const boundary = (gx - gz) * BLOCK_STEP;
  const sign = keepNE ? 1 : -1;
  let dstLen = 0;
  for (let i = 0; i < srcLen; i++) {
    const ai = i * 2;
    const bi = ((i + 1) % srcLen) * 2;
    const au = src[ai], av = src[ai + 1];
    const bu = src[bi], bv = src[bi + 1];
    const aDiag = au - av;
    const bDiag = bu - bv;
    const aIn = (aDiag - boundary) * sign >= -1e-9;
    const bIn = (bDiag - boundary) * sign >= -1e-9;
    if (aIn) {
      dst[dstLen * 2    ] = au;
      dst[dstLen * 2 + 1] = av;
      dstLen++;
    }
    if (aIn !== bIn) {
      const denom = bDiag - aDiag;
      const t = denom !== 0 ? (boundary - aDiag) / denom : 0;
      dst[dstLen * 2    ] = au + t * (bu - au);
      dst[dstLen * 2 + 1] = av + t * (bv - av);
      dstLen++;
    }
  }
  return dstLen;
}

function _emitVert(u, v, blockGx, blockGz, keepNE, outXZ) {
  const [wx, wz] = gridToWorld(u, v);
  outXZ.push(wx, wz, u, v, blockGx, blockGz, keepNE ? 1.0 : 0.0);
}

// Fan-triangulate the interleaved `poly` (2 floats/vert, first `polyLen` verts
// are live) and emit one vertex triple per fan triangle into `outXZ`.
function _emitSubPolyTop(poly, polyLen, blockGx, blockGz, keepNE, outXZ) {
  if (polyLen < 3) return;
  const p0u = poly[0], p0v = poly[1];
  for (let i = 1; i < polyLen - 1; i++) {
    const piu = poly[i * 2    ],     piv = poly[i * 2 + 1    ];
    const pju = poly[(i + 1) * 2], pjv = poly[(i + 1) * 2 + 1];
    _emitVert(p0u, p0v, blockGx, blockGz, keepNE, outXZ);
    _emitVert(piu, piv, blockGx, blockGz, keepNE, outXZ);
    _emitVert(pju, pjv, blockGx, blockGz, keepNE, outXZ);
  }
}

function _tessellateTriTops(v0, v1, v2, outXZ, coveredBlocks) {
  const [u0, nv0] = worldToGrid(v0[0], v0[1]);
  const [u1, nv1] = worldToGrid(v1[0], v1[1]);
  const [u2, nv2] = worldToGrid(v2[0], v2[1]);
  _triBuf[0] = u0; _triBuf[1] = nv0;
  _triBuf[2] = u1; _triBuf[3] = nv1;
  _triBuf[4] = u2; _triBuf[5] = nv2;

  const minU = Math.min(u0, u1, u2);
  const maxU = Math.max(u0, u1, u2);
  const minV = Math.min(nv0, nv1, nv2);
  const maxV = Math.max(nv0, nv1, nv2);
  const gxMin = Math.floor(minU / BLOCK_STEP);
  const gxMax = Math.floor((maxU - 1e-6) / BLOCK_STEP);
  const gzMin = Math.floor(minV / BLOCK_STEP);
  const gzMax = Math.floor((maxV - 1e-6) / BLOCK_STEP);

  for (let gx = gxMin; gx <= gxMax; gx++) {
    const uMin = gx * BLOCK_STEP;
    const uMax = uMin + BLOCK_STEP;
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const vMin = gz * BLOCK_STEP;
      const vMax = vMin + BLOCK_STEP;

      // Sutherland–Hodgman against the cell rect, flip-flopping scratch.
      let len = _clipHalfPlaneInto(_triBuf, 3,   _polyA, 0, uMin,  1);
      if (len < 3) continue;
      len     = _clipHalfPlaneInto(_polyA,  len, _polyB, 0, uMax, -1);
      if (len < 3) continue;
      len     = _clipHalfPlaneInto(_polyB,  len, _polyA, 1, vMin,  1);
      if (len < 3) continue;
      len     = _clipHalfPlaneInto(_polyA,  len, _polyB, 1, vMax, -1);
      if (len < 3) continue;
      // `_polyB[0..len-1]` now holds the cell-clipped poly.

      coveredBlocks?.add(`${gx},${gz}`);

      // Diagonal split — emit NE half, then SW half. Each diagonal clip reads
      // from `_polyB` and writes into `_polyA`; emission finishes before the
      // next clip overwrites `_polyA`.
      const lenNE = _clipDiagonalInto(_polyB, len, _polyA, gx, gz, true);
      _emitSubPolyTop(_polyA, lenNE, gx, gz, true, outXZ);

      const lenSW = _clipDiagonalInto(_polyB, len, _polyA, gx, gz, false);
      _emitSubPolyTop(_polyA, lenSW, gx, gz, false, outXZ);
    }
  }
}

// ── Per-layer drape build ────────────────────────────────────────────────────
//
// Packs the tessellated top vertices (interleaved 7 floats/vert) into one
// Float32Array per layer, plus the list of terrain blocks the layer covers
// (as packed Int32Array of gx,gz pairs) so main can run skirt emission
// against live terrain state. `hasTerrain` gates covered-block tracking — in
// flat mode, skirts aren't emitted so we skip the Set too.

function _buildPolygonLayerTop(polygons, hasTerrain) {
  const topXz = [];
  const coveredBlocks = hasTerrain ? new Set() : null;
  for (const flat of polygons) {
    for (let i = 0; i < flat.length; i += 6) {
      _tessellateTriTops(
        [flat[i    ], flat[i + 1]],
        [flat[i + 2], flat[i + 3]],
        [flat[i + 4], flat[i + 5]],
        topXz, coveredBlocks,
      );
    }
  }
  return { topXz, coveredBlocks };
}

function _buildStreetLayerTop(streets, hasTerrain) {
  const topXz = [];
  const coveredBlocks = hasTerrain ? new Set() : null;
  if (!streets.length) return { topXz, coveredBlocks };
  const segXZ = [];
  emitStreetTrisXZ(streets, segXZ);
  for (let i = 0; i < segXZ.length; i += 6) {
    _tessellateTriTops(
      [segXZ[i    ], segXZ[i + 1]],
      [segXZ[i + 2], segXZ[i + 3]],
      [segXZ[i + 4], segXZ[i + 5]],
      topXz, coveredBlocks,
    );
  }
  return { topXz, coveredBlocks };
}

// Pack a Set<"gx,gz"> into a flat Int32Array of [gx0, gz0, gx1, gz1, ...] so
// it ships via transferables instead of structured clone. Null in → null out.
function _packCoveredBlocks(coveredBlocks) {
  if (!coveredBlocks) return null;
  const out = new Int32Array(coveredBlocks.size * 2);
  let i = 0;
  for (const key of coveredBlocks) {
    const ci = key.indexOf(',');
    out[i++] = +key.slice(0, ci);
    out[i++] = +key.slice(ci + 1);
  }
  return out;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'buildDrape') return;
  const { jobId, hasTerrain, water, green, streets } = msg;

  try {
    const w = _buildPolygonLayerTop(water  || [], hasTerrain);
    const g = _buildPolygonLayerTop(green  || [], hasTerrain);
    const s = _buildStreetLayerTop(streets || [], hasTerrain);

    const wTop = new Float32Array(w.topXz);
    const gTop = new Float32Array(g.topXz);
    const sTop = new Float32Array(s.topXz);
    const wBlocks = _packCoveredBlocks(w.coveredBlocks);
    const gBlocks = _packCoveredBlocks(g.coveredBlocks);
    const sBlocks = _packCoveredBlocks(s.coveredBlocks);

    const transfer = [wTop.buffer, gTop.buffer, sTop.buffer];
    if (wBlocks) transfer.push(wBlocks.buffer);
    if (gBlocks) transfer.push(gBlocks.buffer);
    if (sBlocks) transfer.push(sBlocks.buffer);

    self.postMessage({
      type: 'drapeResult',
      jobId,
      water:   { topXz: wTop, coveredBlocks: wBlocks },
      green:   { topXz: gTop, coveredBlocks: gBlocks },
      streets: { topXz: sTop, coveredBlocks: sBlocks },
    }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', jobId, error: err.message });
  }
};
