import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GRID_SIZE } from './loadCityGML.js';
import { TileManager } from './TileManager.js';
import { OsmManager } from './OsmManager.js';
import { TerrainManager } from './TerrainManager.js';
import { paintStore } from './paintStore.js';
import {
  initMinimap, updateMinimap, setMinimapSize,
  adjustMinimapZoom, adjustMinimapPan, resetMinimapPan,
  minimapMetersPerPixel, minimapPixelToWorld,
} from './minimap.js';

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
camera.position.set(2215, 1.7, -5928); // Times Square (42nd St & 7th Ave) — default spawn

// ─── Player state persistence ─────────────────────────────────────────────────
//
// Position, view rotation, and fly-mode are saved to localStorage on unload
// so a soft reload (Ctrl+R / F5) drops you back where you were. Ctrl+Shift+R
// flips a sessionStorage flag in the keydown handler before the browser
// handles the reload; we check that flag here and clear the save, so hard
// reload returns to the default spawn.

const PLAYER_STATE_KEY = 'graffiti_player_state_v1';
const PLAYER_RESET_KEY = 'graffiti_player_reset';

if (sessionStorage.getItem(PLAYER_RESET_KEY) === '1') {
  sessionStorage.removeItem(PLAYER_RESET_KEY);
  localStorage.removeItem(PLAYER_STATE_KEY);
}

const _savedPlayer = (() => {
  try {
    const raw = localStorage.getItem(PLAYER_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
})();

if (_savedPlayer) {
  camera.position.set(_savedPlayer.px, _savedPlayer.py, _savedPlayer.pz);
  camera.quaternion.set(_savedPlayer.qx, _savedPlayer.qy, _savedPlayer.qz, _savedPlayer.qw);
}

function savePlayerState() {
  try {
    localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
      px: camera.position.x, py: camera.position.y, pz: camera.position.z,
      qx: camera.quaternion.x, qy: camera.quaternion.y, qz: camera.quaternion.z, qw: camera.quaternion.w,
      flying: isFlying,
    }));
  } catch {}
}

window.addEventListener('beforeunload', savePlayerState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePlayerState();
});

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

// Terrain-on vs terrain-off switch. When terrain is enabled (default), the
// ground plane sits well below DEM water level (-1.34 m in NYC) so it never
// peeks through the terrain. When terrain is disabled (`npm run dev:flat`)
// the ground plane is the only floor, so it sits just below y=0 like
// pre-terrain — buildings have their bases shifted to y=0 in the worker and
// OSM overlays stack flat at Y_LAND etc.
const TERRAIN_ENABLED = import.meta.env.VITE_TERRAIN !== '0';
const FLOOR_Y = TERRAIN_ENABLED ? -5 : -0.1;

// The ground plane follows the player every frame — cheaper and more robust
// than making it arena-sized (which runs into depth precision issues at the
// horizon) and guarantees a floor exists wherever the random-teleport drops us.
// Cooler, greyer than the OSM LAND_MAT colour so the border between
// "inside 5-borough coverage" and "no OSM data here" is visible.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20000, 20000),
  new THREE.MeshLambertMaterial({ color: 0x9b9b9e }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, FLOOR_Y, 0);
ground.receiveShadow = false;
scene.add(ground);

// ─── State ────────────────────────────────────────────────────────────────────

// All meshes that can be collided with (populated as buildings load)
const collidables = [ground];   // ground always included
const buildingMeshes = [];      // buildings only (for wall collision)

// ─── Culling ──────────────────────────────────────────────────────────────────

// The cull radius tracks TileManager's effective load radius — there's no
// reason to render/raycast beyond what's actually loaded, and scaling them
// together keeps the visual edge consistent when sparsity widens the ring.
function cullRadius() { return tileManager.getLoadRadius(); }

// Filtered views rebuilt by updateCulling() whenever the player moves enough
// or the load radius shifts past CULL_HYSTERESIS.
let nearBuildingMeshes = [];
let nearCollidables    = [ground];

let _cullX = NaN, _cullZ = NaN;
let _cullR = 0;

function updateCulling() {
  const px = camera.position.x, pz = camera.position.z;
  _cullX = px; _cullZ = pz;
  _cullR = cullRadius();
  updateViewFalloff(_cullR);
  const r2 = _cullR * _cullR;
  nearBuildingMeshes = [];

  // Per-tile short-circuit: hide the tile's group when its AABB is entirely
  // outside the cull radius so the renderer doesn't walk each invisible mesh every
  // frame. Inside in-range tiles we still do per-building culling for the
  // partial-overlap case at the boundary.
  for (const tile of tileManager.tiles()) {
    const b = tile.bounds;
    const bx = Math.max(b.minX, Math.min(px, b.maxX));
    const bz = Math.max(b.minZ, Math.min(pz, b.maxZ));
    const tileInRange = (px - bx) ** 2 + (pz - bz) ** 2 < r2;
    tile.group.visible = tileInRange;
    if (!tileInRange) continue;

    for (const mesh of tile.meshes) {
      const c = mesh.userData.center;
      const near = (c.x - px) ** 2 + (c.z - pz) ** 2 < r2;
      mesh.visible = near;
      if (near) nearBuildingMeshes.push(mesh);

      // Each merged mesh covers both meshTypes; toggle paint overlays for all
      // buildingKeys it owns.
      for (const bk of mesh.userData.buildingKeys) {
        const paintSet = buildingPaintMeshByBuilding.get(bk);
        if (paintSet) for (const paintMesh of paintSet) paintMesh.visible = near;
      }
    }
  }
  nearCollidables = [ground, ...nearBuildingMeshes, ...terrainManager.meshes()];
}

// Only re-cull when the player has moved at least this far (metres).
const CULL_HYSTERESIS = 10;

function maybeCull() {
  const dx = camera.position.x - _cullX, dz = camera.position.z - _cullZ;
  const r = cullRadius();
  if (dx * dx + dz * dz >= CULL_HYSTERESIS ** 2 ||
      Math.abs(r - _cullR)  >= CULL_HYSTERESIS) {
    updateCulling();
  }
}

// Fog density and camera.far are tuned relative to BASE_RADIUS. Density
// scales inversely (less fog when the radius widens, so distant buildings
// stay visible) and far sits a short margin past the cull edge so we don't
// waste depth precision on geometry nothing will ever reach.
const BASE_RADIUS     = 200;
const BASE_FOG_DENSITY = 0.003;
const FAR_MARGIN       = 400;
function updateViewFalloff(r) {
  scene.fog.density = BASE_FOG_DENSITY * (BASE_RADIUS / Math.max(r, 1));
  camera.far        = r + FAR_MARGIN;
  camera.updateProjectionMatrix();
}

