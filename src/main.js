import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GRID_SIZE } from './loadCityGML.js';
import { TileManager } from './TileManager.js';
import { OsmManager } from './OsmManager.js';
import { paintStore } from './paintStore.js';
import { initMinimap, updateMinimap } from './minimap.js';

// ─── Scene ───────────────────────────────────────────────────────────────────

const canvas = document.createElement('canvas');
document.body.prepend(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ab8d4);
scene.fog = new THREE.FogExp2(0x9ab8d4, 0.003);

const camera = new THREE.PerspectiveCamera(100, window.innerWidth / window.innerHeight, 0.5, 2000);
camera.position.set(2215, 1.7, -5928); // Times Square (42nd St & 7th Ave)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Lights ───────────────────────────────────────────────────────────────────

scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const sun = new THREE.DirectionalLight(0xfff8e7, 1.8);
sun.position.set(150, 300, 100);
sun.castShadow = false;
scene.add(sun);

// ─── Ground ───────────────────────────────────────────────────────────────────

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20000, 20000),
  new THREE.MeshLambertMaterial({ color: 0x444440 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(2215, 0, -5928); // centered on spawn area
ground.receiveShadow = false;
scene.add(ground);

// ─── State ────────────────────────────────────────────────────────────────────

// All meshes that can be collided with (populated as buildings load)
const collidables = [ground];   // ground always included
const buildingMeshes = [];      // buildings only (for wall collision)

// ─── Culling ──────────────────────────────────────────────────────────────────

const CULL_RADIUS = 200; // metres — buildings beyond this are hidden and skipped in raycasts

// Filtered views rebuilt by updateCulling() whenever the player moves enough.
let nearBuildingMeshes = [];
let nearCollidables    = [ground];

let _cullX = NaN, _cullZ = NaN;

function updateCulling() {
  const px = camera.position.x, pz = camera.position.z;
  _cullX = px; _cullZ = pz;
  const r2 = CULL_RADIUS * CULL_RADIUS;
  nearBuildingMeshes = [];
  for (const mesh of buildingMeshes) {
    const c = mesh.userData.center;
    const near = (c.x - px) ** 2 + (c.z - pz) ** 2 < r2;
    mesh.visible = near;
    if (near) nearBuildingMeshes.push(mesh);

    // Cull paint overlay meshes for this building.
    const paintSet = buildingPaintMeshByBuilding.get(`${mesh.userData.buildingId}:${mesh.userData.meshType}`);
    if (paintSet) for (const paintMesh of paintSet) paintMesh.visible = near;
  }
  nearCollidables = [ground, ...nearBuildingMeshes];
}

// Only re-cull when the player has moved at least this far (metres).
const CULL_HYSTERESIS = 10;

function maybeCull() {
  const dx = camera.position.x - _cullX, dz = camera.position.z - _cullZ;
  if (dx * dx + dz * dz >= CULL_HYSTERESIS ** 2) updateCulling();
}

let isFlying    = false;
let lastSpaceTap = 0;
const DOUBLE_TAP_MS = 280;

const WALK_HEIGHT   = 3.0;  // eye height above surface
const WALK_SPEED    = 8;
const SPRINT_SPEED  = 24;
const FLY_SPEED     = 22;
const FLY_VERT      = 14;
const PLAYER_RADIUS = 1.8;  // keep walls this far out so tilted view doesn't clip in
const GRAVITY       = 22;   // m/s²
const TERMINAL_VEL  = -50;

let velY = 0;

// ─── Controls ─────────────────────────────────────────────────────────────────

const controls = new PointerLockControls(camera, renderer.domElement);

const overlay     = document.getElementById('overlay');
const crosshair   = document.getElementById('crosshair');
const hud         = document.getElementById('hud');
const randomBtn   = document.getElementById('minimap-random');
initMinimap();

randomBtn.addEventListener('click', () => {
  if (!firstTileLoaded || teleporting) return;
  const loc = tileManager.randomLocation();
  if (!loc) return;
  camera.position.set(loc.x, WALK_HEIGHT, loc.z);
  velY = 0;
  updateCulling();

  // Mirror the first-page-load experience: unlock pointer, show the dimmed
  // "loading" overlay, and wait for nearby tiles to finish loading before
  // letting the user click in.
  teleporting = true;
  overlay.classList.add('loading');
  status.textContent = 'Loading tiles…';
  randomBtn.disabled = true;
  colorPickMode = false;
  if (controls.isLocked) controls.unlock();
  else overlay.classList.remove('hidden');

  // Kick the tile manager now so any fresh loads are in-flight before the
  // next frame, and so we can detect the "nothing new to load" case (e.g.
  // teleport landed inside an already-loaded tile) and clear immediately.
  tileManager.tick(loc.x, loc.z);
  if (tileManager.allNearbyTilesLoaded(loc.x, loc.z)) finishTeleportLoad();
});

renderer.domElement.addEventListener('mousedown', e => {
  if (!controls.isLocked) { if (e.button === 0 && firstTileLoaded) { colorPickMode = false; controls.lock(); } return; }
  if (e.button === 0) tryPaint();
  if (e.button === 2) tryErase();
});
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
overlay.addEventListener('click', () => { if (firstTileLoaded && !teleporting) controls.lock(); });

controls.addEventListener('lock', () => {
  overlay.classList.add('hidden');
  crosshair.classList.add('visible');
});
controls.addEventListener('unlock', () => {
  crosshair.classList.remove('visible');
  // Press-C flow hides the overlay so only the colorbar is visible. ESC leaves
  // colorPickMode false and shows the full overlay, but the colorbar + minimap
  // button remain clickable above it either way.
  if (!colorPickMode) overlay.classList.remove('hidden');
});

const keys = {};

document.addEventListener('keydown', e => {
  // Let Ctrl/Cmd combos pass through untouched — close tab, reload, copy,
  // devtools, etc. We don't use Ctrl or Meta for any in-game action, so
  // short-circuiting here is safe. Keyup still processes normally, otherwise
  // a key pressed before Ctrl would get stuck when released while Ctrl holds.
  if (e.ctrlKey || e.metaKey) return;

  const wasDown = keys[e.code];
  keys[e.code] = true;

  // Only count the first keydown event (not auto-repeat) as a tap
  if (e.code === 'Space' && controls.isLocked && !wasDown) {
    e.preventDefault();
    const now = performance.now();
    if (now - lastSpaceTap < DOUBLE_TAP_MS) {
      isFlying = !isFlying;
      if (!isFlying) velY = 0; // start falling cleanly when leaving fly mode
    }
    lastSpaceTap = now;
  }

  if (e.code === 'Tab' && !e.repeat) {
    e.preventDefault();
    setActiveColor((activeColorIdx + 1) % COLORS.length);
  }

  if (e.code === 'KeyC' && controls.isLocked && !e.repeat) {
    colorPickMode = true;
    controls.unlock();
  }
});

document.addEventListener('keyup', e => { keys[e.code] = false; });

window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ─── Collision helpers ────────────────────────────────────────────────────────

const snapRay  = new THREE.Raycaster(); // reusable ray for safe-start checks
const wallRay  = new THREE.Raycaster();
const downRay  = new THREE.Raycaster();
const DOWN     = new THREE.Vector3(0, -1, 0);

// Returns true if moving `dist` m along `dir` from `origin` is clear of walls.
function wallClear(origin, dir, dist) {
  wallRay.set(origin, dir);
  wallRay.far = dist + PLAYER_RADIUS;
  const hits = wallRay.intersectObjects(nearBuildingMeshes, false);
  return hits.length === 0 || hits[0].distance > PLAYER_RADIUS;
}

// Check across the full body height so short ledges are caught too.
function canMoveAxis(pos, dir, dist) {
  for (let i = 0; i < WALL_Y_OFFSETS.length; i++) {
    _wallOrigins[i].set(pos.x, pos.y + WALL_Y_OFFSETS[i], pos.z);
    if (!wallClear(_wallOrigins[i], dir, dist)) return false;
  }
  return true;
}

// Cast a ray straight down from just above the player's feet.
// Returns the Y of the nearest surface below, or null if none within `maxDrop`.
function surfaceBelow(pos, maxDrop) {
  const origin = new THREE.Vector3(pos.x, pos.y - WALK_HEIGHT + 0.15, pos.z);
  downRay.set(origin, DOWN);
  downRay.far = maxDrop + 0.15;
  const hits = downRay.intersectObjects(nearCollidables, false);
  return hits.length > 0 ? hits[0].point.y : null;
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const COLORS = [
  { name: 'erase',       hex: null,       css: '#555',     isErase: true  },
  { name: 'white',       hex: 0xffffff,   css: '#ffffff'                  },
  { name: 'gray',        hex: 0x888888,   css: '#888888'                  },
  { name: 'black',       hex: 0x111111,   css: '#111111'                  },
  { name: 'red',         hex: 0xff2222,   css: '#ff2222'                  },
  { name: 'orange',      hex: 0xff8800,   css: '#ff8800'                  },
  { name: 'yellow',      hex: 0xffee00,   css: '#ffee00'                  },
  { name: 'yellowgreen', hex: 0x88cc00,   css: '#88cc00'                  },
  { name: 'green',       hex: 0x22cc44,   css: '#22cc44'                  },
  { name: 'teal',        hex: 0x00bbaa,   css: '#00bbaa'                  },
  { name: 'lightblue',   hex: 0x66ccff,   css: '#66ccff'                  },
  { name: 'blue',        hex: 0x2255ff,   css: '#2255ff'                  },
  { name: 'purple',      hex: 0x9933ff,   css: '#9933ff'                  },
  { name: 'pink',        hex: 0xff66bb,   css: '#ff66bb'                  },
  { name: 'brown',       hex: 0x885522,   css: '#885522'                  },
];
const SEED_COLORS = COLORS.filter(c => !c.isErase);
const SEED_COLOR_HEX = SEED_COLORS.map(c => c.hex); // flat hex array forwarded to the tile worker

let activeColorIdx = 4; // start on red
let colorPickMode  = false;

const colorBar = document.getElementById('colorbar');
const swatchEls = COLORS.map((c, i) => {
  const el = document.createElement('div');
  el.className = 'color-swatch' + (i === activeColorIdx ? ' active' : '');
  el.title = c.name;
  el.style.background = c.css;
  if (c.isErase) el.textContent = '✕';
  el.addEventListener('click', () => {
    setActiveColor(i);
    colorPickMode = false;
    controls.lock();
  });
  colorBar.appendChild(el);
  return el;
});

function setActiveColor(i) {
  swatchEls[activeColorIdx].classList.remove('active');
  activeColorIdx = i;
  swatchEls[activeColorIdx].classList.add('active');
}

// ─── Paint ────────────────────────────────────────────────────────────────────

const PAINT_DIST = 15;    // max reach in metres
const SMALL_CELL_AREA = GRID_SIZE ** 2  * 0.15;  // 1/10 of a cell — slivers smaller than this merge with their largest neighbor

const paintRay          = new THREE.Raycaster();
const paintGroup        = new THREE.Group();
const buildingPaintMeshes         = new Map(); // "buildingId:meshType|color" → mesh
const buildingPaintMeshByBuilding = new Map(); // "buildingId:meshType" → Set<mesh>
const pendingRebuild    = new Set();   // buildingKeys awaiting rebuild
scene.add(paintGroup);

function schedulePaintRebuild(buildingKey) {
  if (pendingRebuild.size === 0) requestAnimationFrame(flushPaintRebuilds);
  pendingRebuild.add(buildingKey);
}

function flushPaintRebuilds() {
  const t = performance.now();
  for (const bk of pendingRebuild) {
    const srcMesh = buildingMeshMap.get(bk);
    if (srcMesh) rebuildBuildingPaint(srcMesh);
  }
  pendingRebuild.clear();
  performance.measure('paint:rebuild', { start: t, end: performance.now() });
}

// ── Geometry helpers (plain arrays, no THREE allocation) ──────────────────────

function cross3(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function dot3(a, b)  { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function sub3(a, b)  { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function lerp3(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]), a[2]+t*(b[2]-a[2])]; }
function lerp2(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])]; }
function norm3(v)    { const l = Math.sqrt(dot3(v,v)); return l ? [v[0]/l,v[1]/l,v[2]/l] : v; }

