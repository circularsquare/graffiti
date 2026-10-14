import { localToLngLat } from './geo.js';
import { getPaintHeat } from './paintHeat.js';

const TILE_SIZE    = 256;  // OSM tile pixel size
const ZOOM_MIN     = 12;
const ZOOM_MAX     = 19;
const ZOOM_DEFAULT = 16;   // ~325m visible across 180px canvas at latitude 40.7°
// Redraw every animation frame. drawImage on cached tile textures is a few
// GPU composites — cheap enough that 60 fps is fine even for the big map,
// and keeps rotation visually smooth while mouse-looking.
const INTERVAL  = 0;
const EARTH_CIRCUM_M = 40075016.686;

// Tile image cache: "z/tx/ty" → HTMLImageElement
const _cache = new Map();

let _ctx        = null;
let _lastTime   = -Infinity;
let _size       = 180;   // current canvas side in px — mutable via setMinimapSize
let _zoom       = ZOOM_DEFAULT;  // fractional; floor is the OSM tile z, remainder scales drawImage
let _panX       = 0;     // metres — world X offset of view centre from player
let _panZ       = 0;     // metres — world Z offset of view centre from player
let _viewLat    = 40.70475;  // last drawn view-centre latitude, cached for metresPerPixel()
let _headingUp  = false;  // false = north-up (map fixed, arrow rotates); true = heading-up (map rotates, arrow fixed)
let _lastYaw    = 0;      // cached last-drawn yaw — read by main.js to rotate the compass rose in lockstep
let _showHeat   = false;  // paint-heat overlay (red blobs marking painted tiles), toggled in map mode

// Blob radius in metres on the ground. A painted tile is ~100–125 m across, so
// a ~110 m radius glow covers one tile and bleeds into neighbours, which reads
// as a continuous heatmap where paint is contiguous and a clear dot where it's
// a lone tile. A floor in px (below) keeps lone tiles visible when zoomed out.
const HEAT_RADIUS_M  = 110;
const HEAT_RADIUS_MIN_PX = 7;  // never let a blob shrink below this on screen

// True-heatmap rendering: blobs are first additively accumulated into an
// offscreen INTENSITY field (white-on-transparent, alpha = stacked paint),
// then that intensity is recoloured through a fixed ramp so the on-screen hue
// tracks the accumulated opacity at each pixel — a yellow core is always rimmed
// by orange then red, regardless of which tile contributed. See _drawPaintHeat.
let _heatScratch = null;   // offscreen canvas, lazily sized to match the minimap
let _heatRamp    = null;   // 256×1 lookup: intensity (0..255 alpha) → rgba colour

// Build the colour ramp once: a 256-wide gradient from transparent → red →
// orange → yellow. Index = accumulated intensity; the alpha baked into the ramp
// fades the faint edges out so blobs blend into the map instead of hard discs.
function _buildHeatRamp() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.00, 'rgba(255, 45, 45, 0)');    // no paint → transparent
  grad.addColorStop(0.06, 'rgba(255, 45, 45, 0.05)'); // barely painted → near-transparent red
  grad.addColorStop(0.18, 'rgba(255, 45, 45, 0.45)'); // faint → translucent red
  grad.addColorStop(0.45, 'rgba(255, 70, 40, 0.70)'); // red
  grad.addColorStop(0.80, 'rgba(255, 140, 30, 0.82)');// orange
  grad.addColorStop(0.92, 'rgba(255, 225, 40, 0.92)');// yellow (just below the very top)
  grad.addColorStop(1.00, 'rgba(255, 248, 170, 0.96)');// hottest → light/pale yellow
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 1);
  return g.getImageData(0, 0, 256, 1).data;
}

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
  document.documentElement.style.setProperty('--minimap-size', px + 'px');
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

export function getMinimapHeadingUp() { return _headingUp; }
export function toggleMinimapHeadingUp() {
  _headingUp = !_headingUp;
  _lastTime = -Infinity;  // force immediate redraw
  return _headingUp;
}
export function getMinimapYaw() { return _lastYaw; }

