import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { TileManager } from './TileManager.js';
import { OsmManager } from './OsmManager.js';
import { TerrainManager } from './TerrainManager.js';
import { TreeManager } from './TreeManager.js';
import { PigeonManager } from './PigeonManager.js';
import { paintStore } from './paintStore.js';
import { gridToWorld, worldToGrid, MANHATTAN_GRID_DEG } from './geo.js';
import { createPhysics, WALK_HEIGHT } from './physics.js';
import { createPaintManager } from './paintManager.js';
import { tilesWithLandmarks, prepareLandmarks, landmarksReady, tileInjection } from './landmarks.js';
import {
  initMinimap, updateMinimap, setMinimapSize,
  adjustMinimapZoom, adjustMinimapPan, resetMinimapPan,
  minimapMetersPerPixel, minimapPixelToWorld,
  toggleMinimapHeadingUp, getMinimapHeadingUp,
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

// Fresh-spawn pool. `yawDeg` is a compass heading in degrees (CW from true
// north); applied as a negative Y-Euler because negative Y rotation turns
// the camera CW viewed from above. Add new locations freely — the random
// pick below handles the rest. Tune if the view doesn't frame the subject.
const SPAWN_LOCATIONS = [
  // Times Square (42nd St & 7th Ave) — facing uptown along 7th Ave.
  { name: 'Times Square',       x: 2215, y:  1.70, z: -5928, yawDeg: MANHATTAN_GRID_DEG },
  // Flatiron — north of the building looking back south at the prow.
  { name: 'Flatiron',           x: 1903, y: 14.33, z: -4116, yawDeg: -174 },
  // Washington Sq Park — south of the fountain, facing the arch.
  { name: 'Washington Sq Park', x: 1196, y: 10.90, z: -2883, yawDeg:   29 },
  // Bowling Green — southern tip of Broadway, looking uptown.
  { name: 'Bowling Green',      x: -166, y:  7.34, z:   -14, yawDeg:   16 },
];
const _spawn = SPAWN_LOCATIONS[Math.floor(Math.random() * SPAWN_LOCATIONS.length)];
camera.position.set(_spawn.x, _spawn.y, _spawn.z);

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
} else {
  // Apply the randomly-picked spawn's heading (CW-from-north → negative Y-Euler).
  camera.quaternion.setFromEuler(new THREE.Euler(0, -_spawn.yawDeg * Math.PI / 180, 0, 'YXZ'));
}

function savePlayerState() {
  try {
    localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
      px: camera.position.x, py: camera.position.y, pz: camera.position.z,
      qx: camera.quaternion.x, qy: camera.quaternion.y, qz: camera.quaternion.z, qw: camera.quaternion.w,
      flying: physics.isFlying,
    }));
  } catch {}
}

window.addEventListener('beforeunload', savePlayerState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePlayerState();
});

function syncRendererToViewport() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', syncRendererToViewport);
// Some mobile browsers (and Chrome's device emulator) settle the viewport
// meta after the script's initial run, leaving the canvas stuck at the pre-
// viewport size. Re-sync on `load` once layout is definitely final.
window.addEventListener('load', syncRendererToViewport);

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
        const paintSet = paint.buildingPaintMeshByBuilding.get(bk);
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

// Player physics (movement, capsule collision, gravity, spawn placement) lives
// in physics.js. The instance is created further down, once terrainManager is
// available — movement reads terrain heights each frame.
let physics;

// Paint system (palette, cell caches, hit-test, paint/erase, seeding) lives in
// paintManager.js. Forward-declared so input handlers/updateCulling/debug HUD
// can close over it before the managers it needs (terrain/osm) exist.
let paint;

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

// Three's lock() calls requestPointerLock() without returning or catching its
// promise, so the rejection Chrome fires during its ~1.25s post-Escape cooldown
// surfaces as an unhandled SecurityError. Override to swallow it — the 'lock'
// event only fires on success, so a failed attempt leaves the overlay up and
// the user can simply click again.
controls.lock = () => {
  const p = renderer.domElement.requestPointerLock();
  if (p && typeof p.catch === 'function') p.catch(() => {});
};
// Three also attaches its own pointerlockerror listener that unconditionally
// console.errors on the same cooldown failure. Remove it — our override + the
// prompt-hiding cooldown UX already cover the case.
document.removeEventListener('pointerlockerror', controls._onPointerlockError);

