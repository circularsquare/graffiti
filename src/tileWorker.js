// Off-thread tile loader.
//
// Two-phase protocol so the main thread gets buildings visible (and the spawn
// gate can open) without waiting for the expensive seed-cell scan:
//
//   Phase 1 — mesh build: fetch → JSON.parse → per-mesh typed arrays
//             (position, UV, normal, bbox). postMessage 'loaded'.
//   Phase 2 — seed scan:  per-cell Sutherland-Hodgman clip + random seed
//             dice-roll. postMessage 'cellData'.
//
// The worker is single-threaded so the scan still runs serially after the
// mesh build, but because the main thread picks up 'loaded' the instant
// postMessage returns, scene.add + onTileLoaded run in parallel with the
// worker's scan. First-tile latency drops from ~1.5 s to ~300 ms.
//
// Protocol:
//   main → worker: { type:'load', tileId, file, seedConfig: { fraction, colors } }
//   worker → main: { type:'loaded',   tileId, meshes:   [MeshData,   ...] }
//                  { type:'cellData', tileId, cellData: [CellBundle, ...] }
//                  { type:'error',    tileId, error }
//
// MeshData:
//   { buildingId, meshType,
//     position: Float32Array, uv: Float32Array, normal: Float32Array,
//     horizU: [x, z] | null,
//     bbox: { minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz } }
//
// CellBundle:
//   { buildingId, meshType,
//     cellKeys:  string[],
//     cellGeoms: Float32Array[],   // parallel to cellKeys
//     seeds:     Array<{ idx, color, normal: [x,y,z], planeD }> }

const GRID_SIZE    = 2.0;
const OFFSET       = 0.025; // 2.5 cm outward offset along face normal (keep in sync with main.js)
const COPLANAR_TOL = 0.15;  // 15 cm — rejects stepped/ledged faces from matching a cell

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'load') return;

  const { tileId, file, seedConfig } = msg;
  try {
    const t0 = performance.now();
    const res = await fetch(file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const t1 = performance.now();
    const buildings = await res.json();
    const t2 = performance.now();

    // Phase 1 — mesh build. We also snapshot position+uv for phase 2 because
    // the originals get their underlying ArrayBuffers transferred out of the
    // worker by postMessage (transfer list detaches them).
    const meshes     = [];
    const scanInputs = [];
    const transferMesh = [];
    for (const b of buildings) {
      for (const m of buildMeshDataFromBuilding(b)) {
        scanInputs.push({
          buildingId: m.buildingId,
          meshType:   m.meshType,
          pos:        new Float32Array(m.position), // cheap memcpy — small next to scan cost
          uv:         new Float32Array(m.uv),
        });
        meshes.push(m);
        transferMesh.push(m.position.buffer, m.uv.buffer, m.normal.buffer);
      }
    }
    const t3 = performance.now();

    performance.measure('tile:fetch', { start: t0, end: t1 });
    performance.measure('tile:parse', { start: t1, end: t2 });
    performance.measure('tile:build', { start: t2, end: t3 });

    self.postMessage({ type: 'loaded', tileId, meshes }, transferMesh);

    // Phase 2 — seed scan. Runs synchronously in this worker, but the main
    // thread has already picked up 'loaded' and started wrapping meshes.
    const tScan = performance.now();
    const cellData      = [];
    const transferCells = [];
    for (const p of scanInputs) {
      const r = scanCells(p.pos, p.uv, p.buildingId, p.meshType, seedConfig);
      cellData.push({
        buildingId: p.buildingId,
        meshType:   p.meshType,
        cellKeys:   r.cellKeys,
        cellGeoms:  r.cellGeoms,
        seeds:      r.seeds,
      });
      for (const g of r.cellGeoms) transferCells.push(g.buffer);
    }
    performance.measure('tile:scan', { start: tScan, end: performance.now() });

    self.postMessage({ type: 'cellData', tileId, cellData }, transferCells);
  } catch (err) {
    self.postMessage({ type: 'error', tileId, error: err.message });
  }
};

