// Off-thread tile loader.
//
// Two-phase protocol so the main thread gets buildings visible (and the spawn
// gate can open) without waiting for the expensive seed-cell scan:
//
//   Phase 1 — mesh build: fetch → JSON.parse → per-mesh typed arrays
//             (position, UV, normal, lineCoord, bbox). postMessage 'loaded'.
//   Phase 2 — seed scan:  per-cell Sutherland-Hodgman clip + random seed
//             dice-roll. postMessage 'cellData'.
//
// The worker is single-threaded so the scan still runs serially after the
// mesh build, but because the main thread picks up 'loaded' the instant
// postMessage returns, scene.add + onTileLoaded run in parallel with the
// worker's scan.
//
// Before UV projection and cell scanning we group triangles into "faces" by
// greedy-seed near-coplanar matching: a triangle joins an existing face if
// its normal agrees within ~1.8° (dot > FACE_NDOT_TIGHT) and its plane offset
// is within FACE_DIST_TIGHT (15 cm). All triangles in a face share a single
// UV basis, so the grid is continuous across the triangulation's diagonal —
// the CityGML source often has quads that aren't quite coplanar, and
// per-triangle UVs would drift visibly at the shared diagonal. The face also
// drives the shader-side face outline (see computeLineCoords): edges internal
// to a face get zeroed out so only real face boundaries draw a border.
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
//     lineCoord: Float32Array,   // 3 floats per vertex — per-edge perp. distance
//     horizU: [x, z] | null,
//     bbox: { minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz } }
//
// CellBundle:
//   { buildingId, meshType,
//     cellKeys:  string[],
//     cellGeoms: Float32Array[],   // parallel to cellKeys
//     seeds:     Array<{ idx, color, normal: [x,y,z], planeD }>,
//     cellGroups: Array<Array<cellKey>>  // paint-groups of size >= 2; singletons implicit }