let isFlying    = _savedPlayer ? !!_savedPlayer.flying : false;
let lastSpaceTap = 0;
const DOUBLE_TAP_MS = 280;

const WALK_HEIGHT   = 3.0;  // eye height above surface
const MIN_EYE_Y     = FLOOR_Y + WALK_HEIGHT; // camera clamp when standing on the default floor (no building underfoot)
const WALK_SPEED    = 8;
const SPRINT_SPEED  = 24;
const FLY_SPEED     = 22;
const FLY_VERT      = 14;
const PLAYER_RADIUS = 1.5;  // body collision radius; also used as spawn clearance
const STEP_UP_HEIGHT = 0.4; // max lip the player auto-climbs when walking
const GRAVITY       = 22;   // m/s²
const TERMINAL_VEL  = -50;

let velY = 0;

// ─── Controls ─────────────────────────────────────────────────────────────────

// Drop pointer-lock mousemove spikes before PointerLockControls sees them.
// Chrome occasionally fires a mousemove with a huge delta after focus
// changes or OS cursor warps; stock controls multiply that straight into
// yaw/pitch and the view snaps wildly. A real human flick stays well under
// this threshold even on high-polling-rate mice.
const LOOK_SPIKE_PX = 200;
document.addEventListener('mousemove', (e) => {
  if (Math.abs(e.movementX) > LOOK_SPIKE_PX || Math.abs(e.movementY) > LOOK_SPIKE_PX) {
    e.stopImmediatePropagation();
  }
}, { capture: true });

const controls = new PointerLockControls(camera, renderer.domElement);

const overlay       = document.getElementById('overlay');
const overlayPrompt = document.getElementById('overlay-prompt');
const crosshair     = document.getElementById('crosshair');
const hud           = document.getElementById('hud');
const randomBtn   = document.getElementById('minimap-random');
const minimapWrap = document.getElementById('minimap-wrap');
initMinimap();

// Small vs. big minimap. 234 px mirrors the initial HTML canvas size; big mode
// fills half the shorter viewport axis (so it's ~a quarter of the screen's
// area, always square, never overflows on portrait windows).
const MINIMAP_SIZE_SMALL = 234;
function minimapBigSize() {
  return Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.5);
}
let minimapBig = false;
function applyMinimapLayout() {
  const px = minimapBig ? minimapBigSize() : MINIMAP_SIZE_SMALL;
  setMinimapSize(px);
  // Keep the random-location button anchored just below the map so the big
  // map doesn't visually swallow it. The wrap sits at top: 28px; the button
  // follows at (28 + size + 6)px.
  const btn = document.getElementById('minimap-random');
  if (btn) btn.style.top = (28 + px + 6) + 'px';
}
function toggleMinimapBig() {
  minimapBig = !minimapBig;
  minimapWrap.classList.toggle('big', minimapBig);
  applyMinimapLayout();
  if (minimapBig) {
    // Map mode = pointer-escape mode: release the mouse so the user can
    // interact with the map (drag/scroll/click) instead of mouse-looking.
    if (controls.isLocked) controls.unlock();
  } else {
    // Pan is a map-mode-local view adjustment — snap back to player-centred
    // so the small map always tracks the player.
    resetMinimapPan();
    // Exiting map mode also exits escape mode — re-lock into first-person.
    // Guarded like the overlay's click-to-lock so we don't try to lock during
    // initial load or mid-teleport.
    if (firstTileLoaded && !teleporting && !controls.isLocked) controls.lock();
  }
}
window.addEventListener('resize', () => {
  if (minimapBig) applyMinimapLayout();
});

// Max distance from a spawn point to the nearest building tile AABB. Keeps
// the random-teleport button from dropping the player in open water / parks /
// the middle of the FDR where there's nothing to paint.
const STREET_SPAWN_MAX_BUILDING_DIST = 50; // metres

/**
 * Try to pick a spawn on an actual OSM street that's within
 * STREET_SPAWN_MAX_BUILDING_DIST of a building. Returns null if no street
 * data is available (OSM manifest missing) or every tried point was far from
 * buildings — the caller should fall back to the plain random picker.
 *
 * Why sample OSM tiles rather than the loaded street meshes: the street
 * meshes only cover the ~300 m around the player; we want teleport targets
 * anywhere on the map. So we hit the manifest and fetch street polylines on
 * demand, cached in OsmManager for repeat clicks.
 */
async function pickStreetSpawn(maxTileTries = 20, pointsPerTile = 4) {
  const candidates = osmManager.tilesWithStreets();
  if (candidates.length === 0) return null;
  for (let i = 0; i < maxTileTries; i++) {
    const tile = candidates[Math.floor(Math.random() * candidates.length)];
    let streets;
    try { streets = await osmManager.fetchStreets(tile.id); }
    catch { continue; }
    if (!streets || streets.length === 0) continue;
    for (let j = 0; j < pointsPerTile; j++) {
      const s = streets[Math.floor(Math.random() * streets.length)];
      if (!s.points || s.points.length < 2) continue;
      const segIdx = Math.floor(Math.random() * (s.points.length - 1));
      const p0 = s.points[segIdx], p1 = s.points[segIdx + 1];
      const t = Math.random();
      const x = p0[0] + (p1[0] - p0[0]) * t;
      const z = p0[1] + (p1[1] - p0[1]) * t;
      if (tileManager.distanceToNearestBuildingTile(x, z) <= STREET_SPAWN_MAX_BUILDING_DIST) {
        return { x, z };
      }
    }
  }
  return null;
}

const _teleportEuler = new THREE.Euler(0, 0, 0, 'YXZ');

// Mirror the first-page-load experience: move the player, unlock pointer,
// show the dimmed "loading" overlay, and wait for nearby tiles to finish
// loading before letting the user click in. Shared by the random-location
// button and map-click teleport.
function fastTravelTo(x, z) {
  if (!firstTileLoaded) return;
  // Intentionally not gated on `teleporting`: a fresh teleport preempts the
  // in-flight one. The gate check in onTileLoaded runs against the current
  // camera position, so only tiles around the latest destination matter.
  camera.position.set(x, MIN_EYE_Y, z);
  velY = 0;
  // Keep the current yaw but pitch the view 20° above horizontal so the player
  // lands looking at the skyline, not their feet. YXZ Euler + positive X = up.
  _teleportEuler.setFromQuaternion(camera.quaternion);
  _teleportEuler.x = Math.PI * 20 / 180;
  _teleportEuler.z = 0;
  camera.quaternion.setFromEuler(_teleportEuler);
  updateCulling();

  teleporting = true;
  overlay.classList.add('loading');
  overlayPrompt.textContent = 'Loading data...';
  colorPickMode = false;
  if (controls.isLocked) controls.unlock();
  else overlay.classList.remove('hidden');

  // Close the big map if it was open so the loading overlay is actually
  // visible; resetMinimapPan() runs via toggleMinimapBig.
  if (minimapBig) toggleMinimapBig();

  // Kick the tile manager now so any fresh loads are in-flight before the
  // next frame, and so we can detect the "nothing new to load" case (e.g.
  // teleport landed inside an already-loaded tile) and clear immediately.
  tileManager.tick(x, z);
  if (tileManager.allNearbyTilesLoaded(x, z)) finishTeleportLoad();
}

