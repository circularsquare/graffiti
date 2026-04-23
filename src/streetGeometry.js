// Shared street ribbon tessellation. Used by OsmManager.js (flat-mode builder)
// and osmWorker.js (terrain-mode drape). Lives in its own module so the two
// paths can't drift — the width table and miter math must stay in sync or
// flat and draped streets render at different widths on the same OSM input.

// Approximate road width (metres) per OSM `highway` value. Anything unlisted
// falls back to DEFAULT_WIDTH.
export const TYPE_WIDTH = {
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
export const DEFAULT_WIDTH = 5;

// Street polylines → extruded ribbon with miter joins at each interior
// vertex. Without joins, adjacent rectangles leave V-shaped gaps on the
// outside of a turn — very visible on curved roads approximated by short
// straight segments. Writes 2 triangles × 3 verts × 2 floats = 12 floats
// per segment into `outXZ` (pairs of x,z in triangle order).
export function emitStreetTrisXZ(streets, outXZ) {
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
