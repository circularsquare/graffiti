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

// Gradient map: 1-pixel-tall strip, one pixel per shading band, NearestFilter
// so transitions are hard steps instead of smooth gradients.
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

export const GRID_SIZE = 2.0; // metres per grid cell — must match tileWorker.js

/**
 * Wrap a worker MeshData object into a THREE.Mesh. The heavy work — UVs,
 * normals, bounding box, Y-shift — has already happened off-thread; this just
 * attaches the transferred typed arrays to a BufferGeometry and picks the
 * right shared material.
 */
export function wrapMeshData(d) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(d.position, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(d.uv, 2));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(d.normal, 3));

  const bb = d.bbox;
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(bb.minX, bb.minY, bb.minZ),
    new THREE.Vector3(bb.maxX, bb.maxY, bb.maxZ),
  );

  const mesh = new THREE.Mesh(geo, d.meshType === 'roof' ? ROOF_MAT : WALL_MAT);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.buildingId = d.buildingId;
  mesh.userData.meshType   = d.meshType;
  mesh.userData.horizU     = d.horizU;
  mesh.userData.center     = new THREE.Vector3(bb.cx, bb.cy, bb.cz);

  // cellData arrives later from the worker's phase-2 scan and is attached by
  // TileManager._applyCellDataToTile. seedTileCells reads mesh.userData.cellData
  // when the onTileCellData callback fires.
  return mesh;
}
