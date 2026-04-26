// Off-thread terrain cell loader.
//
// Protocol:
//   main -> worker: { type:'load', gx, gz, key, file }
//   worker -> main: { type:'loaded', key, empty:true }
//                or { type:'loaded', key, empty:false, res, position, normal, blockCenter, nwY, neY, seY, swY }
//                or { type:'error', key, error }

const CELL_SIZE = 125;
const NODATA_CM = -32768;
const NODATA_U8 = 255;
const BLOCK_BASE_Y = -10;
const SLOPE_THRESHOLD_FRAC = 0.20;

// Terrain cells are indexed in a grid that's rotated from world XZ by this
// angle (Manhattan street orientation). Vertex positions, normals, and block
// centres are computed in grid space and rotated to world at emit time so
// every downstream consumer (raycast, paint, OSM shader) sees world coords.
// Must match src/geo.js::MANHATTAN_GRID_DEG.
const MANHATTAN_GRID_DEG = 29.0;
const _GRID_A   = MANHATTAN_GRID_DEG * Math.PI / 180;
const _GRID_COS = Math.cos(_GRID_A);
const _GRID_SIN = Math.sin(_GRID_A);

// Any sample whose decoded elevation is below this gets clamped to it. In
// NYC only hydroflats (water, -1.34 m) sit below 0, so this flattens lakes /
// rivers / harbour into a single plane at y=0 without needing OSM water data
// in the worker. Land cells are untouched.
const WATER_LEVEL_Y = 0;

async function inflateGzip(gzippedBuf) {
  const stream = new Response(gzippedBuf).body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'load') return;

  const { gx, gz, key, file } = msg;
  try {
    const res = await fetch(file);
    // Vite's dev server returns /index.html (HTML content) for missing static
    // files. Treat 404s and any HTML response as "no terrain for this cell".
    const ct = res.headers.get('content-type') || '';
    if (res.status === 404 || ct.includes('html')) {
      self.postMessage({ type: 'loaded', key, empty: true });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Files are gzipped on disk with `application/octet-stream`. Neither Vite
    // nor Cloudflare auto-compress that content type, so the raw gzip bytes
    // travel to us intact and we inflate here. DecompressionStream runs in
    // native code — cost is <1ms per 1–2 KB tile.
    const buf = await inflateGzip(await res.arrayBuffer());
    const view = new DataView(buf);

    // v2 header (8 bytes, little-endian):
    //   u8 version, u8 scale_dm, u16 res, u16 pad, i16 min_dm
    // Payload: uint8[(res+2*pad)²] deltas. The perimeter carries neighbour-tile
    // samples so corner smoothing spans seams. See scripts/bake_terrain.py.
    const version = view.getUint8(0);
    if (version !== 2) throw new Error(`unsupported terrain version ${version}`);
    const scaleDm = view.getUint8(1);
    const cellRes = view.getUint16(2, true);
    const pad     = view.getUint16(4, true);
    const minDm   = view.getInt16(6, true);
    const padRes  = cellRes + 2 * pad;
    const deltas  = new Uint8Array(buf, 8, padRes * padRes);

    // Decode deltas → int16 cm for the meshing path, which operates in cm.
    // Elevation_cm = (min_dm + v*scale_dm)*10. NYC elevation fits int16 cm
    // comfortably (~±327 m). NODATA is filled once at bake time
    // (scripts/fill_dem_nodata.py) so both tiles at a shared seam sample see
    // the same elevation; any stray NODATA_CM survives to _decode → 0 and
    // gets pinned at sea level by the WATER_LEVEL_Y clamp.
    const samples = new Int16Array(padRes * padRes);
    const baseCm = minDm * 10;
    const stepCm = scaleDm * 10;
    let nodataCount = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = deltas[i];
      if (v === NODATA_U8) { samples[i] = NODATA_CM; nodataCount++; }
      else                 { samples[i] = baseCm + v * stepCm; }
    }
    // Bake-time fill (fill_dem_nodata.py) should reach every sample; anything
    // that makes it here falls through to _decode → 0 and clamps to sea level.
    // Seam consistency is preserved regardless — both sides of a seam sample
    // the same filled DEM, so both see NODATA at the same positions and both
    // clamp to 0. Water-edge tiles routinely produce a handful of fallthroughs
    // (DEM survey stops at the shoreline); the threshold is set to only flag
    // tiles where fill genuinely failed to reach them.
    if (nodataCount > 50) {
      console.warn(`terrain cell ${gx},${gz}: ${nodataCount} NODATA fallthroughs (of ${samples.length})`);
    }
    const built = buildBlockyTerrainGeometry(gx, gz, cellRes, pad, samples);

    self.postMessage(
      { type: 'loaded', key, empty: false, res: cellRes, ...built },
      [
        built.position.buffer,
        built.normal.buffer,
        built.blockCenter.buffer,
        built.nwY.buffer,
        built.neY.buffer,
        built.seY.buffer,
        built.swY.buffer,
      ],
    );
  } catch (err) {
    // Tag transport-level failures (TypeError from fetch: wifi drop, DNS,
    // CORS with no response) so TerrainManager can route them to the
    // shared netHealth breaker instead of treating them as content errors.
    const kind = err instanceof TypeError ? 'NETWORK' : 'OTHER';
    self.postMessage({ type: 'error', key, error: err.message, kind });
  }
};

