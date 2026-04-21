import * as THREE from 'three';

// ─── Grid textures ────────────────────────────────────────────────────────────
// Each canvas tile = one 1×1 m grid cell. The texture repeats via UV coords.

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

// Single shared building material (used to be separate ROOF_MAT / WALL_MAT
// with identical settings; merged into one when roof+wall got combined into
// one mesh per building — see tileWorker.buildMergedMeshData).
const BUILDING_MAT = new THREE.MeshToonMaterial({ color: 0xf5f3ef, map: gridTex, gradientMap, side: THREE.DoubleSide });

// Face-boundary outline — drawn in the toon material's fragment shader using a
// per-vertex `lineCoord` attribute whose components are the world-space
// perpendicular distance to each of the triangle's three edges. The shader
// picks the minimum and darkens the surface where it drops below halfWidth.
// Internal edges of a face are bumped to a large value by the worker so they
// never trigger. Width is in metres, so the line scales with camera distance
// exactly like the grid-texture lines.
// Green so face borders read as a separate visual layer from the blue grid
// texture lines — easy to tell which lines are cell boundaries (blue) vs
// face boundaries (green) at a glance.
const BORDER_COLOR      = new THREE.Color(0x1e7a4e);
const BORDER_HALF_WIDTH = 0.015;  // metres — ≈ grid line width (4 px / 256 px × 1 m)
const BORDER_OPACITY    = 0.7;

function injectBorderShader(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBorderColor     = { value: BORDER_COLOR };
    shader.uniforms.uBorderHalfWidth = { value: BORDER_HALF_WIDTH };
    shader.uniforms.uBorderOpacity   = { value: BORDER_OPACITY };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>
attribute vec3 lineCoord;
varying vec3 vLineCoord;`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
vLineCoord = lineCoord;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>
varying vec3 vLineCoord;
uniform vec3  uBorderColor;
uniform float uBorderHalfWidth;
uniform float uBorderOpacity;`)
      .replace('#include <colorspace_fragment>',
        `float _lineDist = min(vLineCoord.x, min(vLineCoord.y, vLineCoord.z));
// fwidth() gives the rate of change of _lineDist across one screen pixel.
// Fading across ±_aa pixels around the edge gives crisp world-scale lines
// with exactly ~1 px of screen-space anti-aliasing at any camera distance,
// killing the subpixel flicker that the fixed fade had at range.
float _aa = max(fwidth(_lineDist), 1e-5);
float _lineEdge = 1.0 - smoothstep(uBorderHalfWidth - _aa, uBorderHalfWidth + _aa, _lineDist);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uBorderColor, _lineEdge * uBorderOpacity);
#include <colorspace_fragment>`);
  };
  mat.customProgramCacheKey = () => 'graffiti-border-shader-v3-green';
  // fwidth() needs GL_OES_standard_derivatives on WebGL1; three enables it on
  // WebGL2 automatically. Safe to request explicitly.
  mat.extensions = { ...(mat.extensions || {}), derivatives: true };
}

injectBorderShader(BUILDING_MAT);

export const GRID_SIZE = 1.0; // metres per grid cell — must match tileWorker.js

/**
 * Wrap a worker MeshData object into a THREE.Mesh. The heavy work — UVs,
 * normals, bounding box, Y-shift — has already happened off-thread; this just
 * attaches the transferred typed arrays to a BufferGeometry. One mesh per
 * building holds both roof + wall geometry (merged in the worker); per-face
 * meshType lives in `faces[i].meshType` and is recovered at raycast time via
 * `faces[triFace[ti]].meshType`.
 */
export function wrapMeshData(d) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.Float32BufferAttribute(d.position, 3));
  geo.setAttribute('uv',        new THREE.Float32BufferAttribute(d.uv, 2));
  geo.setAttribute('normal',    new THREE.Float32BufferAttribute(d.normal, 3));
  if (d.lineCoord) {
    geo.setAttribute('lineCoord', new THREE.Float32BufferAttribute(d.lineCoord, 3));
  }

  const bb = d.bbox;
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(bb.minX, bb.minY, bb.minZ),
    new THREE.Vector3(bb.maxX, bb.maxY, bb.maxZ),
  );

  const mesh = new THREE.Mesh(geo, BUILDING_MAT);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.buildingId   = d.buildingId;
  mesh.userData.buildingKeys = d.buildingKeys; // ['id:roof', 'id:wall'] — TileManager uses for map + unload
  mesh.userData.triRanges    = d.triRanges;    // { roof: {start, count}, wall: {start, count} } — lets buildCellGeometry skip the other half of the merged mesh on cache-miss clips
  mesh.userData.horizU       = d.horizU;
  mesh.userData.center       = new THREE.Vector3(bb.cx, bb.cy, bb.cz);
  mesh.userData.triFace = d.triFace; // per-triangle face index
  mesh.userData.faces   = d.faces;   // [{normal:[x,y,z], planeD, meshType}, ...] — used by hitCell

  // cellData arrives later from the worker's phase-2 scan and is attached by
  // TileManager._applyCellDataToTile as mesh.userData.cellDataByType, keyed by
  // meshType. seedTileCells iterates that object when onTileCellData fires.
  return mesh;
}