const GRID_SIZE    = 2.0;
const OFFSET       = 0.025; // 2.5 cm outward offset along face normal (keep in sync with main.js)
const COPLANAR_TOL = 0.15;  // 15 cm — rejects stepped/ledged faces from matching a cell
// Face-equivalence thresholds. Two values per axis (normal + distance), used
// in three combinations across three passes:
//
//   greedy initial   — TIGHT normal + TIGHT distance.
//                      Single-triangle commit. Errors are irreversible mid-
//                      pass and contaminate the face's running averages,
//                      so we err on the side of "different face".
//
//   face post-merge  — TIGHT normal + LOOSE distance.
//                      Face averages are less noisy than single triangles,
//                      so we let plane-distance breathe more — the whole
//                      point of post-merge is to catch coplanar faces
//                      greedy split. We keep the normal check tight because
//                      we'd rather leave two genuinely-angled faces apart
//                      than fuse them.
//
//   cell overlap dedupe — LOOSE normal + LOOSE distance.
//                      At the cell level, paint correctness trumps face
//                      fidelity: two cells at the same (cu, cv) will visually
//                      overlap and z-fight if not fused, even if their owning
//                      faces are genuinely a few degrees / centimetres apart.
//                      Loosen both axes here.
const FACE_NDOT_TIGHT = 0.9995; // ~1.8°
const FACE_NDOT_LOOSE = 0.99;   // ~8°
const FACE_DIST_TIGHT = 0.15;   // 15 cm
const FACE_DIST_LOOSE = 0.30;   // 30 cm

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

    // Phase 1 — mesh build. Roof + wall get merged into ONE meshData per
    // building so the renderer issues half as many draw calls (each building
    // previously emitted two meshes sharing identical materials; see
    // loadCityGML.js BUILDING_MAT). Phase 2 still gets per-meshType inputs
    // because scanCells keys cells by meshType in the cellKey — that's how
    // `buildingId:roof:cu:cv:pd` stays distinct from `buildingId:wall:…`.
    //
    // We also snapshot position+uv and the face data for phase 2 because the
    // originals get their underlying ArrayBuffers transferred out of the
    // worker by postMessage (transfer list detaches them).
    const meshes       = [];
    const scanInputs   = [];
    const transferMesh = [];
    for (const b of buildings) {
      const perType = buildMeshDataFromBuilding(b);
      if (perType.length === 0) continue;

      // Per-meshType scan inputs for phase 2 (scanCells expects single-meshType data).
      for (const built of perType) {
        const m = built.meshData;
        scanInputs.push({
          buildingId: m.buildingId,
          meshType:   m.meshType,
          pos:        new Float32Array(m.position), // cheap memcpy — small next to scan cost
          uv:         new Float32Array(m.uv),
          faces:      built.faceInfo.faces,
          // triFace is also transferred out on the MeshData, so snapshot it
          // here; otherwise phase 2 would see a detached buffer.
          triFace:    new Int32Array(built.faceInfo.triFace),
          horizU:     m.horizU, // needed by buildCellGroups for tangent basis fallback on roof-ish faces
        });
      }

      // Merge roof + wall into one meshData. Each face carries its meshType
      // so main.js#hitCell can still recover per-triangle meshType via
      // faces[triFace[ti]].meshType. userData.buildingKeys lists the
      // ['id:roof', 'id:wall'] this mesh represents (for buildingMeshMap
      // registration + unload cleanup in TileManager).
      const merged = buildMergedMeshData(perType);
      meshes.push(merged);
      transferMesh.push(merged.position.buffer, merged.uv.buffer, merged.normal.buffer, merged.lineCoord.buffer, merged.triFace.buffer);
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
      const r = scanCells(p.pos, p.uv, p.buildingId, p.meshType, seedConfig, p.faces, p.triFace, p.horizU);
      cellData.push({
        buildingId: p.buildingId,
        meshType:   p.meshType,
        cellKeys:   r.cellKeys,
        cellGeoms:  r.cellGeoms,
        seeds:      r.seeds,
        cellGroups: r.cellGroups,
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

/**
 * Concatenate each per-meshType meshData into a single merged meshData for
 * phase 1. Face objects carry `meshType` so main.js can recover it per
 * triangle (faces[triFace[ti]].meshType). triFace indices for the second and
 * later meshTypes are shifted by the running face count.
 *
 * Single-meshType buildings (e.g. walls only) skip concatenation and return
 * the sole meshData with `buildingKeys` + face `meshType` tags added for API
 * consistency with the merged case.
 */
function buildMergedMeshData(perType) {
  // Tag faces with meshType in-place; record buildingKeys once.
  for (const { meshData, faceInfo } of perType) {
    for (const f of faceInfo.faces) if (f) f.meshType = meshData.meshType;
  }
  const buildingKeys = perType.map(({ meshData }) => `${meshData.buildingId}:${meshData.meshType}`);

  if (perType.length === 1) {
    const md = perType[0].meshData;
    md.buildingKeys = buildingKeys;
    md.triRanges = { [md.meshType]: { start: 0, count: (md.triFace.length | 0) } };
    return md;
  }

  let totalPos = 0, totalUv = 0, totalN = 0, totalLC = 0, totalTri = 0;
  for (const { meshData: md } of perType) {
    totalPos += md.position.length;
    totalUv  += md.uv.length;
    totalN   += md.normal.length;
    totalLC  += md.lineCoord.length;
    totalTri += md.triFace.length;
  }

  const position  = new Float32Array(totalPos);
  const uv        = new Float32Array(totalUv);
  const normal    = new Float32Array(totalN);
  const lineCoord = new Float32Array(totalLC);
  const triFace   = new Int32Array(totalTri);
  const faces     = [];

  let oPos = 0, oUv = 0, oN = 0, oLC = 0, oTri = 0;
  let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let horizU = null;
  // Record where each meshType lives in the merged triangle buffer so main.js
  // buildCellGeometry can iterate only the relevant half on cache misses.
  const triRanges = {};

  for (const { meshData: md, faceInfo } of perType) {
    const faceOffset = faces.length;
    for (const f of faceInfo.faces) faces.push(f);

    const triStart = oTri;
    const triCount = md.triFace.length;
    triRanges[md.meshType] = { start: triStart, count: triCount };

    position.set(md.position, oPos);
    uv.set(md.uv, oUv);
    normal.set(md.normal, oN);
    lineCoord.set(md.lineCoord, oLC);
    for (let i = 0; i < md.triFace.length; i++) {
      const fi = md.triFace[i];
      triFace[oTri + i] = fi < 0 ? -1 : fi + faceOffset;
    }

    oPos += md.position.length;
    oUv  += md.uv.length;
    oN   += md.normal.length;
    oLC  += md.lineCoord.length;
    oTri += triCount;

    const bb = md.bbox;
    if (bb.minX < minX) minX = bb.minX;
    if (bb.minY < minY) minY = bb.minY;
    if (bb.minZ < minZ) minZ = bb.minZ;
    if (bb.maxX > maxX) maxX = bb.maxX;
    if (bb.maxY > maxY) maxY = bb.maxY;
    if (bb.maxZ > maxZ) maxZ = bb.maxZ;

    // Only the roof's horizU is meaningful (oriented from walls); walls get null.
    if (!horizU && md.horizU) horizU = md.horizU;
  }

  return {
    buildingId: perType[0].meshData.buildingId,
    buildingKeys,
    triRanges,
    position,
    uv,
    normal,
    horizU,
    lineCoord,
    triFace,
    faces,
    bbox: {
      minX, minY, minZ,
      maxX, maxY, maxZ,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      cz: (minZ + maxZ) / 2,
    },
  };
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

  const faceInfo = extractFaces(verts);

  // Flag faces whose outside-direction we can't trust. Two cues:
  //   (1) face's horizontal normal component points toward the mesh bbox
  //       center — a correctly-wound wall's outside points away from center.
  //   (2) face tilts more than ~10° below horizontal (ny < -sin 10°) — real
  //       exterior surfaces don't face downward at any meaningful angle.
  // Cell geometry (worker scanCells + main.js buildCellGeometry) emits the
  // paint polygon on both sides of the face plane when this is set, so the
  // overlay is visible regardless of winding.
  const bboxCx = (minX + maxX) / 2;
  const bboxCz = (minZ + maxZ) / 2;
  for (let fi = 0; fi < faceInfo.faces.length; fi++) {
    const f = faceInfo.faces[fi];
    if (!f) continue;
    const n = f.normal;
    let sus = n[1] < -0.174; // sin(10°)
    if (!sus && (n[0] * n[0] + n[2] * n[2]) > 1e-6) {
      const dx = bboxCx - f.centroid[0];
      const dz = bboxCz - f.centroid[2];
      if (n[0] * dx + n[2] * dz > 0) sus = true;
    }
    f.suspicious = sus ? 1 : 0;
  }

  // ── DIAGNOSTIC — strip once we know ─────────────────────────────────────
  // For each face, compute the spread of per-triangle planeD values
  // (triangle centroid projected onto face's averaged normal). Any face
  // whose spread exceeds 0.5 m contains triangles that shouldn't geometrically
  // belong to it — a sign that greedy or post-merge glued distant geometry
  // into one face.
  {
    const triCount = (verts.length / 9) | 0;
    const perFace = faceInfo.faces.map(() => ({ count: 0, minPD: Infinity, maxPD: -Infinity }));
    for (let ti = 0; ti < triCount; ti++) {
      const fi = faceInfo.triFace[ti];
      if (fi < 0) continue;
      const f = faceInfo.faces[fi];
      if (!f) continue;
      const i0 = ti * 9;
      const cx = (verts[i0]     + verts[i0 + 3] + verts[i0 + 6]) / 3;
      const cy = (verts[i0 + 1] + verts[i0 + 4] + verts[i0 + 7]) / 3;
      const cz = (verts[i0 + 2] + verts[i0 + 5] + verts[i0 + 8]) / 3;
      const pd = f.normal[0] * cx + f.normal[1] * cy + f.normal[2] * cz;
      const entry = perFace[fi];
      entry.count++;
      if (pd < entry.minPD) entry.minPD = pd;
      if (pd > entry.maxPD) entry.maxPD = pd;
    }
    // Log high-spread faces as before.
    for (let fi = 0; fi < perFace.length; fi++) {
      const e = perFace[fi];
      if (e.count < 1) continue;
      const spread = e.maxPD - e.minPD;
      if (spread > 0.5) {
        const f = faceInfo.faces[fi];
        console.warn(
          `[faceSpread] ${id}:${meshType} face ${fi}: ` +
          `tris=${e.count} spread=${spread.toFixed(2)}m ` +
          `triPD∈[${e.minPD.toFixed(2)}, ${e.maxPD.toFixed(2)}] ` +
          `facePD=${f.planeD.toFixed(2)} ` +
          `normal=(${f.normal[0].toFixed(2)}, ${f.normal[1].toFixed(2)}, ${f.normal[2].toFixed(2)})`
        );
      }
    }

    // Extra: dump the full per-face summary for a specific suspect building.
    // Lets us see whether this buildingId:meshType appears in multiple tiles
    // (would show up as multiple dumps here) and every face's actual PD range.
    if (id === 'gml_GPNX0C79ZX5WQHONUIVPFFNSA8HNVT5LF7V1' && meshType === 'wall') {
      console.log(`[faceDump] ${id}:${meshType} totalFaces=${perFace.length} totalTris=${triCount}`);
      for (let fi = 0; fi < perFace.length; fi++) {
        const e = perFace[fi];
        if (e.count < 1) continue;
        const f = faceInfo.faces[fi];
        console.log(
          `  face ${fi}: tris=${e.count} ` +
          `triPD∈[${e.minPD.toFixed(3)}, ${e.maxPD.toFixed(3)}] ` +
          `facePD=${f.planeD.toFixed(3)} ` +
          `normal=(${f.normal[0].toFixed(4)}, ${f.normal[1].toFixed(4)}, ${f.normal[2].toFixed(4)})`
        );
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  const uv          = computeGridUVs(verts, GRID_SIZE, horizU, faceInfo);
  const normal      = computeFlatNormals(verts);
  const lineCoord   = computeLineCoords(verts, faceInfo.triFace);

  const meshData = {
    buildingId: id,
    meshType,
    position: verts,
    uv,
    normal,
    horizU,
    lineCoord,
    triFace: faceInfo.triFace, // per-triangle → face index
    faces:   faceInfo.faces,   // Array<{normal:[x,y,z], planeD}> — main.js uses these
                                // in hitCell() so paint's cellKey matches the worker's.
    bbox: {
      minX, minY: minYo, minZ,
      maxX, maxY: maxYo, maxZ,
      cx: (minX + maxX) / 2,
      cy: (minYo + maxYo) / 2,
      cz: (minZ + maxZ) / 2,
    },
  };

  return { meshData, faceInfo };
}

// ── Near-coplanar face extraction (greedy seed) ──────────────────────────────
//
// Triangles join an existing face when their normal matches the face's running
// average (normal-dot > FACE_NDOT_TIGHT) AND their plane offset is within
// FACE_DIST_TIGHT of the face average. New seed otherwise. Linear in
// (tri × face) but meshes typically have few faces (~5–30 per building), so
// this is cheap.

function extractFaces(verts) {
  const triCount = (verts.length / 9) | 0;
  const buckets  = []; // { sumNx, sumNy, sumNz, sumCx, sumCy, sumCz, count }
  const triFace = new Int32Array(triCount);

  for (let ti = 0; ti < triCount; ti++) {
    const i0 = ti * 9;
    const ax = verts[i0],     ay = verts[i0 + 1], az = verts[i0 + 2];
    const bx = verts[i0 + 3], by = verts[i0 + 4], bz = verts[i0 + 5];
    const cx = verts[i0 + 6], cy = verts[i0 + 7], cz = verts[i0 + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-10) { triFace[ti] = -1; continue; }
    nx /= nl; ny /= nl; nz /= nl;
    const cxo = (ax + bx + cx) / 3;
    const cyo = (ay + by + cy) / 3;
    const czo = (az + bz + cz) / 3;

    let best = -1;
    for (let bi = 0; bi < buckets.length; bi++) {
      const bk = buckets[bi];
      const inv = 1 / bk.count;
      let bnx = bk.sumNx * inv, bny = bk.sumNy * inv, bnz = bk.sumNz * inv;
      const bnl = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz);
      if (bnl < 1e-10) continue;
      bnx /= bnl; bny /= bnl; bnz /= bnl;
      const dot = nx * bnx + ny * bny + nz * bnz;
      if (dot <= FACE_NDOT_TIGHT) continue;

      // Geometric distance from the new centroid to the face's plane, using
      // the face's running-average normal and centroid. This is origin-
      // independent — comparing plain planeD values would reject triangles
      // that genuinely share a plane when their centroids are far from the
      // world origin (FiDi is ~km from REF_LNG/REF_LAT).
      const bcx = bk.sumCx * inv, bcy = bk.sumCy * inv, bcz = bk.sumCz * inv;
      const dx = cxo - bcx, dy = cyo - bcy, dz = czo - bcz;
      const planeDist = Math.abs(bnx * dx + bny * dy + bnz * dz);
      if (planeDist < FACE_DIST_TIGHT) { best = bi; break; }
    }

    if (best < 0) {
      buckets.push({
        sumNx: nx,  sumNy: ny,  sumNz: nz,
        sumCx: cxo, sumCy: cyo, sumCz: czo,
        count: 1,
      });
      triFace[ti] = buckets.length - 1;
    } else {
      const bk = buckets[best];
      bk.sumNx += nx;  bk.sumNy += ny;  bk.sumNz += nz;
      bk.sumCx += cxo; bk.sumCy += cyo; bk.sumCz += czo;
      bk.count += 1;
      triFace[ti] = best;
    }
  }

  // Post-merge pass. The greedy loop above commits each triangle to the first
  // face it matches — so two triangles with identical normals can end up in
  // separate faces if an intermediate triangle happened to be too far from
  // the in-progress face's plane and seeded its own. Here we re-examine all
  // face pairs and merge any whose averaged normal + plane agree. Repeats
  // until no merges; O(F³) worst case but F is typically ≤30.
  //
  // Distance check: instead of measuring centroid-to-centroid (which is
  // origin-invariant in principle but pollutable by `normalNoise × wallExtent`
  // at large scales — a 0.5° normal-averaging error across a 30 m wall can
  // produce ~0.3 m of fake apparent depth even when the two faces are truly
  // coplanar), we measure each of face j's triangle centroids against face i's
  // plane equation. A real stepback puts every face-j triangle ~stepback m off
  // face i's plane → check fails. A noisy-but-coplanar split has every
  // face-j triangle ~0 m off → check passes.
  {
    let changed = true;
    while (changed) {
      changed = false;

      // (Re)build face → triangle list for this cycle. Inverted from triFace.
      const faceTris = new Map();
      for (let t = 0; t < triFace.length; t++) {
        const fi = triFace[t];
        if (fi < 0) continue;
        let list = faceTris.get(fi);
        if (!list) { list = []; faceTris.set(fi, list); }
        list.push(t);
      }

      merge:
      for (let i = 0; i < buckets.length; i++) {
        if (!buckets[i]) continue;
        const bi = buckets[i], invI = 1 / bi.count;
        let nix = bi.sumNx * invI, niy = bi.sumNy * invI, niz = bi.sumNz * invI;
        const niLen = Math.sqrt(nix*nix + niy*niy + niz*niz);
        if (niLen < 1e-10) continue;
        nix /= niLen; niy /= niLen; niz /= niLen;
        const cix = bi.sumCx * invI, ciy = bi.sumCy * invI, ciz = bi.sumCz * invI;
        const niDotCi = nix*cix + niy*ciy + niz*ciz; // face i's plane equation: n_i · X = niDotCi

        for (let j = i + 1; j < buckets.length; j++) {
          if (!buckets[j]) continue;
          const bj = buckets[j], invJ = 1 / bj.count;
          let njx = bj.sumNx * invJ, njy = bj.sumNy * invJ, njz = bj.sumNz * invJ;
          const njLen = Math.sqrt(njx*njx + njy*njy + njz*njz);
          if (njLen < 1e-10) continue;
          njx /= njLen; njy /= njLen; njz /= njLen;

          const dot = nix*njx + niy*njy + niz*njz;
          if (dot <= FACE_NDOT_TIGHT) continue;

          // Per-triangle distance check: every triangle in face j must be
          // within FACE_DIST_LOOSE of face i's plane. Early-exit on first
          // failure.
          const jTris = faceTris.get(j);
          if (!jTris || jTris.length === 0) continue;
          let maxDist = 0;
          for (let k = 0; k < jTris.length; k++) {
            const ti = jTris[k];
            const i0 = ti * 9;
            const cx = (verts[i0]     + verts[i0 + 3] + verts[i0 + 6]) / 3;
            const cy = (verts[i0 + 1] + verts[i0 + 4] + verts[i0 + 7]) / 3;
            const cz = (verts[i0 + 2] + verts[i0 + 5] + verts[i0 + 8]) / 3;
            const d = Math.abs(nix*cx + niy*cy + niz*cz - niDotCi);
            if (d > maxDist) {
              maxDist = d;
              if (maxDist >= FACE_DIST_LOOSE) break;
            }
          }
          if (maxDist >= FACE_DIST_LOOSE) continue;

          // Merge j into i.
          bi.sumNx += bj.sumNx; bi.sumNy += bj.sumNy; bi.sumNz += bj.sumNz;
          bi.sumCx += bj.sumCx; bi.sumCy += bj.sumCy; bi.sumCz += bj.sumCz;
          bi.count += bj.count;
          buckets[j] = null;
          for (let t = 0; t < triFace.length; t++) {
            if (triFace[t] === j) triFace[t] = i;
          }
          changed = true;
          break merge; // restart outer so bi's refreshed average is used
        }
      }
    }
  }

  // Compact buckets (drop nulls) and remap triFace indices.
  const finalBuckets = [];
  const oldToNew = new Int32Array(buckets.length);
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i]) { oldToNew[i] = finalBuckets.length; finalBuckets.push(buckets[i]); }
    else            { oldToNew[i] = -1; }
  }
  for (let t = 0; t < triFace.length; t++) {
    if (triFace[t] >= 0) triFace[t] = oldToNew[triFace[t]];
  }

  const faces = finalBuckets.map(bk => {
    const inv = 1 / bk.count;
    let nx = bk.sumNx * inv, ny = bk.sumNy * inv, nz = bk.sumNz * inv;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const cx = bk.sumCx * inv, cy = bk.sumCy * inv, cz = bk.sumCz * inv;
    return { normal: [nx, ny, nz], planeD: nx * cx + ny * cy + nz * cz, centroid: [cx, cy, cz] };
  });

  return { faces, triFace };
}

// ── UV projection (one basis per face) ───────────────────────────────────────
//
// Face-tangent UVs: axes lie in the face plane so the 2 m grid is undistorted
// on any surface angle. V = world UP projected onto the face (falls back to
// horizU / world NORTH for near-horizontal faces); U = cross(V, n). Computed
// per face, not per triangle, so every triangle in a face shares the same
// basis and the grid is continuous across internal diagonals.
//
// Per-face origin shift with centred remainder: each face's U/V values are
// shifted so the face sits centred within its `ceil(width / GRID_SIZE)` cell
// span. The first and last cell along each axis end up the same width, so a
// 6.4 m face yields cells of width 1.2 / 2 / 2 / 1.2 m instead of 2 / 2 / 2 /
// 0.4 m. Same cell count either way, but the slivers are bigger (less likely
// to be unpaintable specks). A face whose width is an exact multiple of
// GRID_SIZE has zero shift and produces no slivers.
//
// Trade-off: world-anchored grid continuity across faces is lost, but
// cross-face continuity was already broken in practice (different normals →
// different bases → misaligned grids regardless of origin).

function computeGridUVs(flatVerts, gridSize, horizU, faceInfo) {
  const count = flatVerts.length / 3;
  const uvs   = new Float32Array(count * 2);

  const bases = faceInfo.faces.map(c => {
    const [nx, ny, nz] = c.normal;
    let vx = -ny * nx, vy = 1 - ny * ny, vz = -ny * nz;
    let vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vl < 0.1) {
      if (horizU) { vx = horizU[0]; vy = 0; vz = horizU[1]; }
      else        { vx = -nz * nx; vy = -nz * ny; vz = 1 - nz * nz; }
      vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
    if (vl < 1e-10) return null;
    vx /= vl; vy /= vl; vz /= vl;
    const ux = vy * nz - vz * ny;
    const uy = vz * nx - vx * nz;
    const uz = vx * ny - vy * nx;
    return {
      ux, uy, uz, vx, vy, vz,
      minU: Infinity, maxU: -Infinity,
      minV: Infinity, maxV: -Infinity,
    };
  });

  const triCount = (flatVerts.length / 9) | 0;

  // Pass 1 — compute per-face U/V bbox across that face's vertices.
  for (let ti = 0; ti < triCount; ti++) {
    const ci = faceInfo.triFace[ti];
    if (ci < 0) continue;
    const basis = bases[ci];
    if (!basis) continue;
    const { ux, uy, uz, vx, vy, vz } = basis;
    const i0 = ti * 9;
    for (let k = 0; k < 3; k++) {
      const off = i0 + k * 3;
      const px = flatVerts[off], py = flatVerts[off + 1], pz = flatVerts[off + 2];
      const u = px * ux + py * uy + pz * uz;
      const v = px * vx + py * vy + pz * vz;
      if (u < basis.minU) basis.minU = u;
      if (u > basis.maxU) basis.maxU = u;
      if (v < basis.minV) basis.minV = v;
      if (v > basis.maxV) basis.maxV = v;
    }
  }

  // Pre-compute the centring shift per face (in grid units). For a face of
  // width W cells (= span / gridSize), the sliver remainder is
  //   rem = ceil(W) - W
  // and we split it equally between the two ends, so each end-cell has width
  // (gridSize/2) × (1 - rem) ... actually, each end-cell occupies rem/2 grid
  // units in shifted UV. shiftU = rem/2 ensures the face starts at cu=0
  // covering rem/2 units, then full cells, then ends with another rem/2 unit.
  for (const b of bases) {
    if (!b) continue;
    const widthU_g = (b.maxU - b.minU) / gridSize;
    const widthV_g = (b.maxV - b.minV) / gridSize;
    const remU = Math.ceil(widthU_g) - widthU_g;
    const remV = Math.ceil(widthV_g) - widthV_g;
    b.shiftU = remU / 2;
    b.shiftV = remV / 2;
  }

  // Pass 2 — emit UVs with per-face origin shifted so the face is centred
  // within its cell span.
  for (let ti = 0; ti < triCount; ti++) {
    const ci = faceInfo.triFace[ti];
    if (ci < 0) continue;
    const basis = bases[ci];
    if (!basis) continue;
    const { ux, uy, uz, vx, vy, vz, minU, minV, shiftU, shiftV } = basis;
    const i0 = ti * 9;
    for (let k = 0; k < 3; k++) {
      const off = i0 + k * 3;
      const px = flatVerts[off], py = flatVerts[off + 1], pz = flatVerts[off + 2];
      uvs[(ti * 3 + k) * 2]     = (px * ux + py * uy + pz * uz - minU) / gridSize + shiftU;
      uvs[(ti * 3 + k) * 2 + 1] = (px * vx + py * vy + pz * vz - minV) / gridSize + shiftV;
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

// ── Seed-cell triangle scan (per-face cell identity) ─────────────────────────
//
// For every UV cell (integer bucket) a triangle overlaps, we Sutherland-Hodgman
// clip the triangle to the cell, apply a 2.5 cm outward offset along the face
// normal, and accumulate the resulting polygon into that cell's geometry. The
// same discovery pass also rolls the random seed dice for each cell so the
// main thread doesn't have to iterate cells again.
//
// Cell identity (face normal + planeD) comes from the triangle's face, not
// the triangle itself, so all triangles in a face contribute to the same
// cells without the per-triangle normal noise the CityGML source can have.
// planeDKey = Math.round(facePlaneD * 2) → 50 cm buckets; parallel faces
// < 50 cm apart on the same building share a key (rare in FiDi). Must match
// canonicalCellKey() in main.js.

function scanCells(pos, uv, buildingId, meshType, seedConfig, faces, triFace, horizU) {
  const triCount = (pos.length / 9) | 0;
  const discovered = new Map();

  for (let ti = 0; ti < triCount; ti++) {
    const fi = triFace[ti];
    if (fi < 0) continue;
    const face       = faces[fi];
    const faceNormal = face.normal;
    const facePlaneD = face.planeD;

    const pi = ti * 9, ui = ti * 6;
    const tri = [
      { pos: [pos[pi],     pos[pi + 1], pos[pi + 2]], uv: [uv[ui],     uv[ui + 1]] },
      { pos: [pos[pi + 3], pos[pi + 4], pos[pi + 5]], uv: [uv[ui + 2], uv[ui + 3]] },
      { pos: [pos[pi + 6], pos[pi + 7], pos[pi + 8]], uv: [uv[ui + 4], uv[ui + 5]] },
    ];

    const pdKey = Math.round(facePlaneD * 2);
    const u0 = tri[0].uv[0], u1 = tri[1].uv[0], u2 = tri[2].uv[0];
    const v0 = tri[0].uv[1], v1 = tri[1].uv[1], v2 = tri[2].uv[1];
    const uMin = Math.floor(Math.min(u0, u1, u2));
    const uMax = Math.floor(Math.max(u0, u1, u2));
    const vMin = Math.floor(Math.min(v0, v1, v2));
    const vMax = Math.floor(Math.max(v0, v1, v2));

    for (let cu = uMin; cu <= uMax; cu++) {
      for (let cv = vMin; cv <= vMax; cv++) {
        const cellKey = `${buildingId}:${meshType}:${cu}:${cv}:${pdKey}`;

        let entry = discovered.get(cellKey);
        if (!entry) {
          entry = { normal: faceNormal, planeD: facePlaneD, verts: [] };
          discovered.set(cellKey, entry);
        }

        // Reject triangles inconsistent with this cell's stored face
        if (dot3(faceNormal, entry.normal) < 0.7) continue;
        if (Math.abs(facePlaneD - entry.planeD) > COPLANAR_TOL) continue;

        let poly = tri;
        poly = clipHalfPlane(poly, 0, cu,     +1);
        poly = clipHalfPlane(poly, 0, cu + 1, -1);
        poly = clipHalfPlane(poly, 1, cv,     +1);
        poly = clipHalfPlane(poly, 1, cv + 1, -1);
        if (poly.length < 3) continue;

        // Offset along the face's normal (not the triangle's) so adjacent
        // clipped polygons within the same face share edges cleanly. If the
        // face was flagged suspicious in makeMeshData, also emit a mirror
        // copy offset the other way — the data's outside direction can't be
        // trusted there, so we cover both possibilities.
        const ox = faceNormal[0] * OFFSET;
        const oy = faceNormal[1] * OFFSET;
        const oz = faceNormal[2] * OFFSET;
        const doubleSide = face.suspicious === 1;
        for (let k = 1; k < poly.length - 1; k++) {
          for (const v of [poly[0], poly[k], poly[k + 1]]) {
            entry.verts.push(v.pos[0] + ox, v.pos[1] + oy, v.pos[2] + oz);
          }
          if (doubleSide) {
            for (const v of [poly[0], poly[k], poly[k + 1]]) {
              entry.verts.push(v.pos[0] - ox, v.pos[1] - oy, v.pos[2] - oz);
            }
          }
        }
      }
    }
  }

  // Dedupe overlapping cells: multiple faces whose post-merge rejected (or
  // whose planes round to different pdKeys but sit within a few centimetres of
  // each other) can each own a cell at the same (cu, cv). Their geometries
  // overlap in 3D, so a user painting one can't cover the others, and the
  // seed assigned to any of them renders through. Collapse same-(cu, cv) cells
  // whose planes are within FACE_DIST_LOOSE and whose normals agree into a
  // single entry, anchored on the first (lowest-planeD) one.
  dedupOverlappingCells(discovered);

  // Pre-bake paint groups: sets of cells that paint/erase together. See the
  // long comment on buildCellGroups for the merge rules. Runs on the post-
  // dedupe discovered map so each cell has its final polygon.
  const cellGroups = buildCellGroups(discovered, horizU);

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

  return { cellKeys, cellGeoms, seeds, cellGroups };
}

// ── Cell overlap dedupe ─────────────────────────────────────────────────────
//
// Near-coplanar faces that weren't post-merged (normal/plane deltas just
// outside the face thresholds) can still produce cells at the same (cu, cv)
// with different pdKeys. This pass groups cells by (buildingId:meshType:cu:cv),
// chains them into near-coplanar sets (plane distance ≤ FACE_DIST_LOOSE,
// normal-dot ≥ FACE_NDOT_LOOSE against the chain's anchor), and merges each
// chain into a single entry so exactly one cell owns each visual position.

function dedupOverlappingCells(discovered) {
  // Group cells by everything except the pdKey suffix.
  const groups = new Map();
  for (const k of discovered.keys()) {
    const last = k.lastIndexOf(':');
    const prefix = k.slice(0, last);
    let g = groups.get(prefix);
    if (!g) { g = []; groups.set(prefix, g); }
    g.push(k);
  }

  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => discovered.get(a).planeD - discovered.get(b).planeD);

    // Greedy chaining against each chain's anchor (first member). This avoids
    // transitive merges where A~B and B~C but A and C are too far apart.
    const chains = [];
    for (const k of keys) {
      const e = discovered.get(k);
      let joined = false;
      for (const ch of chains) {
        const a = discovered.get(ch[0]);
        if (Math.abs(e.planeD - a.planeD) > FACE_DIST_LOOSE) continue;
        const nDot = e.normal[0]*a.normal[0] + e.normal[1]*a.normal[1] + e.normal[2]*a.normal[2];
        if (nDot < FACE_NDOT_LOOSE) continue;
        ch.push(k);
        joined = true;
        break;
      }
      if (!joined) chains.push([k]);
    }

    for (const ch of chains) {
      if (ch.length < 2) continue;
      const keepEnt = discovered.get(ch[0]);
      for (let i = 1; i < ch.length; i++) {
        const absorb = discovered.get(ch[i]);
        for (let v = 0; v < absorb.verts.length; v++) keepEnt.verts.push(absorb.verts[v]);
        discovered.delete(ch[i]);
      }
    }
  }
}

// ── Paint-group pre-bake ─────────────────────────────────────────────────────
//
// Produces sets of cellKeys that paint/erase together at runtime. Replaces the
// old runtime resolveGroup BFS in main.js. Works cross-face (adjacency is by
// world-space shared edges, not UV neighbours), and is bounded by these caps
// so no single paint click can sweep an unbounded region:
//
//   length ≤ GRID_SIZE + 0.2 m per axis  — bbox in the group anchor's face-
//                                          tangent frame. 20 cm slack over a
//                                          normal cell lets edge slivers pair
//                                          with their adjacent full cell on
//                                          the same face without runaway
//                                          chaining.
//   angle  ≤ 20° from anchor normal      — member normal vs. anchor normal
//
// Plus a "longest-edge-share" rule: a join only commits if the shared edge is
// ≥ 90% of *either* cell's longest boundary edge. This makes "never merge two
// long slivers end-to-end" automatic — stacking lengthwise means sharing the
// short side, which is nobody's longest edge.
//
// Cross-face restriction: when the candidate's group anchor is on a different
// face from the sliver (different normal-array reference), require the sliver
// itself to be narrow (< CROSS_FACE_NARROW_MAX in its short dimension). This
// keeps cylinder facets from auto-merging into multi-facet groups while still
// letting genuinely thin chamfer slivers paint together with their adjacent
// walls. The unpainted face-border line on the building underneath is hard to
// hide for cross-face merges, so we only do them when the underlying line is
// already short enough not to be visually distracting.

const SLIVER_AREA           = GRID_SIZE * GRID_SIZE * 0.5;  // 2.0 m² — half a normal cell. Catches narrow-but-tall cylinder facet cells (not just edge slivers).
const MAX_GROUP_LEN         = GRID_SIZE + 0.2;              // 2.2 m
const CROSS_FACE_NARROW_MAX = 0.1;                          // sliver's short-dim cap for cross-face merges (m)
const GROUP_NDOT_MIN        = Math.cos(20 * Math.PI / 180); // ≈ 0.9397 — 20° cap
const LONGEST_EDGE_TOL      = 0.9;                          // shared-edge tolerance

// Recover a cell's union-polygon area + boundary edges from its fan-triangulated
// `verts` buffer. A clipped polygon is fan-triangulated as (v0, v_k, v_{k+1}):
// the interior diagonals (v0→v_k for k≥2) appear in exactly two fan triangles
// so they cancel as internal, and real boundary segments appear once. With
// `dedupOverlappingCells` concatenating multiple polygons into one cell, the
// same trick recovers the union boundary as long as matching edges hash to
// the same rounded key.
function cellGeomStats(verts) {
  const triCount = (verts.length / 9) | 0;
  if (triCount === 0) return { area: 0, edges: [] };

  const ROUND = 100; // 1 cm, matches computeLineCoords
  let area = 0;
  const edgeCount = new Map(); // rounded edge key → count
  const edgeData  = new Map(); // rounded edge key → first-seen endpoint coords

  for (let ti = 0; ti < triCount; ti++) {
    const i0 = ti * 9;
    const ax = verts[i0],     ay = verts[i0 + 1], az = verts[i0 + 2];
    const bx = verts[i0 + 3], by = verts[i0 + 4], bz = verts[i0 + 5];
    const cx = verts[i0 + 6], cy = verts[i0 + 7], cz = verts[i0 + 8];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);

    const segs = [
      [ax, ay, az, bx, by, bz],
      [bx, by, bz, cx, cy, cz],
      [cx, cy, cz, ax, ay, az],
    ];
    for (const s of segs) {
      const k1 = Math.round(s[0]*ROUND)+','+Math.round(s[1]*ROUND)+','+Math.round(s[2]*ROUND);
      const k2 = Math.round(s[3]*ROUND)+','+Math.round(s[4]*ROUND)+','+Math.round(s[5]*ROUND);
      if (k1 === k2) continue; // degenerate zero-length
      const key = k1 < k2 ? k1+'|'+k2 : k2+'|'+k1;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      if (!edgeData.has(key)) {
        edgeData.set(key, [s[0], s[1], s[2], s[3], s[4], s[5]]);
      }
    }
  }

  const edges = [];
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue; // internal (diagonal or shared seam)
    const d = edgeData.get(key);
    const dx = d[3] - d[0], dy = d[4] - d[1], dz = d[5] - d[2];
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    edges.push({ ax: d[0], ay: d[1], az: d[2], bx: d[3], by: d[4], bz: d[5], len, key });
  }
  return { area, edges };
}

// Face-tangent basis matching computeGridUVs. Used for local-frame bbox of
// the group anchor so "length along U" and "length along V" are well defined
// on any surface orientation.
function faceTangentBasis(normal, horizU) {
  const nx = normal[0], ny = normal[1], nz = normal[2];
  let vx = -ny * nx, vy = 1 - ny * ny, vz = -ny * nz;
  let vl = Math.sqrt(vx*vx + vy*vy + vz*vz);
  if (vl < 0.1) {
    if (horizU) { vx = horizU[0]; vy = 0; vz = horizU[1]; }
    else        { vx = -nz*nx; vy = -nz*ny; vz = 1 - nz*nz; }
    vl = Math.sqrt(vx*vx + vy*vy + vz*vz);
  }
  if (vl < 1e-10) return null;
  vx /= vl; vy /= vl; vz /= vl;
  const ux = vy*nz - vz*ny;
  const uy = vz*nx - vx*nz;
  const uz = vx*ny - vy*nx;
  return { ux, uy, uz, vx, vy, vz };
}

function _adjAccum(map, a, b, sharedLen) {
  let list = map.get(a);
  if (!list) { list = []; map.set(a, list); }
  const existing = list.find(e => e.otherKey === b);
  if (existing) existing.sharedLen += sharedLen;
  else list.push({ otherKey: b, sharedLen });
}

function buildCellGroups(discovered, horizU) {
  // Per-cell stats. `area` is kept only for sliver classification and the
  // smallest-first sliver sort; there's no area cap on merged groups (the
  // per-axis length cap implicitly bounds it).
  const cellInfo = new Map(); // cellKey → { area, edges, maxEdgeLen, normal, isSliver }
  for (const [cellKey, entry] of discovered) {
    const { area, edges } = cellGeomStats(entry.verts);
    let maxEdgeLen = 0;
    for (const e of edges) if (e.len > maxEdgeLen) maxEdgeLen = e.len;
    cellInfo.set(cellKey, {
      area, edges, maxEdgeLen,
      normal: entry.normal,
      isSliver: area < SLIVER_AREA,
    });
  }

  // Edge index: rounded-key → [{ cellKey, edgeLen }]. Edges shared by 2+ cells
  // surface as adjacencies.
  const edgeIndex = new Map();
  for (const [cellKey, info] of cellInfo) {
    for (const e of info.edges) {
      let list = edgeIndex.get(e.key);
      if (!list) { list = []; edgeIndex.set(e.key, list); }
      list.push({ cellKey, edgeLen: e.len });
    }
  }

  // cellKey → [{ otherKey, sharedLen }]
  const adjacency = new Map();
  for (const list of edgeIndex.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.cellKey === b.cellKey) continue;
        const sharedLen = Math.min(a.edgeLen, b.edgeLen);
        _adjAccum(adjacency, a.cellKey, b.cellKey, sharedLen);
        _adjAccum(adjacency, b.cellKey, a.cellKey, sharedLen);
      }
    }
  }

  // Group state. Full cells get their own singleton upfront so slivers can
  // attach to them directly.
  const groups    = []; // Array<{ members:Set, anchorNormal, anchorBasis, uMin,uMax,vMin,vMax }>
  const groupOf   = new Map(); // cellKey → group idx

  function projectEdgesIntoBBox(edges, basis, uMin, uMax, vMin, vMax) {
    for (const e of edges) {
      const uA = e.ax*basis.ux + e.ay*basis.uy + e.az*basis.uz;
      const vA = e.ax*basis.vx + e.ay*basis.vy + e.az*basis.vz;
      const uB = e.bx*basis.ux + e.by*basis.uy + e.bz*basis.uz;
      const vB = e.bx*basis.vx + e.by*basis.vy + e.bz*basis.vz;
      if (uA < uMin) uMin = uA; if (uA > uMax) uMax = uA;
      if (uB < uMin) uMin = uB; if (uB > uMax) uMax = uB;
      if (vA < vMin) vMin = vA; if (vA > vMax) vMax = vA;
      if (vB < vMin) vMin = vB; if (vB > vMax) vMax = vB;
    }
    return [uMin, uMax, vMin, vMax];
  }

  function newSingleton(cellKey, info) {
    const basis = faceTangentBasis(info.normal, horizU);
    if (!basis) return -1;
    const [uMin, uMax, vMin, vMax] = projectEdgesIntoBBox(info.edges, basis, Infinity, -Infinity, Infinity, -Infinity);
    const idx = groups.length;
    groups.push({
      members:      new Set([cellKey]),
      anchorNormal: info.normal,
      anchorBasis:  basis,
      uMin, uMax, vMin, vMax,
    });
    groupOf.set(cellKey, idx);
    return idx;
  }

  for (const [cellKey, info] of cellInfo) {
    if (!info.isSliver) newSingleton(cellKey, info);
  }

  // Slivers, ascending area.
  const sliverKeys = [];
  for (const [cellKey, info] of cellInfo) {
    if (info.isSliver) sliverKeys.push(cellKey);
  }
  sliverKeys.sort((a, b) => cellInfo.get(a).area - cellInfo.get(b).area);

  for (const slKey of sliverKeys) {
    if (groupOf.has(slKey)) continue;
    const slInfo = cellInfo.get(slKey);
    const adj = adjacency.get(slKey);
    if (!adj || adj.length === 0) continue;

    const candidates = adj.slice().sort((a, b) => b.sharedLen - a.sharedLen);

    let joined = false;
    for (const { otherKey, sharedLen } of candidates) {
      const otherInfo = cellInfo.get(otherKey);
      if (!otherInfo) continue;

      // Longest-edge-share rule.
      const passLE =
        sharedLen >= LONGEST_EDGE_TOL * slInfo.maxEdgeLen ||
        sharedLen >= LONGEST_EDGE_TOL * otherInfo.maxEdgeLen;
      if (!passLE) continue;

      // Target group: neighbor's existing group, else a new singleton anchored
      // on the neighbor.
      let gIdx = groupOf.get(otherKey);
      let createdForThisAttempt = false;
      if (gIdx === undefined) {
        gIdx = newSingleton(otherKey, otherInfo);
        if (gIdx < 0) continue;
        createdForThisAttempt = true;
      }
      const g = groups[gIdx];

      // Angle cap (sliver vs. anchor).
      const nx = slInfo.normal[0], ny = slInfo.normal[1], nz = slInfo.normal[2];
      const ax = g.anchorNormal[0], ay = g.anchorNormal[1], az = g.anchorNormal[2];
      if (nx*ax + ny*ay + nz*az < GROUP_NDOT_MIN) {
        if (createdForThisAttempt) {
          groups.pop();
          groupOf.delete(otherKey);
        }
        continue;
      }

      // Cross-face check: if sliver and group-anchor are on different faces
      // (different normal-array reference, since all cells from one face share
      // the face's normal), only allow the merge if the sliver itself is very
      // narrow. Approximates "narrow dim" as area / longest-edge — exact for
      // rectangles, close enough for clipped polygons.
      const sameFace = slInfo.normal === g.anchorNormal;
      if (!sameFace) {
        const narrowDim = slInfo.maxEdgeLen > 0 ? slInfo.area / slInfo.maxEdgeLen : Infinity;
        if (narrowDim >= CROSS_FACE_NARROW_MAX) {
          if (createdForThisAttempt) {
            groups.pop();
            groupOf.delete(otherKey);
          }
          continue;
        }
      }

      // Length cap in anchor frame. This also implicitly bounds group area
      // to MAX_GROUP_LEN² (~4.84 m²).
      const [uMin, uMax, vMin, vMax] = projectEdgesIntoBBox(
        slInfo.edges, g.anchorBasis, g.uMin, g.uMax, g.vMin, g.vMax);
      if (uMax - uMin > MAX_GROUP_LEN || vMax - vMin > MAX_GROUP_LEN) {
        if (createdForThisAttempt) {
          groups.pop();
          groupOf.delete(otherKey);
        }
        continue;
      }

      // Commit.
      g.members.add(slKey);
      g.uMin = uMin; g.uMax = uMax; g.vMin = vMin; g.vMax = vMax;
      groupOf.set(slKey, gIdx);
      joined = true;
      break;
    }
    // If not joined, sliver stays ungrouped (acts as singleton at runtime).
  }

  // Unified-normal offset within each group. Cell polygons left scanCells
  // already shifted 2.5 cm along their own face normal; for cells whose
  // adjacent group-mate lives on a different face (e.g. cylinder facets),
  // that per-face offset opens a ~6 mm V-gap at the shared edge where the
  // building's face-border shader peeks through. Re-offset every grouped
  // cell onto the group anchor's normal so adjacent members' offset edges
  // coincide exactly. Singletons are untouched.
  for (const g of groups) {
    if (g.members.size < 2) continue;
    const ax = g.anchorNormal[0], ay = g.anchorNormal[1], az = g.anchorNormal[2];
    for (const memberKey of g.members) {
      const mn = cellInfo.get(memberKey).normal;
      const dx = (ax - mn[0]) * OFFSET;
      const dy = (ay - mn[1]) * OFFSET;
      const dz = (az - mn[2]) * OFFSET;
      if (dx === 0 && dy === 0 && dz === 0) continue; // anchor itself
      const verts = discovered.get(memberKey).verts;
      for (let i = 0; i < verts.length; i += 3) {
        verts[i]     += dx;
        verts[i + 1] += dy;
        verts[i + 2] += dz;
      }
    }
  }

  const out = [];
  for (const g of groups) {
    if (g.members.size >= 2) out.push([...g.members]);
  }
  return out;
}