const overlay       = document.getElementById('overlay');
const overlayPrompt = document.getElementById('overlay-prompt');
const crosshair     = document.getElementById('crosshair');
const minimapWrap = document.getElementById('minimap-wrap');
initMinimap();

// Compass rose: click to toggle between north-up and heading-up minimap modes.
// Rotated each frame below so the red arrow always points to true north on
// screen — acts as a constant visual ground-truth regardless of mode.
const compassEl = document.getElementById('compass');
compassEl.addEventListener('click', (e) => {
  e.stopPropagation();  // don't let the click fall through to minimap-click teleport in big mode
  toggleMinimapHeadingUp();
});
// Prevent mousedown from starting a pan drag when the compass is hit in big mode.
compassEl.addEventListener('mousedown', (e) => { e.stopPropagation(); });

// Small vs. big minimap. 234 px mirrors the initial HTML canvas size; big mode
// fills half the shorter viewport axis (so it's ~a quarter of the screen's
// area, always square, never overflows on portrait windows).
const MINIMAP_SIZE_SMALL = 234;
function minimapBigSize() {
  return Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.5);
}
let minimapBig = false;
function applyMinimapLayout() {
  setMinimapSize(minimapBig ? minimapBigSize() : MINIMAP_SIZE_SMALL);
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

const _teleportEuler = new THREE.Euler(0, 0, 0, 'YXZ');

// Rising counter so a second fastTravelTo() started before the first's
// sampleAsync resolves can abandon the stale one. Compared by the awaited
// callback only; no races possible between set and check on the main thread.
let _teleportId = 0;

// Destination of the in-flight teleport. Set before sampleAsync so the
// per-frame gate check uses the destination position, not the current camera
// position (which is still at the old location during the terrain fetch).
let _teleportDestX = 0, _teleportDestZ = 0;

// Unlock pointer, show the dimmed "loading" overlay, fetch the destination's
// terrain height, then place the player and wait for nearby tiles to finish
// loading before letting the user click back in. Used by the map-click
// teleport.
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
  overlayPrompt.textContent = 'loading data...';
  paint.closeColorPicker();
  if (controls.isLocked) controls.unlock();
  else overlay.classList.remove('hidden');

  // Close the big map if it was open so the loading overlay is actually
  // visible; resetMinimapPan() runs via toggleMinimapBig.
  if (minimapBig) toggleMinimapBig();

  // Resolve the spawn Y before moving the camera. Falls back to MIN_EYE_Y if
  // terrain is disabled or the destination cell is a 404.
  let spawnY = physics.MIN_EYE_Y;
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
  physics.resetFallVelocity();
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
  if (e.button !== 0) return;
  // Accept clicks on the big map, or on the small map while the game is
  // escaped (unlocked). In locked first-person the cursor is captured, so
  // the small map can't receive clicks anyway.
  if (!minimapBig && controls.isLocked) return;
  const { x, y } = _mapMouseLocal(e);
  _mapDragging = true;
  _mapDragMoved = false;
  _mapDragStartX = _mapDragLastX = x;
  _mapDragStartY = _mapDragLastY = y;
  if (minimapBig) minimapWrap.classList.add('dragging');
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
  // Panning only applies to the big map; the small map just tracks a click.
  if (minimapBig) {
    // Dragging right moves content right → view centre shifts left (west).
    // In heading-up mode the canvas is rotated by −yaw, so the screen-space
    // drag delta must be rotated back into world XZ by +yaw before applying.
    const m = minimapMetersPerPixel();
    if (getMinimapHeadingUp()) {
      const c = Math.cos(_lastMinimapYaw), s = Math.sin(_lastMinimapYaw);
      const wdx = dxPx * c - dyPx * s;
      const wdy = dxPx * s + dyPx * c;
      adjustMinimapPan(-wdx * m, -wdy * m);
    } else {
      adjustMinimapPan(-dxPx * m, -dyPx * m);
    }
  }
});

