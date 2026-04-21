import * as THREE from 'three';
import { MANHATTAN_GRID_DEG } from './geo.js';

// Analytic triplanar block-grid overlay, shared by TerrainManager and the
// OSM draped meshes in OsmManager. The grid must visually sit above OSM and
// below paint, so baking it into both terrain and OSM materials makes every
// walkable surface carry the grid — whatever colour is immediately under the
// player, the grid draws on top of it. Paint's +0.025 m Y offset still wins.
//
// Gridline pitch = BLOCK_SIZE so lines coincide with paintable-block edges.
// Rotation matches the Manhattan street grid (see geo.js::MANHATTAN_GRID_DEG)
// so lines align with the terrain cell lattice AND with building walls.

// Must match scripts/bake_terrain.py::SAMPLES and the BLOCK_SIZE used in
// TerrainManager. Exported so terrain paint can align cliff-side sub-cells
// to the same horizontal grid lines drawn by this shader.
export const BLOCK_SIZE = 125 / 64;

const GRID_COLOR      = new THREE.Color(0x28378C);
const GRID_HALF_WIDTH = 0.012;
const GRID_OPACITY    = 0.6;

const _GRID_COS = Math.cos(MANHATTAN_GRID_DEG * Math.PI / 180);
const _GRID_SIN = Math.sin(MANHATTAN_GRID_DEG * Math.PI / 180);

export const GRID_SHADER_CACHE_KEY = 'grid-overlay-v1';

/**
 * Extend an onBeforeCompile `shader` with the grid overlay. Captures the
 * pre-bias geometric world normal into a varying — callers that bias the
 * normal for shading (terrain/osm's world-up flatten) must do so AFTER the
 * `#include <beginnormal_vertex>` slot, since this helper reads `objectNormal`
 * straight out of that include.
 */
export function injectGridOverlay(shader) {
  shader.uniforms.uGridColor     = { value: GRID_COLOR };
  shader.uniforms.uGridHalfWidth = { value: GRID_HALF_WIDTH };
  shader.uniforms.uGridOpacity   = { value: GRID_OPACITY };
  shader.uniforms.uGridCos       = { value: _GRID_COS };
  shader.uniforms.uGridSin       = { value: _GRID_SIN };
  shader.uniforms.uGridStep      = { value: BLOCK_SIZE };

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>',
      `#include <common>
varying vec3 vGridWorldPos;
varying vec3 vGridTrueNormal;`)
    .replace('#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
       vGridTrueNormal = normalize(mat3(modelMatrix) * objectNormal);`)
    .replace('#include <begin_vertex>',
      `#include <begin_vertex>
       vGridWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>',
      `#include <common>
varying vec3 vGridWorldPos;
varying vec3 vGridTrueNormal;
uniform vec3  uGridColor;
uniform float uGridHalfWidth;
uniform float uGridOpacity;
uniform float uGridCos;
uniform float uGridSin;
uniform float uGridStep;

// Metres-distance to the nearest gridline in each axis of a 2D projection,
// then pick the closer. Gridlines sit at integer multiples of uGridStep; the
// * uGridStep rescales fract-of-a-cell back to metres so halfW compares in
// metres. fwidth AA keeps lines ~1px at any camera distance.
float _gridAmt(vec2 p, float halfW) {
  vec2 q = abs(fract(p / uGridStep - 0.5) - 0.5) * uGridStep;
  float d = min(q.x, q.y);
  float aa = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(halfW - aa, halfW + aa, d);
}`)
    .replace('#include <colorspace_fragment>',
      `{
  // Rotate world XZ into Manhattan grid space so gridlines align with the
  // terrain cell axes (and with building walls that follow the same grid).
  vec3 gp = vec3(
     vGridWorldPos.x * uGridCos + vGridWorldPos.z * uGridSin,
     vGridWorldPos.y,
    -vGridWorldPos.x * uGridSin + vGridWorldPos.z * uGridCos);
  vec3 gn = vec3(
     vGridTrueNormal.x * uGridCos + vGridTrueNormal.z * uGridSin,
     vGridTrueNormal.y,
    -vGridTrueNormal.x * uGridSin + vGridTrueNormal.z * uGridCos);
  vec3 w = abs(gn);
  w /= (w.x + w.y + w.z + 1e-5);
  float g = _gridAmt(gp.yz, uGridHalfWidth) * w.x
          + _gridAmt(gp.xz, uGridHalfWidth) * w.y
          + _gridAmt(gp.xy, uGridHalfWidth) * w.z;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uGridColor, g * uGridOpacity);
}
#include <colorspace_fragment>`);
}

/** Set on materials using injectGridOverlay so fwidth compiles on WebGL1. */
export function enableGridExtensions(mat) {
  mat.extensions = { ...(mat.extensions || {}), derivatives: true };
}
