// ── Landmark override layer ────────────────────────────────────────────────
//
// The citywide CityGML dataset has a handful of known-bad simplifications —
// e.g. the Washington Square Arch ships as a solid block. Each entry here
// hides one or more of those buildings and replaces them with a hand-authored
// triangle mesh that's fed through the *exact same* tileWorker pipeline as a
// regular building (face extraction, UV, lineCoord, cell scan, paint groups,
// seeding). Result: landmarks render with grid + face borders and are
// paintable just like everything else.
//
// Authoring a new entry:
//   • `hideBuildingIds`: aim the F3 crosshair at the bad building in-game and
//     copy the `bldg ...` line. Multiple IDs OK if the dataset split it.
//   • `position`: world XZ centre. F3's `hit (x, y, z)` line gives a point
//     ON the building; the true centre is inset along the hit face's normal.
//   • `rotationY`: Y-axis rotation in radians. Manhattan's grid tilts
//     ≈ 29° east of true north — landmarks aligned with that grid typically
//     want ±29 × RAD_PER_DEG here.
//   • `buildTriangles()`: returns `{ roof: Float32Array, walls: Float32Array }`
//     of triangles in **local space** with base at y=0. Each triangle is
//     9 floats (3 verts × xyz), CCW winding from the outside (right-hand
//     normal). The wrapper transforms to world space by applying rotationY,
//     translating by position, and adding the resolved terrain Y.
//
// ── Single-tile assumption ────────────────────────────────────────────────
// Each landmark must fit inside one 100 m tile cell — `prepareLandmarks`
// throws if a landmark's bbox straddles the grid. Compact monuments
// (statues, arches, kiosks) trivially satisfy this. Bridges don't — when we
// get there, the slicer will need to split a landmark across cells before
// injection.

const RAD_PER_DEG = Math.PI / 180;

// Must match build_tiles.py and TileManager's tile cell size.
const TILE_SIZE = 100;

const LANDMARKS = [
  {
    name: 'washington-square-arch',
    hideBuildingIds: ['gml_YEPHIVWC44TXVQJNO5B1BH1OL5GIIWHMQ52R'],
    position: { x: 1234.1, z: -2945.1 },
    // +29° aligns the arch's wide axis (X local) with the Manhattan street
    // grid, putting its depth axis (Z local) along the avenue direction so
    // the opening straddles 5th Ave. _transformTris uses the standard 2D
    // rotation in XZ — `rotationY > 0` rotates +X toward +Z (CW from +Y),
    // not the right-handed convention Three.js Object3D.rotation.y uses.
    rotationY: 29 * RAD_PER_DEG,
    buildTriangles: buildWashingtonSquareArchTriangles,
  },
];

// ── Public API ─────────────────────────────────────────────────────────────

let _byTile      = null;          // tileId → [{ buildingId, hideBuildingIds, roof, walls }]
let _ready       = false;
let _readyPromise = null;

/**
 * Tile IDs that contain at least one landmark, derivable from the config
 * alone (no terrain Y needed). TileManager uses this for the block-on-Y
 * gate: a tile in this set won't load until prepareLandmarks() resolves.
 */
export function tilesWithLandmarks() {
  const out = new Set();
  for (const L of LANDMARKS) {
    out.add(_tileIdForXZ(L.position.x, L.position.z));
  }
  return out;
}

/**
 * Resolve terrain Y for every landmark, transform local triangles into
 * world space, build the per-tile lookup. Idempotent — repeat calls return
 * the same Promise.
 */
