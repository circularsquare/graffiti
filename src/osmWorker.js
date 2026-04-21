// OSM drape tessellation worker. Main thread posts a tile's source polygons +
// streets; the worker returns interleaved 7-float-per-vertex `topXz` arrays
// (one per layer: water/green/streets) plus the set of terrain blocks each
// layer covers. Main thread still owns terrain sampling, so skirt emission
// and Y resolution (`_drapeIntoPositions`) stay on main after the roundtrip.
//
// See OsmManager.js for the full comment on the vertex layout and how the
// 7-float layout flows back into `_drapeIntoPositions` for Y lookup.

import { worldToGrid, gridToWorld } from './geo.js';

const BLOCK_STEP = 125 / 64;

const TYPE_WIDTH = {
  motorway: 11, motorway_link: 8,
  trunk: 10,    trunk_link: 7,
  primary: 9,   primary_link: 6,
  secondary: 8, secondary_link: 5,
  tertiary: 7,  tertiary_link: 5,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  service: 4,
  pedestrian: 4,
  footway: 2.5,
  cycleway: 2.5,
  path: 2,
  steps: 2,
  track: 3,
};
const DEFAULT_WIDTH = 5;

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

// ── Street ribbon emission with miter joins ─────────────────────────────────

function _emitStreetTrisXZ(streets, outXZ) {
  const offX = [];
  const offZ = [];
  for (const s of streets) {
    const width = TYPE_WIDTH[s.type] ?? DEFAULT_WIDTH;
    const half  = width * 0.5;
    const endExtend = width * 0.1;
    const pts  = s.points;
    if (!pts || pts.length < 2) continue;
    const N = pts.length;
    offX.length = N;
    offZ.length = N;

    for (let i = 0; i < N; i++) {
      let inX = 0,  inZ = 0;
      let outX = 0, outZ = 0;
      let hasIn = false, hasOut = false;
      if (i > 0) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dz = pts[i][1] - pts[i - 1][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { inX = dx / len; inZ = dz / len; hasIn = true; }
      }
      if (i < N - 1) {
        const dx = pts[i + 1][0] - pts[i][0];
        const dz = pts[i + 1][1] - pts[i][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { outX = dx / len; outZ = dz / len; hasOut = true; }
      }

      let tx, tz;
      if (hasIn && hasOut) { tx = inX + outX; tz = inZ + outZ; }
      else if (hasIn)      { tx = inX;        tz = inZ; }
      else                 { tx = outX;       tz = outZ; }
      const tlen = Math.hypot(tx, tz);
      if (tlen < 1e-6) {
        tx = hasOut ? outX : inX;
        tz = hasOut ? outZ : inZ;
      } else {
        tx /= tlen; tz /= tlen;
      }
      const px = -tz, pz = tx;

      let miter = half;
      if (hasIn && hasOut) {
        const inPx = -inZ, inPz = inX;
        const c = px * inPx + pz * inPz;
        if (Math.abs(c) > 0.2) miter = half / c;
        else                   miter = (c >= 0 ? 4 : -4) * half;
      }
      const maxMiter = 4 * half;
      if (miter >  maxMiter) miter =  maxMiter;
      if (miter < -maxMiter) miter = -maxMiter;

      offX[i] = px * miter;
      offZ[i] = pz * miter;
    }

    for (let i = 0; i < N - 1; i++) {
      let x0 = pts[i][0],     z0 = pts[i][1];
      let x1 = pts[i + 1][0], z1 = pts[i + 1][1];
      if (i === 0) {
        const dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { x0 -= (dx / len) * endExtend; z0 -= (dz / len) * endExtend; }
      }
      if (i + 1 === N - 1) {
        const dx = pts[N - 1][0] - pts[N - 2][0], dz = pts[N - 1][1] - pts[N - 2][1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) { x1 += (dx / len) * endExtend; z1 += (dz / len) * endExtend; }
      }
      const o0x = offX[i],     o0z = offZ[i];
      const o1x = offX[i + 1], o1z = offZ[i + 1];

      outXZ.push(
        x0 + o0x, z0 + o0z,
        x0 - o0x, z0 - o0z,
        x1 - o1x, z1 - o1z,
        x0 + o0x, z0 + o0z,
        x1 - o1x, z1 - o1z,
        x1 + o1x, z1 + o1z,
      );
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
  _emitStreetTrisXZ(streets, segXZ);
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
