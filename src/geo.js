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