function geomArea(verts) {
  let area = 0;
  for (let i = 0; i < verts.length; i += 9) {
    const ex = verts[i+3]-verts[i],   ey = verts[i+4]-verts[i+1], ez = verts[i+5]-verts[i+2];
    const fx = verts[i+6]-verts[i],   fy = verts[i+7]-verts[i+1], fz = verts[i+8]-verts[i+2];
    area += 0.5 * Math.sqrt((ey*fz-ez*fy)**2 + (ez*fx-ex*fz)**2 + (ex*fy-ey*fx)**2);
  }
  return area;
}

// Sutherland-Hodgman clip against one half-plane in UV space.
// axisIdx: 0=U, 1=V  sign: +1 → keep where axis>=value, -1 → keep where axis<=value
function clipHalfPlane(poly, axisIdx, value, sign) {
  if (!poly.length) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i], next = poly[(i + 1) % poly.length];
    const cv = curr.uv[axisIdx], nv = next.uv[axisIdx];
    const cIn = sign > 0 ? cv >= value : cv <= value;
    const nIn = sign > 0 ? nv >= value : nv <= value;
    if (cIn) out.push(curr);
    if (cIn !== nIn) {
      const t = (value - cv) / (nv - cv);
      out.push({ pos: lerp3(curr.pos, next.pos, t), uv: lerp2(curr.uv, next.uv, t) });
    }
  }
  return out;
}

