#!/usr/bin/env python3
"""
Bake USGS 3DEP 1 m DEM tiles into per-cell heightmaps aligned with the
building tile grid.

For every 125 m cell within PAD_CELLS of a building tile, emit a gzip-compressed
binary heightmap file with per-tile-quantised decimetre deltas. Sample spacing =
GRID_SIZE / SAMPLES ≈ 2 m.

Outputs:
    public/terrain/cell_{gx}_{gz}.bin   — one gzipped file per cell

Binary format v2 (little-endian, gzipped on disk):
    uint8   version      = 2
    uint8   scale_dm     # decimetres per delta unit, 1..255
    uint16  res          # inner samples per side
    uint16  pad          # perimeter cells on each side
    int16   min_dm       # tile-minimum elevation in decimetres above NAVD88
    uint8   samples[(res+2*pad)^2]
                         # row-major: z then x, +z = south.
                         # 255 = NODATA sentinel; otherwise
                         # elevation_dm = min_dm + value * scale_dm.
                         # scale_dm is chosen per-tile so the tile's elevation
                         # range fits into 0..254. Flat tiles get scale=1
                         # (10 cm precision); the steepest Manhattan tiles land
                         # at scale≈4 (40 cm) — still below the worker's
                         # slope-threshold so blocky output is unchanged.

The file is gzipped; adjacent deltas cluster tightly so DEFLATE typically cuts
the 4.4 KB raw payload to ~1–2 KB. Both Vite dev (octet-stream skips the dev
compression middleware) and Cloudflare (octet-stream is not in its auto-compress
list) serve the bytes as-is; terrainWorker.js inflates via DecompressionStream.

`pad` is the overlap width in cells. With pad=1 every tile carries its
neighbours' edge samples (and corner samples) so the worker can corner-smooth
across tile seams without fetching neighbour tiles. Adjacent tiles share the
same world-space samples in their overlap region, which makes the smoothed
corner Y match exactly — no visible cliff along the tile boundary.

Bounds are derivable from the cell's (gx, gz) grid coordinate, so we don't
store them in the file — the runtime derives them via gx*GRID_SIZE, etc.
The runtime doesn't use a manifest either: it fetches cell files by URL and
treats 404 as "no terrain here".

Usage:
    python scripts/bake_terrain.py
    python scripts/bake_terrain.py --refresh        # re-emit cells already on disk
    python scripts/bake_terrain.py --limit 100      # stop after N cells (smoke test)
"""

import os, sys, json, math, glob, gzip, argparse, time
import numpy as np
import rasterio
from rasterio.windows import Window
from pyproj import Transformer

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Same reference point as convert_citygml.py / geo.js / fetch_osm_features.py
REF_LNG = -74.01175
REF_LAT = 40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))

# Terrain grid rotation (Manhattan street orientation). Must match
# src/geo.js::MANHATTAN_GRID_DEG. Each cell's 64×64 sample grid is laid out in
# grid space and rotated into world space before UTM projection, so baked cell
# (gx, gz) addresses a rotated square in world XZ.
MANHATTAN_GRID_DEG = 29.0
_G_COS = math.cos(math.radians(MANHATTAN_GRID_DEG))
_G_SIN = math.sin(math.radians(MANHATTAN_GRID_DEG))


def _grid_to_world(u, v):
    """Terrain grid UV → world XZ. Vectorised (numpy) or scalar."""
    return (u * _G_COS - v * _G_SIN, u * _G_SIN + v * _G_COS)


def _world_to_grid(x, z):
    """World XZ → terrain grid UV. Inverse of _grid_to_world."""
    return (x * _G_COS + z * _G_SIN, -x * _G_SIN + z * _G_COS)

HERE              = os.path.dirname(__file__)
DEM_DIR           = os.path.join(HERE, '..', 'data', 'dem')
OUTPUT_DIR        = os.path.join(HERE, '..', 'public', 'terrain')
BUILDING_MANIFEST = os.path.join(HERE, '..', 'public', 'tiles', 'manifest.json')