export function prepareLandmarks({ terrain }) {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    const byTile = new Map();
    await Promise.all(LANDMARKS.map(async (L) => {
      const local = L.buildTriangles();
      const cos = Math.cos(L.rotationY || 0);
      const sin = Math.sin(L.rotationY || 0);
      const yOff = (await terrain.sampleAsync(L.position.x, L.position.z)) ?? 0;

      const roof  = _transformTris(local.roof  || new Float32Array(0), L.position.x, yOff, L.position.z, cos, sin);
      const walls = _transformTris(local.walls || new Float32Array(0), L.position.x, yOff, L.position.z, cos, sin);

      // Single-tile assertion. The -ε on the max edge handles a landmark
      // sitting exactly on a tile boundary — bbox max is exclusive.
      const bbox = _bbox(roof, walls);
      const txMin = Math.floor(bbox.minX / TILE_SIZE);
      const txMax = Math.floor((bbox.maxX - 1e-4) / TILE_SIZE);
      const tzMin = Math.floor(bbox.minZ / TILE_SIZE);
      const tzMax = Math.floor((bbox.maxZ - 1e-4) / TILE_SIZE);
      if (txMin !== txMax || tzMin !== tzMax) {
        throw new Error(
          `landmark "${L.name}" straddles a tile boundary ` +
          `(world bbox ${bbox.minX.toFixed(1)}..${bbox.maxX.toFixed(1)} x, ` +
          `${bbox.minZ.toFixed(1)}..${bbox.maxZ.toFixed(1)} z). ` +
          `Single-tile landmarks only — see CLAUDE/spec for the limitation.`
        );
      }

      const tileId = `cell_${txMin}_${tzMin}`;
      const rec = {
        buildingId:      `landmark_${L.name}`,
        hideBuildingIds: L.hideBuildingIds || [],
        roof, walls,
      };
      let arr = byTile.get(tileId);
      if (!arr) { arr = []; byTile.set(tileId, arr); }
      arr.push(rec);
    }));
    _byTile = byTile;
    _ready  = true;
  })();
  return _readyPromise;
}

export function landmarksReady() { return _ready; }

/**
 * Per-tile injection payload for the worker. Returns null when the tile has
 * no landmarks. Aggregates all landmarks belonging to the tile into a single
 * payload (one tile may host multiple landmarks).
 */
export function tileInjection(tileId) {
  if (!_byTile) return null;
  const recs = _byTile.get(tileId);
  if (!recs) return null;
  const injectedBuildings = recs.map(r => ({
    buildingId: r.buildingId,
    roof:       r.roof,
    walls:      r.walls,
  }));
  const hideBuildingIds = [];
  for (const r of recs) for (const id of r.hideBuildingIds) hideBuildingIds.push(id);
  return { injectedBuildings, hideBuildingIds };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _tileIdForXZ(x, z) {
  return `cell_${Math.floor(x / TILE_SIZE)}_${Math.floor(z / TILE_SIZE)}`;
}

// Apply Y-axis rotation + XYZ translation to a flat triangle-vert array.
// Produces a fresh Float32Array — the worker transfers ownership of these
// buffers across postMessage, so they must not be aliased into LANDMARKS.
function _transformTris(local, tx, ty, tz, cos, sin) {
  const out = new Float32Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i], y = local[i + 1], z = local[i + 2];
    out[i    ] = x * cos - z * sin + tx;
    out[i + 1] = y + ty;
    out[i + 2] = x * sin + z * cos + tz;
  }
  return out;
}