/**
 * Clip srcMesh geometry to the UV cell [cellU, cellU+1] × [cellV, cellV+1].
 * Two filters reject triangles from unrelated faces:
 *   1. Normal direction — dot product with cellNormal must be > 0.7 (rejects perpendicular/opposite walls)
 *   2. Depth — triangle centroid must be within COPLANAR_TOL of the hit plane dot(p, n) = planeD
 *      (rejects parallel faces that are set back, e.g. ledges/steps behind the clicked surface)
 * Returns flat vertex array (x,y,z triples), offset 5 cm along cellNormal.
 */
function buildCellGeometry(srcMesh, cellU, cellV, cellNormal, planeD) {
  const pos = srcMesh.geometry.attributes.position.array;
  const uv  = srcMesh.geometry.attributes.uv.array;
  const verts = [];
  const OFFSET        = 0.025;
  const COPLANAR_TOL  = 0.15; // 15 cm — rejects steps/ledges, accepts tessellation seams
  const cn = [cellNormal.x, cellNormal.y, cellNormal.z];

  for (let ti = 0; ti < pos.length / 9; ti++) {
    const pi = ti * 9, ui = ti * 6;

    const tri = [
      { pos: [pos[pi],   pos[pi+1], pos[pi+2]], uv: [uv[ui],   uv[ui+1]] },
      { pos: [pos[pi+3], pos[pi+4], pos[pi+5]], uv: [uv[ui+2], uv[ui+3]] },
      { pos: [pos[pi+6], pos[pi+7], pos[pi+8]], uv: [uv[ui+4], uv[ui+5]] },
    ];

    // Quick UV bounding-box reject
    const us = [tri[0].uv[0], tri[1].uv[0], tri[2].uv[0]];
    const vs = [tri[0].uv[1], tri[1].uv[1], tri[2].uv[1]];
    if (Math.max(...us) < cellU || Math.min(...us) > cellU + 1) continue;
    if (Math.max(...vs) < cellV || Math.min(...vs) > cellV + 1) continue;

    // Reject triangles whose normal doesn't match the clicked face
    const triNorm = norm3(cross3(sub3(tri[1].pos, tri[0].pos), sub3(tri[2].pos, tri[0].pos)));
    if (dot3(triNorm, cn) < 0.7) continue;

    // Reject triangles set back from the clicked surface (parallel faces at different depth)
    const cx = (tri[0].pos[0] + tri[1].pos[0] + tri[2].pos[0]) / 3;
    const cy = (tri[0].pos[1] + tri[1].pos[1] + tri[2].pos[1]) / 3;
    const cz = (tri[0].pos[2] + tri[1].pos[2] + tri[2].pos[2]) / 3;
    if (Math.abs(cx*cn[0] + cy*cn[1] + cz*cn[2] - planeD) > COPLANAR_TOL) continue;

    // Clip polygon to cell bounds
    let poly = tri;
    poly = clipHalfPlane(poly, 0, cellU,     +1);
    poly = clipHalfPlane(poly, 0, cellU + 1, -1);
    poly = clipHalfPlane(poly, 1, cellV,     +1);
    poly = clipHalfPlane(poly, 1, cellV + 1, -1);
    if (poly.length < 3) continue;

    // Fan-triangulate and offset along normal
    for (let k = 1; k < poly.length - 1; k++) {
      for (const v of [poly[0], poly[k], poly[k+1]]) {
        verts.push(v.pos[0] + cn[0]*OFFSET, v.pos[1] + cn[1]*OFFSET, v.pos[2] + cn[2]*OFFSET);
      }
    }
  }
  return verts;
}