document.addEventListener('mouseup', (e) => {
  if (!_mapDragging) return;
  _mapDragging = false;
  minimapWrap.classList.remove('dragging');
  if (_mapDragMoved) return;
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

// -1 = idle; 0 = left held (paint); 2 = right held (erase). Checked each frame
// in animate() so holding the mouse paints every new cell under the crosshair —
// but only after HOLD_DRAG_MS, so a quick click paints exactly one cell.
let paintHeldButton = -1;
let paintHeldAt     = 0;
const HOLD_DRAG_MS  = 300;

function endPaintStroke() {
  if (paintHeldButton === -1) return;
  paint.endStroke();
  paintHeldButton = -1;
}

renderer.domElement.addEventListener('mousedown', e => {
  if (!controls.isLocked) { if (e.button === 0 && firstTileLoaded) { paint.closeColorPicker(); controls.lock(); } return; }
  if (e.button === 0)      { paintHeldButton = 0; paintHeldAt = performance.now(); paint.beginStroke(); paint.tryPaint(); }
  else if (e.button === 2) { paintHeldButton = 2; paintHeldAt = performance.now(); paint.beginStroke(); paint.tryErase(); }
});
// Listen on window so a mouseup outside the canvas (e.g. over the HUD) still ends the stroke.
window.addEventListener('mouseup', e => {
  if ((e.button === 0 && paintHeldButton === 0) || (e.button === 2 && paintHeldButton === 2)) {
    endPaintStroke();
  }
});
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
overlay.addEventListener('click', () => { if (firstTileLoaded && !teleporting) controls.lock(); });

// After any pointer-lock exit, Chrome enforces a ~1.25s cooldown before
// requestPointerLock() will succeed. During that window the "Click to explore"
// prompt is a lie, so hide it and restore it once the cooldown lifts.
let promptRestoreTimer = null;

controls.addEventListener('lock', () => {
  overlay.classList.add('hidden');
  crosshair.classList.add('visible');
  // Re-locking means the user is returning to first-person — close the big
  // map (and reset its pan) so it doesn't stay spread across the game view.
  if (minimapBig) toggleMinimapBig();
  minimapWrap.classList.remove('escaped');
  if (promptRestoreTimer) { clearTimeout(promptRestoreTimer); promptRestoreTimer = null; }
  overlayPrompt.style.visibility = '';
});
controls.addEventListener('unlock', () => {
  // Close any in-progress brush stroke so undo captures exactly what's committed.
  endPaintStroke();
  crosshair.classList.remove('visible');
  // Press-C flow hides the overlay so only the colorbar is visible. ESC leaves
  // colorPickMode false and shows the full overlay, but the colorbar + minimap
  // button remain clickable above it either way.
  if (!paint.isColorPicking) overlay.classList.remove('hidden');
  minimapWrap.classList.add('escaped');
  overlayPrompt.style.visibility = 'hidden';
  if (promptRestoreTimer) clearTimeout(promptRestoreTimer);
  promptRestoreTimer = setTimeout(() => {
    overlayPrompt.style.visibility = '';
    promptRestoreTimer = null;
  }, 1300);
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
      if (e.shiftKey) paint.applyRedo(); // Ctrl+Shift+Z
      else paint.applyUndo();
    }
    if (e.code === 'KeyY' && controls.isLocked && !e.repeat) {
      e.preventDefault();
      paint.applyRedo();
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
      overlayPrompt.textContent = 'click to explore';
      physics.snapToSafeStart();
    }
    return;
  }

  const wasDown = keys[e.code];
  keys[e.code] = true;

  // Only count the first keydown event (not auto-repeat) as a tap
  if (e.code === 'Space' && controls.isLocked && !wasDown) {
    e.preventDefault();
    physics.handleSpaceTap();
  }

  if (e.code === 'Tab' && !e.repeat) {
    e.preventDefault();
    paint.cycleActiveColor(e.shiftKey);
  }

  if (e.code === 'KeyC' && controls.isLocked && !e.repeat) {
    paint.openColorPicker();
  }

  if (e.code === 'KeyI' && controls.isLocked && !e.repeat) {
    paint.pickColorFromAim();
  }

  if (e.code === 'KeyM' && !e.repeat) {
    toggleMinimapBig();
  }

  if (e.code === 'KeyX' && !e.repeat) {
    // Toggle the in-game controls hud. Pause-menu CSS forces it visible
    // regardless, so the toggle only takes effect once gameplay resumes.
    document.getElementById('overlay-controls').classList.toggle('hidden');
  }

  // Cheat code: typing "refill" anywhere fires a paint-bank refill request.
  // Server gates on REFILL_SECRET; first use per session prompts for the
  // secret and caches it in sessionStorage. Wrong secret → cached value is
  // cleared so the next attempt re-prompts.
  if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    _cheatBuffer = (_cheatBuffer + e.key.toLowerCase()).slice(-CHEAT_CODE.length);
    if (_cheatBuffer === CHEAT_CODE) {
      _cheatBuffer = '';
      tryCheatRefill();
    }
  }
});