// ── Mesh construction ─────────────────────────────────────────────────────────

function buildMeshDataFromBuilding(b) {
  const minY   = buildingMinY(b.roof, b.walls);
  const horizU = dominantWallDir(b.walls);
  const out = [];
  const roof = makeMeshData(b.roof,  b.id, minY, horizU, 'roof');
  if (roof) out.push(roof);
  const wall = makeMeshData(b.walls, b.id, minY, null,   'wall');
  if (wall) out.push(wall);
  return out;
}

function buildingMinY(roof, walls) {
  let min = Infinity;
  for (const arr of [roof, walls]) {
    if (!arr) continue;
    for (let i = 1; i < arr.length; i += 3) if (arr[i] < min) min = arr[i];
  }
  return min === Infinity ? 0 : min;
}

// Longest horizontal edge across wall triangles, folded to 0–180° hemisphere.
function dominantWallDir(walls) {
  if (!walls || walls.length < 9) return null;
  let bestLen = 0, bestX = 0, bestZ = 0;
  for (let i = 0; i < walls.length; i += 9) {
    const pts = [
      [walls[i],   walls[i+1], walls[i+2]],
      [walls[i+3], walls[i+4], walls[i+5]],
      [walls[i+6], walls[i+7], walls[i+8]],
    ];
    for (let k = 0; k < 3; k++) {
      const a = pts[k], b = pts[(k + 1) % 3];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const hLen = Math.sqrt(dx * dx + dz * dz);
      if (hLen < 0.01 || Math.abs(dy) > hLen * 0.3) continue;
      if (hLen > bestLen) { bestLen = hLen; bestX = dx / hLen; bestZ = dz / hLen; }
    }
  }
  if (bestLen < 0.1) return null;
  if (bestX < 0 || (bestX === 0 && bestZ < 0)) { bestX = -bestX; bestZ = -bestZ; }
  return [bestX, bestZ];
}

function makeMeshData(flatVerts, id, minY, horizU, meshType) {
  if (!flatVerts || flatVerts.length < 9) return null;

  // Shift Y so base sits at y=0 and accumulate bbox in one pass.
  const count = flatVerts.length;
  const verts = new Float32Array(count);
  let minX =  Infinity, minYo =  Infinity, minZ =  Infinity;
  let maxX = -Infinity, maxYo = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i += 3) {
    const x = flatVerts[i];
    const y = flatVerts[i + 1] - minY;
    const z = flatVerts[i + 2];
    verts[i] = x; verts[i + 1] = y; verts[i + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minYo) minYo = y; if (y > maxYo) maxYo = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const uv     = computeGridUVs(verts, GRID_SIZE, horizU);
  const normal = computeFlatNormals(verts);

  return {
    buildingId: id,
    meshType,
    position: verts,
    uv,
    normal,
    horizU,
    bbox: {
      minX, minY: minYo, minZ,
      maxX, maxY: maxYo, maxZ,
      cx: (minX + maxX) / 2,
      cy: (minYo + maxYo) / 2,
      cz: (minZ + maxZ) / 2,
    },
  };
}