// ── Per-building merged paint mesh ────────────────────────────────────────────
//
// cellGeomCache: cellKey → Float32Array of pre-offset vertex triples.
// Populated by seedAllCells (single-pass scan) and lazily by rebuildBuildingPaint
// for user-painted cells. Rebuilds just concatenate cached arrays — no triangle
// scan needed after initial load, so paint/erase is instant.

const cellGeomCache     = new Map(); // cellKey → Float32Array
const cellGeomByBuilding = new Map(); // buildingKey → Set<cellKey> — so unloads don't scan the whole cache

function rebuildBuildingPaint(srcMesh) {
  const { buildingId, meshType } = srcMesh.userData;
  const buildingKey = `${buildingId}:${meshType}`;
  const prefix = buildingKey + ':';

  // Remove all existing paint meshes for this building
  const toDelete = [];
  for (const k of buildingPaintMeshes.keys()) {
    if (k.startsWith(buildingKey + '|')) toDelete.push(k);
  }
  for (const k of toDelete) {
    const m = buildingPaintMeshes.get(k);
    m.geometry.dispose(); m.material.dispose();
    paintGroup.remove(m);
    buildingPaintMeshes.delete(k);
  }
  buildingPaintMeshByBuilding.delete(buildingKey);

  // Group cell geometry arrays by color. Iterate only this building's cells
  // via the paintStore index — avoids a full map scan when tens of thousands
  // of cells are seeded across other buildings.
  const byColor = new Map(); // colorHex → Float32Array[]

  for (const k of paintStore.cellsForBuilding(buildingKey)) {
    const v = paintStore.cells.get(k);
    if (!v) continue;

    if (!cellGeomCache.has(k)) {
      const parts = k.slice(prefix.length).split(':');
      const cu = parseInt(parts[0]), cv = parseInt(parts[1]);
      const verts = buildCellGeometry(srcMesh, cu, cv, new THREE.Vector3(...v.normal), v.planeD);
      cellGeomCache.set(k, new Float32Array(verts));
      let geomSet = cellGeomByBuilding.get(buildingKey);
      if (!geomSet) { geomSet = new Set(); cellGeomByBuilding.set(buildingKey, geomSet); }
      geomSet.add(k);
    }

    const arr = cellGeomCache.get(k);
    if (!arr.length) continue;

    const c = v.color;
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(arr);
  }

  for (const [colorHex, arrays] of byColor) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const allVerts = new Float32Array(total);
    let off = 0;
    for (const a of arrays) { allVerts.set(a, off); off += a.length; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(allVerts, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide }));
    mesh.visible = srcMesh.visible;
    const pmKey = `${buildingKey}|${colorHex}`;
    mesh.userData.paintMeshKey = pmKey; // stashed so TileManager._unload can delete by lookup
    paintGroup.add(mesh);
    buildingPaintMeshes.set(pmKey, mesh);
    if (!buildingPaintMeshByBuilding.has(buildingKey)) buildingPaintMeshByBuilding.set(buildingKey, new Set());
    buildingPaintMeshByBuilding.get(buildingKey).add(mesh);
  }
}

