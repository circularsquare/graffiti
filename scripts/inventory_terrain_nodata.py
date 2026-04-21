#!/usr/bin/env python3
"""
Inventory NODATA in baked terrain tiles.

Scans public/terrain/*.bin, decodes each v2 payload, and for every tile with at
least one NODATA sample writes a row to a CSV with:
  gx, gz, nodata_count, nodata_pct (of inner grid),
  valid_min_m, valid_max_m, valid_mean_m,
  nearby_valid_mean_m  — avg elevation of the 3x3-neighbour valid samples for
                         NODATA points, i.e. "how high is the surrounding
                         terrain around the holes"

Also prints a histogram of per-tile NODATA percentages and the worst offenders
so you can cross-reference them on the map.

Usage:
    python scripts/inventory_terrain_nodata.py
"""

import os, sys, gzip, glob, struct, re, csv
import numpy as np

HERE        = os.path.dirname(__file__)
TERRAIN_DIR = os.path.join(HERE, '..', 'public', 'terrain')
OUT_CSV     = os.path.join(HERE, '..', 'terrain_nodata_inventory.csv')

NODATA_U8 = 255
CELL_RE   = re.compile(r'^cell_(-?\d+)_(-?\d+)\.bin$')

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')


def decode_tile(path):
    with gzip.open(path, 'rb') as f:
        buf = f.read()
    version  = buf[0]
    if version != 2:
        raise ValueError(f'unsupported version {version}')
    scale_dm = buf[1]
    res      = struct.unpack('<H', buf[2:4])[0]
    pad      = struct.unpack('<H', buf[4:6])[0]
    min_dm   = struct.unpack('<h', buf[6:8])[0]
    pad_res  = res + 2 * pad
    deltas   = np.frombuffer(buf[8:8 + pad_res * pad_res], dtype=np.uint8)
    deltas   = deltas.reshape(pad_res, pad_res)
    elev_m   = np.where(
        deltas == NODATA_U8,
        np.nan,
        (min_dm + deltas.astype(np.float32) * scale_dm) * 0.1,
    )
    return res, pad, elev_m


def neighbour_mean_for_nodata(elev_m):
    """For each NaN sample, mean of its (up to 8) valid neighbours. Returns
    the tile-wide mean of those per-hole means, or NaN if no hole has any
    valid neighbour at all."""
    h, w  = elev_m.shape
    valid = ~np.isnan(elev_m)
    if not (~valid).any():
        return float('nan')

    total = np.zeros_like(elev_m)
    count = np.zeros_like(elev_m)
    for dz in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dz == 0 and dx == 0:
                continue
            zs = slice(max(0,  dz), h + min(0,  dz))
            zd = slice(max(0, -dz), h + min(0, -dz))
            xs = slice(max(0,  dx), w + min(0,  dx))
            xd = slice(max(0, -dx), w + min(0, -dx))
            src_valid = valid[zs, xs]
            total[zd, xd] += np.where(src_valid, elev_m[zs, xs], 0.0)
            count[zd, xd] += src_valid.astype(np.float32)

    nb_mean = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    nb_for_holes = nb_mean[~valid]
    nb_for_holes = nb_for_holes[~np.isnan(nb_for_holes)]
    if nb_for_holes.size == 0:
        return float('nan')
    return float(nb_for_holes.mean())


def main():
    paths = sorted(glob.glob(os.path.join(TERRAIN_DIR, '*.bin')))
    if not paths:
        sys.exit(f'No .bin files in {TERRAIN_DIR}')
    print(f'Scanning {len(paths)} tiles…')

    rows = []
    clean = 0
    all_nodata = 0
    for i, path in enumerate(paths):
        m = CELL_RE.match(os.path.basename(path))
        if not m:
            continue
        gx, gz = int(m.group(1)), int(m.group(2))

        try:
            res, pad, elev_m = decode_tile(path)
        except Exception as e:
            print(f'  error reading {os.path.basename(path)}: {e}')
            continue

        inner        = elev_m[pad:pad + res, pad:pad + res]
        inner_total  = res * res
        nodata_count = int(np.isnan(inner).sum())
        if nodata_count == 0:
            clean += 1
            continue
        if nodata_count == inner_total:
            all_nodata += 1

        valid = elev_m[~np.isnan(elev_m)]
        if valid.size == 0:
            valid_min = valid_max = valid_mean = float('nan')
        else:
            valid_min  = float(valid.min())
            valid_max  = float(valid.max())
            valid_mean = float(valid.mean())
        nb_mean = neighbour_mean_for_nodata(elev_m)

        def fmt(v): return '' if np.isnan(v) else round(v, 2)
        rows.append({
            'gx': gx, 'gz': gz,
            'nodata_count':        nodata_count,
            'inner_samples':       inner_total,
            'nodata_pct':          round(100 * nodata_count / inner_total, 2),
            'valid_min_m':         fmt(valid_min),
            'valid_max_m':         fmt(valid_max),
            'valid_mean_m':        fmt(valid_mean),
            'nearby_valid_mean_m': fmt(nb_mean),
        })

        if (i + 1) % 5000 == 0:
            print(f'  [{i+1}/{len(paths)}]  holes so far: {len(rows)}')

    with open(OUT_CSV, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=[
            'gx', 'gz', 'nodata_count', 'inner_samples', 'nodata_pct',
            'valid_min_m', 'valid_max_m', 'valid_mean_m', 'nearby_valid_mean_m',
        ])
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print()
    print(f'Total tiles:           {len(paths)}')
    print(f'  clean (no NODATA):   {clean}')
    print(f'  with some NODATA:    {len(rows)}')
    print(f'  inner fully NODATA:  {all_nodata}  (unexpected — bake should skip)')
    print(f'CSV: {OUT_CSV}')

    if rows:
        buckets = [(0, 1), (1, 5), (5, 20), (20, 50), (50, 99), (99, 100.0001)]
        print('\nHistogram of nodata_pct (inner 64×64):')
        for lo, hi in buckets:
            n = sum(1 for r in rows if lo <= r['nodata_pct'] < hi)
            print(f'  [{lo:>3}% .. {hi:>5}%)  {n:>6}')

        print('\n10 worst offenders:')
        for r in sorted(rows, key=lambda r: -r['nodata_pct'])[:10]:
            print(f"  gx={r['gx']:>5} gz={r['gz']:>5}  "
                  f"{r['nodata_pct']:5.1f}%  "
                  f"valid_mean={r['valid_mean_m']}m  "
                  f"nearby_around_holes={r['nearby_valid_mean_m']}m")


if __name__ == '__main__':
    main()
