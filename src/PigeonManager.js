import * as THREE from 'three';

// Grounded pigeon flocks. Each loaded cell rolls 0–2 flock anchors on open
// ground (deterministic per-cell RNG; anchors under a building roof are
// rejected). Each flock is 5–9 pigeons scattered in a small cluster, standing
// on the terrain with a subtle peck-bob.
//
// Rendering: one InstancedMesh of Y-axis-locked camera-facing quads — the
// sprite stays vertical in the world regardless of camera tilt, so pigeons
// don't swing around when you look down at them from flight. Single-frame
// front-view sprite, so it reads the same from every angle.

const CELL_SIZE     = 150;
const LOAD_RADIUS   = 200;
const UNLOAD_MARGIN =  60;

const MAX_PIGEONS = 512;

const FLOCK_CHANCES  = [0, 0, 1, 1, 2];  // 40/40/20 → 0/1/2 flocks per tile
const FLOCK_SIZE_MIN = 5;
const FLOCK_SIZE_MAX = 9;

const SCATTER_RADIUS = 2.5;   // metres — pigeon cluster radius around anchor
const BUILDING_CLEARANCE = 3; // metres — min gap (terrain → roof) for a point
                              // to count as "under a building" and be rejected

const PECK_FREQ_MIN = 0.3;    // Hz — peck-bob rate
const PECK_FREQ_MAX = 0.9;
const PECK_AMP      = 0.06;   // metres — head-bob amplitude

const PIGEON_SCALE_MIN = 0.55;  // metres; pigeon silhouette is ~0.6 of quad,
const PIGEON_SCALE_MAX = 0.75;  // so birds come out ~30–45 cm tall

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

function buildPigeonAtlas() {
  // Single 32×32 frame — front-view standing pigeon in the bottom half of
  // the quad so the feet sit at the quad's bottom edge (anchor-at-feet).
  const SIZE = 32;
  const canvas = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const PX = 2;
  const paint = (ax, ay) => ctx.fillRect(ax * PX, ay * PX, PX, PX);

  // Art grid 16×16; silhouette occupies rows 6–15.
  const BODY = [
                    [5, 9], [6, 9], [7, 9], [8, 9], [9, 9],
    [4, 10], [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10],
    [4, 11], [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11],
                    [5, 12], [6, 12], [7, 12], [8, 12], [9, 12],
                    [5, 13], [6, 13], [7, 13], [8, 13], [9, 13],
  ];
  const HEAD = [
    [6, 6], [7, 6], [8, 6],
    [6, 7], [7, 7], [8, 7],
  ];
  const EYES = [
    [6, 8], [8, 8],
  ];
  const LEGS = [
    [6, 14], [9, 14],
    [5, 15], [6, 15], [9, 15], [10, 15],   // feet spread
  ];

  ctx.fillStyle = '#555';
  for (const [x, y] of BODY) paint(x, y);
  ctx.fillStyle = '#3a3a3a';
  for (const [x, y] of HEAD) paint(x, y);
  ctx.fillStyle = '#222';
  for (const [x, y] of EYES) paint(x, y);
  ctx.fillStyle = '#d78';   // soft pink for feet — a small pop of colour
  for (const [x, y] of LEGS) paint(x, y);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const VERT = `
attribute vec3 instancePos;
attribute float instanceScale;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  // Y-axis-locked billboard: right axis = perpendicular to the horizontal
  // direction from sprite to camera. Keeps the sprite upright in the world
  // regardless of camera pitch — crucial for ground-standing creatures.
  vec3 anchor = instancePos;
  vec3 toCam  = cameraPosition - anchor;
  vec3 fwd    = vec3(toCam.x, 0.0, toCam.z);
  float lenF  = length(fwd);
  fwd = lenF > 1e-4 ? fwd / lenF : vec3(1.0, 0.0, 0.0);
  vec3 right  = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));

  // Quad bottom at anchor.y (anchor-at-feet so the pigeon stands on
  // whatever Y the CPU wrote).
  float sx = position.x * instanceScale;
  float sy = (position.y + 0.5) * instanceScale;
  vec3 world = anchor + right * sx + vec3(0.0, sy, 0.0);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  vUv = uv;

  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}
`;

const FRAG = `
uniform sampler2D uAtlas;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  if (c.a < 0.5) discard;
  gl_FragColor = c;
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

    const atlas = buildPigeonAtlas();

    this._mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uAtlas: { value: null } },
      ]),
      vertexShader:   VERT,
      fragmentShader: FRAG,
      fog:            true,
      transparent:    false,
      side:           THREE.DoubleSide,
    });
    this._mat.uniforms.uAtlas.value = atlas;

    const baseGeo = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index               = baseGeo.index;
    geo.attributes.position = baseGeo.attributes.position;
    geo.attributes.uv       = baseGeo.attributes.uv;

    this._instancePos   = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS * 3), 3);
    this._instanceScale = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIGEONS),     1);
    this._instancePos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instancePos',   this._instancePos);
    geo.setAttribute('instanceScale', this._instanceScale);
    geo.instanceCount = 0;

    this._geo  = geo;
    this._mesh = new THREE.Mesh(geo, this._mat);
    this._mesh.frustumCulled = false;
    scene.add(this._mesh);

    this._pigeons      = [];         // flat array; swap-pop on tile unload
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
          px, py, pz,
          peckFreq:  lerp(rng, PECK_FREQ_MIN, PECK_FREQ_MAX),
          peckPhase: rng() * Math.PI * 2,
          scale:     lerp(rng, PIGEON_SCALE_MIN, PIGEON_SCALE_MAX),
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

  _rebuildStaticAttrs() {
    const pos = this._instancePos.array;
    const sc  = this._instanceScale.array;
    const n   = this._pigeons.length;
    for (let i = 0; i < n; i++) {
      const p = this._pigeons[i];
      pos[i * 3]     = p.px;
      pos[i * 3 + 1] = p.py;
      pos[i * 3 + 2] = p.pz;
      sc[i]          = p.scale;
    }
    this._geo.instanceCount = n;
    this._instancePos.needsUpdate   = true;
    this._instanceScale.needsUpdate = true;
  }

  update(timeSec) {
    const pigeons = this._pigeons;
    const n = pigeons.length;
    if (n === 0) return;
    const pos = this._instancePos.array;
    for (let i = 0; i < n; i++) {
      const p = pigeons[i];
      // sin^8 is mostly 0 with brief spikes — reads as an occasional peck.
      const s = Math.sin(timeSec * p.peckFreq + p.peckPhase);
      const bob = Math.pow(Math.max(0, s), 8) * PECK_AMP;
      pos[i * 3 + 1] = p.py + bob;
    }
    this._instancePos.needsUpdate = true;
  }
}