// When any cell changes, schedule a rebuild for its building (debounced to one per frame).
paintStore.subscribe((cellKey) => {
  const parts = cellKey.split(':');
  parts.pop(); parts.pop(); parts.pop(); // drop pdKey, cellV, cellU
  schedulePaintRebuild(parts.join(':'));
});

const SEED_FRACTION = 0.2; // fraction of cells to randomly seed on load (applied in tileWorker.js)

// Apply the worker's pre-computed cell data to paint caches. The triangle scan
// + clipping + seed dice roll all happened off-thread; this pass just copies
// Float32Arrays into cellGeomCache and calls paintStore.seed for cells that
// aren't already user-painted. Still chunked so a giant tile doesn't push
// rebuildBuildingPaint calls into one frame.
async function seedTileCells(meshes) {
  const SEED_CHUNK = 50;
  const now        = Date.now();
  const tSeed      = performance.now();

  for (let start = 0; start < meshes.length; start += SEED_CHUNK) {
    const end = Math.min(start + SEED_CHUNK, meshes.length);

    for (let mi = start; mi < end; mi++) {
      const srcMesh = meshes[mi];
      if (!srcMesh.parent) continue; // tile was unloaded before we got here

      const cellData = srcMesh.userData.cellData;
      if (!cellData) continue; // already applied, or wrapped without worker data

      const { buildingId, meshType } = srcMesh.userData;
      const bk = `${buildingId}:${meshType}`;

      let geomSet = cellGeomByBuilding.get(bk);
      if (!geomSet) { geomSet = new Set(); cellGeomByBuilding.set(bk, geomSet); }

      const { cellKeys, cellGeoms, seeds } = cellData;
      for (let i = 0; i < cellKeys.length; i++) {
        cellGeomCache.set(cellKeys[i], cellGeoms[i]);
        geomSet.add(cellKeys[i]);
      }

      for (const s of seeds) {
        const cellKey = cellKeys[s.idx];
        if (paintStore.cells.has(cellKey)) continue; // preserve existing (user or prior-session seed)
        paintStore.seed(cellKey, {
          color:     s.color,
          normal:    s.normal,
          planeD:    s.planeD,
          paintedAt: now,
        });
      }

      // Free the bundle — its Float32Arrays now live in cellGeomCache.
      srcMesh.userData.cellData = null;

      rebuildBuildingPaint(srcMesh);
    }

    if (end < meshes.length) await new Promise(r => requestIdleCallback(r, { timeout: 2000 }));
  }

  performance.measure('tile:seed', { start: tSeed, end: performance.now() });
}

// ── Paint / erase actions ─────────────────────────────────────────────────────

function hitCell() {
  paintRay.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = paintRay.intersectObjects(nearBuildingMeshes, false);
  if (!hits.length || hits[0].distance > PAINT_DIST || !hits[0].uv) return null;
  const hit    = hits[0];
  const mesh   = hit.object;
  const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
  return {
    cellU:  Math.floor(hit.uv.x),
    cellV:  Math.floor(hit.uv.y),
    normal,
    planeD: normal.dot(hit.point), // signed distance of hit surface from origin along normal
    mesh,
  };
}