randomBtn.addEventListener('click', async () => {
  if (!firstTileLoaded) return;
  const loc = (await pickStreetSpawn()) ?? tileManager.randomLocation();
  if (!loc) return;
  fastTravelTo(loc.x, loc.z);
});

// ─── Map-mode mouse interaction ───────────────────────────────────────────────
// Active only while the minimap is in "big" mode (.big class). Drag to pan,
// wheel to zoom, click to fast-travel. Pan does not persist when leaving map
// mode (reset in toggleMinimapBig); zoom does.

let _mapDragging = false;
let _mapDragMoved = false;
let _mapDragStartX = 0, _mapDragStartY = 0;
let _mapDragLastX  = 0, _mapDragLastY  = 0;
const MAP_CLICK_SLOP = 3; // px — mouse movement under this on a press counts as a click

function _mapMouseLocal(e) {
  const rect = minimapWrap.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
}

minimapWrap.addEventListener('mousedown', (e) => {
  if (!minimapBig || e.button !== 0) return;
  const { x, y } = _mapMouseLocal(e);
  _mapDragging = true;
  _mapDragMoved = false;
  _mapDragStartX = _mapDragLastX = x;
  _mapDragStartY = _mapDragLastY = y;
  minimapWrap.classList.add('dragging');
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('mousemove', (e) => {
  if (!_mapDragging) return;
  const { x, y } = _mapMouseLocal(e);
  const dxPx = x - _mapDragLastX;
  const dyPx = y - _mapDragLastY;
  _mapDragLastX = x;
  _mapDragLastY = y;
  if (!_mapDragMoved &&
      Math.hypot(x - _mapDragStartX, y - _mapDragStartY) > MAP_CLICK_SLOP) {
    _mapDragMoved = true;
  }
  // Dragging right moves content right → view centre shifts left (west).
  const m = minimapMetersPerPixel();
  adjustMinimapPan(-dxPx * m, -dyPx * m);
});

document.addEventListener('mouseup', (e) => {
  if (!_mapDragging) return;
  _mapDragging = false;
  minimapWrap.classList.remove('dragging');
  if (_mapDragMoved || !minimapBig) return;
  const { x, y, rect } = _mapMouseLocal(e);
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
  const { x: wx, z: wz } = minimapPixelToWorld(x, y, camera.position.x, camera.position.z);
  fastTravelTo(wx, wz);
});

minimapWrap.addEventListener('wheel', (e) => {
  if (!minimapBig) return;
  e.preventDefault();
  // deltaY > 0 on scroll-down → zoom out; ~0.5 zoom per standard notch (100px).
  adjustMinimapZoom(-e.deltaY * 0.005);
}, { passive: false });

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
  // Re-locking means the user is returning to first-person — close the big
  // map (and reset its pan) so it doesn't stay spread across the game view.
  if (minimapBig) toggleMinimapBig();
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
  if (e.ctrlKey || e.metaKey) {
    // Ctrl+Shift+R / Cmd+Shift+R: flag reset so next page load clears the
    // saved player state and spawns at the default. sessionStorage survives
    // the reload; the flag is consumed at startup (see PLAYER_RESET_KEY).
    if (e.shiftKey && e.code === 'KeyR') {
      sessionStorage.setItem(PLAYER_RESET_KEY, '1');
    }
    return;
  }

  // F3: toggle the debug HUD. Prevent the browser's default search action.
  if (e.code === 'F3') {
    e.preventDefault();
    debugHudOn = !debugHudOn;
    debugHud.style.display = debugHudOn ? 'block' : 'none';
    return;
  }

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

  if (e.code === 'KeyM' && !e.repeat) {
    toggleMinimapBig();
  }
});

document.addEventListener('keyup', e => { keys[e.code] = false; });

window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ─── Collision helpers ────────────────────────────────────────────────────────

const snapRay  = new THREE.Raycaster(); // reusable ray for safe-start checks
const downRay  = new THREE.Raycaster();
const DOWN     = new THREE.Vector3(0, -1, 0);