// Face-tangent UVs: axes lie in the face plane so the 2 m grid is undistorted
// on any surface angle. V = world UP projected onto the face (falls back to
// horizU / world NORTH for near-horizontal faces); U = cross(V, n).
function computeGridUVs(flatVerts, gridSize, horizU) {
  const count = flatVerts.length / 3;
  const uvs   = new Float32Array(count * 2);

  for (let ti = 0; ti < count; ti += 3) {
    const i0 = ti * 3, i1 = i0 + 3, i2 = i0 + 6;

    const ax = flatVerts[i0],   ay = flatVerts[i0 + 1], az = flatVerts[i0 + 2];
    const bx = flatVerts[i1],   by = flatVerts[i1 + 1], bz = flatVerts[i1 + 2];
    const cx = flatVerts[i2],   cy = flatVerts[i2 + 1], cz = flatVerts[i2 + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-10) continue;
    nx /= nl; ny /= nl; nz /= nl;

    let vx = -ny * nx, vy = 1 - ny * ny, vz = -ny * nz;
    let vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vl < 0.1) {
      if (horizU) { vx = horizU[0]; vy = 0; vz = horizU[1]; }
      else        { vx = -nz * nx; vy = -nz * ny; vz = 1 - nz * nz; }
      vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
    vx /= vl; vy /= vl; vz /= vl;

    const ux = vy * nz - vz * ny;
    const uy = vz * nx - vx * nz;
    const uz = vx * ny - vy * nx;

    const pts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    for (let k = 0; k < 3; k++) {
      const [px, py, pz] = pts[k];
      uvs[(ti + k) * 2]     = (px * ux + py * uy + pz * uz) / gridSize;
      uvs[(ti + k) * 2 + 1] = (px * vx + py * vy + pz * vz) / gridSize;
    }
  }

  return uvs;
}