const NEIGHBORS = [[1,0],[-1,0],[0,1],[0,-1]];

/**
 * Resolves the full group of cell keys that should be painted/erased together.
 *
 * Algorithm:
 * 1. Find the canonical (non-sliver) root for the clicked cell by following
 *    the chain: each sliver points to its largest neighbor, transitively.
 * 2. BFS outward through adjacent slivers, including a sliver only if its
 *    own canonical root matches the group's canonical root.
 *
 * This gives disjoint groups (C and D don't cross-contaminate) and handles
 * chains of slivers (E←F←H all collapse to E's group).
 */
function resolveGroup(h) {
  const { buildingId, meshType } = h.mesh.userData;
  const pd = Math.round(h.planeD * 2); // 50 cm buckets — wide enough to match seed-scan keys on non-planar geometry
  const key = (cu, cv) => `${buildingId}:${meshType}:${cu}:${cv}:${pd}`;
  const areaCache = new Map();
  const getArea = (cu, cv) => {
    const k = `${cu},${cv}`;
    if (!areaCache.has(k)) {
      // Use pre-clipped geometry from the seed-scan cache when available — avoids
      // a full triangle scan for every neighbour cell during BFS.
      const cacheKey = key(cu, cv);
      const cached = cellGeomCache.get(cacheKey);
      const area = cached
        ? geomArea(cached)
        : geomArea(buildCellGeometry(h.mesh, cu, cv, h.normal, h.planeD));
      areaCache.set(k, area);
    }
    return areaCache.get(k);
  };

  // Follow the chain of "largest neighbor" until we reach a non-sliver cell.
  function findCanonical(cu, cv, seen = new Set()) {
    const k = `${cu},${cv}`;
    if (seen.has(k)) return [cu, cv];
    seen.add(k);
    if (getArea(cu, cv) >= SMALL_CELL_AREA) return [cu, cv];
    let bestU = cu, bestV = cv, best = getArea(cu, cv);
    for (const [du, dv] of NEIGHBORS) {
      const a = getArea(cu+du, cv+dv);
      if (a > best) { best = a; bestU = cu+du; bestV = cv+dv; }
    }
    if (bestU === cu && bestV === cv) return [cu, cv]; // no bigger neighbor
    return findCanonical(bestU, bestV, seen);
  }

  const [canonU, canonV] = findCanonical(h.cellU, h.cellV);
  const group = new Set([key(canonU, canonV)]);

  // BFS through adjacent slivers, keeping only those whose canonical matches.
  const bfsVisited = new Set([`${canonU},${canonV}`]);
  const queue = [[canonU, canonV]];
  while (queue.length > 0) {
    const [cu, cv] = queue.shift();
    for (const [du, dv] of NEIGHBORS) {
      const nu = cu+du, nv = cv+dv;
      const nk = `${nu},${nv}`;
      if (bfsVisited.has(nk)) continue;
      bfsVisited.add(nk);
      if (getArea(nu, nv) >= SMALL_CELL_AREA) continue; // not a sliver
      const [scU, scV] = findCanonical(nu, nv);
      if (scU === canonU && scV === canonV) {
        group.add(key(nu, nv));
        queue.push([nu, nv]); // explore this sliver's neighbors too
      }
    }
  }
  return group;
}

function tryPaint() {
  const activeColor = COLORS[activeColorIdx];
  if (activeColor.isErase) { tryErase(); return; }
  const h = hitCell();
  if (!h) return;
  const { buildingId, meshType } = h.mesh.userData;
  const cellData = { color: activeColor.hex, normal: h.normal.toArray(), planeD: h.planeD, paintedAt: Date.now() };
  const pd = Math.round(h.planeD * 2);
  const mainKey = `${buildingId}:${meshType}:${h.cellU}:${h.cellV}:${pd}`;

  // Paint the primary cell immediately so it appears this frame.
  paintStore.paint(mainKey, cellData);

  // Resolve adjacent slivers off the critical path — runs after the frame renders.
  setTimeout(() => {
    try {
      const group = resolveGroup(h);
      group.delete(mainKey);
      if (group.size) paintStore.paintBatch([...group].map(k => [k, cellData]));
    } catch (e) { console.warn('resolveGroup:', e); }
  }, 0);
}

function tryErase() {
  const h = hitCell();
  if (!h) return;
  const { buildingId, meshType } = h.mesh.userData;
  const pd = Math.round(h.planeD * 2);
  const mainKey = `${buildingId}:${meshType}:${h.cellU}:${h.cellV}:${pd}`;

  // Erase the primary cell immediately.
  paintStore.erase(mainKey);

  // Resolve and erase adjacent slivers off the critical path.
  setTimeout(() => {
    try {
      const group = resolveGroup(h);
      group.delete(mainKey);
      if (group.size) paintStore.eraseBatch([...group]);
    } catch (e) { console.warn('resolveGroup:', e); }
  }, 0);
}