const CHEAT_CODE = 'refill';
const CHEAT_SECRET_KEY = 'graffiti_refill_secret';
let _cheatBuffer = '';
let _cheatInFlight = false;

async function tryCheatRefill() {
  if (_cheatInFlight) return;
  let secret = sessionStorage.getItem(CHEAT_SECRET_KEY);
  if (!secret) {
    secret = window.prompt('refill secret?');
    if (!secret) return;
    sessionStorage.setItem(CHEAT_SECRET_KEY, secret);
  }
  _cheatInFlight = true;
  try {
    const result = await paintStore.tryRefill(secret);
    if (result === 'forbidden') {
      sessionStorage.removeItem(CHEAT_SECRET_KEY);
      console.warn('refill: wrong secret, cached value cleared');
    } else if (result === 'error') {
      console.warn('refill: request failed');
    } else {
      // Brief green flash on the paint-bank readout so the cheat has visible
      // feedback even when the bucket was already at capacity.
      _paintBankEl.classList.remove('flash');
      void _paintBankEl.offsetWidth; // force reflow so the class re-apply restarts the animation
      _paintBankEl.classList.add('flash');
    }
  } finally {
    _cheatInFlight = false;
  }
}

document.addEventListener('keyup', e => { keys[e.code] = false; });

// Clear all held keys whenever focus or pointer lock is lost. The browser
// doesn't expose physical key state, so if a key is down when focus leaves
// (e.g. alt-tab), no keyup ever arrives and the key "sticks". If the user is
// still genuinely holding it when they return, OS auto-repeat re-fires keydown
// within ~30ms. blur alone is unreliable on Windows + pointer lock, so we
// also hook visibilitychange and the PointerLockControls unlock event.
const clearHeldKeys = () => { for (const k in keys) keys[k] = false; };
window.addEventListener('blur', clearHeldKeys);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') clearHeldKeys();
});
controls.addEventListener('unlock', clearHeldKeys);

// (Colors, undo, paint state — see paintManager.js.)

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
  white-space: pre; z-index: 9999;
  user-select: text; -webkit-user-select: text; cursor: text;
  display: none;