// ── Per-vertex lineCoord (shader border input) ───────────────────────────────
//
// For each triangle vertex we emit a 3-component attribute where component k
// is the perpendicular world-space distance from that vertex to the triangle's
// k-th edge (the edge opposite vertex k). Linear interpolation across the
// triangle gives the true perpendicular distance to each edge at every
// fragment; the shader picks the minimum and draws a border line where it
// drops below a threshold.
//
// For internal edges (two triangles of the same face share it) we bump the
// relevant component to BIG at the edge's two endpoint vertices, so the shader
// never picks that edge. Only real face boundaries emit a border.
// Component-axis convention:
//   x-component = distance to edge BC (opposite vertex a)
//   y-component = distance to edge CA (opposite vertex b)
//   z-component = distance to edge AB (opposite vertex c)

function computeLineCoords(verts, faceIds) {
  const triCount = (verts.length / 9) | 0;
  const out      = new Float32Array(triCount * 9);
  // 1 cm edge-match precision. CityGML-source vertex positions of adjacent
  // polygons sometimes differ by ~mm even on a "shared" edge; 1 mm was too
  // tight and produced phantom borders. Building-scale features are never
  // closer than a centimetre, so 1 cm is safe.
  const ROUND    = 100;
  const BIG      = 1e6;

  const edgeMap  = new Map();   // edgeKey → faceIds[]
  const edgeKeys = new Array(triCount * 3);

  // Per-face edge index for the T-junction fallback. Same-face edges that
  // don't match topologically (different endpoints) but are collinear and
  // overlap in segment interval are treated as internal — this handles the
  // CityGML case where two adjacent polygons share a flat boundary but one
  // side has a midpoint vertex the other doesn't, so earcut produces edges
  // that never match regardless of rounding precision.
  const faceEdges = new Map(); // fid → Array<[ax, ay, az, bx, by, bz, ti]>

  for (let ti = 0; ti < triCount; ti++) {
    const i0 = ti * 9;
    const kA = Math.round(verts[i0  ]*ROUND)+','+Math.round(verts[i0+1]*ROUND)+','+Math.round(verts[i0+2]*ROUND);
    const kB = Math.round(verts[i0+3]*ROUND)+','+Math.round(verts[i0+4]*ROUND)+','+Math.round(verts[i0+5]*ROUND);
    const kC = Math.round(verts[i0+6]*ROUND)+','+Math.round(verts[i0+7]*ROUND)+','+Math.round(verts[i0+8]*ROUND);
    const keyAB = kA < kB ? kA+'|'+kB : kB+'|'+kA;
    const keyBC = kB < kC ? kB+'|'+kC : kC+'|'+kB;
    const keyCA = kC < kA ? kC+'|'+kA : kA+'|'+kC;
    edgeKeys[ti*3+0] = keyAB;
    edgeKeys[ti*3+1] = keyBC;
    edgeKeys[ti*3+2] = keyCA;

    const fid = faceIds[ti];
    let eAB = edgeMap.get(keyAB); if (!eAB) { eAB = []; edgeMap.set(keyAB, eAB); } eAB.push(fid);
    let eBC = edgeMap.get(keyBC); if (!eBC) { eBC = []; edgeMap.set(keyBC, eBC); } eBC.push(fid);
    let eCA = edgeMap.get(keyCA); if (!eCA) { eCA = []; edgeMap.set(keyCA, eCA); } eCA.push(fid);

    // Cache edge endpoints per face for the T-junction lookup.
    let list = faceEdges.get(fid);
    if (!list) { list = []; faceEdges.set(fid, list); }
    list.push([
      verts[i0  ], verts[i0+1], verts[i0+2],
      verts[i0+3], verts[i0+4], verts[i0+5], ti]);
    list.push([
      verts[i0+3], verts[i0+4], verts[i0+5],
      verts[i0+6], verts[i0+7], verts[i0+8], ti]);
    list.push([
      verts[i0+6], verts[i0+7], verts[i0+8],
      verts[i0  ], verts[i0+1], verts[i0+2], ti]);
  }

  for (let ti = 0; ti < triCount; ti++) {
    const i0 = ti * 9;
    const ax = verts[i0  ], ay = verts[i0+1], az = verts[i0+2];
    const bx = verts[i0+3], by = verts[i0+4], bz = verts[i0+5];
    const cx = verts[i0+6], cy = verts[i0+7], cz = verts[i0+8];

    const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
    const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
    const nx = e1y*e2z - e1z*e2y;
    const ny = e1z*e2x - e1x*e2z;
    const nz = e1x*e2y - e1y*e2x;
    const area2 = Math.sqrt(nx*nx + ny*ny + nz*nz);

    const lbc = Math.sqrt((bx-cx)*(bx-cx)+(by-cy)*(by-cy)+(bz-cz)*(bz-cz));
    const lca = Math.sqrt((cx-ax)*(cx-ax)+(cy-ay)*(cy-ay)+(cz-az)*(cz-az));
    const lab = Math.sqrt((ax-bx)*(ax-bx)+(ay-by)*(ay-by)+(az-bz)*(az-bz));
    const ha = lbc > 1e-10 ? area2/lbc : 0;
    const hb = lca > 1e-10 ? area2/lca : 0;
    const hc = lab > 1e-10 ? area2/lab : 0;

    let vax = ha, vay = 0,  vaz = 0;
    let vbx = 0,  vby = hb, vbz = 0;
    let vcx = 0,  vcy = 0,  vcz = hc;

    const fid = faceIds[ti];
    const isTopoInternal = (key) => {
      const fids = edgeMap.get(key);
      return fids && fids.length === 2 && fids[0] === fid && fids[1] === fid;
    };
    const isTJunctionInternal = (p0x, p0y, p0z, p1x, p1y, p1z) => {
      const list = faceEdges.get(fid);
      if (!list) return false;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e[6] === ti) continue; // same triangle
        if (edgesCollinearOverlap(p0x, p0y, p0z, p1x, p1y, p1z,
                                  e[0], e[1], e[2], e[3], e[4], e[5])) return true;
      }
      return false;
    };
    const isInternal = (key, p0x, p0y, p0z, p1x, p1y, p1z) =>
      isTopoInternal(key) || isTJunctionInternal(p0x, p0y, p0z, p1x, p1y, p1z);

    if (isInternal(edgeKeys[ti*3+0], ax, ay, az, bx, by, bz)) { vaz = BIG; vbz = BIG; }  // edge AB
    if (isInternal(edgeKeys[ti*3+1], bx, by, bz, cx, cy, cz)) { vbx = BIG; vcx = BIG; }  // edge BC
    if (isInternal(edgeKeys[ti*3+2], cx, cy, cz, ax, ay, az)) { vcy = BIG; vay = BIG; }  // edge CA

    const o = ti * 9;
    out[o  ] = vax; out[o+1] = vay; out[o+2] = vaz;
    out[o+3] = vbx; out[o+4] = vby; out[o+5] = vbz;
    out[o+6] = vcx; out[o+7] = vcy; out[o+8] = vcz;
  }

  return out;
}