// ─── Movement ─────────────────────────────────────────────────────────────────

let lastTime = performance.now();

const _fwd  = new THREE.Vector3();
const _right = new THREE.Vector3();
const _xDir  = new THREE.Vector3();
const _zDir  = new THREE.Vector3();

// Y offsets from camera (eye) position that we cast horizontal rays at.
// Spans the full body: eye → near-feet, so short ledges are caught.
const WALL_Y_OFFSETS = [0, -0.9, -1.8, -(WALK_HEIGHT - 0.15)];
const _wallOrigins   = WALL_Y_OFFSETS.map(() => new THREE.Vector3());

const _PUSH_DIRS = [
  new THREE.Vector3( 1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3( 0, 0, 1),
  new THREE.Vector3( 0, 0,-1),
];

function updateMovement() {
  const now = performance.now();
  const dt  = Math.min((now - lastTime) / 1000, 0.05);
  lastTime  = now;

  if (!controls.isLocked) return;

  // ── Horizontal ──────────────────────────────────────────────────────────────

  const flyBoost = isFlying && keys['KeyQ'] ? 3 : 1;
  const speed = isFlying
    ? FLY_SPEED * flyBoost
    : (keys['ShiftLeft'] || keys['ShiftRight'] ? SPRINT_SPEED : WALK_SPEED);

  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  _fwd.normalize();

  // right = cross(fwd, up) = (-fwd.z, 0, fwd.x)
  _right.set(-_fwd.z, 0, _fwd.x);

  let dx = 0, dz = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    { dx += _fwd.x;   dz += _fwd.z; }
  if (keys['KeyS'] || keys['ArrowDown'])  { dx -= _fwd.x;   dz -= _fwd.z; }
  if (keys['KeyA'] || keys['ArrowLeft'])  { dx -= _right.x; dz -= _right.z; }
  if (keys['KeyD'] || keys['ArrowRight']) { dx += _right.x; dz += _right.z; }

  const hLen = Math.sqrt(dx * dx + dz * dz);
  if (hLen > 0) {
    dx = (dx / hLen) * speed * dt;
    dz = (dz / hLen) * speed * dt;
  }

  // Axis-separated wall collision (allows wall-sliding)
  if (Math.abs(dx) > 0.0001) {
    _xDir.set(Math.sign(dx), 0, 0);
    if (canMoveAxis(camera.position, _xDir, Math.abs(dx))) camera.position.x += dx;
  }
  if (Math.abs(dz) > 0.0001) {
    _zDir.set(0, 0, Math.sign(dz));
    if (canMoveAxis(camera.position, _zDir, Math.abs(dz))) camera.position.z += dz;
  }

  // Push out of any wall the player has sunk into (e.g. after descending into geometry)
  for (const dir of _PUSH_DIRS) {
    for (let i = 0; i < WALL_Y_OFFSETS.length; i++) {
      _wallOrigins[i].set(camera.position.x, camera.position.y + WALL_Y_OFFSETS[i], camera.position.z);
      wallRay.set(_wallOrigins[i], dir);
      wallRay.far = PLAYER_RADIUS;
      const hits = wallRay.intersectObjects(nearBuildingMeshes, false);
      if (hits.length > 0 && hits[0].distance < PLAYER_RADIUS) {
        camera.position.addScaledVector(dir, hits[0].distance - PLAYER_RADIUS);
        break;
      }
    }
  }

  // ── Vertical ────────────────────────────────────────────────────────────────

  if (isFlying) {
    velY = 0;
    // Space: ascend freely (intentionally allows clipping through ceilings to escape buildings)
    if (keys['Space']) camera.position.y += FLY_VERT * flyBoost * dt;
    // Shift: descend, but block at any surface below (including ground)
    if (keys['ShiftLeft'] || keys['ShiftRight']) {
      const dy = FLY_VERT * flyBoost * dt;
      const footOrigin = new THREE.Vector3(camera.position.x, camera.position.y - WALK_HEIGHT + 0.05, camera.position.z);
      downRay.set(footOrigin, DOWN);
      downRay.far = dy + 0.1;
      const hits = downRay.intersectObjects(nearCollidables, false);
      if (hits.length === 0 || hits[0].distance > dy) camera.position.y -= dy;
    }
    camera.position.y = Math.max(WALK_HEIGHT, camera.position.y);
  } else {
    // Gravity
    velY = Math.max(velY - GRAVITY * dt, TERMINAL_VEL);
    const dY = velY * dt;

    if (dY < 0) {
      // Falling — look for a surface within this frame's drop distance
      const surf = surfaceBelow(camera.position, Math.abs(dY));
      if (surf !== null) {
        // Land (or stay grounded)
        camera.position.y = surf + WALK_HEIGHT;
        velY = 0;
      } else {
        camera.position.y += dY;
        // Hard floor fallback
        if (camera.position.y < WALK_HEIGHT) {
          camera.position.y = WALK_HEIGHT;
          velY = 0;
        }
      }
    }
    // (No upward velocity in walk mode — no jump yet)
  }

  // ── HUD ─────────────────────────────────────────────────────────────────────
  hud.textContent = isFlying
    ? 'Financial District, NYC  ✦ flying'
    : 'Financial District, NYC';
}

// ─── Buildings ────────────────────────────────────────────────────────────────

const status = document.getElementById('status');

// Maps "buildingId:meshType" → mesh so paint overlays can look up source geometry.
const buildingMeshMap = new Map();


// Returns true if the XZ position has clearance in all 8 horizontal directions.
function positionIsClear(x, z) {
  const pos = new THREE.Vector3(x, WALK_HEIGHT, z);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    snapRay.set(pos, new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
    snapRay.far = PLAYER_RADIUS + 0.1;
    if (snapRay.intersectObjects(nearBuildingMeshes, false).length > 0) return false;
  }
  return true;
}

// After buildings load, make sure the camera isn't spawned inside one.
// Tries expanding rings of candidate positions until a clear spot is found.
function snapToSafeStart() {
  const cx = camera.position.x, cz = camera.position.z;
  if (positionIsClear(cx, cz)) return;

  for (let r = 5; r <= 100; r += 5) {
    const steps = Math.max(8, Math.round(r * 1.2));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(angle) * r;
      const z = cz + Math.sin(angle) * r;
      if (positionIsClear(x, z)) {
        camera.position.set(x, WALK_HEIGHT, z);
        return;
      }
    }
  }
}