`;
document.body.appendChild(debugHud);

// Freeze HUD updates while the cursor is over it — textContent is rewritten
// every frame, which blows away any active text selection the user is trying
// to copy. Hover-pause lets them read/copy the snapshot from the moment they
// moved onto the HUD. Values resume updating once the cursor leaves.
let _debugHudHovered = false;
debugHud.addEventListener('mouseenter', () => { _debugHudHovered = true; });
debugHud.addEventListener('mouseleave', () => { _debugHudHovered = false; });

function updateDebugHud() {
  if (!debugHudOn) return;
  if (_debugHudHovered) return;
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
  const paintCount   = paint.buildingPaintMeshCount;
  const terrainCount = terrainManager.meshes().length;
  const renderLine =
    `draw     ${r.calls} calls   ${r.triangles.toLocaleString()} tris\n` +
    `         bldg ${bldgCount}   paint ${paintCount}   terrain ${terrainCount}`;

  // Per-source streaming backlog. `q` is the deferred queue, `f` is in-flight
  // fetches. The source with the largest q+f gets a `<-` marker so it's
  // obvious which pipeline is currently furthest behind without having to
  // open DevTools → Performance. Paint is reactive (no fetch queue), so we
  // show `pendingTileCount` — tiles with unsaved edits waiting on the
  // debounced server flush — as its backlog proxy.
  const _streamSources = [
    { name: 'bldg',    q: tileManager._loadQueue.length,    f: tileManager._activeLoads    },
    { name: 'osm',     q: osmManager._loadQueue.length,     f: osmManager._activeLoads     },
    { name: 'terrain', q: terrainManager._loadQueue.length, f: terrainManager._activeLoads },
    { name: 'trees',   q: treeManager ? treeManager._loadQueue.length : 0,
                       f: treeManager ? treeManager._activeLoads      : 0 },
    { name: 'paint',   q: paintStore.pendingTileCount, f: 0, kind: 'dirty' },
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

  // Current position + heading in SPAWN_LOCATIONS format. Stand where you
  // want a new spawn, open the HUD, and paste the line into the array.
  // _lastMinimapYaw is the same yaw the minimap uses (CW from true north).
  const spawnLine =
    `spawn    { x: ${Math.round(camera.position.x)}, ` +
    `y: ${camera.position.y.toFixed(2)}, ` +
    `z: ${Math.round(camera.position.z)}, ` +
    `yawDeg: ${Math.round(_lastMinimapYaw * 180 / Math.PI)} }`;

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
      ? [fpsLine, renderLine, streamLine, spawnLine, ...terrainLines].join('\n')
      : [fpsLine, renderLine, streamLine, spawnLine, '(no hit)'].join('\n');
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
    ? paint.centroidKeyStr(fData.centroid)
    : paint.centroidKeyStr([hit.point.x, hit.point.y, hit.point.z]);
  const cellKey  = `${ud.buildingId}:${meshType}:${cu}:${cv}:${ck}:${pdKey}`;
  const cached   = paint.cellGeomCache.get(cellKey);
  const area     = cached ? paint.geomArea(cached) : null;
  const pdMismatch = facePD != null &&
    Math.round(facePD * 2) !== Math.round(triPD * 2);

  // Paint status. If this flips from "no" to "yes <color>" right after a
  // click, the paintStore is receiving the paint correctly and the problem
  // is downstream in rebuildBuildingPaint / the mesh itself. If it stays
  // "no", the click isn't reaching this cellKey at all.
  const stored = paintStore.cells.get(cellKey);
  const paintMeshCount = (paint.buildingPaintMeshByBuilding.get(`${ud.buildingId}:${meshType}`) || new Set()).size;

  const group       = paint.cellGroups.get(cellKey);
  const groupSize   = group ? group.size : 1;

  const lines = [
    fpsLine,
    renderLine,
    streamLine,
    spawnLine,
    `bldg     ${ud.buildingId}`,
    `hit      (${hit.point.x.toFixed(1)}, ${hit.point.y.toFixed(1)}, ${hit.point.z.toFixed(1)})`,
    `mesh     ${meshType}   tri ${faceIdx}   face ${fi}`,
    `cell     (${cu}, ${cv})   pdKey ${pdKey}`,
    `cellKey  ${cellKey}`,
    `cache    ${cached ? `hit (area ${area.toFixed(2)} m²${area < paint.SMALL_CELL_AREA ? ' — SLIVER' : ''})` : 'MISS'}`,
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

// Maps "buildingId:meshType" → mesh so paint overlays can look up source geometry.
// Shared across main, TileManager, TerrainManager, and paintManager (which
// reads it during flushPaintRebuilds to resolve a buildingKey to its mesh).
const buildingMeshMap = new Map();

// ─── Paint ────────────────────────────────────────────────────────────────────
//
// Paint is created here (before TileManager) because TileManager needs the
// paint bindings (cellGeomCache, seedConfig, onTileCellData, etc.) spread into
// its constructor. Paint, in turn, needs terrainManager / osmManager, which
// don't exist yet — hence the deferred getters.
paint = createPaintManager({
  scene,
  camera,
  controls,
  crosshairEl: crosshair,
  colorbarEl:  document.getElementById('colorbar'),
  overlayEl:   overlay,
  getTerrainManager:     () => terrainManager,
  getOsmManager:         () => osmManager,
  getNearBuildingMeshes: () => nearBuildingMeshes,
  buildingMeshMap,
  shiftBuildingsY: !TERRAIN_ENABLED,
});

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

// True once building tiles, terrain (if enabled), and OSM around (x, z) have
// all settled (loaded or 404). Shared by the startup gate and the teleport
// gate — the two conditions were identical modulo the position argument.
function allManagersSettledAt(x, z) {
  if (!tileManager.allNearbyTilesLoaded(x, z)) return false;
  if (TERRAIN_ENABLED && !terrainManager.allNearbySettled(x, z)) return false;
  if (!osmManager.allNearbySettled(x, z)) return false;
  return true;
}

// Phase 2 of startup: gate until terrain, OSM, and building tiles around the
// spawn position have all settled. Called every frame so it fires as soon as
// all conditions are met without needing explicit callbacks.
function tryFinishInitialLoad() {
  if (firstTileLoaded) return;
  if (!_startupTerrainDone) return;
  if (!tileManager._manifestLoaded) return;
  if (!allManagersSettledAt(camera.position.x, camera.position.z)) return;

  firstTileLoaded = true;
  overlay.classList.remove('loading'); // 'startup' already removed by _doStartupTerrainFirst
  overlayPrompt.textContent = 'click to explore';
  if (!_savedPlayer) physics.snapOutOfBuildingFootprint();
  physics.snapToSafeStart();
}

// Gate check for teleport. Uses the stored destination, not camera.position —
// the camera is still at the old location during the sampleAsync terrain
// fetch, and we must not pass the gate against the already-loaded old tiles.
function tryFinishTeleportLoad() {
  if (!teleporting) return;
  if (!allManagersSettledAt(_teleportDestX, _teleportDestZ)) return;
  finishTeleportLoad();
}

function finishTeleportLoad() {
  if (!teleporting) return;
  teleporting = false;
  overlay.classList.remove('loading');
  overlayPrompt.textContent = 'click to explore';
  physics.snapOutOfBuildingFootprint();
  physics.snapToSafeStart();
}

// Landmark overrides (see src/landmarks.js). Tile IDs containing landmarks
// are computed up front so resolveTileInjection knows which tiles to gate
// on landmark prep — most tiles return null (no injection) immediately.
// prepareLandmarks runs once terrainManager exists (further down) and
// flips landmarksReady() to true; until then, landmark tiles return
// 'pending' and TileManager defers loading them.
const _landmarkTiles = tilesWithLandmarks();

const tileManager = new TileManager({
  scene,
  buildingMeshes,
  collidables,
  buildingMeshMap,
  resolveTileInjection: (tileId) => {
    if (!_landmarkTiles.has(tileId)) return null;
    if (!landmarksReady()) return 'pending';
    return tileInjection(tileId);
  },
  ...paint.tileManagerBindings,
  onTileLoaded(meshes) {
    // Phase 1 — buildings are visible now. The spawn gate opens here so the
    // player can start interacting before the seed scan (phase 2) finishes.
    updateCulling();
    // If this tile's buildings just engulfed the player, eject them
    // horizontally. Only runs post-spawn; initial placement handles itself via
    // snapToSafeStart / snapOutOfBuildingFootprint in tryFinishInitialLoad.
    if (physics && firstTileLoaded && !teleporting) {
      physics.popOutOfBuildingCeiling(meshes);
    }
    tryFinishInitialLoad();
    if (teleporting) tryFinishTeleportLoad();
  },
  onTileCellData(meshes) {
    // Phase 2 — worker's seed scan result is now on mesh.userData.cellDataByType,
    // keyed by meshType. Populate cellGeomCache and apply seeded paint.
    paint.seedTileCells(meshes);
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
let pigeonManager = null;

const terrainManager = TERRAIN_ENABLED
  ? new TerrainManager({
      scene,
      // Paint plumbing — lets terrain tiles register their 5 face-type
      // buildingKeys in the shared paint caches. Same maps the building
      // pipeline uses; rebuildBuildingPaint picks the terrain path when
      // the buildingKey starts with "terrain_".
      buildingMeshMap,
      ...paint.terrainManagerBindings,
      // Fires once per terrain-tile load after the server paint fetch
      // resolves. Rebuilds paint overlays for any face-type that has cells
      // so persisted graffiti appears as soon as you re-enter the tile.
      // Also nudges OsmManager to re-drape any OSM overlay meshes whose
      // vertices fall inside this terrain cell — they would have been
      // pinned at y=offset if they loaded before the covering terrain
      // cell did.
      onTerrainLoaded(state) {
        paint.seedTerrainCells(state);
        for (const bk of state.buildingKeys) {
          const cells = paintStore.cellsForBuilding(bk);
          if (cells && cells.size > 0) paint.rebuildBuildingPaint(state.mesh, bk);
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
        osmManager.redrapeOverBounds(_gridBoundsToWorldAABB(state.bounds), state.bounds);
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

// Landmark prep — resolves terrain Y for each landmark via sampleAsync, then
// transforms the local-space triangles into world space and builds the
// per-tile injection lookup. resolveTileInjection (set up where TileManager
// is constructed) returns 'pending' for landmark tiles until this resolves.
prepareLandmarks({ terrain: terrainManager }).catch(err => {
  console.error('prepareLandmarks failed:', err);
});

if (TERRAIN_ENABLED) {
  treeManager = new TreeManager({ scene, terrain: terrainManager });
  // Pigeons temporarily disabled — the 3D-mesh rewrite still needs visual polish
  // before going to prod. Re-enable by uncommenting.
  // pigeonManager = new PigeonManager({
  //   scene,
  //   terrain: terrainManager,
  //   getBuildings: () => buildingMeshes,
  // });
  // window.pigeonManager = pigeonManager;
}

// Dev-only: lets DevTools issue one-off paint wipes (e.g. after a landmark
// topology change orphans cells under stale cellKeys).
window.paintStore = paintStore;

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

// ─── Physics ──────────────────────────────────────────────────────────────────
//
// Wired up now (not at module top) because movement reads terrainManager each
// frame. The getters keep physics in sync with updateCulling's wholesale
// reassignment of the near-* arrays.
physics = createPhysics({
  camera,
  controls,
  keys,
  terrain: terrainManager,
  floorY: FLOOR_Y,
  initialFlying: !!_savedPlayer?.flying,
  getNearColliders:    () => nearCollidables,
  getNearRayColliders: () => nearRayCollidables,
  getNearBuildings:    () => nearBuildingMeshes,
});

// ─── Render loop ──────────────────────────────────────────────────────────────

const _minimapDir = new THREE.Vector3();
let _lastMinimapYaw = 0;

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

// Paint-bank HUD: bottom-right token readout. `paintStore.tickBucket()` fires
// our subscribeBucket listener each animation tick (~1 Hz via the
// _lastPaintBankTick gate below) so the "+1 in Ys" countdown advances without
// a separate timer.
const _paintBankEl        = document.getElementById('paint-bank');
const _paintBankCountEl   = document.getElementById('paint-bank-count');
const _paintBankRefillEl  = document.getElementById('paint-bank-refill');
let   _lastPaintBankTick  = 0;

function renderPaintBank(state) {
  if (!state.ready) {
    _paintBankCountEl.textContent  = 'paint: loading…';
    _paintBankRefillEl.textContent = '';
    _paintBankEl.classList.remove('empty');
    return;
  }
  _paintBankCountEl.textContent = `paint: ${state.tokens}/${state.capacity}`;
  if (state.tokens >= state.capacity) {
    _paintBankRefillEl.textContent = 'full';
  } else {
    const secs = Math.max(1, Math.ceil(state.msUntilNext / 1000));
    _paintBankRefillEl.textContent = `+1 in ${secs}s`;
  }
  _paintBankEl.classList.toggle('empty', state.tokens === 0);
}
paintStore.subscribeBucket(renderPaintBank);
renderPaintBank(paintStore.getBucketState());
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

// Tiles the player is currently "near" poll on paintStore's fast loop (6 s);
// everything else sweeps at 30 s. Recomputed at 1 Hz while pointer-locked:
// standing building tile + standing terrain tile + the tile owning the cell
// under the crosshair. While unlocked (menu / afk), pulls pause entirely so
// idle tabs don't burn server requests indefinitely. hitCell raycasts, so
// the 1 Hz cadence keeps per-frame cost negligible.
let _lastActiveTilesUpdate = 0;

function updateActiveTiles() {
  const active = new Set();
  const px = camera.position.x, pz = camera.position.z;
  active.add(`cell_${Math.floor(px / 100)}_${Math.floor(pz / 100)}`);
  const [u, v] = worldToGrid(px, pz);
  active.add(`terrain_${Math.floor(u / 125)}_${Math.floor(v / 125)}`);

  const h = paint.hitCell();
  if (h?.cellKey) {
    const tid = paintStore.tileIdOfCell(h.cellKey);
    if (tid) active.add(tid);
  }
  paintStore.setActiveTiles(active);
}

function animate(now) {
  requestAnimationFrame(animate);
  if (now - _lastFrameTime < FRAME_INTERVAL) return;
  _lastFrameTime = now;
  tickFps(now);

  if (now - _lastActiveTilesUpdate > 1000) {
    _lastActiveTilesUpdate = now;
    if (controls.isLocked) {
      paintStore.setPaused(false);
      updateActiveTiles();
    } else {
      paintStore.setPaused(true);
    }
  }

  tileManager.tick(camera.position.x, camera.position.z);
  osmManager.tick(camera.position.x, camera.position.z);
  terrainManager.tick(camera.position.x, camera.position.z);
  if (treeManager) treeManager.tick(camera.position.x, camera.position.z);
  if (pigeonManager) {
    pigeonManager.tick(camera.position.x, camera.position.z);
    pigeonManager.update(now / 1000, camera.position.x, camera.position.z);
  }
  if (!firstTileLoaded) tryFinishInitialLoad();
  if (teleporting) tryFinishTeleportLoad();
  updateViewFalloff(cullRadius());
  maybeCull();
  physics.updateMovement();
  if (paintHeldButton !== -1 && now - paintHeldAt > HOLD_DRAG_MS) {
    if (paintHeldButton === 0) paint.tryPaint();
    else                       paint.tryErase();
  }
  ground.position.x = camera.position.x;
  ground.position.z = camera.position.z;
  camera.getWorldDirection(_minimapDir);
  _lastMinimapYaw = Math.atan2(_minimapDir.x, -_minimapDir.z);
  updateMinimap(camera.position.x, camera.position.z, _lastMinimapYaw);
  // North-up: compass arrow always points up. Heading-up: map was rotated
  // by −yaw, so screen-space north is at +yaw off vertical — rotate the
  // compass by −yaw to track it.
  compassEl.style.transform = getMinimapHeadingUp()
    ? `rotate(${-_lastMinimapYaw}rad)`
    : 'rotate(0deg)';
  updateDebugHud();
  updateLoadingIndicator(now);
  if (now - _lastPaintBankTick >= 1000) {
    _lastPaintBankTick = now;
    paintStore.tickBucket();
  }
  const eyeOffset = physics.eyeVisualOffset;
  camera.position.y += eyeOffset;
  renderer.render(scene, camera);
  camera.position.y -= eyeOffset;
}

_doStartupTerrainFirst();
animate(0);