GRID_SIZE   = 125    # must match build_tiles.py
SAMPLES     = 64     # per side → ~1.95 m spacing
PAD         = 1      # perimeter sample rows each tile carries past its inner
                     # grid, so the worker can corner-smooth across tile seams
                     # (see module docstring). A tile's on-disk sample count is
                     # therefore (SAMPLES + 2*PAD)².
PAD_CELLS   = 2      # emit terrain for building cells + this many cells of pad
NODATA_U8   = 255    # sentinel for "no DEM coverage here" in the encoded uint8
                     # delta stream. Valid delta values occupy 0..254.
FORMAT_VERSION = 2

# USGS 3DEP stores NODATA as -999999 or similar large negatives. Anything
# below this is treated as unobserved and flagged with NODATA_I16 on output.
VALID_ELEV_MIN_M = -200.0
VALID_ELEV_MAX_M =  500.0


# ── Coordinate helpers ───────────────────────────────────────────────────────

# Per-CRS transformer cache. NY DEMs are UTM 18N (EPSG:26918); NJ tiles are
# the same zone. Caching avoids re-initialising the pipeline per cell.
_tr_cache = {}
def lnglat_to_crs(lng, lat, crs):
    key = str(crs)
    tr = _tr_cache.get(key)
    if tr is None:
        tr = Transformer.from_crs('EPSG:4326', key, always_xy=True)
        _tr_cache[key] = tr
    return tr.transform(lng, lat)


def local_to_crs(x_local, z_local, crs):
    lng = REF_LNG + x_local / METERS_PER_LNG
    lat = REF_LAT - z_local / METERS_PER_LAT  # +Z = south
    return lnglat_to_crs(lng, lat, crs)


# ── Target cell enumeration ──────────────────────────────────────────────────

def read_manifest():
    with open(BUILDING_MANIFEST) as f:
        return json.load(f)


def target_cells(manifest, pad=PAD_CELLS):
    """Set of (gx, gz) 125 m cells to emit terrain for: every cell a building
    tile overlaps, plus `pad` cells on each side. Padding is per-cell, not
    bbox-expansion, so sparse coverage at the NYC fringe doesn't blow up into
    tens of thousands of ocean cells.

    Terrain cells live in GRID space (rotated from world by MANHATTAN_GRID_DEG);
    building tiles live in WORLD space. To find the grid cells covering a
    building's world-space AABB we rotate all 4 corners to grid space and take
    the grid-space AABB — slightly over-eager at the edges (rotation inflates
    the AABB by ~√2) but correct."""
    building_cells = set()
    for t in manifest:
        b = t['bounds']
        corners = [(b['minX'], b['minZ']), (b['maxX'], b['minZ']),
                   (b['maxX'], b['maxZ']), (b['minX'], b['maxZ'])]
        us, vs = zip(*(_world_to_grid(x, z) for (x, z) in corners))
        gx0 = math.floor(min(us) / GRID_SIZE)
        gx1 = math.floor((max(us) - 1e-6) / GRID_SIZE)
        gz0 = math.floor(min(vs) / GRID_SIZE)
        gz1 = math.floor((max(vs) - 1e-6) / GRID_SIZE)
        for gx in range(gx0, gx1 + 1):
            for gz in range(gz0, gz1 + 1):
                building_cells.add((gx, gz))

    result = set()
    for (gx, gz) in building_cells:
        for dx in range(-pad, pad + 1):
            for dz in range(-pad, pad + 1):
                result.add((gx + dx, gz + dz))
    return result


# ── DEM index ────────────────────────────────────────────────────────────────

def _dem_priority(path):
    # Lower = queried first in sample_cell. NY DEMs must outrank NJ so the real
    # NY LiDAR (e.g. the Cloisters bluff in x58y453_NY_CMPG_2013) isn't
    # clobbered by the 100 m fillnodata tail from x58y453_NJ_SdL5_2014 that
    # bleeds 25 m "shelf" values eastward across the Hudson — that tail used to
    # land right under the Cloisters and produce a sheer stepped cliff at the
    # fill-range boundary.
    name = os.path.basename(path)
    if '_NY_' in name: return 0
    if '_NJ_' in name: return 1
    return 2


