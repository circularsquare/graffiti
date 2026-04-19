import { localToLngLat } from './geo.js';

const TILE_SIZE    = 256;  // OSM tile pixel size
const ZOOM_MIN     = 13;
const ZOOM_MAX     = 19;
const ZOOM_DEFAULT = 16;   // ~325m visible across 180px canvas at latitude 40.7°
// Redraw every animation frame. drawImage on cached tile textures is a few
// GPU composites — cheap enough that 60 fps is fine even for the big map,
// and keeps rotation visually smooth while mouse-looking.
const INTERVAL  = 0;
const EARTH_CIRCUM_M = 40075016.686;

// Tile image cache: "z/tx/ty" → HTMLImageElement
const _cache = new Map();

let _ctx      = null;
let _lastTime = -Infinity;
let _size     = 180;   // current canvas side in px — mutable via setMinimapSize
let _zoom     = ZOOM_DEFAULT;  // fractional; floor is the OSM tile z, remainder scales drawImage
let _panX     = 0;     // metres — world X offset of view centre from player
let _panZ     = 0;     // metres — world Z offset of view centre from player
let _viewLat  = 40.70475;  // last drawn view-centre latitude, cached for metresPerPixel()

export function initMinimap() {
  const canvas = document.getElementById('minimap');
  _ctx  = canvas.getContext('2d');
  _size = canvas.width;
}

/**
 * Resize the minimap canvas in-place. Updates the wrapper div so its drop
 * shadow/border tracks the new size, and forces a redraw on the next tick
 * (throttled _draw would otherwise skip the immediate call after a toggle).
 */
export function setMinimapSize(px) {
  _size = px;
  const canvas = document.getElementById('minimap');
  canvas.width  = px;
  canvas.height = px;
  const wrap = document.getElementById('minimap-wrap');
  if (wrap) {
    wrap.style.width  = px + 'px';
    wrap.style.height = px + 'px';
  }
  _lastTime = -Infinity;
}

export function getMinimapZoom() { return _zoom; }
export function setMinimapZoom(z) {
  _zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}
export function adjustMinimapZoom(delta) { setMinimapZoom(_zoom + delta); }

export function resetMinimapPan() { _panX = 0; _panZ = 0; }
export function adjustMinimapPan(dxMetres, dzMetres) {
  _panX += dxMetres;
  _panZ += dzMetres;
}

/**
 * World metres per canvas pixel at the current zoom and view latitude.
 * Web Mercator is conformal, so this is the same in X and Y.
 */
export function minimapMetersPerPixel() {
  const tileM = EARTH_CIRCUM_M * Math.cos(_viewLat * Math.PI / 180) / (2 ** _zoom);
  return tileM / TILE_SIZE;
}

/**
 * Convert a canvas-space pixel (px, py) to local world coordinates (x, z),
 * given the player's current world position. Uses the currently drawn
 * view centre (player + pan) and zoom.
 */
export function minimapPixelToWorld(px, py, playerX, playerZ) {
  const m = minimapMetersPerPixel();
  const dxPx = px - _size / 2;
  const dyPx = py - _size / 2;
  return {
    x: playerX + _panX + dxPx * m,
    z: playerZ + _panZ + dyPx * m,
  };
}

/**
 * Call once per frame from the render loop.
 * @param {number} x   - world X (east/west metres)
 * @param {number} z   - world Z (north/south metres, north = negative)
 * @param {number} yaw - camera yaw in radians, CW from north: 0=N, π/2=E
 */
export function updateMinimap(x, z, yaw) {
  const now = performance.now();
  if (now - _lastTime < INTERVAL) return;
  _lastTime = now;
  _draw(x, z, yaw);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function latLngToTileFrac(lat, lng, z) {
  const n      = 2 ** z;
  const tx     = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const ty     = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return [tx, ty];
}

function getTile(z, tx, ty) {
  const key = `${z}/${tx}/${ty}`;
  if (_cache.has(key)) return _cache.get(key);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`;
  _cache.set(key, img); // store before load completes to prevent double-fetch
  img.onload = () => { _cache.set(key, img); };
  return img;
}

function _draw(playerX, playerZ, yaw) {
  const viewX = playerX + _panX;
  const viewZ = playerZ + _panZ;
  const [vlng, vlat] = localToLngLat(viewX, viewZ);
  _viewLat = vlat;

  const zFloor   = Math.floor(_zoom);
  const scaleF   = 2 ** (_zoom - zFloor);
  const tileSize = TILE_SIZE * scaleF;
  const maxTile  = 2 ** zFloor - 1;

  const [ftx,  fty]  = latLngToTileFrac(vlat, vlng, zFloor);
  const [plng, plat] = localToLngLat(playerX, playerZ);
  const [pftx, pfty] = latLngToTileFrac(plat, plng, zFloor);

  const cx = _size / 2, cy = _size / 2;
  _ctx.clearRect(0, 0, _size, _size);

  // Map is drawn north-up (unrotated). Only the player arrow below rotates.
  _ctx.save();
  _ctx.translate(cx, cy);

  // Axis-aligned map: reach = enough tiles to cover half the canvas side,
  // plus one for fractional offsets. No √2 slack needed without rotation.
  const reach = Math.max(1, Math.ceil(_size / (2 * tileSize)) + 1);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = Math.floor(ftx) + dx;
      const ty = Math.floor(fty) + dy;
      if (tx < 0 || ty < 0 || tx > maxTile || ty > maxTile) continue;
      const img = getTile(zFloor, tx, ty);
      if (!img.complete || !img.naturalWidth) continue;
      // Pixel offset of this tile's top-left from the view centre.
      const drawX = (tx - ftx) * tileSize;
      const drawY = (ty - fty) * tileSize;
      _ctx.drawImage(img, drawX, drawY, tileSize, tileSize);
    }
  }

  _ctx.restore();

  // Player marker — offset from the view centre by (player - view) in pixels.
  // Rotates with yaw so the arrow tip tracks the player's heading on a
  // north-up map. When pan is zero, the marker sits at canvas centre.
  const markerX = cx + (pftx - ftx) * tileSize;
  const markerY = cy + (pfty - fty) * tileSize;
  _ctx.save();
  _ctx.translate(markerX, markerY);
  _ctx.rotate(yaw);

  // Shadow triangle for contrast against any map colour.
  _ctx.beginPath();
  _ctx.moveTo(0, -9); _ctx.lineTo(-6, 5); _ctx.lineTo(6, 5);
  _ctx.closePath();
  _ctx.fillStyle = 'rgba(0,0,0,0.5)';
  _ctx.fill();

  // Main red triangle — tip points in the direction the player is facing.
  _ctx.beginPath();
  _ctx.moveTo(0, -8); _ctx.lineTo(-5, 4); _ctx.lineTo(5, 4);
  _ctx.closePath();
  _ctx.fillStyle = '#ff2222';
  _ctx.fill();
  _ctx.restore();
}
