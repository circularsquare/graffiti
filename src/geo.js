// Reference point: center of our FiDi bounding box
export const REF_LNG = -74.01175;
export const REF_LAT = 40.70475;

const METERS_PER_LAT = 111320;
const METERS_PER_LNG = 111320 * Math.cos(REF_LAT * Math.PI / 180); // ~84,390 at 40.7°

/**
 * Convert [lng, lat] → local [x, z] in meters.
 * x = east (+) / west (-)
 * z = south (+) / north (-)  — so north is -Z, the default Three.js "forward"
 */
export function lngLatToLocal(lng, lat) {
  const x = (lng - REF_LNG) * METERS_PER_LNG;
  const z = -(lat - REF_LAT) * METERS_PER_LAT;
  return [x, z];
}

/** Convert local [x, z] in meters → [lng, lat]. Inverse of lngLatToLocal. */
export function localToLngLat(x, z) {
  const lng = REF_LNG + x / METERS_PER_LNG;
  const lat = REF_LAT - z / METERS_PER_LAT;
  return [lng, lat];
}

// ── Manhattan-grid rotation (terrain only) ───────────────────────────────────
// Manhattan's avenues run ~29° east of true north. The TERRAIN grid is rotated
// by this angle so its blocky step walls align with the dominant street
// direction north of Canal. Buildings, OSM, world XZ, and the minimap are all
// untouched — only terrain cell indexing and mesh emission live in grid space.
//
// If the visible alignment is wrong after the first bake (e.g. blocks run
// perpendicular to avenues instead of along them), flip the sign of this
// constant — DO NOT change the transform math. Must stay in sync with
// scripts/bake_terrain.py::MANHATTAN_GRID_DEG.
export const MANHATTAN_GRID_DEG = 29.0;
const _GRID_A   = MANHATTAN_GRID_DEG * Math.PI / 180;
const _GRID_COS = Math.cos(_GRID_A);
const _GRID_SIN = Math.sin(_GRID_A);

/** World XZ (buildings, OSM, player) → terrain grid UV. */
export function worldToGrid(x, z) {
  return [ x * _GRID_COS + z * _GRID_SIN, -x * _GRID_SIN + z * _GRID_COS ];
}
/** Terrain grid UV → world XZ. Inverse of worldToGrid. */
export function gridToWorld(u, v) {
  return [ u * _GRID_COS - v * _GRID_SIN,  u * _GRID_SIN + v * _GRID_COS ];
}