// ─── Tile manager ─────────────────────────────────────────────────────────────

let firstTileLoaded = false;
let tilesLoadedCount = 0;
const TILES_NEEDED = 4;

// Teleport loading state — the random-location button re-enters the same
// "Loading tiles…" overlay as the initial page load, cleared when every
// tile in load range of the new position has finished loading.
let teleporting = false;

function finishTeleportLoad() {
  if (!teleporting) return;
  teleporting = false;
  overlay.classList.remove('loading');
  randomBtn.disabled = false;
  snapToSafeStart();
  setTimeout(() => { status.textContent = ''; }, 3000);
}

const tileManager = new TileManager({
  scene,
  buildingMeshes,
  collidables,
  buildingMeshMap,
  cellGeomCache,
  cellGeomByBuilding,
  buildingPaintMeshes,
  buildingPaintMeshByBuilding,
  paintGroup,
  seedConfig: { fraction: SEED_FRACTION, colors: SEED_COLOR_HEX },
  onTileLoaded(meshes) {
    // Phase 1 — buildings are visible now. The spawn gate opens here so the
    // player can start interacting before the seed scan (phase 2) finishes.
    updateCulling();
    tilesLoadedCount++;
    if (!firstTileLoaded && tilesLoadedCount >= TILES_NEEDED) {
      firstTileLoaded = true;
      overlay.classList.remove('loading');
      randomBtn.disabled = false;
      snapToSafeStart();
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
    if (teleporting && tileManager.allNearbyTilesLoaded(camera.position.x, camera.position.z)) {
      finishTeleportLoad();
    }
  },
  onTileCellData(meshes) {
    // Phase 2 — worker's seed scan result is now on mesh.userData.cellData.
    // Populate cellGeomCache and apply seeded paint.
    seedTileCells(meshes);
  },
  onTileUnloaded() {
    updateCulling();
  },
});

status.textContent = 'Loading buildings…';
tileManager.init('/tiles/manifest.json');

// OSM overlay — streets, water, and green spaces rendered as flat meshes on
// the ground. Loads its own tiles on the same 250 m grid as building tiles.
const osmManager = new OsmManager({ scene });
osmManager.init('/osm/manifest.json');

// ─── Render loop ──────────────────────────────────────────────────────────────

const _minimapDir = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  tileManager.tick(camera.position.x, camera.position.z);
  osmManager.tick(camera.position.x, camera.position.z);
  maybeCull();
  updateMovement();
  camera.getWorldDirection(_minimapDir);
  updateMinimap(camera.position.x, camera.position.z, Math.atan2(_minimapDir.x, -_minimapDir.z));
  renderer.render(scene, camera);
}

animate();
