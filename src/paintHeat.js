import { gridToWorld } from './geo.js';

// Paint-heat overlay data: a session-cached snapshot of which tiles currently
// hold paint, plus a per-tile heat value used to shade the map. Fetched once
// (lazily, when the player first enables the map's heat layer) from the
// server's GET /paint_heat sweep.
//
// The server returns each painted blob's byte size as a paint-amount proxy
// (erasing deletes cell keys, so size tracks live paint, not history). We
// convert each tile's grid coord to a world-space centre here so the minimap
// can project it exactly like the player marker, and normalise size → heat in
// 0..1 with a sqrt curve so a handful of busy tiles don't wash everything else
// out.

// Endpoint base mirrors paintStore's: VITE_PAINT_ENDPOINT points at the worker
// in prod (".../paint"), and falls back to the dev plugin's "/api/paint".
const TILE_ENDPOINT = import.meta.env.VITE_PAINT_ENDPOINT ?? '/api/paint';
const HEAT_ENDPOINT = TILE_ENDPOINT.replace(/\/paint\/?$/, '/paint_heat');

// Grid metrics — must match the tile builders. Building tiles are 100 m and
// axis-aligned (scripts/build_tiles.py::GRID_SIZE); terrain tiles are 125 m and
// rotated 29° to the Manhattan grid (TerrainManager::CELL_SIZE + geo.js).
const BUILDING_CELL_M = 100;
const TERRAIN_CELL_M  = 125;

// Heat is mapped on a LOG scale between two FIXED, absolute byte references
// (not the per-fetch min/max). Fixed anchors make the colour meaningful and
// stable: the same amount of paint always reads the same red, regardless of
// what else is painted this session or how the city fills in over time.
//   - HEAT_MIN_BYTES: a barely-painted tile. ~150 B ≈ a single painted cell
//     (the server already drops blobs ≤ 40 B, so the faintest real tile lands
//     near here) → heat 0.
//   - HEAT_FULL_BYTES: a heavily-worked tile. ~150 KB ≈ ~1000 painted cells →
//     heat 1. Anything bigger (e.g. a 1 MB landmark wall) just saturates.
// Tune HEAT_FULL_BYTES down to make the map "hotter" sooner, up to require more
// paint before a tile reads as fully red.
// Calibrated against the live prod distribution (236 painted tiles, 2026-05-30):
// min 151 B, median ~7 KB, p90 ~86 KB, p99 ~555 KB, max ~4.5 MB. FULL is set at
// the p99 so only the top ~1% of tiles saturate to the hot end of the ramp,
// leaving the genuinely heavily-painted tiles distinct from each other; the old
// 150 KB anchor sat near p90, so a sixth of all tiles maxed out and the map read
// as over-saturated yellow. Re-pull `/paint_heat` and re-check percentiles if
// the city fills in a lot more.
const HEAT_MIN_BYTES  = 150;
const HEAT_FULL_BYTES = 555_000;
const _LHEAT_MIN  = Math.log(HEAT_MIN_BYTES);
const _LHEAT_SPAN = Math.log(HEAT_FULL_BYTES) - _LHEAT_MIN;

// Gamma applied to the log-normalised value. Plain log makes lightly-painted
// tiles read too hot (log rises steeply near the low anchor), so we pull the
// low/mid range down with a power curve while leaving the top pinned at 1.
// 2 = log², a clear de-emphasis; raise for even more contrast toward the top.
// At the recalibrated 555 KB FULL anchor, log³ over-suppressed (median heat
// ~0.10, most tiles barely visible), so 2.5 restores mid-range visibility while
// still pulling the light end down. (log³ only looked right against the old,
// too-low anchor where everything read hot.)
const HEAT_GAMMA = 2.5;

/**
 * Byte size → heat ∈ [0,1]: fixed-anchor log, then a gamma curve to weaken the
 * low end so a tile needs real paint (not just a few cells) before it glows hot.
 */
function sizeToHeat(size) {
  const h = (Math.log(size) - _LHEAT_MIN) / _LHEAT_SPAN;
  const clamped = h < 0 ? 0 : h > 1 ? 1 : h;
  return clamped ** HEAT_GAMMA;
}

// Session cache. null until the first successful fetch; an in-flight fetch is
// memoised on _promise so concurrent enables share one request.
let _heat    = null;   // Array<{ x, z, heat, isTerrain }>
let _promise = null;

/**
 * World-space centre of a tile, in local XZ metres.
 * Building: axis-aligned 100 m cells keyed by floor(centroid / 100).
 * Terrain:  125 m cells in the 29°-rotated grid space; gridToWorld un-rotates.
 */
function tileCenter(gx, gz, isTerrain) {
  if (isTerrain) {
    const u = (gx + 0.5) * TERRAIN_CELL_M;
    const v = (gz + 0.5) * TERRAIN_CELL_M;
    const [x, z] = gridToWorld(u, v);
    return { x, z };
  }
  return { x: (gx + 0.5) * BUILDING_CELL_M, z: (gz + 0.5) * BUILDING_CELL_M };
}

/**
 * Fetch the painted-tile snapshot once and cache it for the session. Returns
 * the cached array on every later call (or the same in-flight promise if a
 * fetch is already running). Returns [] on failure — the overlay just shows
 * nothing rather than erroring the map.
 */
export function loadPaintHeat() {
  if (_heat) return Promise.resolve(_heat);
  if (_promise) return _promise;
  _promise = (async () => {
    try {
      const res = await fetch(HEAT_ENDPOINT);
      if (!res.ok) throw new Error(`paint_heat HTTP ${res.status}`);
      const { tiles } = await res.json();
      // Size → heat via the fixed-anchor log scale (sizeToHeat). Absolute, not
      // relative to this fetch — so a tile's colour is stable session to
      // session and as the city fills in. A single 1 MB tile no longer crushes
      // everyone else into the faint end; it just saturates at full red.
      _heat = tiles.map(([gx, gz, isT, size]) => {
        const c = tileCenter(gx, gz, isT === 1);
        return { x: c.x, z: c.z, isTerrain: isT === 1, heat: sizeToHeat(size) };
      });
    } catch (e) {
      console.warn('paintHeat: load failed —', e.message);
      _heat = [];
    } finally {
      _promise = null;
    }
    return _heat;
  })();
  return _promise;
}

/** Cached heat list (or null if never loaded). Synchronous, for the draw loop. */
export function getPaintHeat() { return _heat; }

/** Drop the cache so the next loadPaintHeat() re-fetches (e.g. manual refresh). */
export function invalidatePaintHeat() { _heat = null; _promise = null; }