function _bbox(...arrs) {
  let minX =  Infinity, maxX = -Infinity;
  let minZ =  Infinity, maxZ = -Infinity;
  for (const a of arrs) {
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], z = a[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

// ── Procedural shapes ──────────────────────────────────────────────────────
//
// Each shape returns `{ roof: Float32Array, walls: Float32Array }`. Tops
// (and any bottoms visible from outside, like the underside of an arch
// lintel) go into `roof`; vertical surfaces go into `walls`. The worker's
// face extractor doesn't actually care which bucket a face lands in — they
// just become face entries with `meshType: 'roof' | 'wall'`. The bucketing
// matters for paint-cell key uniqueness (cellKey embeds meshType) and for
// horizU computation (only walls feed dominantWallDir).
//
// Two piers + a flat-bottom lintel approximation of Washington Square Arch.
// Real arch is ~23.5 × 19 × 6 m; opening is ~9 × 14 m. The actual arched
// curve isn't modelled — needs a Blender-authored glTF for that.
//
// Topology is hand-laid to avoid coplanar internal seams that would z-fight
// under DoubleSide rendering: piers stop at the lintel base (top face
// suppressed), lintel sits on top spanning full width, lintel bottom is
// only emitted over the opening (the strips over the piers would be hidden
// inside the geometry). Pier walls and lintel walls at the same X are
// coplanar + adjacent — the worker's face extractor merges them into one
// continuous front/back face spanning the whole arch silhouette.
function buildWashingtonSquareArchTriangles() {
  const W = 19, H = 23.5, D = 6;
  const OPENING_W = 9, OPENING_H = 14;

  const roof = [];
  const walls = [];

  // Left pier — y∈[0, OPENING_H]. Top suppressed (covered by lintel),
  // bottom suppressed (sits on terrain).
  emitBox(roof, walls,
    -W / 2,         0, -D / 2,
    -OPENING_W / 2, OPENING_H, D / 2,
    /*skipTop=*/true, /*skipBottom=*/true);

  // Right pier — mirror.
  emitBox(roof, walls,
     OPENING_W / 2, 0, -D / 2,
     W / 2,         OPENING_H, D / 2,
    true, true);

  // Lintel: x∈[-W/2, W/2], y∈[OPENING_H, H]. Full top + 4 walls; bottom
  // emitted only over the opening so the underside of the arch is visible
  // from below but the pier-covered strips don't double up with the
  // (suppressed) pier tops.
  const lx0 = -W / 2,         lx1 = W / 2;
  const ly0 = OPENING_H,      ly1 = H;
  const lz0 = -D / 2,         lz1 = D / 2;
  const ox0 = -OPENING_W / 2, ox1 = OPENING_W / 2;

  // Top (+Y) — full
  emitQuad(roof, [lx0, ly1, lz0], [lx0, ly1, lz1], [lx1, ly1, lz1], [lx1, ly1, lz0]);
  // Bottom (-Y) — only the strip over the opening
  emitQuad(roof, [ox0, ly0, lz0], [ox1, ly0, lz0], [ox1, ly0, lz1], [ox0, ly0, lz1]);
  // Front (+Z)
  emitQuad(walls, [lx0, ly0, lz1], [lx1, ly0, lz1], [lx1, ly1, lz1], [lx0, ly1, lz1]);
  // Back (-Z)
  emitQuad(walls, [lx1, ly0, lz0], [lx0, ly0, lz0], [lx0, ly1, lz0], [lx1, ly1, lz0]);
  // Left (-X)
  emitQuad(walls, [lx0, ly0, lz0], [lx0, ly0, lz1], [lx0, ly1, lz1], [lx0, ly1, lz0]);
  // Right (+X)
  emitQuad(walls, [lx1, ly0, lz1], [lx1, ly0, lz0], [lx1, ly1, lz0], [lx1, ly1, lz1]);

  return { roof: new Float32Array(roof), walls: new Float32Array(walls) };
}

// Emit an axis-aligned box. Vertices wound CCW from outside so each face's
// right-hand normal points outward. Top + bottom go into `roof`, the four
// vertical sides into `walls`. skipTop / skipBottom drop those faces for
// boxes that meet other geometry at top / bottom (lintel above, terrain
// below) — the dropped face would otherwise sit coplanar with the meeting
// surface and z-fight under DoubleSide rendering.
function emitBox(roof, walls, minX, minY, minZ, maxX, maxY, maxZ, skipTop, skipBottom) {
  const v = [
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
    [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
  ];
  if (!skipTop) {
    pushTri(roof, v[4], v[7], v[6]);
    pushTri(roof, v[4], v[6], v[5]);
  }
  if (!skipBottom) {
    pushTri(roof, v[0], v[1], v[2]);
    pushTri(roof, v[0], v[2], v[3]);
  }
  // Front (+Z): 3,2,6,7
  pushTri(walls, v[3], v[2], v[6]);
  pushTri(walls, v[3], v[6], v[7]);
  // Back (-Z): 1,0,4,5
  pushTri(walls, v[1], v[0], v[4]);
  pushTri(walls, v[1], v[4], v[5]);
  // Right (+X): 1,5,6,2
  pushTri(walls, v[1], v[5], v[6]);
  pushTri(walls, v[1], v[6], v[2]);
  // Left (-X): 0,3,7,4
  pushTri(walls, v[0], v[3], v[7]);
  pushTri(walls, v[0], v[7], v[4]);
}

// Emit a quad (a,b,c,d) wound CCW from outside as two triangles into `out`.
function emitQuad(out, a, b, c, d) {
  pushTri(out, a, b, c);
  pushTri(out, a, c, d);
}

function pushTri(out, a, b, c) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}