function _decode(cm) {
  return cm === NODATA_CM ? 0 : cm * 0.01;
}

function _cellBounds(gx, gz) {
  return {
    minX: gx * CELL_SIZE,
    minZ: gz * CELL_SIZE,
  };
}

function buildBlockyTerrainGeometry(gx, gz, res, pad, samples) {
  const b = _cellBounds(gx, gz);
  const step = CELL_SIZE / res;
  const baseY = BLOCK_BASE_Y;
  const slopeThreshold = step * SLOPE_THRESHOLD_FRAC;
  const padRes = res + 2 * pad;

  // Decode padded sample grid into metres. Inner cell (ix, iz) lives at
  // padded index (ix+pad, iz+pad); the `pad` rows/cols on each side carry
  // neighbour-tile samples so corner smoothing and side-face decisions work
  // across tile seams.
  const heights = new Float32Array(padRes * padRes);
  for (let i = 0, n = padRes * padRes; i < n; i++) {
    const y = _decode(samples[i]);
    heights[i] = y < WATER_LEVEL_Y ? WATER_LEVEL_Y : y;
  }
  const h = (ix, iz) => heights[(iz + pad) * padRes + (ix + pad)];

  // Per-cell 4 corner Ys. We visit each of the (res+1)² inner grid corners
  // once; at each corner we union the 4 surrounding cells (all guaranteed
  // in-padded-range — may be perimeter samples from neighbour tiles) along
  // close X/Z pairs, then write each cell's component-mean into its
  // appropriate corner-slot of the 4 per-cell arrays. Cells on either side
  // of a close pair — within tile or across a seam — end up in the same
  // component, so their top quads meet at exactly the same Y and the seam
  // disappears.
  const nwY = new Float32Array(res * res);
  const neY = new Float32Array(res * res);
  const seY = new Float32Array(res * res);
  const swY = new Float32Array(res * res);

  // Perimeter-cell corner Ys for the four seams. We need these so a seam
  // cell's side face bottom can land exactly on the neighbour tile's top
  // corner Y — the neighbour renders its top using its own union-find
  // result, which both tiles compute identically from the shared perimeter
  // samples. Indexed by the perimeter cell's position along the seam.
  //
  //   *NbrX[I] = cell X's group-avg corner at the shared seam corner.
  //
  // With pad=1 we reach these seam-neighbour cells through the same
  // union-find pass that computes our own inner corners, so these are
  // essentially free to populate.
  const westNbrNE  = new Float32Array(res); // cell (-1, I)'s NE corner
  const westNbrSE  = new Float32Array(res); // cell (-1, I)'s SE corner
  const eastNbrNW  = new Float32Array(res); // cell (res, I)'s NW corner
  const eastNbrSW  = new Float32Array(res); // cell (res, I)'s SW corner
  const northNbrSW = new Float32Array(res); // cell (I, -1)'s SW corner
  const northNbrSE = new Float32Array(res); // cell (I, -1)'s SE corner
  const southNbrNW = new Float32Array(res); // cell (I, res)'s NW corner
  const southNbrNE = new Float32Array(res); // cell (I, res)'s NE corner

  // Union-find scratch (4 slots: 0=TL, 1=TR, 2=BL, 3=BR).
  const parent = new Int8Array(4);
  const sum = new Float32Array(4);
  const cnt = new Int8Array(4);
  const find = (i) => { while (parent[i] !== i) i = parent[i]; return i; };

  for (let cz = 0; cz <= res; cz++) {
    for (let cx = 0; cx <= res; cx++) {
      // The 4 cells around this inner corner, in INNER coords (valid range
      // is [0, res) for interior cells, -1 and res are perimeter reads).
      const hTL = h(cx - 1, cz - 1);
      const hTR = h(cx,     cz - 1);
      const hBL = h(cx - 1, cz    );
      const hBR = h(cx,     cz    );

      parent[0] = 0; parent[1] = 1; parent[2] = 2; parent[3] = 3;
      if (Math.abs(hTL - hTR) <= slopeThreshold) parent[find(0)] = find(1);
      if (Math.abs(hBL - hBR) <= slopeThreshold) parent[find(2)] = find(3);
      if (Math.abs(hTL - hBL) <= slopeThreshold) parent[find(0)] = find(2);
      if (Math.abs(hTR - hBR) <= slopeThreshold) parent[find(1)] = find(3);

      sum[0] = sum[1] = sum[2] = sum[3] = 0;
      cnt[0] = cnt[1] = cnt[2] = cnt[3] = 0;
      { const r = find(0); sum[r] += hTL; cnt[r]++; }
      { const r = find(1); sum[r] += hTR; cnt[r]++; }
      { const r = find(2); sum[r] += hBL; cnt[r]++; }
      { const r = find(3); sum[r] += hBR; cnt[r]++; }

      // Write back to the relevant INNER cell's corner array. A corner at
      // (cx, cz) only maps to an inner cell if that cell index is in
      // [0, res) — the bounds checks filter the perimeter-only slots.
      //   slot 0 (TL cell @ (cx-1, cz-1)) → cell's SE corner
      //   slot 1 (TR cell @ (cx,   cz-1)) → cell's SW corner
      //   slot 2 (BL cell @ (cx-1, cz  )) → cell's NE corner
      //   slot 3 (BR cell @ (cx,   cz  )) → cell's NW corner
      const r0 = find(0), a0 = sum[r0] / cnt[r0];
      const r1 = find(1), a1 = sum[r1] / cnt[r1];
      const r2 = find(2), a2 = sum[r2] / cnt[r2];
      const r3 = find(3), a3 = sum[r3] / cnt[r3];
      if (cx > 0 && cz > 0  )   seY[(cz - 1) * res + (cx - 1)] = a0;
      if (cx < res && cz > 0)   swY[(cz - 1) * res +  cx     ] = a1;
      if (cx > 0 && cz < res)   neY[ cz      * res + (cx - 1)] = a2;
      if (cx < res && cz < res) nwY[ cz      * res +  cx     ] = a3;

      // Perimeter cells' corners facing the seam. Each seam corner writes
      // the relevant slot avg to the neighbour cell whose EDGE faces the
      // tile — the opposite of the inner-cell writes above. These are the Y
      // the neighbour tile will draw its top at, so our seam cell's side
      // face can land on them exactly.
      //   West seam (cx === 0):   slot 0 → (-1, cz-1)'s SE; slot 2 → (-1, cz)'s NE
      //   East seam (cx === res): slot 1 → (res, cz-1)'s SW; slot 3 → (res, cz)'s NW
      //   North seam (cz === 0): slot 0 → (cx-1, -1)'s SE; slot 1 → (cx, -1)'s SW
      //   South seam (cz === res): slot 2 → (cx-1, res)'s NE; slot 3 → (cx, res)'s NW
      if (cx === 0) {
        if (cz > 0)   westNbrSE[cz - 1] = a0;
        if (cz < res) westNbrNE[cz]     = a2;
      }
      if (cx === res) {
        if (cz > 0)   eastNbrSW[cz - 1] = a1;
        if (cz < res) eastNbrNW[cz]     = a3;
      }
      if (cz === 0) {
        if (cx > 0)   northNbrSE[cx - 1] = a0;
        if (cx < res) northNbrSW[cx]     = a1;
      }
      if (cz === res) {
        if (cx > 0)   southNbrNE[cx - 1] = a2;
        if (cx < res) southNbrNW[cx]     = a3;
      }
    }
  }

  // Upper bound: 6 faces × 2 tris × 3 verts × 3 floats per block.
  const maxVerts = res * res * 6 * 6;
  const positions = new Float32Array(maxVerts * 3);
  const normals = new Float32Array(maxVerts * 3);
  const blockCenters = new Float32Array(maxVerts * 2);
  let vi = 0;
  let cx = 0, cz = 0;

  const emitQuad = (p0, p1, p2, p3, nx, ny, nz) => {
    // Two triangles: p0-p1-p2, p0-p2-p3. Flat normals per face. All six
    // verts share the owning block's (cx, cz) centre so the fragment shader
    // can colour side faces from their block's top-centre OSM sample.
    //
    // Positions/normals/centre arrive in grid space and get rotated to world
    // here so the mesh is world-space from the consumer's POV — raycast hits,
    // paint offsets (normal × OFFSET), and the OSM shader's world-XZ sample
    // all work unchanged. Rotation is around Y, so normal.y / p[1] are
    // untouched. Rotating blockCenter and the per-face normal once per quad
    // (not per vertex) since they're constant across the quad.
    const wnx = nx * _GRID_COS - nz * _GRID_SIN;
    const wnz = nx * _GRID_SIN + nz * _GRID_COS;
    const wcx = cx * _GRID_COS - cz * _GRID_SIN;
    const wcz = cx * _GRID_SIN + cz * _GRID_COS;
    const verts = [p0, p1, p2, p0, p2, p3];
    for (let k = 0; k < 6; k++) {
      const p = verts[k];
      positions[vi * 3    ] = p[0] * _GRID_COS - p[2] * _GRID_SIN;
      positions[vi * 3 + 1] = p[1];
      positions[vi * 3 + 2] = p[0] * _GRID_SIN + p[2] * _GRID_COS;
      normals[vi * 3    ] = wnx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = wnz;
      blockCenters[vi * 2    ] = wcx;
      blockCenters[vi * 2 + 1] = wcz;
      vi++;
    }
  };

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix;
      const hC = h(ix, iz);
      const x0 = b.minX + ix * step, x1 = x0 + step;
      const z0 = b.minZ + iz * step, z1 = z0 + step;
      cx = x0 + step * 0.5;
      cz = z0 + step * 0.5;

      const yNW = nwY[i];
      const yNE = neY[i];
      const ySE = seY[i];
      const ySW = swY[i];

      // Top face: 2 triangles along the NW-SE diagonal so a cell tilted in
      // both X and Z renders as 2 planar tris instead of a non-planar
      // quad. Normal stays (0,1,0); the shading-bias hook flattens
      // lighting, and the OSM sampler gates on vLocalNormalY > 0.5 which
      // tolerates the ≤ 6 % tilt.
      emitQuad(
        [x0, yNW, z0], [x0, ySW, z1], [x1, ySE, z1], [x1, yNE, z0],
        0, 1, 0,
      );

      // Side faces emit when we're the taller side of a cliff.
      //
      // Within the tile, the bottom edge drops `slopeThreshold + 0.02 m`
      // below the neighbour's centre Y. This artificial extension covers
      // the sky-strip that would otherwise show at corners where smoothing
      // pulled the neighbour's corner above its centre — small cliffs stay
      // visible as a slab rather than collapsing to zero height when the
      // union-find transitively unifies all four slots.
      //
      // At a tile seam we instead match the neighbour's exact top-corner Ys
      // (minus a 2 cm float-safety drop), read from the westNbr* / eastNbr*
      // / northNbr* / southNbr* arrays populated during the union-find.
      // Both tiles compute those corner averages identically from the
      // shared perimeter samples, so the seam closes without any leak. We
      // can't use the bias hack here because the neighbour's rendered top
      // uses its own corner values, not its centre — the bias was what
      // left the tile-border holes you're seeing.
      const sideBottomBias = slopeThreshold + 0.02;
      const SEAM_SAFETY    = 0.02;
      const hW = h(ix - 1, iz);
      if (hC - hW > slopeThreshold) {
        let bN, bS;
        if (ix > 0) {
          bN = bS = Math.max(baseY, hW - sideBottomBias);
        } else {
          bN = Math.max(baseY, westNbrNE[iz] - SEAM_SAFETY);
          bS = Math.max(baseY, westNbrSE[iz] - SEAM_SAFETY);
        }
        emitQuad(
          [x0, yNW, z0], [x0, bN, z0], [x0, bS, z1], [x0, ySW, z1],
          -1, 0, 0,
        );
      }
      const hE = h(ix + 1, iz);
      if (hC - hE > slopeThreshold) {
        let bN, bS;
        if (ix < res - 1) {
          bN = bS = Math.max(baseY, hE - sideBottomBias);
        } else {
          bN = Math.max(baseY, eastNbrNW[iz] - SEAM_SAFETY);
          bS = Math.max(baseY, eastNbrSW[iz] - SEAM_SAFETY);
        }
        emitQuad(
          [x1, yNE, z0], [x1, ySE, z1], [x1, bS, z1], [x1, bN, z0],
          1, 0, 0,
        );
      }
      const hN = h(ix, iz - 1);
      if (hC - hN > slopeThreshold) {
        let bW, bE;
        if (iz > 0) {
          bW = bE = Math.max(baseY, hN - sideBottomBias);
        } else {
          bW = Math.max(baseY, northNbrSW[ix] - SEAM_SAFETY);
          bE = Math.max(baseY, northNbrSE[ix] - SEAM_SAFETY);
        }
        emitQuad(
          [x0, yNW, z0], [x1, yNE, z0], [x1, bE, z0], [x0, bW, z0],
          0, 0, -1,
        );
      }
      const hS = h(ix, iz + 1);
      if (hC - hS > slopeThreshold) {
        let bW, bE;
        if (iz < res - 1) {
          bW = bE = Math.max(baseY, hS - sideBottomBias);
        } else {
          bW = Math.max(baseY, southNbrNW[ix] - SEAM_SAFETY);
          bE = Math.max(baseY, southNbrNE[ix] - SEAM_SAFETY);
        }
        emitQuad(
          [x1, ySE, z1], [x0, ySW, z1], [x0, bW, z1], [x1, bE, z1],
          0, 0, 1,
        );
      }
    }
  }

  return {
    position: positions.slice(0, vi * 3),
    normal: normals.slice(0, vi * 3),
    blockCenter: blockCenters.slice(0, vi * 2),
    nwY,
    neY,
    seY,
    swY,
  };
}

