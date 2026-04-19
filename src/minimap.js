import { localToLngLat } from './geo.js';

const ZOOM      = 16;   // OSM zoom level — ~325m visible across 180px canvas
const TILE_SIZE = 256;  // OSM tile pixel size
// Redraw every animation frame. drawImage on cached tile textures is a few
// GPU composites — cheap enough that 60 fps is fine even for the big map,
// and keeps rotation visually smooth while mouse-looking.
const INTERVAL  = 0;

// Tile image cache: "z/tx/ty" → HTMLImageElement
const _cache = new Map();

let _ctx      = null;
let _lastTime = -Infinity;
let _size     = 180;   // current canvas side in px — mutable via setMinimapSize

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

function latLngToTileFrac(lat, lng) {
  const n      = 2 ** ZOOM;
  const tx     = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const ty     = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return [tx, ty];
}

function getTile(tx, ty) {
  const key = `${ZOOM}/${tx}/${ty}`;
  if (_cache.has(key)) return _cache.get(key);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `https://tile.openstreetmap.org/${ZOOM}/${tx}/${ty}.png`;
  _cache.set(key, img); // store before load completes to prevent double-fetch
  img.onload = () => { _cache.set(key, img); };
  return img;
}

function _draw(x, z, yaw) {
  const [lng, lat] = localToLngLat(x, z);
  const [ftx, fty] = latLngToTileFrac(lat, lng);
  const maxTile    = 2 ** ZOOM - 1;
  const cx = _size / 2, cy = _size / 2;

  _ctx.clearRect(0, 0, _size, _size);

  // Map is drawn north-up (unrotated). Only the player arrow below rotates.
  _ctx.save();
  _ctx.translate(cx, cy);

  // Axis-aligned map: reach = enough tiles to cover half the canvas side,
  // plus one for fractional offsets. No √2 slack needed without rotation.
  const reach = Math.max(1, Math.ceil(_size / (2 * TILE_SIZE)) + 1);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = Math.floor(ftx) + dx;
      const ty = Math.floor(fty) + dy;
      if (tx < 0 || ty < 0 || tx > maxTile || ty > maxTile) continue;
      const img = getTile(tx, ty);
      if (!img.complete || !img.naturalWidth) continue;
      // Pixel offset of this tile's top-left from the player's position.
      const drawX = (tx - ftx) * TILE_SIZE;
      const drawY = (ty - fty) * TILE_SIZE;
      _ctx.drawImage(img, drawX, drawY, TILE_SIZE, TILE_SIZE);
    }
  }

  _ctx.restore();

  // Player marker — rotates with yaw so the arrow tip tracks the player's
  // heading on a north-up map. Drawn at canvas centre.
  _ctx.save();
  _ctx.translate(cx, cy);
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