// For non-indexed geometry each triangle owns 3 unique vertices, so each
// vertex gets the triangle's face normal — equivalent to flat shading and
// matches THREE.BufferGeometry.computeVertexNormals() on non-indexed input.
function computeFlatNormals(verts) {
  const count = verts.length;
  const normals = new Float32Array(count);
  for (let i = 0; i < count; i += 9) {
    const ax = verts[i],     ay = verts[i + 1], az = verts[i + 2];
    const bx = verts[i + 3], by = verts[i + 4], bz = verts[i + 5];
    const cx = verts[i + 6], cy = verts[i + 7], cz = verts[i + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    for (let k = 0; k < 3; k++) {
      normals[i + k * 3]     = nx;
      normals[i + k * 3 + 1] = ny;
      normals[i + k * 3 + 2] = nz;
    }
  }
  return normals;
}

// ── Seed-cell triangle scan ──────────────────────────────────────────────────
//
// For every UV cell (integer bucket) a triangle overlaps, we Sutherland-Hodgman
// clip the triangle to the cell, apply a 2.5 cm outward offset along the face
// normal, and accumulate the resulting polygon into that cell's geometry. The
// same discovery pass also rolls the random seed dice for each cell so the
// main thread doesn't have to iterate cells again.
//
// planeDKey = Math.round(planeD * 2) → 50 cm buckets. Wider than COPLANAR_TOL
// so same-face triangles always share a key; parallel faces < 50 cm apart on
// the same building share a key (rare in FiDi). Must match resolveGroup() in
// main.js.

function scanCells(pos, uv, buildingId, meshType, seedConfig) {
  const triCount = (pos.length / 9) | 0;

  // cellKey → { normal, planeD, verts[] }
  const discovered = new Map();

  for (let ti = 0; ti < triCount; ti++) {
    const pi = ti * 9, ui = ti * 6;
    const tri = [
      { pos: [pos[pi],     pos[pi + 1], pos[pi + 2]], uv: [uv[ui],     uv[ui + 1]] },
      { pos: [pos[pi + 3], pos[pi + 4], pos[pi + 5]], uv: [uv[ui + 2], uv[ui + 3]] },
      { pos: [pos[pi + 6], pos[pi + 7], pos[pi + 8]], uv: [uv[ui + 4], uv[ui + 5]] },
    ];

    const triNorm   = norm3(cross3(sub3(tri[1].pos, tri[0].pos), sub3(tri[2].pos, tri[0].pos)));
    const cx = (tri[0].pos[0] + tri[1].pos[0] + tri[2].pos[0]) / 3;
    const cy = (tri[0].pos[1] + tri[1].pos[1] + tri[2].pos[1]) / 3;
    const cz = (tri[0].pos[2] + tri[1].pos[2] + tri[2].pos[2]) / 3;
    const triPlaneD = cx * triNorm[0] + cy * triNorm[1] + cz * triNorm[2];
    const triPdKey  = Math.round(triPlaneD * 2);

    const u0 = tri[0].uv[0], u1 = tri[1].uv[0], u2 = tri[2].uv[0];
    const v0 = tri[0].uv[1], v1 = tri[1].uv[1], v2 = tri[2].uv[1];
    const uMin = Math.floor(Math.min(u0, u1, u2));
    const uMax = Math.floor(Math.max(u0, u1, u2));
    const vMin = Math.floor(Math.min(v0, v1, v2));
    const vMax = Math.floor(Math.max(v0, v1, v2));

    for (let cu = uMin; cu <= uMax; cu++) {
      for (let cv = vMin; cv <= vMax; cv++) {
        const cellKey = `${buildingId}:${meshType}:${cu}:${cv}:${triPdKey}`;

        let entry = discovered.get(cellKey);
        if (!entry) {
          entry = { normal: triNorm, planeD: triPlaneD, verts: [] };
          discovered.set(cellKey, entry);
        }

        // Reject triangles inconsistent with this cell's stored face
        if (dot3(triNorm, entry.normal) < 0.7) continue;
        if (Math.abs(triPlaneD - entry.planeD) > COPLANAR_TOL) continue;

        let poly = tri;
        poly = clipHalfPlane(poly, 0, cu,     +1);
        poly = clipHalfPlane(poly, 0, cu + 1, -1);
        poly = clipHalfPlane(poly, 1, cv,     +1);
        poly = clipHalfPlane(poly, 1, cv + 1, -1);
        if (poly.length < 3) continue;

        const cn = triNorm;
        for (let k = 1; k < poly.length - 1; k++) {
          for (const v of [poly[0], poly[k], poly[k + 1]]) {
            entry.verts.push(
              v.pos[0] + cn[0] * OFFSET,
              v.pos[1] + cn[1] * OFFSET,
              v.pos[2] + cn[2] * OFFSET,
            );
          }
        }
      }
    }
  }

  // Flatten the discovered map into parallel arrays + roll seed dice.
  // Already-painted cells are filtered out on the main thread (worker has no
  // access to paintStore); the wasted dice rolls here are trivial.
  const seedFraction = seedConfig ? seedConfig.fraction : 0;
  const seedColors   = seedConfig ? seedConfig.colors   : null;

  const cellKeys  = new Array(discovered.size);
  const cellGeoms = new Array(discovered.size);
  const seeds     = [];
  let idx = 0;
  for (const [cellKey, entry] of discovered) {
    cellKeys[idx]  = cellKey;
    cellGeoms[idx] = new Float32Array(entry.verts);
    if (seedColors && Math.random() < seedFraction) {
      const color = seedColors[(Math.random() * seedColors.length) | 0];
      seeds.push({ idx, color, normal: entry.normal, planeD: entry.planeD });
    }
    idx++;
  }

  return { cellKeys, cellGeoms, seeds };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function cross3(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot3(a, b)   { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function sub3(a, b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function lerp3(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]), a[2]+t*(b[2]-a[2])]; }
function lerp2(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])]; }
function norm3(v)     { const l = Math.sqrt(dot3(v,v)); return l ? [v[0]/l,v[1]/l,v[2]/l] : v; }

function clipHalfPlane(poly, axisIdx, value, sign) {
  if (!poly.length) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i], next = poly[(i + 1) % poly.length];
    const cv = curr.uv[axisIdx], nv = next.uv[axisIdx];
    const cIn = sign > 0 ? cv >= value : cv <= value;
    const nIn = sign > 0 ? nv >= value : nv <= value;
    if (cIn) out.push(curr);
    if (cIn !== nIn) {
      const t = (value - cv) / (nv - cv);
      out.push({ pos: lerp3(curr.pos, next.pos, t), uv: lerp2(curr.uv, next.uv, t) });
    }
  }
  return out;
}