// Closest point on triangle (a,b,c) to point p — written into `out`.
// Ericson, Real-Time Collision Detection §5.1.5. Pre-allocated temps below.
const _cptAB = new THREE.Vector3();
const _cptAC = new THREE.Vector3();
const _cptAP = new THREE.Vector3();
const _cptBP = new THREE.Vector3();
const _cptCP = new THREE.Vector3();
const _cptBC = new THREE.Vector3();
function closestPointOnTriangle(p, a, b, c, out) {
  _cptAB.subVectors(b, a);
  _cptAC.subVectors(c, a);
  _cptAP.subVectors(p, a);
  const d1 = _cptAB.dot(_cptAP);
  const d2 = _cptAC.dot(_cptAP);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);

  _cptBP.subVectors(p, b);
  const d3 = _cptAB.dot(_cptBP);
  const d4 = _cptAC.dot(_cptBP);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.copy(a).addScaledVector(_cptAB, v);
  }

  _cptCP.subVectors(p, c);
  const d5 = _cptAB.dot(_cptCP);
  const d6 = _cptAC.dot(_cptCP);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.copy(a).addScaledVector(_cptAC, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    _cptBC.subVectors(c, b);
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(_cptBC, w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return out.copy(a).addScaledVector(_cptAB, v).addScaledVector(_cptAC, w);
}

// Returns the highest surface the player's footprint is sitting on, or null.
//
// Center ray starts at feet + STEP_UP_HEIGHT + 0.15 so it can detect a surface
// up to STEP_UP_HEIGHT above current feet — this is the step-up: the moment
// the player's center crosses onto a slightly-higher roof, Y snaps to it.
//
// Ring rays (8 compass offsets at ~PLAYER_RADIUS) start at feet + 0.15 and
// only see surfaces at or below feet — they support the player at current
// feet level when their center has drifted past a roof edge, without
// triggering an unwanted snap-up from a taller neighbor the player is merely
// standing next to.
const _surfOrig = new THREE.Vector3();
const RING_OFFSETS = (() => {
  const offsets = [];
  const r = PLAYER_RADIUS * 0.9;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    offsets.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return offsets;
})();
function surfaceBelow(pos, maxDrop) {
  let bestY = null;

  _surfOrig.set(pos.x, pos.y - WALK_HEIGHT + STEP_UP_HEIGHT + 0.15, pos.z);
  downRay.set(_surfOrig, DOWN);
  downRay.far = maxDrop + STEP_UP_HEIGHT + 0.15;
  const centerHits = downRay.intersectObjects(nearCollidables, false);
  if (centerHits.length > 0) bestY = centerHits[0].point.y;

  for (let i = 0; i < RING_OFFSETS.length; i++) {
    const [ox, oz] = RING_OFFSETS[i];
    _surfOrig.set(pos.x + ox, pos.y - WALK_HEIGHT + 0.15, pos.z + oz);
    downRay.set(_surfOrig, DOWN);
    downRay.far = maxDrop + 0.15;
    const hits = downRay.intersectObjects(nearCollidables, false);
    if (hits.length > 0) {
      const y = hits[0].point.y;
      if (bestY === null || y > bestY) bestY = y;
    }
  }
  return bestY;
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
const SMALL_CELL_AREA = GRID_SIZE ** 2 * 0.5; // 2.0 m² — matches tileWorker SLIVER_AREA, used only by the debug HUD's SLIVER label

const paintRay          = new THREE.Raycaster();
const paintGroup        = new THREE.Group();

// ─── Debug HUD ────────────────────────────────────────────────────────────────
//
// Toggle with F3. Shows what the crosshair is hitting: building id, mesh type,
// triangle index, face id (which face the triangle belongs to), cell coords,
// planeD + key, face normal, hit distance. Useful for diagnosing face
// boundaries ("why is there a green line between these two faces?" — if both
// sides show the same face id, it's a T-junction; if different, the face
// extraction criteria rejected the merge).

const debugRay = new THREE.Raycaster();
let debugHudOn = false;

// FPS tracking — rolled over a ~500 ms window so the number updates smoothly
// instead of jittering frame-to-frame. Only displayed when debugHudOn.
let _fpsValue = 0;
let _fpsFrameCount = 0;
let _fpsWindowStart = 0;

function tickFps(now) {
  if (_fpsWindowStart === 0) _fpsWindowStart = now;
  _fpsFrameCount++;
  const elapsed = now - _fpsWindowStart;
  if (elapsed >= 500) {
    _fpsValue = (_fpsFrameCount * 1000) / elapsed;
    _fpsFrameCount = 0;
    _fpsWindowStart = now;
  }
}

const debugHud = document.createElement('div');
debugHud.id = 'debug-hud';
debugHud.style.cssText = `
  position: fixed; top: 12px; left: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.4;
  color: #fff; background: rgba(0, 0, 0, 0.6);
  padding: 8px 10px; border-radius: 4px;
  white-space: pre; pointer-events: none; z-index: 9999;
  display: none;
`;
document.body.appendChild(debugHud);

function updateDebugHud() {
  if (!debugHudOn) return;
  const fpsLine = `fps      ${_fpsValue.toFixed(1)}`;
  debugRay.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = debugRay.intersectObjects(nearBuildingMeshes, false);
  if (!hits.length) { debugHud.textContent = fpsLine + '\n(no hit)'; return; }
  const hit     = hits[0];
  const mesh    = hit.object;
  const ud      = mesh.userData;
  const faceIdx = hit.faceIndex;
  const fi     = ud.triFace ? ud.triFace[faceIdx] : -1;
  const fData  = (ud.faces && fi >= 0) ? ud.faces[fi] : null;

  const triNormal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
  const triPD     = triNormal.dot(hit.point);
  const facePD    = fData ? fData.planeD : null;
  // meshType is now per-face (merged mesh carries both roof + wall).
  const meshType  = fData && fData.meshType ? fData.meshType
    : (Math.abs(triNormal.y) > 0.5 ? 'roof' : 'wall');

  // The key used by paint (and the worker's seed cache): face planeD if
  // available, else the per-triangle planeD. If these disagree enough to
  // round to different pdKeys, paint misses the cache — that's the bug this
  // HUD is meant to surface.
  const paintPD  = facePD != null ? facePD : triPD;
  const pdKey    = Math.round(paintPD * 2);
  const cu       = hit.uv ? Math.floor(hit.uv.x) : '—';
  const cv       = hit.uv ? Math.floor(hit.uv.y) : '—';
  const cellKey  = `${ud.buildingId}:${meshType}:${cu}:${cv}:${pdKey}`;
  const cached   = cellGeomCache.get(cellKey);
  const area     = cached ? geomArea(cached) : null;
  const pdMismatch = facePD != null &&
    Math.round(facePD * 2) !== Math.round(triPD * 2);

  // Paint status. If this flips from "no" to "yes <color>" right after a
  // click, the paintStore is receiving the paint correctly and the problem
  // is downstream in rebuildBuildingPaint / the mesh itself. If it stays
  // "no", the click isn't reaching this cellKey at all.
  const stored = paintStore.cells.get(cellKey);
  const paintMeshCount = (buildingPaintMeshByBuilding.get(`${ud.buildingId}:${meshType}`) || new Set()).size;

  const group       = cellGroups.get(cellKey);
  const groupSize   = group ? group.size : 1;

  debugHud.textContent = [
    fpsLine,
    `bldg     ${ud.buildingId}`,
    `mesh     ${meshType}   tri ${faceIdx}   face ${fi}`,
    `cell     (${cu}, ${cv})   pdKey ${pdKey}`,
    `cellKey  ${cellKey}`,
    `cache    ${cached ? `hit (area ${area.toFixed(2)} m²${area < SMALL_CELL_AREA ? ' — SLIVER' : ''})` : 'MISS'}`,
    `group    ${groupSize}${groupSize > 1 ? ' cells' : ' (singleton)'}`,
    `painted  ${stored ? `yes ${typeof stored.color === 'number' ? '#' + stored.color.toString(16).padStart(6, '0') : stored.color}` : 'no'}`,
    `bldgMeshes ${paintMeshCount}`,
    `planeD   ${paintPD.toFixed(3)}${pdMismatch ? `   (tri ${triPD.toFixed(3)} — MISMATCH)` : ''}`,
    `normal   (${triNormal.x.toFixed(2)}, ${triNormal.y.toFixed(2)}, ${triNormal.z.toFixed(2)})`,
    `dist     ${hit.distance.toFixed(1)} m`,
  ].join('\n');
}
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
    if (srcMesh) rebuildBuildingPaint(srcMesh, bk);
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
function buildCellGeometry(srcMesh, cellU, cellV, cellNormal, planeD, meshType) {
  const pos = srcMesh.geometry.attributes.position.array;
  const uv  = srcMesh.geometry.attributes.uv.array;
  const faces   = srcMesh.userData.faces;
  const triFace = srcMesh.userData.triFace;
  const verts = [];
  const OFFSET        = 0.025;
  const COPLANAR_TOL  = 0.15; // 15 cm — rejects steps/ledges, accepts tessellation seams
  const cn = [cellNormal.x, cellNormal.y, cellNormal.z];

  // When meshType is known, iterate only that half of the merged mesh (roof
  // tris vs wall tris live in contiguous ranges — see tileWorker
  // buildMergedMeshData). Cuts per-call cost roughly in half since the other
  // half is always rejected by the normal-dot filter anyway.
  const ranges = srcMesh.userData.triRanges;
  const range  = (meshType && ranges && ranges[meshType]) ? ranges[meshType] : null;
  const tiStart = range ? range.start : 0;
  const tiEnd   = range ? range.start + range.count : (pos.length / 9) | 0;

  for (let ti = tiStart; ti < tiEnd; ti++) {
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

    // If the owning face was flagged suspicious in the worker (untrustworthy
    // outside direction), emit the polygon offset on both sides of the plane
    // so paint is visible regardless of winding. See tileWorker.js makeMeshData.
    const fi = triFace ? triFace[ti] : -1;
    const doubleSide = fi >= 0 && faces && faces[fi] && faces[fi].suspicious === 1;

    // Fan-triangulate and offset along normal
    for (let k = 1; k < poly.length - 1; k++) {
      for (const v of [poly[0], poly[k], poly[k+1]]) {
        verts.push(
          v.pos[0] + cn[0]*OFFSET,
          v.pos[1] + cn[1]*OFFSET,
          v.pos[2] + cn[2]*OFFSET,
        );
      }
      if (doubleSide) {
        for (const v of [poly[0], poly[k], poly[k+1]]) {
          verts.push(
            v.pos[0] - cn[0]*OFFSET,
            v.pos[1] - cn[1]*OFFSET,
            v.pos[2] - cn[2]*OFFSET,
          );
        }
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

// Paint groups — pre-baked in tileWorker.buildCellGroups. Every member of a
// group maps to the SAME shared Set instance, so `.get(k)` is O(1) and
// reference-identical across members (tryPaint/tryErase just iterate the set).
const cellGroups             = new Map(); // cellKey → Set<cellKey>
const cellGroupKeysByBuilding = new Map(); // buildingKey → Set<cellKey> — for O(building) unload cleanup

function rebuildBuildingPaint(srcMesh, buildingKey) {
  // buildingKey comes from the caller (either flushPaintRebuilds or
  // seedTileCells) because one merged srcMesh covers both roof + wall. The
  // paint system still keys paint meshes + cellGeomCache by buildingKey, so
  // each meshType rebuilds independently.
  const prefix = buildingKey + ':';
  // Extract meshType (part after the building id) so buildCellGeometry on a
  // cache miss iterates only the matching half of the merged mesh.
  const colonIdx = buildingKey.indexOf(':');
  const meshType = colonIdx >= 0 ? buildingKey.slice(colonIdx + 1) : null;

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
      const verts = buildCellGeometry(srcMesh, cu, cv, new THREE.Vector3(...v.normal), v.planeD, meshType);
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

const SEED_FRACTION = 0.1; // fraction of cells to randomly seed on load (applied in tileWorker.js)

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

      const perType = srcMesh.userData.cellDataByType;
      if (!perType) continue; // already applied, or wrapped without worker data

      const { buildingId } = srcMesh.userData;

      // Iterate each meshType's CellBundle independently — cellKeys, seeds,
      // and paint-mesh keys are all scoped to (building, meshType).
      for (const meshType in perType) {
        const cellData = perType[meshType];
        const bk = `${buildingId}:${meshType}`;

        let geomSet = cellGeomByBuilding.get(bk);
        if (!geomSet) { geomSet = new Set(); cellGeomByBuilding.set(bk, geomSet); }

        const { cellKeys, cellGeoms, seeds, cellGroups: groups } = cellData;
        for (let i = 0; i < cellKeys.length; i++) {
          cellGeomCache.set(cellKeys[i], cellGeoms[i]);
          geomSet.add(cellKeys[i]);
        }

        // Paint groups — every member of a group points at the same Set instance.
        if (groups && groups.length) {
          let groupKeySet = cellGroupKeysByBuilding.get(bk);
          if (!groupKeySet) { groupKeySet = new Set(); cellGroupKeysByBuilding.set(bk, groupKeySet); }
          for (const members of groups) {
            const shared = new Set(members);
            for (const k of members) {
              cellGroups.set(k, shared);
              groupKeySet.add(k);
            }
          }
        }

        // Once a tile has any persisted cells, its seed pattern is locked in —
        // skip fresh rolls from the worker so reloads don't grow the coverage
        // with a new ~16% every session.
        const tileId = paintStore.tileIdOfBuilding(bk);
        const tileLocked = tileId && paintStore.tileHasSavedData(tileId);

        if (!tileLocked) {
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
        }

        rebuildBuildingPaint(srcMesh, bk);
      }

      // Free the bundle — its Float32Arrays now live in cellGeomCache.
      srcMesh.userData.cellDataByType = null;
    }

    if (end < meshes.length) await new Promise(r => requestIdleCallback(r, { timeout: 2000 }));
  }

  performance.measure('tile:seed', { start: tSeed, end: performance.now() });
}

// ── Paint / erase actions ─────────────────────────────────────────────────────

/**
 * Given a tentative cellKey built from a raycast hit's face planeD, return
 * the canonical cellKey in cellGeomCache for the same visual cell. The worker
 * dedupes overlapping cells by merging them under one anchor face's pdKey —
 * but a raycast that hits a different face would compute a different pdKey,
 * so we scan this building's cells for the same (cu, cv) and pick the nearest
 * pdKey (within 1 bucket = 50 cm of planeD). Bigger gaps mean genuinely
 * different surfaces that shouldn't be aliased.
 */
function canonicalCellKey(buildingKey, cu, cv, pdKey) {
  const tentative = `${buildingKey}:${cu}:${cv}:${pdKey}`;
  if (cellGeomCache.has(tentative)) return tentative;
  const geomSet = cellGeomByBuilding.get(buildingKey);
  if (!geomSet) return tentative;
  const targetPrefix = `${buildingKey}:${cu}:${cv}:`;
  let bestKey = null, bestDist = Infinity;
  for (const k of geomSet) {
    if (!k.startsWith(targetPrefix)) continue;
    const kpd = parseInt(k.slice(targetPrefix.length));
    const d = Math.abs(kpd - pdKey);
    if (d < bestDist) { bestDist = d; bestKey = k; }
  }
  return bestKey && bestDist <= 1 ? bestKey : tentative;
}

function hitCell() {
  paintRay.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = paintRay.intersectObjects(nearBuildingMeshes, false);
  if (!hits.length || hits[0].distance > PAINT_DIST || !hits[0].uv) return null;
  const hit  = hits[0];
  const mesh = hit.object;

  // Prefer the face's averaged normal + planeD when available. The worker's
  // seed cache generates cellKeys from face.planeD; using per-triangle planeD
  // here would round into a different 50 cm bucket for any triangle whose
  // normal drifted slightly from the face average. Worker dedupe then anchors
  // the cell on one face's pdKey; canonicalCellKey below redirects any
  // neighboring pdKey onto that anchor.
  let normal, planeD;
  const faces   = mesh.userData.faces;
  const triFace = mesh.userData.triFace;
  const fi = (faces && triFace) ? triFace[hit.faceIndex] : -1;
  if (fi >= 0) {
    const f = faces[fi];
    normal = new THREE.Vector3(f.normal[0], f.normal[1], f.normal[2])
      .transformDirection(mesh.matrixWorld).normalize();
    planeD = f.planeD;
  } else {
    normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    planeD = normal.dot(hit.point);
  }

  const cellU = Math.floor(hit.uv.x);
  const cellV = Math.floor(hit.uv.y);
  const pd    = Math.round(planeD * 2);
  const { buildingId } = mesh.userData;
  // meshType lives on each face now (merged mesh holds both roof + wall).
  // Fallback infers from normal for degenerate-triangle hits where fi < 0.
  const meshType = (fi >= 0 && faces && faces[fi] && faces[fi].meshType)
    ? faces[fi].meshType
    : (Math.abs(normal.y) > 0.5 ? 'roof' : 'wall');
  const cellKey = canonicalCellKey(`${buildingId}:${meshType}`, cellU, cellV, pd);

  return { cellU, cellV, normal, planeD, mesh, cellKey };
}

function tryPaint() {
  const activeColor = COLORS[activeColorIdx];
  if (activeColor.isErase) { tryErase(); return; }
  const h = hitCell();
  if (!h) return;
  const cellData = { color: activeColor.hex, normal: h.normal.toArray(), planeD: h.planeD, paintedAt: Date.now() };

  // Paint the primary cell immediately so it appears this frame. h.cellKey
  // has already been canonicalized, so painting here replaces whatever was
  // stored for this visual cell rather than creating a sibling entry.
  paintStore.paint(h.cellKey, cellData);

  // Paint-group members are pre-baked by the tile worker. Defer the batch so
  // the primary cell renders this frame without competing for it.
  const group = cellGroups.get(h.cellKey);
  if (group && group.size > 1) {
    setTimeout(() => {
      const others = [];
      for (const k of group) if (k !== h.cellKey) others.push([k, cellData]);
      if (others.length) paintStore.paintBatch(others);
    }, 0);
  }
}

function tryErase() {
  const h = hitCell();
  if (!h) return;

  paintStore.erase(h.cellKey);

  const group = cellGroups.get(h.cellKey);
  if (group && group.size > 1) {
    setTimeout(() => {
      const others = [];
      for (const k of group) if (k !== h.cellKey) others.push(k);
      if (others.length) paintStore.eraseBatch(others);
    }, 0);
  }
}

// ─── Movement ─────────────────────────────────────────────────────────────────

let lastTime = performance.now();

const _fwd  = new THREE.Vector3();
const _right = new THREE.Vector3();

// Y offsets from the eye at which we sample the capsule. Each sample resolves
// as a sphere of PLAYER_RADIUS against nearby triangles — together they span
// eye → near-feet so short ledges and low overhangs are caught.
const CAPSULE_SAMPLE_OFFSETS = [0, -0.9, -1.8, -(WALK_HEIGHT - 0.15)];

// Reusable temps for resolveCapsule.
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _capC = new THREE.Vector3();
const _capP = new THREE.Vector3();
const _capClosest = new THREE.Vector3();

const MAX_CAPSULE_ITERS = 4;

// Push the player out of any building triangle that intersects the capsule.
// Horizontal-only ejection: vertical movement is handled by gravity /
// surfaceBelow. Iterates a few times so multi-contact corners settle.
function resolveCapsule(pos) {
  const r = PLAYER_RADIUS;
  const r2 = r * r;
  const lastOff = CAPSULE_SAMPLE_OFFSETS[CAPSULE_SAMPLE_OFFSETS.length - 1];
  const feetY = pos.y - WALK_HEIGHT;

  for (let iter = 0; iter < MAX_CAPSULE_ITERS; iter++) {
    let moved = false;

    const capMinX = pos.x - r, capMaxX = pos.x + r;
    const capMinZ = pos.z - r, capMaxZ = pos.z + r;
    const capMinY = pos.y + lastOff - r;
    const capMaxY = pos.y + r;

    for (const mesh of nearBuildingMeshes) {
      const bb = mesh.geometry.boundingBox;
      if (!bb) continue;
      if (capMaxX < bb.min.x || capMinX > bb.max.x) continue;
      if (capMaxY < bb.min.y || capMinY > bb.max.y) continue;
      if (capMaxZ < bb.min.z || capMinZ > bb.max.z) continue;

      const posAttr = mesh.geometry.getAttribute('position');
      const arr = posAttr.array;
      const triCount = posAttr.count / 3;

      for (let ti = 0; ti < triCount; ti++) {
        const i0 = ti * 9;
        const ax = arr[i0],     ay = arr[i0 + 1], az = arr[i0 + 2];
        const bx = arr[i0 + 3], by = arr[i0 + 4], bz = arr[i0 + 5];
        const cx = arr[i0 + 6], cy = arr[i0 + 7], cz = arr[i0 + 8];

        if (Math.min(ax, bx, cx) > capMaxX || Math.max(ax, bx, cx) < capMinX) continue;
        if (Math.min(ay, by, cy) > capMaxY || Math.max(ay, by, cy) < capMinY) continue;
        if (Math.min(az, bz, cz) > capMaxZ || Math.max(az, bz, cz) < capMinZ) continue;

        // Skip near-horizontal triangles (roofs, floors). Landing and
        // standing on these is handled by gravity / surfaceBelow; letting
        // them contribute to horizontal push causes the player to get
        // ejected sideways when standing near the seam between rooftops
        // of slightly different heights.
        const ex1 = bx - ax, ey1 = by - ay, ez1 = bz - az;
        const ex2 = cx - ax, ey2 = cy - ay, ez2 = cz - az;
        const nx = ey1 * ez2 - ez1 * ey2;
        const ny = ez1 * ex2 - ex1 * ez2;
        const nz = ex1 * ey2 - ey1 * ex2;
        const nLen2 = nx * nx + ny * ny + nz * nz;
        if (nLen2 < 1e-10) continue;
        // Skip if the face is within 30° of horizontal (normal within 30°
        // of vertical). cos(30°)² ≈ 0.75 → |ny|²/|n|² > 0.75.
        if ((ny * ny) / nLen2 > 0.75) continue;

        _capA.set(ax, ay, az);
        _capB.set(bx, by, bz);
        _capC.set(cx, cy, cz);

        for (let yi = 0; yi < CAPSULE_SAMPLE_OFFSETS.length; yi++) {
          _capP.set(pos.x, pos.y + CAPSULE_SAMPLE_OFFSETS[yi], pos.z);
          closestPointOnTriangle(_capP, _capA, _capB, _capC, _capClosest);
          // Skip contacts whose closest point is within STEP_UP_HEIGHT above
          // the player's feet. This covers the top edge of a wall under our
          // own roof (the original case) and also the short wall of a
          // slightly-higher adjacent roof — ignoring it here lets the player
          // walk into the step, and surfaceBelow's center-ray step-up then
          // raises Y onto the higher roof the same frame.
          if (_capClosest.y < feetY + STEP_UP_HEIGHT + 0.1) continue;
          // Push using true 3D separation but project the push horizontally —
          // this keeps narrow-gap corner ejection while preventing a huge
          // horizontal shove from a contact that is mostly vertical.
          const ddx = _capP.x - _capClosest.x;
          const ddy = _capP.y - _capClosest.y;
          const ddz = _capP.z - _capClosest.z;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 < r2 && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            const push = (r - d) / d;
            pos.x += ddx * push;
            pos.z += ddz * push;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}

// Smoothed fly-mode velocity (m/s). Lerps toward the target velocity built
// from input each frame so starting/stopping movement in the air ramps in
// instead of snapping. Walk mode bypasses this and resets it to zero.
const _flyVel = new THREE.Vector3();
const FLY_SMOOTH_TAU = 0.10; // seconds — ~250ms to reach ~92% of target

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

  // Target horizontal velocity (m/s) from input.
  let tvx = 0, tvz = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    { tvx += _fwd.x;   tvz += _fwd.z; }
  if (keys['KeyS'] || keys['ArrowDown'])  { tvx -= _fwd.x;   tvz -= _fwd.z; }
  if (keys['KeyA'] || keys['ArrowLeft'])  { tvx -= _right.x; tvz -= _right.z; }
  if (keys['KeyD'] || keys['ArrowRight']) { tvx += _right.x; tvz += _right.z; }

  const hLen = Math.sqrt(tvx * tvx + tvz * tvz);
  if (hLen > 0) {
    tvx = (tvx / hLen) * speed;
    tvz = (tvz / hLen) * speed;
  }

  // Target vertical velocity (m/s). Walk mode handles gravity below; in fly
  // mode Space/Shift are direct vertical input.
  let tvy = 0;
  if (isFlying) {
    if (keys['Space'])                            tvy += FLY_VERT * flyBoost;
    if (keys['ShiftLeft'] || keys['ShiftRight'])  tvy -= FLY_VERT * flyBoost;
  }

  let dx, dz, dy;
  if (isFlying) {
    // Exponential smoothing toward the input-driven target velocity. This is
    // what gives the brief "ease in / ease out" feel when starting or
    // stopping in the air.
    const a = 1 - Math.exp(-dt / FLY_SMOOTH_TAU);
    _flyVel.x += (tvx - _flyVel.x) * a;
    _flyVel.y += (tvy - _flyVel.y) * a;
    _flyVel.z += (tvz - _flyVel.z) * a;
    dx = _flyVel.x * dt;
    dy = _flyVel.y * dt;
    dz = _flyVel.z * dt;
  } else {
    // Walking is intentionally snappy.
    _flyVel.set(0, 0, 0);
    dx = tvx * dt;
    dz = tvz * dt;
    dy = 0; // gravity handled below
  }

  // Capsule collision: apply full horizontal delta, then let resolveCapsule
  // push us out of any overlapping triangles. Corners eject along the
  // contact normal so narrow gaps push the player sideways at the entrance
  // instead of letting them wedge in.
  const prevX = camera.position.x;
  const prevZ = camera.position.z;
  camera.position.x += dx;
  camera.position.z += dz;
  resolveCapsule(camera.position);
  // If the resolver reversed our intended motion on an axis, zero the
  // smoothed fly velocity so it doesn't keep accumulating against the wall.
  const actualDx = camera.position.x - prevX;
  const actualDz = camera.position.z - prevZ;
  if (dx !== 0 && actualDx * dx < 0) _flyVel.x = 0;
  if (dz !== 0 && actualDz * dz < 0) _flyVel.z = 0;

  // ── Vertical ────────────────────────────────────────────────────────────────

  if (isFlying) {
    velY = 0;
    // Ascending (dy > 0) is unblocked — intentionally allows clipping through
    // ceilings to escape buildings. Descending (dy < 0) is blocked by any
    // surface below, so the smoothed velocity gets zeroed when we hit ground.
    if (dy > 0) {
      camera.position.y += dy;
    } else if (dy < 0) {
      const drop = -dy;
      const footOrigin = new THREE.Vector3(camera.position.x, camera.position.y - WALK_HEIGHT + 0.05, camera.position.z);
      downRay.set(footOrigin, DOWN);
      downRay.far = drop + 0.1;
      const hits = downRay.intersectObjects(nearCollidables, false);
      if (hits.length === 0 || hits[0].distance > drop) camera.position.y += dy;
      else _flyVel.y = 0;
    }
    camera.position.y = Math.max(MIN_EYE_Y, camera.position.y);
  } else {
    // Rescue: if the player is saved-loaded or spawned below the terrain
    // (e.g. old save from before terrain existed, or a teleport beat terrain
    // streaming), the downward surfaceBelow ray starts inside the mesh and
    // misses. Snap up so gravity finds the surface on the next frame.
    const terrainY = terrainManager.sample(camera.position.x, camera.position.z);
    if (terrainY !== null && camera.position.y - WALK_HEIGHT < terrainY - 0.5) {
      camera.position.y = terrainY + WALK_HEIGHT;
      velY = 0;
    }

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
        if (camera.position.y < MIN_EYE_Y) {
          camera.position.y = MIN_EYE_Y;
          velY = 0;
        }
      }
    }
    // (No upward velocity in walk mode — no jump yet)
  }

  // ── HUD ─────────────────────────────────────────────────────────────────────
  hud.textContent = isFlying
    ? 'Graffiti NYC  ✦ flying'
    : 'Graffiti NYC';
}

// ─── Buildings ────────────────────────────────────────────────────────────────

// Maps "buildingId:meshType" → mesh so paint overlays can look up source geometry.
const buildingMeshMap = new Map();


// Returns true if the XZ position has clearance in all 8 horizontal directions.
function positionIsClear(x, z) {
  const pos = new THREE.Vector3(x, MIN_EYE_Y, z);
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
// When the position is already clear, the saved Y is left alone so rooftop
// saves survive the reload. The per-frame below-terrain rescue in walk mode
// handles the case where the saved Y ends up inside newly-loaded terrain.
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
        placeOnGround(x, z);
        return;
      }
    }
  }
}

function placeOnGround(x, z) {
  const terrainY = terrainManager.sample(x, z);
  const y = terrainY !== null ? terrainY + WALK_HEIGHT : MIN_EYE_Y;
  camera.position.set(x, y, z);
  velY = 0;
}

// ─── Tile manager ─────────────────────────────────────────────────────────────

let firstTileLoaded = false;
let tilesLoadedCount = 0;
// ?buildings=doitt is the only single-tile override (?=lod2 now loads a real
// tile manifest from /tiles_lod2/). Drop the 4-tile gate to 1 in that case so
// the loading overlay clears on the single tile.
const TILES_NEEDED = new URLSearchParams(location.search).get('buildings') === 'doitt' ? 1 : 4;

// Teleport loading state — the random-location button re-enters the same
// "Loading tiles…" overlay as the initial page load, cleared when every
// tile in load range of the new position has finished loading.
let teleporting = false;

function finishTeleportLoad() {
  if (!teleporting) return;
  teleporting = false;
  overlay.classList.remove('loading');
  overlayPrompt.textContent = 'Click to explore';
  randomBtn.disabled = false;
  snapToSafeStart();
}

const tileManager = new TileManager({
  scene,
  buildingMeshes,
  collidables,
  buildingMeshMap,
  cellGeomCache,
  cellGeomByBuilding,
  cellGroups,
  cellGroupKeysByBuilding,
  buildingPaintMeshes,
  buildingPaintMeshByBuilding,
  paintGroup,
  seedConfig: { fraction: SEED_FRACTION, colors: SEED_COLOR_HEX, shiftBuildingsY: !TERRAIN_ENABLED },
  onTileLoaded(meshes) {
    // Phase 1 — buildings are visible now. The spawn gate opens here so the
    // player can start interacting before the seed scan (phase 2) finishes.
    updateCulling();
    tilesLoadedCount++;
    if (!firstTileLoaded && tilesLoadedCount >= TILES_NEEDED) {
      firstTileLoaded = true;
      overlay.classList.remove('loading');
      overlayPrompt.textContent = 'Click to explore';
      randomBtn.disabled = false;
      snapToSafeStart();
    }
    if (teleporting && tileManager.allNearbyTilesLoaded(camera.position.x, camera.position.z)) {
      finishTeleportLoad();
    }
  },
  onTileCellData(meshes) {
    // Phase 2 — worker's seed scan result is now on mesh.userData.cellDataByType,
    // keyed by meshType. Populate cellGeomCache and apply seeded paint.
    seedTileCells(meshes);
  },
  onTileUnloaded() {
    updateCulling();
  },
});

tileManager.init('/tiles/manifest.json');

// OSM overlay — streets, water, and green spaces rendered as flat meshes on
// the ground. OSM radius tracks TileManager's adaptive radius so the overlay
// widens alongside buildings in sparse areas.
// Terrain-on: DEM heightfields stream in, OSM textures composite in the
// terrain shader.
// Terrain-off (VITE_TERRAIN=0, e.g. `npm run dev:flat`): no DEM loading,
// buildings are Y-shifted to sit at y=0 in the worker, OSM overlays render
// as the pre-terrain mesh stack (LAND/water/green/streets at Y_LAND..Y_STREET
// with polygon-offset biasing). TerrainManager is replaced with a null-object
// so the rest of main.js (spawn, collision, rescue) keeps calling it
// unconditionally.
const terrainManager = TERRAIN_ENABLED
  ? new TerrainManager({
      scene,
      getLoadRadius: () => tileManager.getLoadRadius(),
      osmLookup:     (x, z) => osmManager.getLoadedTileAt(x, z),
    })
  : {
      tick() {},
      sample() { return null; },
      meshes() { return []; },
      applyOsmTile() {},
      removeOsmTile() {},
    };

const osmManager = new OsmManager({
  scene,
  getLoadRadius: () => tileManager.getLoadRadius(),
  terrain:       TERRAIN_ENABLED ? terrainManager : null, // labels still drape
  flatMode:      !TERRAIN_ENABLED,                        // render own flat planes with texture
  onTileReady:   (tile) => terrainManager.applyOsmTile(tile),
  onTileUnready: (tile) => terrainManager.removeOsmTile(tile),
});
osmManager.init('/osm/manifest.json');

// ─── Render loop ──────────────────────────────────────────────────────────────

const _minimapDir = new THREE.Vector3();

// Cap the render loop to 60 Hz even on high-refresh monitors. Browsers' RAF
// fires at the monitor's refresh rate (often 120/144/165 Hz), doing work we
// don't need for this game. The 0.5 ms epsilon keeps ~60 fps stable against
// RAF timing jitter (without it the integer divisor occasionally drops to 59).
// NOTE: the cap can only produce divisors of the monitor rate (RAF aliasing),
// so a 45 Hz target on a 60 Hz monitor collapses to 30 Hz. Stick to 60, 30,
// 20, 15 etc. for stable results.
const FRAME_INTERVAL = 1000 / 60 - 0.5;
let _lastFrameTime = 0;

function animate(now) {
  requestAnimationFrame(animate);
  if (now - _lastFrameTime < FRAME_INTERVAL) return;
  _lastFrameTime = now;
  tickFps(now);

  tileManager.tick(camera.position.x, camera.position.z);
  osmManager.tick(camera.position.x, camera.position.z);
  terrainManager.tick(camera.position.x, camera.position.z);
  maybeCull();
  updateMovement();
  ground.position.x = camera.position.x;
  ground.position.z = camera.position.z;
  camera.getWorldDirection(_minimapDir);
  updateMinimap(camera.position.x, camera.position.z, Math.atan2(_minimapDir.x, -_minimapDir.z));
  updateDebugHud();
  renderer.render(scene, camera);
}

animate(0);
