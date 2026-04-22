import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GRID_SIZE } from './loadCityGML.js';
import { TileManager } from './TileManager.js';
import { OsmManager } from './OsmManager.js';
import { TerrainManager } from './TerrainManager.js';
import { TreeManager } from './TreeManager.js';
import { paintStore } from './paintStore.js';
import { worldToGrid, gridToWorld } from './geo.js';
import { BLOCK_SIZE } from './gridShader.js';
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

const camera = new THREE.PerspectiveCamera(100, window.innerWidth / window.innerHeight, 0.25, 2000);
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

scene.add(new THREE.AmbientLight(0xffffff, 1));

const sun = new THREE.DirectionalLight(0xfff8e7, 1.2);
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
// Matches OSM WATER_COLOR (#9cc4e2) so areas outside the 5-borough coverage
// read as open water rather than a grey void.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20000, 20000),
  new THREE.MeshLambertMaterial({ color: 0x9cc4e2 }),
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

// Convert a terrain cell's grid-space AABB to a world-space AABB (the
// AABB of the 4 rotated corners). Terrain indexes cells in grid space
// (Manhattan rotation) while OSM tile bounds are world-space, so any
// cross-system overlap check has to go through this first.
function _gridBoundsToWorldAABB(b) {
  const corners = [
    gridToWorld(b.minX, b.minZ),
    gridToWorld(b.maxX, b.minZ),
    gridToWorld(b.maxX, b.maxZ),
    gridToWorld(b.minX, b.maxZ),
  ];
  let minX =  Infinity, maxX = -Infinity;
  let minZ =  Infinity, maxZ = -Infinity;
  for (const [x, z] of corners) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

// Filtered views rebuilt by updateCulling() whenever the player moves enough
// or the load radius shifts past CULL_HYSTERESIS.
let nearBuildingMeshes = [];
let nearCollidables    = [ground];
// Same contents as nearCollidables but without terrain meshes. Walk-mode
// floor detection raycasts against this list and reads terrain height via
// `terrainManager.sample()` instead — that sample is a bilinear interp of
// the same 4 corner heights the mesh's top quad uses, so Y moves smoothly
// across a slope. Raycasting the blocky mesh directly produced frame-to-
// frame jitter because the 8 ring rays hit the mesh at slightly different
// heights and the MAX-picker kept swapping which one won.
let nearRayCollidables = [ground];

let _cullX = NaN, _cullZ = NaN;
let _cullR = 0;

function updateCulling() {
  const px = camera.position.x, pz = camera.position.z;
  _cullX = px; _cullZ = pz;
  _cullR = cullRadius();
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
  nearRayCollidables = [ground, ...nearBuildingMeshes];

  osmManager.updateLabelVisibility(px, pz);
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
const BASE_RADIUS     = 180;
const BASE_FOG_DENSITY = 0.0038;
const FAR_MARGIN       = 350;
// Compresses the fog ramp into the far ~30% of the view instead of spreading
// it across the full radius — scales density so FogExp2 reaches the same
// opacity at FOG_START_FRAC×_falloffR that it used to reach at _falloffR.
const FOG_START_FRAC  = 0.7;
// Smoothed tracking of the load radius. The raw value jumps whenever a tile
// loads/unloads or the adaptive budget shifts; applying those jumps directly
// to fog density and camera.far makes the horizon appear to jerk during
// flight. Lerping toward the target each frame (FALLOFF_LERP per frame) turns
// a step into a short ramp that the eye reads as smooth.
const FALLOFF_LERP = 0.08;
// Projection-matrix update is O(handful of matrix math + per-material uniform
// re-upload next frame) — cheap individually but runs every frame. Once the
// lerp converges (stable fog/far), we can skip the matrix write without any
// visible effect. 5 cm is below any depth/fog threshold for a ~500 m far
// plane, so the check triggers only at steady-state. Deliberately small so
// the lerp remains responsive while running — we skip only once it's
// genuinely done.
const FALLOFF_EPS = 0.05;
let _falloffR = BASE_RADIUS;
let _lastAppliedFalloffR = BASE_RADIUS;
function updateViewFalloff(targetR) {
  _falloffR += (targetR - _falloffR) * FALLOFF_LERP;
  scene.fog.density = BASE_FOG_DENSITY * (BASE_RADIUS / Math.max(_falloffR * FOG_START_FRAC, 1));
  if (Math.abs(_falloffR - _lastAppliedFalloffR) > FALLOFF_EPS) {
    camera.far = _falloffR + FAR_MARGIN;
    camera.updateProjectionMatrix();
    _lastAppliedFalloffR = _falloffR;
  }
}

let isFlying    = _savedPlayer ? !!_savedPlayer.flying : false;
let lastSpaceTap = 0;
const DOUBLE_TAP_MS = 280;

// Player scale — all lengths/speeds/accelerations below sit ×0.6 against a
// prior ~3 m-tall "giant" pass so proportions vs. city geometry feel natural
// (human ≈ 1.8 m tall, walks ~5 m/s sprinting).
const WALK_HEIGHT   = 1.8;  // eye height above surface
const MIN_EYE_Y     = FLOOR_Y + WALK_HEIGHT; // camera clamp when standing on the default floor (no building underfoot)
const WALK_SPEED    = 4.8;
const SPRINT_SPEED  = 14.4;
const FLY_SPEED     = 13.2;
const FLY_VERT      = 8.4;
const PLAYER_RADIUS = 0.9;  // body collision radius; also used as spawn clearance
const STEP_UP_HEIGHT = 1.0;  // max lip the player auto-climbs when walking
// Visual-only eye smoothing on step-ups. Physics snaps the capsule to the new
// surface instantly (required — otherwise the step reads as a wall and blocks
// forward motion), but the rendered eye lags by the step height and catches
// up exponentially so small cliff edges feel less jarring.
const EYE_STEP_SMOOTH_TAU = 0.12;
let eyeVisualOffset = 0;
const GRAVITY       = 20; // m/s²
const TERMINAL_VEL  = -30;
const JUMP_HEIGHT   = 2.0;  // peak of a standing jump above the ground
const JUMP_VEL      = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT); // v² = 2gh

let velY = 0;
// Edge-triggered jump. Set on a Space keydown that isn't the second half of
// a double-tap fly toggle, consumed (whether or not we actually jumped) on
// the next walking-mode frame so held Space doesn't rebounce and so a stale
// first tap doesn't fire after the fly toggle.
let jumpRequested = false;

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
function syncMapControls(locked = controls.isLocked) {
  const show   = minimapBig || !locked;
  const btn    = document.getElementById('minimap-random');
  const slider = document.getElementById('render-distance');
  const hint   = document.getElementById('minimap-teleport-hint');
  if (btn)    btn.style.display    = show ? '' : 'none';
  if (slider) slider.style.display = show ? '' : 'none';
  if (hint)   hint.style.display   = minimapBig ? 'block' : 'none';
}
syncMapControls(); // set initial visibility (unlocked by default = show)
function applyMinimapLayout() {
  const px = minimapBig ? minimapBigSize() : MINIMAP_SIZE_SMALL;
  setMinimapSize(px);
  // Keep the random-location button and render-distance slider anchored just
  // below the map so the big map doesn't visually swallow them. Map sits at
  // top: 28px; hint follows at (28 + size + 4)px; button follows the hint.
  const btn    = document.getElementById('minimap-random');
  const slider = document.getElementById('render-distance');
  const hint   = document.getElementById('minimap-teleport-hint');
  const hintTop = 28 + px + 4;
  const btnTop  = hintTop + 22;
  if (hint)   hint.style.top   = hintTop + 'px';
  if (btn)    btn.style.top    = btnTop + 'px';
  if (slider) slider.style.top = (btnTop + 34) + 'px';
  syncMapControls();
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

// Rising counter so a second fastTravelTo() started before the first's
// sampleAsync resolves can abandon the stale one. Compared by the awaited
// callback only; no races possible between set and check on the main thread.
let _teleportId = 0;

// Destination of the in-flight teleport. Set before sampleAsync so the
// per-frame gate check uses the destination position, not the current camera
// position (which is still at the old location during the terrain fetch).
let _teleportDestX = 0, _teleportDestZ = 0;

// Mirror the first-page-load experience: unlock pointer, show the dimmed
// "loading" overlay, fetch the destination's terrain height, then place the
// player and wait for nearby tiles to finish loading before letting the user
// click in. Shared by the random-location button and map-click teleport.
//
// Order matters: the overlay is only 40% opaque, so if we moved the camera
// before the terrain cell finished loading, the player would briefly see
// themselves underground (camera at MIN_EYE_Y ≈ -3, terrain usually +3 m).
// sampleAsync triggers a priority fetch for the destination cell so we know
// the ground height before revealing the view.
async function fastTravelTo(x, z) {
  if (!firstTileLoaded) return;
  // Intentionally not gated on `teleporting`: a fresh teleport preempts the
  // in-flight one. _teleportDestX/Z is updated here so gate checks always
  // target the latest destination, not a stale in-flight one.
  const myId = ++_teleportId;
  _teleportDestX = x;
  _teleportDestZ = z;

  teleporting = true;
  overlay.classList.add('loading');
  overlayPrompt.textContent = 'Loading data...';
  colorPickMode = false;
  if (controls.isLocked) controls.unlock();
  else overlay.classList.remove('hidden');
  randomBtn.disabled = true;

  // Close the big map if it was open so the loading overlay is actually
  // visible; resetMinimapPan() runs via toggleMinimapBig.
  if (minimapBig) toggleMinimapBig();

  // Resolve the spawn Y before moving the camera. Falls back to MIN_EYE_Y if
  // terrain is disabled or the destination cell is a 404.
  let spawnY = MIN_EYE_Y;
  if (TERRAIN_ENABLED) {
    try {
      const terrainY = await terrainManager.sampleAsync(x, z);
      if (terrainY !== null) spawnY = terrainY + WALK_HEIGHT;
    } catch {
      // Leave spawnY at MIN_EYE_Y — the walk-mode terrain rescue will snap
      // us up once a covering tile arrives.
    }
    if (myId !== _teleportId) return;
  }

  camera.position.set(x, spawnY, z);
  velY = 0;
  // Keep the current yaw but pitch the view 20° above horizontal so the player
  // lands looking at the skyline, not their feet. YXZ Euler + positive X = up.
  _teleportEuler.setFromQuaternion(camera.quaternion);
  _teleportEuler.x = Math.PI * 20 / 180;
  _teleportEuler.z = 0;
  camera.quaternion.setFromEuler(_teleportEuler);
  updateCulling();

  // Kick the tile manager now so any fresh loads are in-flight before the
  // next frame, and so we can detect the "nothing new to load" case (e.g.
  // teleport landed inside an already-loaded tile) and clear immediately.
  tileManager.tick(x, z);
  tryFinishTeleportLoad();
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
  syncMapControls(true);
});
controls.addEventListener('unlock', () => {
  crosshair.classList.remove('visible');
  // Press-C flow hides the overlay so only the colorbar is visible. ESC leaves
  // colorPickMode false and shows the full overlay, but the colorbar + minimap
  // button remain clickable above it either way.
  if (!colorPickMode) overlay.classList.remove('hidden');
  syncMapControls(false);
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
    if (e.code === 'KeyZ' && controls.isLocked && !e.repeat) {
      e.preventDefault();
      applyUndo();
    }
    return;
  }

  // F3: toggle the debug HUD. Prevent the browser's default search action.
  // Also force-clears a stuck loading gate (first-load or teleport) so the
  // player can escape when no tiles are reachable near the current position.
  if (e.code === 'F3') {
    e.preventDefault();
    debugHudOn = !debugHudOn;
    debugHud.style.display = debugHudOn ? 'block' : 'none';
    if (!firstTileLoaded || teleporting) {
      firstTileLoaded = true;
      teleporting = false;
      overlay.classList.remove('loading', 'startup');
      overlayPrompt.textContent = 'Click to explore';
      randomBtn.disabled = false;
      snapToSafeStart();
    }
    return;
  }

  const wasDown = keys[e.code];
  keys[e.code] = true;

  // Only count the first keydown event (not auto-repeat) as a tap
  if (e.code === 'Space' && controls.isLocked && !wasDown) {
    e.preventDefault();
    const now = performance.now();
    const isDoubleTap = now - lastSpaceTap < DOUBLE_TAP_MS;
    if (isDoubleTap) {
      isFlying = !isFlying;
      if (!isFlying) velY = 0; // start falling cleanly when leaving fly mode
      // Clear any pending jump from the first tap so the player doesn't
      // hop the instant they leave fly mode.
      jumpRequested = false;
    } else if (!isFlying) {
      // First tap in walking — queue a jump for updateMovement. If a second
      // tap arrives within DOUBLE_TAP_MS the branch above will clear this.
      jumpRequested = true;
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

  if (e.code === 'KeyI' && controls.isLocked && !e.repeat) {
    const h = hitCell();
    if (h) {
      const cellData = paintStore.cells.get(h.cellKey);
      if (cellData?.color != null) {
        const idx = COLORS.findIndex(c => c.hex === cellData.color);
        if (idx >= 0) setActiveColor(idx);
      }
    }
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

  // Ray inputs exclude terrain meshes — they're blocky and the 8 ring rays
  // at ±PLAYER_RADIUS produce frame-to-frame jitter as different rings win
  // the MAX on a slope. The terrain-sample read below is the authoritative
  // terrain height (continuous bilinear interp of the mesh's corner heights),
  // and buildings/ground are still raycast because the mesh IS the surface
  // of record there.
  _surfOrig.set(pos.x, pos.y - WALK_HEIGHT + STEP_UP_HEIGHT + 0.15, pos.z);
  downRay.set(_surfOrig, DOWN);
  downRay.far = maxDrop + STEP_UP_HEIGHT + 0.15;
  const centerHits = downRay.intersectObjects(nearRayCollidables, false);
  if (centerHits.length > 0) bestY = centerHits[0].point.y;

  for (let i = 0; i < RING_OFFSETS.length; i++) {
    const [ox, oz] = RING_OFFSETS[i];
    _surfOrig.set(pos.x + ox, pos.y - WALK_HEIGHT + 0.15, pos.z + oz);
    downRay.set(_surfOrig, DOWN);
    downRay.far = maxDrop + 0.15;
    const hits = downRay.intersectObjects(nearRayCollidables, false);
    if (hits.length > 0) {
      const y = hits[0].point.y;
      if (bestY === null || y > bestY) bestY = y;
    }
  }

  // Blocky terrain has vertical step walls. When the player clips into one,
  // the raycast origin sits inside the block and backface culling makes every
  // ray miss — the foot falls through into the ground plane at FLOOR_Y.
  // Consult the heightmap directly so the top of the step is always a
  // candidate surface, whether or not a ray can see it. Only offer it when
  // it's within the normal step-up/drop window so we don't teleport onto a
  // faraway cliff top while the player is standing on a rooftop.
  const terrainY = terrainManager.sample(pos.x, pos.z);
  if (terrainY !== null) {
    const feetY = pos.y - WALK_HEIGHT;
    if (terrainY >= feetY - maxDrop - 0.15 &&
        terrainY <= feetY + STEP_UP_HEIGHT + 0.15 &&
        (bestY === null || terrainY > bestY)) {
      bestY = terrainY;
    }
  }
  return bestY;
}

// ─── Colors ───────────────────────────────────────────────────────────────────

// Based on sweet24 (by bess, lospec.com/palette-list/sweet24), with: shifted
// red, true orange replacing the mustard, added yellow + blue + indigo, dark
// brown/purple removed. 26 colors total, roughly hue-sorted: neutrals → pinks →
// red → oranges → yellow → browns → greens → blues → purple.
const COLORS = [
  { name: 'erase',       hex: null,       css: '#555',     isErase: true  },
  { name: 'black',       hex: 0x1d1b24,   css: '#1d1b24'                  },
  { name: 'dark gray',   hex: 0x46464d,   css: '#46464d'                  },
  { name: 'gray',        hex: 0x7a7576,   css: '#7a7576'                  },
  { name: 'cream',       hex: 0xcec7b1,   css: '#cec7b1'                  },
  { name: 'white',       hex: 0xedefe2,   css: '#edefe2'                  },
  { name: 'pink',        hex: 0xf594aa,   css: '#f594aa'                  },
  { name: 'red',         hex: 0xd6403a,   css: '#d6403a'                  },
  { name: 'salmon',      hex: 0xe68556,   css: '#e68556'                  },
  { name: 'orange',      hex: 0xd66c1c,   css: '#d66c1c'                  },
  { name: 'sand',        hex: 0xe1bf7d,   css: '#e1bf7d'                  },
  { name: 'brown',       hex: 0x936a4d,   css: '#936a4d'                  },
  { name: 'dark brown',  hex: 0x5e3b2f,   css: '#5e3b2f'                  },
  { name: 'gold',        hex: 0xe0a41c,   css: '#e0a41c'                  },
  { name: 'yellow',      hex: 0xf7d020,   css: '#f7d020'                  },
  { name: 'lime',        hex: 0xb9d850,   css: '#b9d850'                  },
  { name: 'bright green',hex: 0x5fc242,   css: '#5fc242'                  },
  { name: 'green',       hex: 0x66a650,   css: '#66a650'                  },
  { name: 'deep teal',   hex: 0x325c4e,   css: '#325c4e'                  },
  { name: 'aqua',        hex: 0x82dcd7,   css: '#82dcd7'                  },
  { name: 'turquoise',   hex: 0x22b4ac,   css: '#22b4ac'                  },
  { name: 'sky',         hex: 0x1c7aa0,   css: '#1c7aa0'                  },
  { name: 'navy',        hex: 0x2d4068,   css: '#2d4068'                  },
  { name: 'blue',        hex: 0x4269c0,   css: '#4269c0'                  },
  { name: 'indigo',      hex: 0x5946b9,   css: '#5946b9'                  },
  { name: 'lavender',    hex: 0xac90cc,   css: '#ac90cc'                  },
  { name: 'dark purple', hex: 0x5e2a6f,   css: '#5e2a6f'                  },
  { name: 'magenta',     hex: 0xa04070,   css: '#a04070'                  },
  { name: 'wine',        hex: 0x6d2047,   css: '#6d2047'                  },
];
const SEED_COLORS = COLORS.filter(c => !c.isErase);
const SEED_COLOR_HEX = SEED_COLORS.map(c => c.hex); // flat hex array forwarded to the tile worker

let activeColorIdx = 7; // start on red
let colorPickMode  = false;

const colorBar = document.getElementById('colorbar');
const swatchEls = COLORS.map((c, i) => {
  const el = document.createElement('div');
  el.className = 'color-swatch' + (i === activeColorIdx ? ' active' : '');
  el.title = c.name;
  el.style.background = c.css;
  if (c.isErase) {
    el.textContent = '✕';
    el.classList.add('erase'); // spans both columns in the 2-col grid
  }
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

// Single-level undo: snapshot of cellKey → previous cellData (null = was absent).
let lastAction = null;

function snapshotCells(primaryKey) {
  const snap = new Map();
  const add = k => snap.set(k, paintStore.cells.get(k) ?? null);
  add(primaryKey);
  const group = cellGroups.get(primaryKey);
  if (group && group.size > 1) for (const k of group) add(k);
  return snap;
}

function applyUndo() {
  if (!lastAction) return;
  for (const [k, prev] of lastAction) {
    if (prev === null) paintStore.erase(k);
    else paintStore.paint(k, prev);
  }
  lastAction = null;
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
  // renderer.info is updated each render(); values here reflect the *previous*
  // frame's draw. Useful for spotting draw-call growth as paint/buildings
  // accumulate and for ruling in/out fragment-bound vs. call-bound GPU cost.
  const r = renderer.info.render;
  // Scene-wide mesh counts split by category so the `calls` number above is
  // attributable: buildings (tile-loaded + merged per-building), paint
  // (per bucket `buildingId:meshType|color` — grows as you paint), terrain
  // (one per loaded cell). If `calls` climbs while only `paint` grows, paint
  // consolidation is the next lever; if `bldg` dominates at load, tightening
  // view radius is.
  const bldgCount    = buildingMeshes.length;
  const paintCount   = buildingPaintMeshes.size;
  const terrainCount = terrainManager.meshes().length;
  const renderLine =
    `draw     ${r.calls} calls   ${r.triangles.toLocaleString()} tris\n` +
    `         bldg ${bldgCount}   paint ${paintCount}   terrain ${terrainCount}`;

  // Per-source streaming backlog. `q` is the deferred queue, `f` is in-flight
  // fetches. The source with the largest q+f gets a `<-` marker so it's
  // obvious which pipeline is currently furthest behind without having to
  // open DevTools → Performance. Paint is reactive (no fetch queue), so we
  // show `_dirtyTiles` — tiles with unsaved edits waiting on the debounced
  // server flush — as its backlog proxy.
  const _streamSources = [
    { name: 'bldg',    q: tileManager._loadQueue.length,    f: tileManager._activeLoads    },
    { name: 'osm',     q: osmManager._loadQueue.length,     f: osmManager._activeLoads     },
    { name: 'terrain', q: terrainManager._loadQueue.length, f: terrainManager._activeLoads },
    { name: 'trees',   q: treeManager ? treeManager._loadQueue.length : 0,
                       f: treeManager ? treeManager._activeLoads      : 0 },
    { name: 'paint',   q: paintStore._dirtyTiles.size, f: 0, kind: 'dirty' },
  ];
  let _streamMax = 0, _streamBehind = -1;
  for (let i = 0; i < _streamSources.length; i++) {
    const b = _streamSources[i].q + _streamSources[i].f;
    if (b > _streamMax) { _streamMax = b; _streamBehind = i; }
  }
  const _streamRows = _streamSources.map((s, i) => {
    const mark = i === _streamBehind && _streamMax > 0 ? '   <-' : '';
    const body = s.kind === 'dirty'
      ? `dirty ${String(s.q).padStart(2)}`
      : `q ${String(s.q).padStart(3)}  f ${String(s.f).padStart(2)}`;
    return `${s.name.padEnd(8)} ${body}${mark}`;
  });
  const streamLine = `stream   ${_streamRows[0]}\n` +
    _streamRows.slice(1).map(r => `         ${r}`).join('\n');

  debugRay.setFromCamera(new THREE.Vector2(0, 0), camera);

  // Separate terrain line so we can show the floor height under the crosshair
  // even when the ray is also hitting a building (useful for debugging the
  // fly-mode terrain rescue). `sample()` reads the DEM heightmap directly and
  // is authoritative — the raycast just gives us an XZ to sample at.
  const terrainHits = debugRay.intersectObjects(terrainManager.meshes(), false);
  const terrainLines = [];
  if (terrainHits.length > 0) {
    const tp   = terrainHits[0].point;
    const sY   = terrainManager.sample(tp.x, tp.z);
    const sStr = sY !== null ? `${sY.toFixed(2)} m` : '—';
    terrainLines.push(`terrain  y ${sStr}   hit ${tp.y.toFixed(2)} m   dist ${terrainHits[0].distance.toFixed(1)} m`);
    const probe = terrainManager.probe(tp.x, tp.z);
    if (probe) {
      terrainLines.push(`  tile   (${probe.gx}, ${probe.gz})   sample (${probe.ix}, ${probe.iz}) / ${probe.res}`);
      terrainLines.push(`  corner NW ${probe.nw.toFixed(2)}  NE ${probe.ne.toFixed(2)}  SE ${probe.se.toFixed(2)}  SW ${probe.sw.toFixed(2)}`);
    }
  }

  const hits = debugRay.intersectObjects(nearBuildingMeshes, false);
  if (!hits.length) {
    debugHud.textContent = terrainLines.length
      ? [fpsLine, renderLine, streamLine, ...terrainLines].join('\n')
      : [fpsLine, renderLine, streamLine, '(no hit)'].join('\n');
    return;
  }
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
  const ck       = fData
    ? centroidKeyStr(fData.centroid)
    : centroidKeyStr([hit.point.x, hit.point.y, hit.point.z]);
  const cellKey  = `${ud.buildingId}:${meshType}:${cu}:${cv}:${ck}:${pdKey}`;
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

  const lines = [
    fpsLine,
    renderLine,
    streamLine,
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
  ];
  if (terrainLines.length) lines.push(...terrainLines);
  debugHud.textContent = lines.join('\n');
}
const buildingPaintMeshes         = new Map(); // "buildingId:meshType" → mesh
const buildingPaintMeshByBuilding = new Map(); // "buildingId:meshType" → Set<mesh>

// Shared material for all paint overlays — vertex colors carry the hue so we
// never need per-mesh material instances. NEVER call .dispose() on this.
const PAINT_MAT = new THREE.MeshBasicMaterial({
  vertexColors: true, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -24,
});
const _paintColor = new THREE.Color(); // scratch — reused per cell to avoid allocation
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
function buildCellGeometry(srcMesh, cellU, cellV, cellNormal, planeD, meshType, cameraPos) {
  const pos = srcMesh.geometry.attributes.position.array;
  const uv  = srcMesh.geometry.attributes.uv.array;
  const faces   = srcMesh.userData.faces;
  const triFace = srcMesh.userData.triFace;
  const verts = [];
  const OFFSET        = 0.012;
  const COPLANAR_TOL  = 0.15; // 15 cm — rejects steps/ledges, accepts tessellation seams
  const cn = [cellNormal.x, cellNormal.y, cellNormal.z];

  // Always offset toward the player regardless of face winding. Convert camera
  // to mesh local space (tiles are translation-only, so this is just a shift),
  // then check which side of the face plane it's on.
  const camLocal = cameraPos.clone();
  srcMesh.worldToLocal(camLocal);
  const offsetSign = (dot3([camLocal.x, camLocal.y, camLocal.z], cn) - planeD) >= 0 ? 1 : -1;

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

    // Fan-triangulate and offset toward the player (offsetSign accounts for winding)
    for (let k = 1; k < poly.length - 1; k++) {
      for (const v of [poly[0], poly[k], poly[k+1]]) {
        verts.push(
          v.pos[0] + cn[0]*OFFSET*offsetSign,
          v.pos[1] + cn[1]*OFFSET*offsetSign,
          v.pos[2] + cn[2]*OFFSET*offsetSign,
        );
      }
    }
  }
  return verts;
}

// Terrain paint cells are simple block faces — no clipping, no cellGeomCache.
// Each face's 6 vertices (2 tris) already exist in the terrain mesh's
// position buffer; the worker emits quads in a known order and TerrainManager
// precomputes a (meshType, ix, iz) → first-vertex-index lookup at tile load.
// We just copy the 18 floats out and offset by the face normal × OFFSET.
// Empty Float32Array if the face isn't emitted on this block (e.g. a cliff
// side pointing at a taller neighbour), which lets the rebuild loop skip it.
function buildTerrainCellGeometry(state, meshType, ix, iz, iy) {
  if (!state || !state.faceStarts) return new Float32Array(0);
  const faceIdx = state.faceStarts[meshType];
  if (!faceIdx) return new Float32Array(0);
  const vi = faceIdx[iz * state.res + ix];
  if (vi < 0) return new Float32Array(0);

  const OFFSET = 0.012;
  const pos = state.mesh.geometry.attributes.position.array;
  const nrm = state.mesh.geometry.attributes.normal.array;
  const nx = nrm[vi * 3], ny = nrm[vi * 3 + 1], nz = nrm[vi * 3 + 2];
  const ox = nx * OFFSET, oy = ny * OFFSET, oz = nz * OFFSET;
  const base = vi * 3;

  // Top face: single cell per (ix, iz), copy the 2-tri quad as-is.
  if (meshType === 'top') {
    const out = new Float32Array(18);
    for (let k = 0; k < 6; k++) {
      out[k * 3    ] = pos[base + k * 3    ] + ox;
      out[k * 3 + 1] = pos[base + k * 3 + 1] + oy;
      out[k * 3 + 2] = pos[base + k * 3 + 2] + oz;
    }
    return out;
  }

  // Side face: clip the quad to the Y band [iy*BLOCK_SIZE, (iy+1)*BLOCK_SIZE]
  // so paint matches the visible grid cell the user clicked. The worker emits
  // each side as 2 tris (p0,p1,p2 / p0,p2,p3) with p0 at vert 0, p1 at 1,
  // p2 at 2, p3 at 5 — see terrainWorker.js::emitQuad. Winding differs per
  // face (west is top,bot,bot,top; east/N/S are top,top,bot,bot) — both are
  // valid convex perimeters, which is all Sutherland–Hodgman needs.
  const p0 = [pos[base +  0], pos[base +  1], pos[base +  2]];
  const p1 = [pos[base +  3], pos[base +  4], pos[base +  5]];
  const p2 = [pos[base +  6], pos[base +  7], pos[base +  8]];
  const p3 = [pos[base + 15], pos[base + 16], pos[base + 17]];
  const poly = [p0, p1, p2, p3];

  const yLo = iy * BLOCK_SIZE;
  const yHi = yLo + BLOCK_SIZE;

  // Sutherland–Hodgman clip of a convex polygon against one half-plane on
  // the Y axis. keepBelow=true keeps points with y <= threshold.
  function clipY(inPoly, threshold, keepBelow) {
    const out = [];
    const n = inPoly.length;
    if (n === 0) return out;
    for (let i = 0; i < n; i++) {
      const curr = inPoly[i];
      const prev = inPoly[(i - 1 + n) % n];
      const currIn = keepBelow ? curr[1] <= threshold : curr[1] >= threshold;
      const prevIn = keepBelow ? prev[1] <= threshold : prev[1] >= threshold;
      if (currIn !== prevIn) {
        const t = (threshold - prev[1]) / (curr[1] - prev[1]);
        out.push([
          prev[0] + (curr[0] - prev[0]) * t,
          threshold,
          prev[2] + (curr[2] - prev[2]) * t,
        ]);
      }
      if (currIn) out.push(curr);
    }
    return out;
  }

  const clipped = clipY(clipY(poly, yHi, true), yLo, false);
  if (clipped.length < 3) return new Float32Array(0);

  // Triangulate as a fan from vertex 0. Output is (n-2) triangles = (n-2)*9
  // floats. For a quad sliced by 2 horizontal planes, n ≤ 6.
  const triCount = clipped.length - 2;
  const out = new Float32Array(triCount * 9);
  let o = 0;
  const writeVert = (p) => {
    out[o++] = p[0] + ox;
    out[o++] = p[1] + oy;
    out[o++] = p[2] + oz;
  };
  for (let i = 1; i <= triCount; i++) {
    writeVert(clipped[0]);
    writeVert(clipped[i]);
    writeVert(clipped[i + 1]);
  }
  return out;
}

// Parse `terrain_{gx}_{gz}:{meshType}` → { gx, gz } (or null if not terrain).
// Robust to negative coordinates (e.g. terrain_-3_-32:top).
function _parseTerrainBuildingKey(buildingKey) {
  const m = /^terrain_(-?\d+)_(-?\d+):/.exec(buildingKey);
  return m ? { gx: +m[1], gz: +m[2] } : null;
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

  // Remove the existing paint mesh for this building (at most one now).
  const existing = buildingPaintMeshes.get(buildingKey);
  if (existing) {
    existing.geometry.dispose(); // material is shared — never dispose it
    paintGroup.remove(existing);
    buildingPaintMeshes.delete(buildingKey);
  }
  buildingPaintMeshByBuilding.delete(buildingKey);

  // Collect cell geometry and per-vertex colors into parallel arrays. Terrain
  // cells bypass cellGeomCache (see comment on terrainCoords below).
  const posArrays   = []; // Float32Array[] of XYZ triples
  const colorArrays = []; // same-length parallel: R,G,B per vertex

  // Terrain cells bypass cellGeomCache: their geometry is trivially derivable
  // from the terrain mesh's position buffer + a (meshType, ix, iz)-indexed
  // face lookup maintained on the tile state. Caching 20k × simple quads per
  // tile would waste ~100 MB at steady state for zero compute gain.
  const terrainCoords = _parseTerrainBuildingKey(buildingKey);
  const terrainState  = terrainCoords
    ? terrainManager.getState(terrainCoords.gx, terrainCoords.gz)
    : null;
  if (terrainCoords && !terrainState) return; // tile unloaded between paint and rebuild

  for (const k of paintStore.cellsForBuilding(buildingKey)) {
    const v = paintStore.cells.get(k);
    if (!v) continue;

    let arr;
    if (terrainState) {
      const parts = k.slice(prefix.length).split(':');
      const ix = parseInt(parts[0]), iz = parseInt(parts[1]);
      const iy = parseInt(parts[2]);
      arr = buildTerrainCellGeometry(terrainState, meshType, ix, iz, iy);
    } else {
      if (!cellGeomCache.has(k)) {
        const parts = k.slice(prefix.length).split(':');
        const cu = parseInt(parts[0]), cv = parseInt(parts[1]);
        const verts = buildCellGeometry(srcMesh, cu, cv, new THREE.Vector3(...v.normal), v.planeD, meshType, camera.position);
        cellGeomCache.set(k, new Float32Array(verts));
        let geomSet = cellGeomByBuilding.get(buildingKey);
        if (!geomSet) { geomSet = new Set(); cellGeomByBuilding.set(buildingKey, geomSet); }
        geomSet.add(k);
      }
      arr = cellGeomCache.get(k);
    }
    if (!arr || !arr.length) continue;

    posArrays.push(arr);

    // setHex applies sRGB→linear conversion to match THREE.MeshBasicMaterial({ color }).
    _paintColor.setHex(v.color);
    const r = _paintColor.r, g = _paintColor.g, b = _paintColor.b;
    const vCnt = arr.length / 3; // vertices in this cell
    const col  = new Float32Array(vCnt * 3);
    for (let i = 0; i < vCnt; i++) { col[i*3]=r; col[i*3+1]=g; col[i*3+2]=b; }
    colorArrays.push(col);
  }

  if (!posArrays.length) return;

  const totalVerts = posArrays.reduce((s, a) => s + a.length, 0);
  const allPos   = new Float32Array(totalVerts);
  const allColor = new Float32Array(totalVerts); // same length (3 floats/vert)
  let off = 0;
  for (let i = 0; i < posArrays.length; i++) {
    allPos.set(posArrays[i], off);
    allColor.set(colorArrays[i], off);
    off += posArrays[i].length;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(allColor, 3));
  // polygonOffset beats any OSM layer's (-1/-6) so paint wins the depth test vs draped OSM at grazing angles.
  const mesh = new THREE.Mesh(geo, PAINT_MAT);
  mesh.visible = srcMesh.visible;
  mesh.userData.paintMeshKey = buildingKey; // stashed so TileManager._unload can delete by lookup
  paintGroup.add(mesh);
  buildingPaintMeshes.set(buildingKey, mesh);
  buildingPaintMeshByBuilding.set(buildingKey, new Set([mesh]));
}

// When any cell changes, schedule a rebuild for its building (debounced to one per frame).
paintStore.subscribe((cellKey) => {
  // Buildings: drop pdKey, centroidKey, cellV, cellU (4 trailing segments)
  // Terrain:   drop iy, iz, ix                        (3 trailing segments)
  const parts = cellKey.split(':');
  const trailing = cellKey.startsWith('terrain_') ? 3 : 4;
  for (let i = 0; i < trailing; i++) parts.pop();
  schedulePaintRebuild(parts.join(':'));
});

const SEED_FRACTION = 0; // fraction of cells to randomly seed on load (applied in tileWorker.js)

// Apply the worker's pre-computed cell data to paint caches. The triangle scan
// + clipping + seed dice roll all happened off-thread; this pass just copies
// Float32Arrays into cellGeomCache and calls paintStore.seed for cells that
// aren't already user-painted. Still chunked so a giant tile doesn't push
// rebuildBuildingPaint calls into one frame.
async function seedTileCells(meshes) {
  const SEED_CHUNK = 50;
  const now        = Date.now();
  const tSeed      = performance.now();

  // Tile is "seed-locked" only after every mesh has been processed without
  // being abandoned mid-way (see abandoned flag below). Resolved lazily from
  // the first mesh we touch since seedTileCells takes meshes, not a tileId.
  let tileId    = null;
  let abandoned = false;

  for (let start = 0; start < meshes.length; start += SEED_CHUNK) {
    const end = Math.min(start + SEED_CHUNK, meshes.length);

    for (let mi = start; mi < end; mi++) {
      const srcMesh = meshes[mi];
      if (!srcMesh.parent) { abandoned = true; continue; } // tile unloaded before we got here

      const perType = srcMesh.userData.cellDataByType;
      if (!perType) continue; // already applied, or wrapped without worker data

      const { buildingId } = srcMesh.userData;

      // Iterate each meshType's CellBundle independently — cellKeys, seeds,
      // and paint-mesh keys are all scoped to (building, meshType).
      for (const meshType in perType) {
        const cellData = perType[meshType];
        const bk = `${buildingId}:${meshType}`;
        if (!tileId) tileId = paintStore.tileIdOfBuilding(bk);

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

        // Skip seed rolls once the tile is marked complete on disk — the
        // pattern is locked in and further rolls would grow coverage past
        // the intended ~10%. Partial tiles (never reached the sentinel) stay
        // unlocked and get another shot on every reload.
        const tileLocked = tileId && paintStore.isTileSeedComplete(tileId);

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

    // rAF instead of requestIdleCallback: idle time can starve to zero under
    // continuous movement, which was the original "bottom third seeded, rest
    // empty" symptom. rAF fires every frame so seeding makes steady progress.
    if (end < meshes.length) await new Promise(r => requestAnimationFrame(r));
  }

  // Only mark the tile seed-complete if we made it through every mesh without
  // abandonment. If any mesh was skipped because its parent was gone, the tile
  // stays unlocked and the next load gets another shot.
  if (tileId && !abandoned) paintStore.markTileSeedComplete(tileId);

  performance.measure('tile:seed', { start: tSeed, end: performance.now() });
}

// Seed ~SEED_FRACTION of terrain top-face cells per tile, gated by the same
// persistent seed-complete sentinel as buildings. Sides are stacked in iy
// bands we'd need the block's Y range to sample correctly; top faces exist
// on every block and give uniform coverage, so this is top-only.
//
// Runs synchronously — one tile is ~4096 top faces, which is fast enough
// that the tile can't unload mid-seed (unload only happens on tick()).
// Caller (onTerrainLoaded) invokes this before its rebuild pass so a single
// rebuildBuildingPaint call covers server-persisted cells and fresh seeds
// together.
const _seedWaterRay = new THREE.Raycaster();
_seedWaterRay.ray.direction.set(0, -1, 0);

function seedTerrainCells(state) {
  if (!state.faceStarts) return;
  if (paintStore.isTileSeedComplete(state.tileId)) return;

  // Skip cells over OSM water. If the covering OSM tile isn't loaded+draped
  // yet we bail without marking the tile complete — the next terrain reload
  // will retry once OSM has caught up. An empty array means "no water here",
  // the fast path for inland tiles.
  const waterMeshes = osmManager.waterMeshesForCell(state.gx, state.gz);
  if (waterMeshes === null) return;

  const meshType = 'top';
  const faceIdx  = state.faceStarts[meshType];
  if (!faceIdx) { paintStore.markTileSeedComplete(state.tileId); return; }

  const bk  = `${state.tileId}:${meshType}`;
  const res = state.res;
  const now = Date.now();
  const b   = state.bounds;
  const step = (b.maxX - b.minX) / res;

  if (SEED_FRACTION === 0) { paintStore.markTileSeedComplete(state.tileId); return; }

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      if (faceIdx[iz * res + ix] < 0) continue;
      if (Math.random() >= SEED_FRACTION) continue;
      const cellKey = `${bk}:${ix}:${iz}:0`;
      if (paintStore.cells.has(cellKey)) continue; // preserve user paint / prior seed

      if (waterMeshes.length) {
        const [wx, wz] = gridToWorld(b.minX + (ix + 0.5) * step, b.minZ + (iz + 0.5) * step);
        _seedWaterRay.ray.origin.set(wx, 10000, wz);
        if (_seedWaterRay.intersectObjects(waterMeshes, false).length) continue;
      }

      const color = SEED_COLOR_HEX[(Math.random() * SEED_COLOR_HEX.length) | 0];
      paintStore.seed(cellKey, {
        color,
        normal:    [0, 1, 0],
        planeD:    0,
        paintedAt: now,
      });
    }
  }

  paintStore.markTileSeedComplete(state.tileId);
}

// ── Paint / erase actions ─────────────────────────────────────────────────────

// Face-centroid segment of a cellKey. Must match tileWorker.centroidKey().
// Distinguishes laterally-separated faces on the same building that share a
// normal direction and fall in the same 50 cm pdKey bucket.
function centroidKeyStr(centroid) {
  return `${Math.round(centroid[0] * 100)}_${Math.round(centroid[1] * 100)}_${Math.round(centroid[2] * 100)}`;
}

/**
 * Given a tentative cellKey built from a raycast hit's face planeD, return
 * the canonical cellKey in cellGeomCache for the same visual cell. The worker
 * dedupes overlapping cells by merging them under one anchor face's pdKey —
 * but a raycast that hits a different face would compute a different pdKey,
 * so we scan this building's cells for the same (cu, cv, centroidKey) and
 * pick the nearest pdKey (within 1 bucket = 50 cm of planeD). The centroidKey
 * match keeps the fallback from crossing onto a different face that happens
 * to share (cu, cv) via its own UV origin.
 */
function canonicalCellKey(buildingKey, cu, cv, ck, pdKey) {
  const tentative = `${buildingKey}:${cu}:${cv}:${ck}:${pdKey}`;
  if (cellGeomCache.has(tentative)) return tentative;
  const geomSet = cellGeomByBuilding.get(buildingKey);
  if (!geomSet) return tentative;
  const targetPrefix = `${buildingKey}:${cu}:${cv}:${ck}:`;
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
  // Terrain meshes are always raycast targets alongside the building near-set.
  // Distance filter below handles PAINT_DIST; terrain hits pass through the
  // terrain branch further down. OSM water meshes are included so we can
  // reject aim points over water — water sits ~2.4 mm above terrain so the
  // first hit is always water wherever water exists.
  const hits = paintRay.intersectObjects(
    [...nearBuildingMeshes, ...terrainManager.meshes(), ...osmManager.waterMeshes()], false,
  );
  if (!hits.length || hits[0].distance > PAINT_DIST) return null;
  const hit  = hits[0];
  const mesh = hit.object;
  if (mesh.userData.isWater) return null;

  // Terrain branch — one block face per cell, no UVs, no planeDKey. The tile's
  // buildingKeys cover all 5 face types; we pick the one matching the hit
  // normal and index by (ix, iz) within the tile. The cellKey is already
  // canonical (the tile owns exactly one cell per face per block).
  if (mesh.name === 'terrain') {
    const ud = mesh.userData;
    const b  = ud.bounds;
    if (!b) return null;
    const state = terrainManager.getState(ud.terrainGX, ud.terrainGZ);
    if (!state) return null;
    // Terrain cells live in grid space; the raycast hit is in world space and
    // `b` is the cell's grid-space AABB. Rotate the hit point into grid space
    // and classify the side-face normal against grid-cardinal axes.
    const step = (b.maxX - b.minX) / state.res;
    const [hu, hv] = worldToGrid(hit.point.x, hit.point.z);

    const tNormal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    const [gnx, gnz] = worldToGrid(tNormal.x, tNormal.z);
    let tMeshType;
    if      (tNormal.y >  0.5) tMeshType = 'top';
    else if (gnx < -0.5) tMeshType = 'sideW';
    else if (gnx >  0.5) tMeshType = 'sideE';
    else if (gnz < -0.5) tMeshType = 'sideN';
    else                 tMeshType = 'sideS';

    // Side-face quads sit exactly on cell boundaries in grid space (west at
    // x = ix·step, east at x = (ix+1)·step, etc.). Flooring the raw hit point
    // is ambiguous at that boundary — for sideE/sideS it deterministically
    // lands one cell past the owning block, and for sideW/sideN float ε can
    // flip either way. Nudge the probe inward (along the inward face normal)
    // so we always classify into the block that actually owns the face.
    let probeU = hu, probeV = hv;
    const nudge = step * 0.5;
    if      (tMeshType === 'sideW') probeU += nudge;
    else if (tMeshType === 'sideE') probeU -= nudge;
    else if (tMeshType === 'sideN') probeV += nudge;
    else if (tMeshType === 'sideS') probeV -= nudge;

    let ix = Math.floor((probeU - b.minX) / step);
    let iz = Math.floor((probeV - b.minZ) / step);
    if (ix < 0) ix = 0; else if (ix >= state.res) ix = state.res - 1;
    if (iz < 0) iz = 0; else if (iz >= state.res) iz = state.res - 1;

    // Cliff sides split into vertical strips aligned with the Y grid lines
    // drawn by gridShader, so one paint cell corresponds to one visible grid
    // square. Top faces stay single-cell (iy = 0) — their grid is already
    // supplied by (ix, iz) on the horizontal.
    const iy = tMeshType === 'top'
      ? 0
      : Math.floor(hit.point.y / BLOCK_SIZE);

    const tBuildingKey = `${ud.terrainTileId}:${tMeshType}`;
    const tCellKey = `${tBuildingKey}:${ix}:${iz}:${iy}`;
    return {
      cellU: ix, cellV: iz,
      normal: tNormal,
      planeD: 0,
      mesh,
      cellKey: tCellKey,
    };
  }

  // Buildings require UVs — reject if the raycast landed on a degenerate tri
  // that didn't produce UV coords.
  if (!hit.uv) return null;

  // Prefer the face's averaged normal + planeD when available. The worker's
  // seed cache generates cellKeys from face.planeD; using per-triangle planeD
  // here would round into a different 50 cm bucket for any triangle whose
  // normal drifted slightly from the face average. Worker dedupe then anchors
  // the cell on one face's pdKey; canonicalCellKey below redirects any
  // neighboring pdKey onto that anchor.
  let normal, planeD, ck;
  const faces   = mesh.userData.faces;
  const triFace = mesh.userData.triFace;
  const fi = (faces && triFace) ? triFace[hit.faceIndex] : -1;
  if (fi >= 0) {
    const f = faces[fi];
    normal = new THREE.Vector3(f.normal[0], f.normal[1], f.normal[2])
      .transformDirection(mesh.matrixWorld).normalize();
    planeD = f.planeD;
    ck = centroidKeyStr(f.centroid);
  } else {
    // Degenerate hit with no face data — we can't recover the face centroid,
    // so fall back to the hit point itself. Same-face subsequent hits will
    // disagree on this, but fi<0 hits are rare enough (CityGML cleanup edge
    // cases) that we accept the imperfect fallback over dropping the click.
    normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    planeD = normal.dot(hit.point);
    ck = centroidKeyStr([hit.point.x, hit.point.y, hit.point.z]);
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
  const cellKey = canonicalCellKey(`${buildingId}:${meshType}`, cellU, cellV, ck, pd);

  return { cellU, cellV, normal, planeD, mesh, cellKey };
}

function tryPaint() {
  const activeColor = COLORS[activeColorIdx];
  if (activeColor.isErase) { tryErase(); return; }
  const h = hitCell();
  if (!h) return;

  lastAction = snapshotCells(h.cellKey);

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

  lastAction = snapshotCells(h.cellKey);

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
// eye → near-feet so short ledges and low overhangs are caught. Expressed as
// fractions of WALK_HEIGHT so they track player scale automatically.
const CAPSULE_SAMPLE_OFFSETS = [0, -0.3 * WALK_HEIGHT, -0.6 * WALK_HEIGHT, -(WALK_HEIGHT - 0.15)];

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

    // Buildings and terrain both get pushed out of the capsule the same
    // way — including terrain meshes here is how cliffs block at
    // PLAYER_RADIUS and slide on diagonals without any special-case code.
    // nearCollidables is [ground, ...buildings, ...terrainMeshes]; ground's
    // PlaneGeometry has no computed bounding box so it no-ops on the bb
    // check below. Horizontal terrain tops pass the 30°-from-horizontal
    // filter and are skipped, so only vertical cliff sides contribute.
    for (const mesh of nearCollidables) {
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

  eyeVisualOffset *= Math.exp(-dt / EYE_STEP_SMOOTH_TAU);
  if (Math.abs(eyeVisualOffset) < 0.001) eyeVisualOffset = 0;

  if (!controls.isLocked) return;

  // ── Horizontal ──────────────────────────────────────────────────────────────

  const flyBoost = isFlying && keys['KeyQ'] ? 3 : 1;
  const speed = isFlying
    ? FLY_SPEED * flyBoost
    : (keys['KeyQ'] ? SPRINT_SPEED : WALK_SPEED);

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
      const rayBlocked = hits.length > 0 && hits[0].distance <= drop;
      // Heightmap gate for stepped terrain: raycast misses when the foot
      // origin is already inside a block (backface-culled from below), so we
      // also consult the DEM directly. Either source is enough to block.
      const terrainY = terrainManager.sample(camera.position.x, camera.position.z);
      const terrainBlocks = terrainY !== null &&
        camera.position.y + dy - WALK_HEIGHT < terrainY;
      if (rayBlocked || terrainBlocks) _flyVel.y = 0;
      else camera.position.y += dy;
    }
    // Buried-below-terrain rescue. Cliff blocking/sliding is handled by
    // resolveCapsule (terrain meshes are iterated alongside buildings), so
    // the only case left is the player's feet ending up below the terrain
    // heightmap — typically from a save/teleport that landed inside a
    // block, or numerical drift where the downward ray missed the top face.
    // Snap Y up to the surface so gravity finds it next frame.
    const terrainYRescue = terrainManager.sample(camera.position.x, camera.position.z);
    if (terrainYRescue !== null && camera.position.y - WALK_HEIGHT < terrainYRescue) {
      camera.position.y = terrainYRescue + WALK_HEIGHT;
      _flyVel.y = 0;
    }
    camera.position.y = Math.max(MIN_EYE_Y, camera.position.y);
  } else {
    // Buried-below-terrain rescue — cliff blocking/sliding is handled by
    // resolveCapsule since terrain meshes are now iterated alongside
    // buildings. The remaining case is feet below the heightmap from a
    // save/teleport or a surfaceBelow ray that missed because its origin
    // was inside the block. Snap Y up so gravity re-grounds next frame.
    const terrainY = terrainManager.sample(camera.position.x, camera.position.z);
    if (terrainY !== null && camera.position.y - WALK_HEIGHT < terrainY) {
      camera.position.y = terrainY + WALK_HEIGHT;
      velY = 0;
    }

    // Jump — edge-triggered via jumpRequested, which the Space keydown
    // handler sets only on a first tap (not the second tap of a double-tap
    // fly toggle). The landing branch below zeros velY on every touchdown,
    // so velY === 0 is the grounded test. Consume the flag unconditionally
    // so a mid-air tap doesn't get banked for the next landing.
    if (jumpRequested && velY === 0) velY = JUMP_VEL;
    jumpRequested = false;

    // Gravity
    velY = Math.max(velY - GRAVITY * dt, TERMINAL_VEL);
    const dY = velY * dt;

    if (dY < 0) {
      // Falling — look for a surface within this frame's drop distance
      const surf = surfaceBelow(camera.position, Math.abs(dY));
      if (surf !== null) {
        // Land (or stay grounded)
        const newY = surf + WALK_HEIGHT;
        const step = newY - camera.position.y;
        if (step > 0) eyeVisualOffset -= step;
        camera.position.y = newY;
        velY = 0;
      } else {
        camera.position.y += dY;
        // Hard floor fallback
        if (camera.position.y < MIN_EYE_Y) {
          camera.position.y = MIN_EYE_Y;
          velY = 0;
        }
      }
    } else if (dY > 0) {
      // Ascending from a jump. Ceilings don't block — matches fly mode's
      // upward-is-free rule so players can't get trapped under overhangs.
      camera.position.y += dY;
    }
  }

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

// True if (x, z) sits directly under any building polygon — a downward ray
// from well above Manhattan's tallest skyscraper hits a building mesh. Catches
// the big-interior case that positionIsClear misses (its 1.6 m ring rays can
// run clean through an empty atrium without ever touching a wall).
const _skyOrigin = new THREE.Vector3();
function positionIsUnderBuilding(x, z) {
  _skyOrigin.set(x, 2000, z);
  snapRay.set(_skyOrigin, DOWN);
  snapRay.far = 2100;
  return snapRay.intersectObjects(nearBuildingMeshes, false).length > 0;
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

// Teleport-specific: shift horizontally if the landing spot is under a
// building polygon. Kept separate from snapToSafeStart so rooftop *saves*
// (initial page load) aren't ejected — teleport always lands at terrain
// level, so "under building" there means "inside the building".
function snapOutOfBuildingFootprint() {
  const cx = camera.position.x, cz = camera.position.z;
  if (!positionIsUnderBuilding(cx, cz)) return;

  for (let r = 5; r <= 120; r += 5) {
    const steps = Math.max(8, Math.round(r * 1.2));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(angle) * r;
      const z = cz + Math.sin(angle) * r;
      if (!positionIsUnderBuilding(x, z)) {
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
let _startupTerrainDone = false;

// Teleport loading state — the random-location button re-enters the same
// "Loading tiles…" overlay as the initial page load, cleared when every
// tile in load range of the new position has finished loading.
let teleporting = false;

// Phase 1 of startup: fetch terrain for the spawn position and place the
// player on the ground, then clear the full-black overlay so the world is
// visible (at 40% opacity) while remaining tiles stream in. Mirrors the
// terrain-first fetch in fastTravelTo so both flows behave identically.
async function _doStartupTerrainFirst() {
  const x = camera.position.x, z = camera.position.z;
  if (TERRAIN_ENABLED) {
    try {
      const terrainY = await terrainManager.sampleAsync(x, z);
      // Preserve saved-player Y (rooftop saves etc.); only snap fresh spawns.
      if (terrainY !== null && !_savedPlayer) camera.position.y = terrainY + WALK_HEIGHT;
    } catch {}
  }
  overlay.classList.remove('startup');
  _startupTerrainDone = true;
}

// Phase 2 of startup: gate until terrain, OSM, and building tiles around the
// spawn position have all settled (loaded or 404). Called every frame so it
// fires as soon as all conditions are met without needing explicit callbacks.
function tryFinishInitialLoad() {
  if (firstTileLoaded) return;
  if (!_startupTerrainDone) return;
  if (!tileManager._manifestLoaded) return;
  const x = camera.position.x, z = camera.position.z;
  if (!tileManager.allNearbyTilesLoaded(x, z)) return;
  if (TERRAIN_ENABLED && !terrainManager.allNearbySettled(x, z)) return;
  if (!osmManager.allNearbySettled(x, z)) return;

  firstTileLoaded = true;
  overlay.classList.remove('loading'); // 'startup' already removed by _doStartupTerrainFirst
  overlayPrompt.textContent = 'Click to explore';
  randomBtn.disabled = false;
  if (!_savedPlayer) snapOutOfBuildingFootprint();
  snapToSafeStart();
}

// Gate check for teleport: all three managers must be settled before
// finishTeleportLoad() unlocks. Checked immediately after each trigger
// (building tile load, terrain load) and every frame to catch OSM settling.
function tryFinishTeleportLoad() {
  if (!teleporting) return;
  // Use the stored destination, not camera.position — the camera is still at
  // the old location during the sampleAsync terrain fetch, and we must not
  // pass the gate against the already-loaded old tiles.
  if (!tileManager.allNearbyTilesLoaded(_teleportDestX, _teleportDestZ)) return;
  if (TERRAIN_ENABLED && !terrainManager.allNearbySettled(_teleportDestX, _teleportDestZ)) return;
  if (!osmManager.allNearbySettled(_teleportDestX, _teleportDestZ)) return;
  finishTeleportLoad();
}

function finishTeleportLoad() {
  if (!teleporting) return;
  teleporting = false;
  overlay.classList.remove('loading');
  overlayPrompt.textContent = 'Click to explore';
  randomBtn.disabled = false;
  snapOutOfBuildingFootprint();
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
    tryFinishInitialLoad();
    if (teleporting) tryFinishTeleportLoad();
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

tileManager.init(`${import.meta.env.VITE_CDN_BASE ?? ''}/tiles/manifest.json`);

// OSM overlay — streets, water, and green spaces rendered as flat meshes on
// the ground. OSM and terrain share a fixed load radius independent of the
// adaptive building radius.
// Terrain-on: DEM heightfields stream in, OSM textures composite in the
// terrain shader.
// Terrain-off (VITE_TERRAIN=0, e.g. `npm run dev:flat`): no DEM loading,
// buildings are Y-shifted to sit at y=0 in the worker, OSM overlays render
// as the pre-terrain mesh stack (LAND/water/green/streets at Y_LAND..Y_STREET
// with polygon-offset biasing). TerrainManager is replaced with a null-object
// so the rest of main.js (spawn, collision, rescue) keeps calling it
// unconditionally.
let treeManager = null;

const terrainManager = TERRAIN_ENABLED
  ? new TerrainManager({
      scene,
      // Paint plumbing — lets terrain tiles register their 5 face-type
      // buildingKeys in the shared paint caches. Same maps the building
      // pipeline uses; rebuildBuildingPaint picks the terrain path when
      // the buildingKey starts with "terrain_".
      buildingMeshMap,
      buildingPaintMeshes,
      buildingPaintMeshByBuilding,
      paintGroup,
      // Fires once per terrain-tile load after the server paint fetch
      // resolves. Rebuilds paint overlays for any face-type that has cells
      // so persisted graffiti appears as soon as you re-enter the tile.
      // Also nudges OsmManager to re-drape any OSM overlay meshes whose
      // vertices fall inside this terrain cell — they would have been
      // pinned at y=offset if they loaded before the covering terrain
      // cell did.
      onTerrainLoaded(state) {
        seedTerrainCells(state);
        for (const bk of state.buildingKeys) {
          const cells = paintStore.cellsForBuilding(bk);
          if (cells && cells.size > 0) rebuildBuildingPaint(state.mesh, bk);
        }
        // state.bounds is GRID space (rotated ~29° from world); OSM tile
        // bounds are world space. Convert the 4 grid corners to world XZ
        // and take their AABB so OsmManager's axis-aligned overlap check
        // against world-space tile bounds is coherent — otherwise the
        // redrape misses OSM tiles whose world-space footprint intersects
        // this terrain cell but whose world-coords happen to fall outside
        // the grid-space interval, leaving their drape pinned at yOffset
        // (buried in terrain, invisible). Bug was latent when drape
        // geometry extended far past tile bounds; post-bake-clip the
        // drape is tight to the tile and the misses become visible holes.
        osmManager.redrapeOverBounds(_gridBoundsToWorldAABB(state.bounds));
        if (treeManager) treeManager.onTerrainCellLoaded();
      },
      onTerrainUnloaded() {
        updateCulling();
      },
    })
  : {
      tick() {},
      sample() { return null; },
      sampleAsync() { return Promise.resolve(null); },
      meshes() { return []; },
      getState() { return null; },
      setRadiusScale() {},
      allNearbySettled() { return true; },
    };

// In terrain mode, OSM features render as draped vector geometry: streets as
// miter-joined ribbons, water/green as triangulated polygons, every triangle
// tessellated to the terrain block grid and planted on per-vertex terrain
// samples. The terrain material is LAND-coloured so uncovered stretches
// already read as land — no land mesh needed. Street labels drape via
// terrain.sample() so they sit on the street surface.
const osmManager = new OsmManager({
  scene,
  terrain:    TERRAIN_ENABLED ? terrainManager : null,
  flatMode:   !TERRAIN_ENABLED,
  showLabels: true,
});
osmManager.init(`${import.meta.env.VITE_CDN_BASE ?? ''}/osm/manifest.json`);

if (TERRAIN_ENABLED) {
  treeManager = new TreeManager({ scene, terrain: terrainManager });
}

// Render-distance slider — scales building/OSM/terrain load radii together.
// Building radius is adaptive (budget-driven) so the scale is applied to both
// its MIN/MAX and its cell budget; OSM/terrain scale linearly off a fixed base.
{
  const slider = document.getElementById('render-distance-slider');
  const label  = document.getElementById('render-distance-val');
  const apply = (v) => {
    tileManager.setRadiusScale(v);
    osmManager.setRadiusScale(v);
    terrainManager.setRadiusScale(v);
    label.textContent = v.toFixed(2) + '×';
  };
  slider.addEventListener('input', () => apply(parseFloat(slider.value)));
  apply(parseFloat(slider.value));
}

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

// Loading indicator — shows one row per data source whose fetch pipeline is
// currently busy. Each row has a short minimum-on time so a tile that finishes
// in a single frame still registers visually instead of flickering.
const _loadingRows = [
  { el: document.getElementById('loading-buildings'), mgr: tileManager,    showUntil: 0 },
  { el: document.getElementById('loading-osm'),       mgr: osmManager,     showUntil: 0 },
  { el: document.getElementById('loading-terrain'),   mgr: terrainManager, showUntil: 0 },
];
const _paintSaveEl    = document.getElementById('loading-paint');
let   _paintShowUntil = 0;
const LOADING_MIN_VISIBLE_MS = 250;
function updateLoadingIndicator(now) {
  // Startup overlay already says "Loading data..." — suppress the bottom-left
  // rows until the overlay is dismissed so we don't say the same thing twice.
  const overlayVisible = !overlay.classList.contains('hidden');
  for (const row of _loadingRows) {
    const busy = row.mgr._activeLoads > 0 || row.mgr._loadQueue.length > 0;
    if (busy) row.showUntil = now + LOADING_MIN_VISIBLE_MS;
    const shouldShow = !overlayVisible && now < row.showUntil;
    const isHidden   = row.el.classList.contains('hidden');
    if (shouldShow && isHidden)        row.el.classList.remove('hidden');
    else if (!shouldShow && !isHidden) row.el.classList.add('hidden');
  }
  if (paintStore.isDirty) _paintShowUntil = now + LOADING_MIN_VISIBLE_MS;
  const paintShow   = !overlayVisible && now < _paintShowUntil;
  const paintHidden = _paintSaveEl.classList.contains('hidden');
  if (paintShow && paintHidden)        _paintSaveEl.classList.remove('hidden');
  else if (!paintShow && !paintHidden) _paintSaveEl.classList.add('hidden');
}

function animate(now) {
  requestAnimationFrame(animate);
  if (now - _lastFrameTime < FRAME_INTERVAL) return;
  _lastFrameTime = now;
  tickFps(now);

  tileManager.tick(camera.position.x, camera.position.z);
  osmManager.tick(camera.position.x, camera.position.z);
  terrainManager.tick(camera.position.x, camera.position.z);
  if (treeManager) treeManager.tick(camera.position.x, camera.position.z);
  if (!firstTileLoaded) tryFinishInitialLoad();
  if (teleporting) tryFinishTeleportLoad();
  updateViewFalloff(cullRadius());
  maybeCull();
  updateMovement();
  ground.position.x = camera.position.x;
  ground.position.z = camera.position.z;
  camera.getWorldDirection(_minimapDir);
  updateMinimap(camera.position.x, camera.position.z, Math.atan2(_minimapDir.x, -_minimapDir.z));
  updateDebugHud();
  updateLoadingIndicator(now);
  camera.position.y += eyeVisualOffset;
  renderer.render(scene, camera);
  camera.position.y -= eyeVisualOffset;
}

_doStartupTerrainFirst();
animate(0);
