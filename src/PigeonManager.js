import * as THREE from 'three';

// Pigeon flocks streamed with the terrain tiles. Each cell rolls 0–2 flock
// anchors on open ground (deterministic per-cell RNG; anchors under a building
// roof are rejected). Each flock is 5–9 pigeons scattered in a small cluster,
// standing on the terrain.
//
// Flee behaviour: when the camera gets within SCARE_RADIUS (XZ) of a pigeon,
// it takes off — flying away from the camera with a small angle jitter, rising
// linearly, and despawning after FLEE_DURATION. Startling one bird cascades to
// the rest of its flock with a small random delay so the group reacts together.
// Pigeons do not come back once they've fled.
//
// Rendering: one instanced low-poly mesh (~32 tris — boxy body + boxy head +
// flat-quad wings + flat tail + beak tri; flat-shaded via fragment-shader
// derivatives). Animation runs entirely in the vertex shader: per-part
// rotations — head pitch for the peck nod, wing roll for the flap — are
// applied per-vertex from a `part` tag and per-instance state. The CPU just
// writes translation / yaw / state. One draw call for all pigeons.

const CELL_SIZE     = 150;
const LOAD_RADIUS   = 200;
const UNLOAD_MARGIN =  60;

const MAX_PIGEONS = 4096;

const FLOCK_CHANCES  = [0, 0, 10, 10, 20];  // TEMP 10× for flee testing — restore [0,0,1,1,2]
const FLOCK_SIZE_MIN = 5;
const FLOCK_SIZE_MAX = 9;

const SCATTER_RADIUS = 2.5;   // metres — pigeon cluster radius around anchor
const BUILDING_CLEARANCE = 3; // metres — min gap (terrain → roof) for a point
                              // to count as "under a building" and be rejected

const PECK_FREQ_MIN = 0.3;    // Hz — peck-bob rate
const PECK_FREQ_MAX = 0.9;

const PIGEON_SCALE_MIN = 0.55;  // final bird ≈ 0.28–0.38 m tall
const PIGEON_SCALE_MAX = 0.75;

const SCARE_RADIUS     = 3;     // metres — XZ distance from camera that triggers flee
const FLEE_DURATION    = 1.5;   // seconds from takeoff to despawn
const FLEE_VXZ_MIN     = 4;     // metres / sec — horizontal flee speed
const FLEE_VXZ_MAX     = 6;
const FLEE_VY_MIN      = 3;     // metres / sec — vertical climb rate
const FLEE_VY_MAX      = 5;
const FLEE_JITTER_RAD  = 0.6;   // ± radians added to the away-from-camera direction
const CASCADE_DELAY_MIN = 0.05; // flock-mates take off this-much later than the trigger bird
const CASCADE_DELAY_MAX = 0.25;

// ---------- pigeon mesh (model space, metres; feet sit on y=0) ----------
const BODY_W   = 0.22, BODY_H = 0.35, BODY_D = 0.30;
const HEAD_W   = 0.17, HEAD_H = 0.20, HEAD_D = 0.15;
const HEAD_FWD = 0.10;                          // head center Z (slightly forward of body)
const HEAD_TOP = BODY_H + HEAD_H - 0.05;        // small overlap into body
const HEAD_CY  = HEAD_TOP - HEAD_H / 2;
// Peck pivot at the neck base, behind the head. Rotating the head here makes
// the beak swing forward-and-down on the nod, not spin in place.
const HEAD_PIVOT_Y = BODY_H - 0.04;
const HEAD_PIVOT_Z = HEAD_FWD - HEAD_D / 2 + 0.02;

const WING_Y         = 0.24;                    // wing hinge Y
const WING_HINGE_X   = BODY_W / 2;              // hinge sits on body side
const WING_SPAN      = 0.18;                    // tip extends this far from hinge
const WING_CHORD_IN  = 0.16;
const WING_CHORD_OUT = 0.12;
const WING_DROOP     = 0.02;                    // outer tip hangs slightly lower when idle

const COL_BODY = [0x55 / 255, 0x55 / 255, 0x55 / 255];
const COL_HEAD = [0x36 / 255, 0x36 / 255, 0x36 / 255];
const COL_BEAK = [0xcc / 255, 0x72 / 255, 0x72 / 255];
const COL_WING = [0x48 / 255, 0x48 / 255, 0x48 / 255];
const COL_TAIL = [0x40 / 255, 0x40 / 255, 0x40 / 255];