def open_dems():
    # We require the pre-filled variants. Raw *.tif have NODATA pixels, and
    # filling them locally per-tile at runtime caused seam-border holes:
    # adjacent tiles converged on different values for the same shared sample.
    # See scripts/fill_dem_nodata.py for the preprocessing step.
    paths = sorted(
        glob.glob(os.path.join(DEM_DIR, '*_filled.tif')),
        key=lambda p: (_dem_priority(p), os.path.basename(p)),
    )
    if not paths:
        sys.exit(f'No *_filled.tif in {DEM_DIR}. '
                 f'Run `python scripts/fill_dem_nodata.py` first.')
    dems = []
    for p in paths:
        ds = rasterio.open(p)
        dems.append(ds)
    print(f'Opened {len(dems)} filled DEM tiles')
    print(f'  CRS set: {sorted({str(ds.crs) for ds in dems})}')
    return dems


# ── Sampling ─────────────────────────────────────────────────────────────────

def bilinear_sample(data, rows, cols, nodata_mask_val=None):
    """
    Bilinear interpolation at (row, col) float coords into `data` (2D ndarray).
    Returns float32 array same shape as `rows`. Coords outside [0, H-1] × [0,
    W-1] return NaN. Pixels whose bilinear neighbourhood contains a NODATA
    value also return NaN.
    """
    h, w = data.shape
    r0 = np.floor(rows).astype(np.int64)
    c0 = np.floor(cols).astype(np.int64)
    r1 = r0 + 1
    c1 = c0 + 1
    fr = (rows - r0).astype(np.float32)
    fc = (cols - c0).astype(np.float32)

    in_bounds = (r0 >= 0) & (c0 >= 0) & (r1 < h) & (c1 < w)
    r0c = np.clip(r0, 0, h - 1)
    c0c = np.clip(c0, 0, w - 1)
    r1c = np.clip(r1, 0, h - 1)
    c1c = np.clip(c1, 0, w - 1)

    v00 = data[r0c, c0c].astype(np.float32)
    v01 = data[r0c, c1c].astype(np.float32)
    v10 = data[r1c, c0c].astype(np.float32)
    v11 = data[r1c, c1c].astype(np.float32)

    if nodata_mask_val is not None:
        bad = ((v00 == nodata_mask_val) | (v01 == nodata_mask_val) |
               (v10 == nodata_mask_val) | (v11 == nodata_mask_val))
    else:
        bad = np.zeros_like(v00, dtype=bool)

    top = v00 * (1 - fc) + v01 * fc
    bot = v10 * (1 - fc) + v11 * fc
    out = top * (1 - fr) + bot * fr

    out[~in_bounds] = np.nan
    out[bad] = np.nan
    # Filter absurd elevations (USGS uses various NODATA sentinels — we catch
    # whatever slipped past by range check).
    out[(out < VALID_ELEV_MIN_M) | (out > VALID_ELEV_MAX_M)] = np.nan
    return out