export function getHeatVisible() { return _showHeat; }
export function setHeatVisible(on) {
  _showHeat = on;
  _lastTime = -Infinity;  // force immediate redraw
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
  let dxPx = px - _size / 2;
  let dyPx = py - _size / 2;
  // Heading-up mode rotates the map by −yaw for display. A screen-space
  // delta from centre is already in the rotated frame, so rotate it back
  // by +yaw before converting to world XZ.
  if (_headingUp) {
    const c = Math.cos(_lastYaw), s = Math.sin(_lastYaw);
    const rx = dxPx * c - dyPx * s;
    const ry = dxPx * s + dyPx * c;
    dxPx = rx;
    dyPx = ry;
  }
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
  _lastYaw = yaw;
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

  _ctx.save();
  _ctx.translate(cx, cy);
  // Heading-up: rotate the whole map by -yaw so the player's facing direction
  // ends up at the top of the canvas. Rotated corners reach √2× further from
  // centre, so widen the tile fetch radius by that factor.
  if (_headingUp) _ctx.rotate(-yaw);
  const reachMult = _headingUp ? Math.SQRT2 : 1;
  const reach = Math.max(1, Math.ceil(_size * reachMult / (2 * tileSize)) + 1);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = Math.floor(ftx) + dx;
      const ty = Math.floor(fty) + dy;
      if (tx < 0 || ty < 0 || tx > maxTile || ty > maxTile) continue;
      const img = getTile(zFloor, tx, ty);
      if (!img.complete || !img.naturalWidth) continue;
      // Pixel-snap positions + 1px bleed: sub-pixel drawImage destinations
      // anti-alias along tile seams, which shows up as faint grid lines on
      // the canvas. Rounding + overdrawing a pixel kills the seams cleanly.
      const drawX = Math.round((tx - ftx) * tileSize);
      const drawY = Math.round((ty - fty) * tileSize);
      const drawW = Math.ceil(tileSize) + 1;
      const drawH = Math.ceil(tileSize) + 1;
      _ctx.drawImage(img, drawX, drawY, drawW, drawH);
    }
  }

  // Paint-heat overlay. Drawn here, INSIDE the same translate(+rotate)
  // transform as the OSM tiles, so blob positions project correctly in both
  // north-up and heading-up modes (the helper reads the live transform).
  if (_showHeat) {
    const heat = getPaintHeat();
    if (heat && heat.length) _drawPaintHeat(heat, ftx, fty, tileSize, zFloor);
  }

  _ctx.restore();

  // Player marker. Position: offset from view centre by (player − view), with
  // that offset rotated by −yaw in heading-up mode so it lands on the right
  // tile. Tip: points toward yaw in north-up, fixed up in heading-up.
  const ox = (pftx - ftx) * tileSize;
  const oy = (pfty - fty) * tileSize;
  let markerX, markerY, markerAngle;
  if (_headingUp) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    markerX = cx + ox * c + oy * s;
    markerY = cy - ox * s + oy * c;
    markerAngle = 0;
  } else {
    markerX = cx + ox;
    markerY = cy + oy;
    markerAngle = yaw;
  }
  _ctx.save();
  _ctx.translate(markerX, markerY);
  _ctx.rotate(markerAngle);

  // 4-sided chevron: tip at front, two side wings, concave notch at back.
  _ctx.beginPath();
  _ctx.moveTo(0, -9);   // tip (forward)
  _ctx.lineTo(6, 5);    // right wing
  _ctx.lineTo(0, 2);    // back notch (concave — makes it a 4-sided kite)
  _ctx.lineTo(-6, 5);   // left wing
  _ctx.closePath();
  _ctx.fillStyle = '#ff2222';
  _ctx.fill();
  _ctx.lineWidth = 1;
  _ctx.lineJoin = 'round';
  _ctx.strokeStyle = '#000';
  _ctx.stroke();
  _ctx.restore();
}

