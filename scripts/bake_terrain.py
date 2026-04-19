#!/usr/bin/env python3
"""
Bake USGS 3DEP 1 m DEM tiles into per-cell heightmaps aligned with the
building tile grid.

For every 125 m cell within PAD_CELLS of a building tile, emit a JSON file
containing a flat SAMPLES × SAMPLES Int16 array of elevation in centimetres
above NAVD88. Sample spacing = GRID_SIZE / SAMPLES ≈ 3.9 m.

Outputs:
    public/terrain/cell_{gx}_{gz}.json   — one file per cell

The runtime doesn't use a manifest — it derives (gx, gz) from the player's
local XZ and fetches cell files by URL, treating 404 as "no terrain here".
So this script only emits per-cell files.

Per-cell JSON:
{
  "bounds":  { "minX", "maxX", "minZ", "maxZ" },   # local metres
  "res":     32,                                    # samples per side
  "minCm":   -1234,                                 # lowest sample (sanity)
  "maxCm":    8765,
  "samples": [ ... 1024 ints ... ]                  # row-major: z then x,
                                                    # increasing z = south
                                                    # -32768 = no data
}

Usage:
    python scripts/bake_terrain.py
    python scripts/bake_terrain.py --refresh        # re-emit cells already on disk
    python scripts/bake_terrain.py --limit 100      # stop after N cells (smoke test)
"""

import os, sys, json, math, glob, argparse, time
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

HERE              = os.path.dirname(__file__)
DEM_DIR           = os.path.join(HERE, '..', 'data', 'dem')
OUTPUT_DIR        = os.path.join(HERE, '..', 'public', 'terrain')
BUILDING_MANIFEST = os.path.join(HERE, '..', 'public', 'tiles', 'manifest.json')

GRID_SIZE   = 125    # must match build_tiles.py
SAMPLES     = 32     # per side → ~3.9 m spacing
PAD_CELLS   = 2      # emit terrain for building cells + this many cells of pad
NODATA_I16  = -32768 # sentinel for "no DEM coverage here"

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
    tens of thousands of ocean cells."""
    building_cells = set()
    for t in manifest:
        b = t['bounds']
        gx0 = math.floor(b['minX'] / GRID_SIZE)
        gx1 = math.floor((b['maxX'] - 1e-6) / GRID_SIZE)
        gz0 = math.floor(b['minZ'] / GRID_SIZE)
        gz1 = math.floor((b['maxZ'] - 1e-6) / GRID_SIZE)
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

def open_dems():
    paths = sorted(glob.glob(os.path.join(DEM_DIR, '*.tif')))
    if not paths:
        sys.exit(f'No DEM tiles found in {DEM_DIR}. Run scripts/fetch_dem.py first.')
    dems = []
    for p in paths:
        ds = rasterio.open(p)
        dems.append(ds)
    print(f'Opened {len(dems)} DEM tiles')
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
    """Return SAMPLES × SAMPLES float32 array of elevation in metres for the
    given cell, filling from whichever DEM(s) cover each sample point. NaN
    for any sample outside DEM coverage."""
    # Sample points: cell-centred pixel grid. For SAMPLES=32 over 125 m that
    # puts the first sample at (gx*125 + 125/64, gz*125 + 125/64) and the
    # last at (gx*125 + 125 - 125/64, gz*125 + 125 - 125/64). Runtime
    # consumers can bilinear-interpolate between adjacent cells' samples
    # without worrying about corner alignment.
    half = GRID_SIZE / (2 * SAMPLES)
    xs = np.linspace(gx * GRID_SIZE + half,
                     (gx + 1) * GRID_SIZE - half, SAMPLES, dtype=np.float64)
    zs = np.linspace(gz * GRID_SIZE + half,
                     (gz + 1) * GRID_SIZE - half, SAMPLES, dtype=np.float64)
    X_local, Z_local = np.meshgrid(xs, zs)

    samples = np.full((SAMPLES, SAMPLES), np.nan, dtype=np.float32)

    # Group DEMs by CRS so we only reproject the sample grid once per CRS.
    dems_by_crs = {}
    for ds in dems:
        dems_by_crs.setdefault(str(ds.crs), []).append(ds)

    for crs, ds_list in dems_by_crs.items():
        # Reproject grid to this CRS.
        X_crs, Y_crs = local_to_crs(X_local.ravel(), Z_local.ravel(), crs)
        X_crs = np.asarray(X_crs, dtype=np.float64).reshape(SAMPLES, SAMPLES)
        Y_crs = np.asarray(Y_crs, dtype=np.float64).reshape(SAMPLES, SAMPLES)

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

def encode_samples(samples_m):
    """Convert float32 metres → list of Int16 centimetres, NaN → NODATA_I16.
    Clip real values to ±32767 so the NODATA sentinel stays distinct."""
    real = np.clip(np.round(samples_m * 100), -32767, 32767)
    cm = np.where(np.isnan(samples_m), NODATA_I16, real).astype(np.int16)
    return cm


def cell_bounds(gx, gz):
    return {
        'minX':  gx * GRID_SIZE,
        'maxX': (gx + 1) * GRID_SIZE,
        'minZ':  gz * GRID_SIZE,
        'maxZ': (gz + 1) * GRID_SIZE,
    }


def write_cell(gx, gz, samples_m):
    cm = encode_samples(samples_m)
    valid = cm != NODATA_I16
    if not valid.any():
        return None  # don't emit fully-empty cells
    payload = {
        'bounds':  cell_bounds(gx, gz),
        'res':     SAMPLES,
        'minCm':   int(cm[valid].min()),
        'maxCm':   int(cm[valid].max()),
        'samples': cm.ravel().tolist(),
    }
    path = os.path.join(OUTPUT_DIR, f'cell_{gx}_{gz}.json')
    with open(path, 'w') as f:
        json.dump(payload, f, separators=(',', ':'))
    return payload


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
        out_path = os.path.join(OUTPUT_DIR, f'cell_{gx}_{gz}.json')
        if not args.refresh and os.path.exists(out_path):
            skipped += 1
            continue

        samples_m = sample_cell(gx, gz, dems)
        payload = write_cell(gx, gz, samples_m)
        if payload is None:
            empty += 1
            continue

        written += 1
        if args.limit and written >= args.limit:
            print(f'  --limit reached at {written} cells')
            break

        if (i + 1) % 500 == 0:
            rate = (i + 1) / max(time.time() - t0, 1e-3)
            eta = (len(cells) - i - 1) / max(rate, 1e-3)
            print(f'  [{i+1}/{len(cells)}]  {rate:.0f} cells/s  ETA {eta/60:.1f} min')

    dt = time.time() - t0
    print(f'Done in {dt/60:.1f} min. written={written} skipped={skipped} empty={empty}')


if __name__ == '__main__':
    main()