def sample_cell(gx, gz, dems):
    """Return (SAMPLES + 2*PAD)² float32 array of elevation in metres for the
    given cell, including PAD rows/cols of perimeter from the neighbouring
    cells so the runtime can corner-smooth across tile seams. NaN for any
    sample outside DEM coverage.

    Sample positions are computed in GRID space (axis-aligned), then rotated
    into world space before CRS projection. Adjacent cells in grid space remain
    adjacent in world space (rotation preserves adjacency), so the PAD overlap
    invariant — perimeter samples at exactly the same world position as the
    neighbour's inner samples — holds by construction, and corner smoothing
    matches bit-exactly across seams just like before."""
    # Sample points align with the inner cell-centred grid and extend by
    # PAD cells on each side. Crucially the perimeter samples fall at exactly
    # the same grid-space positions as the neighbour tile's inner samples —
    # so after rotation to world they hit identical DEM locations on both
    # sides and corner smoothing matches to the bit.
    half    = GRID_SIZE / (2 * SAMPLES)
    step    = GRID_SIZE / SAMPLES
    total   = SAMPLES + 2 * PAD
    start_u = gx * GRID_SIZE + half - PAD * step
    end_u   = (gx + 1) * GRID_SIZE - half + PAD * step
    start_v = gz * GRID_SIZE + half - PAD * step
    end_v   = (gz + 1) * GRID_SIZE - half + PAD * step
    us = np.linspace(start_u, end_u, total, dtype=np.float64)
    vs = np.linspace(start_v, end_v, total, dtype=np.float64)
    U_grid, V_grid = np.meshgrid(us, vs)

    # Grid → world XZ. This is where the cell's rotated footprint happens.
    X_local = U_grid * _G_COS - V_grid * _G_SIN
    Z_local = U_grid * _G_SIN + V_grid * _G_COS

    samples = np.full((total, total), np.nan, dtype=np.float32)

    # Group DEMs by CRS so we only reproject the sample grid once per CRS.
    dems_by_crs = {}
    for ds in dems:
        dems_by_crs.setdefault(str(ds.crs), []).append(ds)

    for crs, ds_list in dems_by_crs.items():
        # Reproject grid to this CRS.
        X_crs, Y_crs = local_to_crs(X_local.ravel(), Z_local.ravel(), crs)
        X_crs = np.asarray(X_crs, dtype=np.float64).reshape(total, total)
        Y_crs = np.asarray(Y_crs, dtype=np.float64).reshape(total, total)

        for ds in ds_list:
            if not np.isnan(samples).any():
                return samples  # everything filled

            b = ds.bounds
            need = (np.isnan(samples) &
                    (X_crs >= b.left) & (X_crs < b.right) &
                    (Y_crs >= b.bottom) & (Y_crs < b.top))
            if not need.any():
                continue

            # Tightest window covering the samples we need from this DEM.
            nx = X_crs[need]
            ny = Y_crs[need]
            # Pad one pixel so bilinear neighbours exist.
            px = abs(ds.transform.a)
            py = abs(ds.transform.e)
            win_left   = nx.min() - px
            win_right  = nx.max() + px
            win_bottom = ny.min() - py
            win_top    = ny.max() + py
            window = ds.window(win_left, win_bottom, win_right, win_top)
            window = window.round_offsets(op='floor').round_lengths(op='ceil')
            window = window.intersection(Window(0, 0, ds.width, ds.height))
            if window.width <= 0 or window.height <= 0:
                continue

            data = ds.read(1, window=window)
            tr = ds.window_transform(window)
            # Pixel coords of each needed sample within the window.
            col_f = (nx - tr.c) / tr.a - 0.5
            row_f = (ny - tr.f) / tr.e - 0.5
            vals = bilinear_sample(data, row_f, col_f, nodata_mask_val=ds.nodata)

            samples[need] = vals

    return samples


# ── Serialization ────────────────────────────────────────────────────────────

