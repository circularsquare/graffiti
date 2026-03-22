import * as THREE from 'three';

// ─── Grid textures ────────────────────────────────────────────────────────────
// Each canvas tile = one 2×2 m grid cell. The texture repeats via UV coords.

function makeGridTexture(bgHex, lineRGBA, size = 256, lineWidth = 4) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = lineRGBA;
  ctx.lineWidth = lineWidth;
  const h = lineWidth / 2;
  ctx.strokeRect(h, h, size - lineWidth, size - lineWidth);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const gridTex = makeGridTexture('#ffffff', 'rgba(40, 55, 140, 0.6)');

// Gradient map: a tiny 1-pixel-tall strip where each pixel = one shading band.
// NearestFilter gives hard steps instead of smooth gradients.
function makeToonGradient(shades = [0.25, 0.55, 0.85]) {
  const canvas = document.createElement('canvas');
  canvas.width = shades.length;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  shades.forEach((v, i) => {
    const c = Math.round(v * 255);
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(i, 0, 1, 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  return tex;
}

const gradientMap = makeToonGradient();

const ROOF_MAT = new THREE.MeshToonMaterial({ color: 0xf5f3ef, map: gridTex, gradientMap, side: THREE.DoubleSide });
const WALL_MAT = new THREE.MeshToonMaterial({ color: 0xf5f3ef, map: gridTex, gradientMap, side: THREE.DoubleSide });

// ─── UV computation ───────────────────────────────────────────────────────────
// Face-tangent projection: UV axes lie *in the face plane*, so the grid is
// undistorted on any surface angle — flat roofs, sloped roofs, and walls alike.
//
// V axis = world UP projected onto the face plane ("up the slope").
//          Falls back to world NORTH when the face is nearly horizontal.
// U axis = cross(V, normal)  →  "across the slope / wall"
// 1 UV unit = gridSize metres of surface distance.
// Find the longest horizontal edge across all wall triangles and return its
// direction as a normalised [x, z] vector.  Using the longest edge (rather
// than averaging all edges) avoids the 45° bias that appears when a
// rectangular building's equal E-W and N-S wall lengths cancel each other out.
function dominantWallDir(walls) {
  if (!walls || walls.length < 9) return null;
  let bestLen = 0, bestX = 0, bestZ = 0;
  for (let i = 0; i < walls.length; i += 9) {
    const pts = [[walls[i],walls[i+1],walls[i+2]],[walls[i+3],walls[i+4],walls[i+5]],[walls[i+6],walls[i+7],walls[i+8]]];
    for (let k = 0; k < 3; k++) {
      const a = pts[k], b = pts[(k+1)%3];
      const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
      const hLen = Math.sqrt(dx*dx + dz*dz);
      if (hLen < 0.01 || Math.abs(dy) > hLen * 0.3) continue; // skip vertical/diagonal edges
      if (hLen > bestLen) { bestLen = hLen; bestX = dx/hLen; bestZ = dz/hLen; }
    }
  }
  if (bestLen < 0.1) return null;
  // Fold to 0–180° hemisphere so direction is consistent regardless of winding
  if (bestX < 0 || (bestX === 0 && bestZ < 0)) { bestX = -bestX; bestZ = -bestZ; }
  return [bestX, bestZ];
}

export const GRID_SIZE = 2.0; // metres per grid cell

// horizU: optional [x,z] building axis used to orient flat-roof grid cells.
function computeGridUVs(flatVerts, gridSize = GRID_SIZE, horizU = null) {
  const count = flatVerts.length / 3;
  const uvs   = new Float32Array(count * 2);

  for (let ti = 0; ti < count; ti += 3) {
    const i0 = ti * 3, i1 = i0 + 3, i2 = i0 + 6;

    const ax = flatVerts[i0], ay = flatVerts[i0+1], az = flatVerts[i0+2];
    const bx = flatVerts[i1], by = flatVerts[i1+1], bz = flatVerts[i1+2];
    const cx = flatVerts[i2], cy = flatVerts[i2+1], cz = flatVerts[i2+2];

    // Face normal
    const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
    const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (nl < 1e-10) continue;
    nx /= nl; ny /= nl; nz /= nl;

    // V axis: project world UP (0,1,0) onto face plane
    // v = UP - dot(UP,n)*n  →  dot(UP,n) = ny
    let vx = -ny*nx, vy = 1 - ny*ny, vz = -ny*nz;
    let vl = Math.sqrt(vx*vx + vy*vy + vz*vz);
    if (vl < 0.1) {
      // Near-horizontal face (flat/sloped roof): use the caller-supplied
      // building axis if available, otherwise fall back to world NORTH.
      if (horizU) {
        // horizU = [ux, uz] dominant wall direction for this building.
        // Use it as V; cross(v,n) will give the perpendicular as U.
        vx = horizU[0]; vy = 0; vz = horizU[1];
      } else {
        // v = NORTH - dot(NORTH,n)*n
        vx = -nz*nx; vy = -nz*ny; vz = 1 - nz*nz;
      }
      vl = Math.sqrt(vx*vx + vy*vy + vz*vz);
    }
    vx /= vl; vy /= vl; vz /= vl;

    // U axis: cross(v, n)  →  "right" direction on the face
    const ux = vy*nz - vz*ny, uy = vz*nx - vx*nz, uz = vx*ny - vy*nx;

    // Project each vertex onto U / V and scale by gridSize
    const pts = [[ax,ay,az],[bx,by,bz],[cx,cy,cz]];
    for (let k = 0; k < 3; k++) {
      const [px, py, pz] = pts[k];
      uvs[(ti+k)*2]     = (px*ux + py*uy + pz*uz) / gridSize;
      uvs[(ti+k)*2 + 1] = (px*vx + py*vy + pz*vz) / gridSize;
    }
  }

  return uvs;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/** Fetch a tile JSON file. Returns the raw array of building data objects. */
export async function fetchTileData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  return res.json();
}

/**
 * Build Three.js meshes from a raw tile data array (output of fetchTileData).
 * Returns a flat array of THREE.Mesh objects ready to be added to the scene.
 */
/**
 * Build meshes for a single building object. Returns 0–2 meshes (roof + wall).
 * Exported so callers can process buildings one-at-a-time in chunked loops.
 */
export function buildMeshFromBuilding(b) {
  const minY   = buildingMinY(b.roof, b.walls);
  const horizU = dominantWallDir(b.walls);
  const meshes = [];
  const roofMesh = makeMesh(b.roof, ROOF_MAT, b.id, minY, horizU, 'roof');
  if (roofMesh) meshes.push(roofMesh);
  const wallMesh = makeMesh(b.walls, WALL_MAT, b.id, minY, null, 'wall');
  if (wallMesh) meshes.push(wallMesh);
  return meshes;
}

export function buildMeshesFromData(data) {
  const meshes = [];
  for (const b of data) meshes.push(...buildMeshFromBuilding(b));
  return meshes;
}

/**
 * Convenience wrapper: fetch a tile file and build meshes in one call.
 * Equivalent to the old loadCityGMLBuildings — kept for backward compat.
 */
export async function loadCityGMLBuildings(url = '/buildings.json') {
  return buildMeshesFromData(await fetchTileData(url));
}

function buildingMinY(roof, walls) {
  let min = Infinity;
  for (const arr of [roof, walls]) {
    if (!arr) continue;
    for (let i = 1; i < arr.length; i += 3) min = Math.min(min, arr[i]);
  }
  return min === Infinity ? 0 : min;
}

function makeMesh(flatVerts, mat, id, minY = 0, horizU = null, meshType = 'wall') {
  if (!flatVerts || flatVerts.length < 9) return null;

  // Shift Y so base is at y=0
  const verts = new Float32Array(flatVerts.length);
  for (let i = 0; i < flatVerts.length; i++) {
    verts[i] = (i % 3 === 1) ? flatVerts[i] - minY : flatVerts[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(computeGridUVs(verts, GRID_SIZE, horizU), 2));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow    = false;
  mesh.receiveShadow = false;
  mesh.userData.buildingId = id;
  mesh.userData.meshType   = meshType;
  mesh.userData.horizU     = horizU;

  return mesh;
}