// Two edges are "T-junction equivalent" if they lie on the same line (within
// 2 cm perpendicular tolerance) and their segments overlap by more than 1 cm
// in interval length. End-to-end edges meeting at a single shared endpoint
// give zero overlap and are correctly treated as separate.
const TJUNCTION_LINE_TOL  = 0.02;
const TJUNCTION_MIN_OVLAP = 0.01;

function edgesCollinearOverlap(a0x, a0y, a0z, a1x, a1y, a1z,
                               b0x, b0y, b0z, b1x, b1y, b1z) {
  const ex = a1x - a0x, ey = a1y - a0y, ez = a1z - a0z;
  const eLen = Math.sqrt(ex*ex + ey*ey + ez*ez);
  if (eLen < 1e-6) return false;
  const edx = ex / eLen, edy = ey / eLen, edz = ez / eLen;

  // Project b0, b1 onto edge-A's line; reject if far from the line.
  const t0 = (b0x - a0x) * edx + (b0y - a0y) * edy + (b0z - a0z) * edz;
  const t1 = (b1x - a0x) * edx + (b1y - a0y) * edy + (b1z - a0z) * edz;
  const px0 = a0x + t0 * edx, py0 = a0y + t0 * edy, pz0 = a0z + t0 * edz;
  const px1 = a0x + t1 * edx, py1 = a0y + t1 * edy, pz1 = a0z + t1 * edz;
  const dSq0 = (b0x-px0)*(b0x-px0) + (b0y-py0)*(b0y-py0) + (b0z-pz0)*(b0z-pz0);
  const dSq1 = (b1x-px1)*(b1x-px1) + (b1y-py1)*(b1y-py1) + (b1z-pz1)*(b1z-pz1);
  const tolSq = TJUNCTION_LINE_TOL * TJUNCTION_LINE_TOL;
  if (dSq0 > tolSq || dSq1 > tolSq) return false;

  // Interval overlap on edge-A's parameter axis.
  const tMin = Math.min(t0, t1), tMax = Math.max(t0, t1);
  const overlap = Math.min(eLen, tMax) - Math.max(0, tMin);
  return overlap > TJUNCTION_MIN_OVLAP;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function dot3(a, b)     { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function lerp3(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]), a[2]+t*(b[2]-a[2])]; }
function lerp2(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])]; }

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