def encode_samples_v2(samples_m):
    """Pack float32 metres into a v2 payload: int16 tile-min in decimetres plus
    uint8 deltas stepping `scale_dm` decimetres each. Returns a tuple
    (scale_dm, min_dm, deltas_u8) or None if every sample is NaN.

    scale_dm is the smallest integer that lets (max_dm - min_dm) fit into
    0..254 (NODATA reserves 255). Flat tiles get scale=1 (10 cm precision);
    the steepest NYC tiles hit scale≈4 (40 cm). Both are below the worker's
    slope threshold so blocky output is unchanged.
    """
    valid_mask = ~np.isnan(samples_m)
    if not valid_mask.any():
        return None

    samples_dm = samples_m * 10  # metres → decimetres
    min_dm_f = float(np.nanmin(samples_dm))
    max_dm_f = float(np.nanmax(samples_dm))
    min_dm = int(np.clip(round(min_dm_f), -32768, 32767))
    # After rounding min_dm we must derive max relative to that exact value.
    max_dm = int(round(max_dm_f))
    range_dm = max(0, max_dm - min_dm)
    # 254 valid slots; NODATA=255 reserved. ceil division.
    scale_dm = max(1, -(-range_dm // 254))
    if scale_dm > 255:
        # Would need a single tile spanning >64 km of elevation — impossible for
        # NYC. Clamp defensively; the worst case truncates extreme values.
        scale_dm = 255

    deltas = np.full(samples_m.shape, NODATA_U8, dtype=np.uint8)
    valid_dm = samples_dm[valid_mask]
    units = np.round((valid_dm - min_dm) / scale_dm).astype(np.int32)
    deltas[valid_mask] = np.clip(units, 0, 254).astype(np.uint8)
    return scale_dm, min_dm, deltas


def write_cell(gx, gz, samples_m):
    """Emit cell_{gx}_{gz}.bin. Returns True if a file was written, False if
    the cell's inner region was entirely NODATA (we skip emitting so the
    runtime's 404 path kicks in and caches the miss).

    Emptiness check is on the INNER region only — a tile's perimeter might
    lie entirely in NODATA (at the edge of DEM coverage) while its interior
    is fine; we still want to emit that one.
    """
    encoded = encode_samples_v2(samples_m)
    if encoded is None:
        return False
    scale_dm, min_dm, deltas = encoded
    inner = deltas[PAD:PAD + SAMPLES, PAD:PAD + SAMPLES]
    if not (inner != NODATA_U8).any():
        return False

    # Header (8 bytes):
    #   u8 version, u8 scale_dm, u16 res, u16 pad, i16 min_dm
    header = np.array([FORMAT_VERSION, scale_dm], dtype=np.uint8).tobytes()
    header += np.array([SAMPLES, PAD], dtype='<u2').tobytes()
    header += np.array([min_dm],       dtype='<i2').tobytes()
    body = deltas.astype(np.uint8).ravel().tobytes()

    path = os.path.join(OUTPUT_DIR, f'cell_{gx}_{gz}.bin')
    # gzip level 6 is the sweet spot: close to max compression on this kind of
    # smooth delta stream, while keeping bake time reasonable over ~50k tiles.
    with gzip.open(path, 'wb', compresslevel=6) as f:
        f.write(header)
        f.write(body)
    return True


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true',
                    help='Re-emit cells whose output file already exists')
    ap.add_argument('--limit', type=int, default=0,
                    help='Stop after writing N cells (for a smoke test)')
    ap.add_argument('--near', type=str, default=None,
                    help='With --limit, process cells nearest this local XZ '
                         'first (e.g. "0,0" = FiDi, "2215,-5928" = Times Sq)')
    args = ap.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print('Reading building manifest…')
    manifest = read_manifest()
    cells = sorted(target_cells(manifest))
    print(f'  {len(cells)} target cells ({PAD_CELLS}-cell pad around {len(manifest)} building tiles)')

    if args.near:
        cx, cz = (float(v) for v in args.near.split(','))
        cgx, cgz = cx / GRID_SIZE, cz / GRID_SIZE
        cells.sort(key=lambda c: (c[0] - cgx) ** 2 + (c[1] - cgz) ** 2)
        print(f'  sorted by distance to ({cx}, {cz})')

    dems = open_dems()

    print('Baking heightmaps…')
    written = skipped = empty = 0
    t0 = time.time()
    for i, (gx, gz) in enumerate(cells):
        out_path = os.path.join(OUTPUT_DIR, f'cell_{gx}_{gz}.bin')
        if not args.refresh and os.path.exists(out_path):
            skipped += 1
            continue

        samples_m = sample_cell(gx, gz, dems)
        if not write_cell(gx, gz, samples_m):
            empty += 1
            continue

        written += 1
        if args.limit and written >= args.limit:
            print(f'  --limit reached at {written} cells')
            break

        if (i + 1) % 1000 == 0:
            rate = (i + 1) / max(time.time() - t0, 1e-3)
            eta = (len(cells) - i - 1) / max(rate, 1e-3)
            print(f'  [{i+1}/{len(cells)}]  {rate:.0f} cells/s  ETA {eta/60:.1f} min')

    dt = time.time() - t0
    print(f'Done in {dt/60:.1f} min. written={written} skipped={skipped} empty={empty}')


if __name__ == '__main__':
    main()