/**
 * True-heatmap render of the painted-tile set. Two passes:
 *   1. Accumulate every blob additively into an offscreen INTENSITY field —
 *      white radial gradients, alpha scaled by each tile's heat. Overlaps add,
 *      so the accumulated alpha at a pixel = how much paint stacks there.
 *   2. Recolour that field through _heatRamp (transparent→red→orange→yellow):
 *      each pixel's accumulated alpha indexes the ramp, so a hot core reads
 *      yellow and is always rimmed by orange then red as the field falls off.
 * Then the recoloured field is composited back onto the minimap.
 *
 * Called while _ctx is inside _draw's translate(+rotate) transform; the
 * offscreen mirrors that transform so blob centres line up, and we blit it back
 * under an identity transform (it's already in final screen pixels).
 *
 * @param ftx,fty   view-centre tile-fraction (so (htx-ftx)*tileSize = px offset)
 * @param tileSize  OSM tile px at current zoom
 * @param zFloor    integer OSM zoom used for latLngToTileFrac
 */
function _drawPaintHeat(heat, ftx, fty, tileSize, zFloor) {
  if (!_heatRamp) _heatRamp = _buildHeatRamp();
  if (!_heatScratch) _heatScratch = document.createElement('canvas');
  if (_heatScratch.width !== _size || _heatScratch.height !== _size) {
    _heatScratch.width = _size;
    _heatScratch.height = _size;
  }
  const hctx = _heatScratch.getContext('2d');
  hctx.clearRect(0, 0, _size, _size);

  // Mirror _draw's current transform so blob coords match the map underneath.
  hctx.save();
  hctx.translate(_size / 2, _size / 2);
  if (_headingUp) hctx.rotate(-_lastYaw);

  // Pixels per ground-metre on screen. Use the canonical metres-per-pixel
  // (continuous in fractional _zoom) and invert it. The earlier
  // (TILE_SIZE * scaleF / tileM) form double-counted scaleF, so rPx jumped 2×
  // at every integer-zoom boundary — denser overlap → the "every other zoom is
  // brighter" sawtooth. metresPerPixel already folds scaleF into tileM/_zoom.
  const mPerPx = EARTH_CIRCUM_M * Math.cos(_viewLat * Math.PI / 180) / (2 ** _zoom) / TILE_SIZE;
  const pxPerM = 1 / mPerPx;
  const rPx    = Math.max(HEAT_RADIUS_MIN_PX, HEAT_RADIUS_M * pxPerM);
  const cullPx = _size * Math.SQRT2 / 2 + rPx;

  // Pass 1 — additive white intensity field.
  hctx.globalCompositeOperation = 'lighter';
  for (const t of heat) {
    const [hlng, hlat] = localToLngLat(t.x, t.z);
    const [htx, hty]   = latLngToTileFrac(hlat, hlng, zFloor);
    const ox = (htx - ftx) * tileSize;
    const oy = (hty - fty) * tileSize;
    if (ox < -cullPx || ox > cullPx || oy < -cullPx || oy > cullPx) continue;
    // Per-blob peak intensity scales with heat, so a heavily-painted lone tile
    // already reaches the hot end of the ramp; overlapping tiles push further.
    const peak = 0.30 + 0.55 * t.heat; // 0.30 (faint) → 0.85 (hot) at the centre
    const g = hctx.createRadialGradient(ox, oy, 0, ox, oy, rPx);
    g.addColorStop(0, `rgba(255,255,255,${peak})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    hctx.fillStyle = g;
    hctx.beginPath();
    hctx.arc(ox, oy, rPx, 0, Math.PI * 2);
    hctx.fill();
  }
  hctx.restore();

  // Pass 2 — recolour the accumulated alpha through the ramp, in place.
  const img  = hctx.getImageData(0, 0, _size, _size);
  const data = img.data;
  const ramp = _heatRamp;
  for (let i = 0; i < data.length; i += 4) {
    const intensity = data[i + 3];      // accumulated alpha (already clamped 0..255)
    const r = intensity * 4;            // ramp index*4 (ramp is 256 entries)
    data[i]     = ramp[r];
    data[i + 1] = ramp[r + 1];
    data[i + 2] = ramp[r + 2];
    data[i + 3] = ramp[r + 3];
  }
  hctx.putImageData(img, 0, 0);

  // Blit the recoloured field back onto the minimap. _ctx is currently inside
  // _draw's transform; reset to identity so we place the already-screen-space
  // scratch 1:1, then restore the caller's transform.
  _ctx.save();
  _ctx.setTransform(1, 0, 0, 1, 0, 0);
  _ctx.drawImage(_heatScratch, 0, 0);
  _ctx.restore();
}