// Part tags — must match the branches in the vertex shader.
const PART_BODY  = 0;
const PART_HEAD  = 1;  // beak is tagged PART_HEAD so it nods with the head
const PART_WINGL = 2;
const PART_WINGR = 3;
const PART_TAIL  = 4;

function hashSeed(gx, gz) {
  let h = (gx | 0) * 73856093 ^ (gz | 0) * 19349663;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function lerp(r, a, b) { return a + (b - a) * r(); }

function buildPigeonGeometry() {
  const positions = [];
  const colors    = [];
  const parts     = [];
  const indices   = [];

  const addVert = (x, y, z, col, part) => {
    positions.push(x, y, z);
    colors.push(col[0], col[1], col[2]);
    parts.push(part);
    return (positions.length / 3) - 1;
  };
  const addTri = (v0, v1, v2, col, part) => {
    const a = addVert(v0[0], v0[1], v0[2], col, part);
    const b = addVert(v1[0], v1[1], v1[2], col, part);
    const c = addVert(v2[0], v2[1], v2[2], col, part);
    indices.push(a, b, c);
  };
  const addQuad = (v0, v1, v2, v3, col, part) => {
    const a = addVert(v0[0], v0[1], v0[2], col, part);
    const b = addVert(v1[0], v1[1], v1[2], col, part);
    const c = addVert(v2[0], v2[1], v2[2], col, part);
    const d = addVert(v3[0], v3[1], v3[2], col, part);
    indices.push(a, b, c,  a, c, d);
  };
  const addBox = (cx, cy, cz, sx, sy, sz, col, part) => {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // 8 shared corners (vertex indices 0..7 by (ox, oy, oz) bit pattern below).
    // Flat shading works anyway — we reconstruct face normals in the fragment
    // shader via derivatives of world position, not interpolated vertex normals.
    const v = [];
    for (let oz = -1; oz <= 1; oz += 2)
    for (let oy = -1; oy <= 1; oy += 2)
    for (let ox = -1; ox <= 1; ox += 2) {
      v.push(addVert(cx + ox * hx, cy + oy * hy, cz + oz * hz, col, part));
    }
    // Index layout: v[ ((oz+1) << 1) | ((oy+1) >> 1) << 0 | ... ] — just list
    // the 6 faces explicitly with outward-CCW winding.
    //   v[0]=(-,-,-) v[1]=(+,-,-) v[2]=(-,+,-) v[3]=(+,+,-)
    //   v[4]=(-,-,+) v[5]=(+,-,+) v[6]=(-,+,+) v[7]=(+,+,+)
    const quad = (a, b, c, d) => indices.push(v[a], v[b], v[c],  v[a], v[c], v[d]);
    quad(0, 2, 3, 1); // -Z
    quad(4, 5, 7, 6); // +Z
    quad(0, 1, 5, 4); // -Y
    quad(2, 6, 7, 3); // +Y
    quad(0, 4, 6, 2); // -X
    quad(1, 3, 7, 5); // +X
  };

  // Body box
  addBox(0, BODY_H / 2, 0, BODY_W, BODY_H, BODY_D, COL_BODY, PART_BODY);

  // Head box (slightly forward of body center)
  addBox(0, HEAD_CY, HEAD_FWD, HEAD_W, HEAD_H, HEAD_D, COL_HEAD, PART_HEAD);

  // Beak — one flat triangle out of the head front face, tagged PART_HEAD so
  // it pitches with the head during the peck.
  const beakY    = HEAD_CY + 0.01;
  const beakBase = HEAD_FWD + HEAD_D / 2;
  const beakTip  = beakBase + 0.07;
  const beakHW   = 0.025;
  addTri(
    [-beakHW, beakY, beakBase],
    [+beakHW, beakY, beakBase],
    [     0, beakY, beakTip ],
    COL_BEAK, PART_HEAD,
  );

  // Left wing — flat quad. Inner edge sits at the body side (the hinge);
  // outer tip extends -X. Winding is CCW viewed from +Y.
  addQuad(
    [-WING_HINGE_X,             WING_Y,              -WING_CHORD_IN  / 2],
    [-WING_HINGE_X,             WING_Y,              +WING_CHORD_IN  / 2],
    [-WING_HINGE_X - WING_SPAN, WING_Y - WING_DROOP, +WING_CHORD_OUT / 2],
    [-WING_HINGE_X - WING_SPAN, WING_Y - WING_DROOP, -WING_CHORD_OUT / 2],
    COL_WING, PART_WINGL,
  );
  // Right wing — mirror.
  addQuad(
    [+WING_HINGE_X,             WING_Y,              +WING_CHORD_IN  / 2],
    [+WING_HINGE_X,             WING_Y,              -WING_CHORD_IN  / 2],
    [+WING_HINGE_X + WING_SPAN, WING_Y - WING_DROOP, -WING_CHORD_OUT / 2],
    [+WING_HINGE_X + WING_SPAN, WING_Y - WING_DROOP, +WING_CHORD_OUT / 2],
    COL_WING, PART_WINGR,
  );

  // Tail — flat quad behind the body, sloped upward.
  const tFrontY = BODY_H * 0.55;
  const tBackY  = BODY_H * 0.82;
  const tFrontZ = -BODY_D / 2;
  const tBackZ  = tFrontZ - 0.14;
  const tFrontHW = BODY_W / 2 - 0.03;
  const tBackHW  = 0.09;
  addQuad(
    [-tFrontHW, tFrontY, tFrontZ],
    [+tFrontHW, tFrontY, tFrontZ],
    [+tBackHW,  tBackY,  tBackZ ],
    [-tBackHW,  tBackY,  tBackZ ],
    COL_TAIL, PART_TAIL,
  );

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('part',     new THREE.Float32BufferAttribute(parts, 1));
  return geo;
}

const VERT = `
attribute vec3  color;
attribute float part;

attribute vec3  instancePos;
attribute float instanceYaw;
attribute float instanceScale;
attribute float instanceState;     // 0 = grounded, 1 = flying
attribute float instancePhase;     // per-bird desync offset
attribute float instancePeckFreq;  // per-bird peck rate

uniform float uTime;
uniform vec3  uHeadPivot;
uniform vec3  uWingLPivot;
uniform vec3  uWingRPivot;

varying vec3 vColor;
varying vec3 vWorldPos;

#include <fog_pars_vertex>

vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}
vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 rotZ(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

void main() {
  vec3 p = position;

  // Peck: sin^8 spike — mostly 0 with brief nods. Only nods while grounded.
  float peckRaw   = max(0.0, sin(uTime * instancePeckFreq + instancePhase));
  float peckAngle = pow(peckRaw, 8.0) * 0.55 * (1.0 - instanceState);

  // Flap: fast sine while flying, folded against body while grounded.
  float flapIdle  = -0.18;
  float flapFly   = sin(uTime * 14.0 + instancePhase) * 1.1;
  float wingAngle = mix(flapIdle, flapFly, instanceState);

  if (part > 0.5 && part < 1.5) {
    // Head + beak: pitch forward around the neck base.
    p = rotX(p - uHeadPivot, peckAngle) + uHeadPivot;
  } else if (part > 1.5 && part < 2.5) {
    // Left wing: -Z rotation lifts the -X tip (see math in comment below).
    p = rotZ(p - uWingLPivot, -wingAngle) + uWingLPivot;
  } else if (part > 2.5 && part < 3.5) {
    // Right wing: mirrored.
    p = rotZ(p - uWingRPivot,  wingAngle) + uWingRPivot;
  }

  p *= instanceScale;
  p = rotY(p, instanceYaw);
  p += instancePos;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  vColor    = color;
  vWorldPos = p;

  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}
`;

const FRAG = `
precision highp float;

varying vec3 vColor;
varying vec3 vWorldPos;

#include <fog_pars_fragment>

void main() {
  // Flat shade by reconstructing the face normal from screen-space derivatives
  // of world position. Works with shared-vertex boxes because derivatives are
  // per-fragment and each fragment belongs to exactly one triangle.
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(vec3(0.4, 1.0, 0.3));
  float ndl = max(0.0, dot(N, L));
  gl_FragColor = vec4(vColor * (0.55 + 0.45 * ndl), 1.0);
  #include <fog_fragment>
}
`;

export class PigeonManager {
  constructor({ scene, terrain, getBuildings }) {
    this._scene         = scene;
    this._terrain       = terrain;
    this._getBuildings  = getBuildings ?? (() => []);
    this._raycaster     = new THREE.Raycaster();
    this._raycaster.far = 1000;
    this._downVec       = new THREE.Vector3(0, -1, 0);
    this._tmpOrigin     = new THREE.Vector3();

    this._mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime:       { value: 0 },
          uHeadPivot:  { value: new THREE.Vector3(0,              HEAD_PIVOT_Y, HEAD_PIVOT_Z) },
          uWingLPivot: { value: new THREE.Vector3(-WING_HINGE_X, WING_Y,       0) },
          uWingRPivot: { value: new THREE.Vector3(+WING_HINGE_X, WING_Y,       0) },
        },
      ]),
      vertexShader:   VERT,
      fragmentShader: FRAG,
      fog:            true,
      // DoubleSide because wings/tail are single flat quads — from below a
      // flying bird the back face needs to render too.
      side:        THREE.DoubleSide,
      extensions:  { derivatives: true },
    });

    const source = buildPigeonGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = source.index;
    geo.setAttribute('position', source.attributes.position);
    geo.setAttribute('color',    source.attributes.color);
    geo.setAttribute('part',     source.attributes.part);

    this._instancePos      = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS * 3), 3);
    this._instanceYaw      = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS),     1);
    this._instanceScale    = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS),     1);
    this._instanceState    = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS),     1);
    this._instancePhase    = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS),     1);
    this._instancePeckFreq = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS),     1);

    this._instancePos.setUsage(THREE.DynamicDrawUsage);
    this._instanceYaw.setUsage(THREE.DynamicDrawUsage);
    this._instanceState.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('instancePos',      this._instancePos);
    geo.setAttribute('instanceYaw',      this._instanceYaw);
    geo.setAttribute('instanceScale',    this._instanceScale);
    geo.setAttribute('instanceState',    this._instanceState);
    geo.setAttribute('instancePhase',    this._instancePhase);
    geo.setAttribute('instancePeckFreq', this._instancePeckFreq);
    geo.instanceCount = 0;

    this._geo  = geo;
    this._mesh = new THREE.Mesh(geo, this._mat);
    this._mesh.frustumCulled = false;
    scene.add(this._mesh);

    this._pigeons      = [];         // flat array; swap-pop on tile unload / flee complete
    this._tiles        = new Map();  // spawned: tileKey -> { gx, gz }
    this._pendingTiles = new Map();  // awaiting buildings: tileKey -> { gx, gz }
  }

  // Tallest building top at (x, z). Null if the buildings list is empty or
  // the ray doesn't hit anything (open ground above this XZ).
  _topYAt(x, z) {
    const buildings = this._getBuildings();
    if (!buildings.length) return null;
    this._tmpOrigin.set(x, 1000, z);
    this._raycaster.set(this._tmpOrigin, this._downVec);
    const hits = this._raycaster.intersectObjects(buildings, false);
    return hits.length > 0 ? hits[0].point.y : null;
  }

  tick(px, pz) {
    const r        = Math.ceil(LOAD_RADIUS / CELL_SIZE);
    const cx       = Math.floor(px / CELL_SIZE);
    const cz       = Math.floor(pz / CELL_SIZE);
    const loadR2   = LOAD_RADIUS * LOAD_RADIUS;
    const unloadR2 = (LOAD_RADIUS + UNLOAD_MARGIN) ** 2;

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const gx = cx + dx;
        const gz = cz + dz;
        const wx = (gx + 0.5) * CELL_SIZE;
        const wz = (gz + 0.5) * CELL_SIZE;
        if ((px - wx) ** 2 + (pz - wz) ** 2 > loadR2) continue;
        const key = `${gx},${gz}`;
        if (this._tiles.has(key) || this._pendingTiles.has(key)) continue;
        this._spawnTile(key, gx, gz);
      }
    }

    for (const [key, state] of this._tiles) {
      const wx = (state.gx + 0.5) * CELL_SIZE;
      const wz = (state.gz + 0.5) * CELL_SIZE;
      if ((px - wx) ** 2 + (pz - wz) ** 2 > unloadR2) this._unloadTile(key);
    }

    if (this._pendingTiles.size > 0 && this._getBuildings().length > 0) {
      for (const [key, state] of this._pendingTiles) {
        const wx = (state.gx + 0.5) * CELL_SIZE;
        const wz = (state.gz + 0.5) * CELL_SIZE;
        this._pendingTiles.delete(key);
        if ((px - wx) ** 2 + (pz - wz) ** 2 > unloadR2) continue;
        this._spawnTile(key, state.gx, state.gz);
      }
    }
  }

  _spawnTile(key, gx, gz) {
    // Defer if buildings haven't loaded — otherwise we'd accept every anchor
    // as "open ground" and spawn flocks inside towers that stream in later.
    if (this._getBuildings().length === 0) {
      this._pendingTiles.set(key, { gx, gz });
      return;
    }

    const rng = mulberry32(hashSeed(gx, gz));
    const flockCount = FLOCK_CHANCES[Math.floor(rng() * FLOCK_CHANCES.length)];

    for (let i = 0; i < flockCount; i++) {
      const fx = (gx + rng()) * CELL_SIZE;
      const fz = (gz + rng()) * CELL_SIZE;
      const groundY = this._terrain.sample(fx, fz) ?? 0;

      // Reject anchors that sit under a building — the flock would spawn on
      // the floor inside a wall. (Rejection skips the flock's remaining RNG
      // draws; still deterministic per tile.)
      const topY = this._topYAt(fx, fz);
      if (topY !== null && topY > groundY + BUILDING_CLEARANCE) continue;

      const size = FLOCK_SIZE_MIN + Math.floor(rng() * (FLOCK_SIZE_MAX - FLOCK_SIZE_MIN + 1));
      const flockId = `${key}#${i}`;
      for (let p = 0; p < size; p++) {
        if (this._pigeons.length >= MAX_PIGEONS) return;
        // Uniform disk sample around the anchor.
        const rad   = Math.sqrt(rng()) * SCATTER_RADIUS;
        const theta = rng() * Math.PI * 2;
        const px = fx + Math.cos(theta) * rad;
        const pz = fz + Math.sin(theta) * rad;
        const py = this._terrain.sample(px, pz) ?? groundY;
        this._pigeons.push({
          tileKey:   key,
          flockId,
          px, py, pz,
          yaw:       rng() * Math.PI * 2,   // random facing while grounded
          peckFreq:  lerp(rng, PECK_FREQ_MIN, PECK_FREQ_MAX),
          peckPhase: rng() * Math.PI * 2,
          scale:     lerp(rng, PIGEON_SCALE_MIN, PIGEON_SCALE_MAX),
          fleeing:   false,
          fleeT0:    0,
          fleeVx:    0, fleeVy: 0, fleeVz: 0,
        });
      }
    }
    this._tiles.set(key, { gx, gz });
    this._rebuildStaticAttrs();
  }

  _unloadTile(key) {
    for (let i = this._pigeons.length - 1; i >= 0; i--) {
      if (this._pigeons[i].tileKey !== key) continue;
      const last = this._pigeons.pop();
      if (i < this._pigeons.length) this._pigeons[i] = last;
    }
    this._tiles.delete(key);
    this._pendingTiles.delete(key);
    this._rebuildStaticAttrs();
  }

  // Writes attrs that don't change frame-to-frame (scale, phase, peckFreq).
  // The per-frame mutable attrs (pos, yaw, state) are overwritten in update().
  _rebuildStaticAttrs() {
    const sc = this._instanceScale.array;
    const ph = this._instancePhase.array;
    const pf = this._instancePeckFreq.array;
    const n  = this._pigeons.length;
    for (let i = 0; i < n; i++) {
      const p = this._pigeons[i];
      sc[i] = p.scale;
      ph[i] = p.peckPhase;
      pf[i] = p.peckFreq;
    }
    this._geo.instanceCount = n;
    this._instanceScale.needsUpdate    = true;
    this._instancePhase.needsUpdate    = true;
    this._instancePeckFreq.needsUpdate = true;
  }

  _computeFleeVel(p, camX, camZ) {
    // Direction away from the camera in XZ, with a small angle jitter so a
    // flock fans out instead of fleeing as one tight line.
    const dx = p.px - camX;
    const dz = p.pz - camZ;
    const len = Math.hypot(dx, dz);
    let dirX, dirZ;
    if (len < 1e-3) {
      const ang = Math.random() * Math.PI * 2;
      dirX = Math.cos(ang);
      dirZ = Math.sin(ang);
    } else {
      dirX = dx / len;
      dirZ = dz / len;
    }
    const jitter = (Math.random() - 0.5) * FLEE_JITTER_RAD;
    const cs = Math.cos(jitter), sn = Math.sin(jitter);
    const rx = dirX * cs - dirZ * sn;
    const rz = dirX * sn + dirZ * cs;
    const vxz = FLEE_VXZ_MIN + Math.random() * (FLEE_VXZ_MAX - FLEE_VXZ_MIN);
    p.fleeVx = rx * vxz;
    p.fleeVz = rz * vxz;
    p.fleeVy = FLEE_VY_MIN + Math.random() * (FLEE_VY_MAX - FLEE_VY_MIN);
  }

  _startFlee(p, timeSec, camX, camZ) {
    this._computeFleeVel(p, camX, camZ);
    p.fleeing = true;
    p.fleeT0  = timeSec;
    // Cascade: flock-mates lift off shortly after, so the whole group reacts
    // together rather than one bird at a time as the player wades through.
    for (const q of this._pigeons) {
      if (q === p || q.fleeing || q.flockId !== p.flockId) continue;
      this._computeFleeVel(q, camX, camZ);
      q.fleeing = true;
      q.fleeT0  = timeSec + CASCADE_DELAY_MIN + Math.random() * (CASCADE_DELAY_MAX - CASCADE_DELAY_MIN);
    }
  }

  // Swap-pop pigeon at index i, keeping every instance buffer in sync.
  _removeAt(i) {
    const n    = this._pigeons.length;
    const last = n - 1;
    if (i !== last) {
      this._pigeons[i] = this._pigeons[last];
      const pos = this._instancePos.array;
      const yaw = this._instanceYaw.array;
      const sc  = this._instanceScale.array;
      const st  = this._instanceState.array;
      const ph  = this._instancePhase.array;
      const pf  = this._instancePeckFreq.array;
      pos[i * 3]     = pos[last * 3];
      pos[i * 3 + 1] = pos[last * 3 + 1];
      pos[i * 3 + 2] = pos[last * 3 + 2];
      yaw[i] = yaw[last];
      sc[i]  = sc[last];
      st[i]  = st[last];
      ph[i]  = ph[last];
      pf[i]  = pf[last];
    }
    this._pigeons.pop();
    this._geo.instanceCount = this._pigeons.length;
    this._instancePos.needsUpdate      = true;
    this._instanceYaw.needsUpdate      = true;
    this._instanceScale.needsUpdate    = true;
    this._instanceState.needsUpdate    = true;
    this._instancePhase.needsUpdate    = true;
    this._instancePeckFreq.needsUpdate = true;
  }

  update(timeSec, camX, camZ) {
    this._mat.uniforms.uTime.value = timeSec;

    const pigeons = this._pigeons;
    if (pigeons.length === 0) return;

    const pos = this._instancePos.array;
    const yaw = this._instanceYaw.array;
    const st  = this._instanceState.array;
    const scareR2 = SCARE_RADIUS * SCARE_RADIUS;

    // Iterate backwards so mid-loop swap-pops (despawn on flee-complete) don't
    // skip the bird that gets moved into the freed slot.
    for (let i = pigeons.length - 1; i >= 0; i--) {
      const p = pigeons[i];

      if (!p.fleeing) {
        const dx = p.px - camX;
        const dz = p.pz - camZ;
        if (dx * dx + dz * dz < scareR2) {
          this._startFlee(p, timeSec, camX, camZ);
        }
      }

      if (p.fleeing) {
        const t = timeSec - p.fleeT0;
        if (t < 0) {
          // Cascade delay — still on the ground, still facing the random
          // grounded yaw. Peck-bob is handled by the shader.
          pos[i * 3]     = p.px;
          pos[i * 3 + 1] = p.py;
          pos[i * 3 + 2] = p.pz;
          yaw[i] = p.yaw;
          st[i]  = 0;
        } else if (t < FLEE_DURATION) {
          pos[i * 3]     = p.px + p.fleeVx * t;
          pos[i * 3 + 1] = p.py + p.fleeVy * t;
          pos[i * 3 + 2] = p.pz + p.fleeVz * t;
          // Mesh faces +Z by default, so atan2(x, z) gives the yaw that
          // points +Z toward the flee velocity.
          yaw[i] = Math.atan2(p.fleeVx, p.fleeVz);
          st[i]  = 1;
        } else {
          this._removeAt(i);
          continue;
        }
      } else {
        pos[i * 3]     = p.px;
        pos[i * 3 + 1] = p.py;
        pos[i * 3 + 2] = p.pz;
        yaw[i] = p.yaw;
        st[i]  = 0;
      }
    }
    this._instancePos.needsUpdate   = true;
    this._instanceYaw.needsUpdate   = true;
    this._instanceState.needsUpdate = true;
  }
}
