#!/usr/bin/env python3
"""
Survey building sizes across all tile JSON files.

Estimates per-building paint-cell count from total triangle surface area
(roof + walls) divided by the 2m×2m cell area (4 m²). This is a proxy —
the runtime worker does surface-aligned grid clipping per face, which is
affected by face orientation, sliver merging, and shared edges. But for
a rough size distribution / outlier hunt the area-based estimate is
within a small constant factor of the true cell count.

Usage:
    python scripts/survey_building_sizes.py
    python scripts/survey_building_sizes.py --top 30 --out survey.json
"""

import argparse, glob, json, math, os, sys, time
from collections import defaultdict

TILES_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'tiles')
CELL_AREA = 4.0  # 2m × 2m

HIST_BUCKETS = [
    (0, 10),       (10, 25),      (25, 50),      (50, 100),
    (100, 250),    (250, 500),    (500, 1000),   (1000, 2500),
    (2500, 5000),  (5000, 10000), (10000, 25000), (25000, math.inf),
]


def tri_area(ax, ay, az, bx, by, bz, cx, cy, cz):
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    return 0.5 * math.sqrt(nx * nx + ny * ny + nz * nz)


def surface_area(arr):
    total = 0.0
    for i in range(0, len(arr) - 8, 9):
        total += tri_area(
            arr[i+0], arr[i+1], arr[i+2],
            arr[i+3], arr[i+4], arr[i+5],
            arr[i+6], arr[i+7], arr[i+8],
        )
    return total


def bucket_label(lo, hi):
    if hi == math.inf:
        return f'{lo}+'
    return f'{lo}-{hi}'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--top', type=int, default=20, help='Number of largest buildings to list')
    p.add_argument('--out', type=str, default=None, help='Optional JSON output path')
    args = p.parse_args()

    paths = sorted(glob.glob(os.path.join(TILES_DIR, 'cell_*.json')))
    if not paths:
        print(f'No tile files found in {TILES_DIR}', file=sys.stderr)
        sys.exit(1)

    print(f'Scanning {len(paths)} tile files …')
    t0 = time.time()

    hist = defaultdict(int)
    top = []  # list of (cells, id, tile, roof_cells, wall_cells)
    total_buildings = 0
    total_cells = 0.0
    max_top = max(args.top, 50)

    for i, path in enumerate(paths):
        with open(path, 'r') as f:
            buildings = json.load(f)
        tile_id = os.path.basename(path)[:-5]

        for b in buildings:
            roof_area = surface_area(b.get('roof', []))
            wall_area = surface_area(b.get('walls', []))
            cells = (roof_area + wall_area) / CELL_AREA

            total_buildings += 1
            total_cells += cells

            for lo, hi in HIST_BUCKETS:
                if lo <= cells < hi:
                    hist[(lo, hi)] += 1
                    break

            if len(top) < max_top:
                top.append((cells, b.get('id', '?'), tile_id,
                            roof_area / CELL_AREA, wall_area / CELL_AREA))
                top.sort(reverse=True)
            elif cells > top[-1][0]:
                top[-1] = (cells, b.get('id', '?'), tile_id,
                           roof_area / CELL_AREA, wall_area / CELL_AREA)
                top.sort(reverse=True)

        if (i + 1) % 2000 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed
            eta = (len(paths) - i - 1) / rate
            print(f'  {i+1:>6}/{len(paths)} tiles  '
                  f'({total_buildings:,} buildings)  '
                  f'eta {eta:.0f}s')

    elapsed = time.time() - t0
    print(f'\nDone in {elapsed:.1f}s — {total_buildings:,} buildings, '
          f'{total_cells:,.0f} estimated cells total')

    # ── Histogram ────────────────────────────────────────────────────────────
    print(f'\nHistogram of estimated cells per building:')
    print(f'  {"range":>14}  {"count":>8}  {"pct":>6}  {"cum%":>6}')
    cum = 0
    for lo, hi in HIST_BUCKETS:
        n = hist[(lo, hi)]
        cum += n
        pct = 100 * n / total_buildings if total_buildings else 0
        cumpct = 100 * cum / total_buildings if total_buildings else 0
        bar = '█' * max(1, int(50 * pct / 100)) if n else ''
        print(f'  {bucket_label(lo, hi):>14}  {n:>8,}  {pct:>5.1f}%  {cumpct:>5.1f}%  {bar}')

    # ── Percentiles ──────────────────────────────────────────────────────────
    # (from histogram — rough, but enough for context)

    # ── Top offenders ────────────────────────────────────────────────────────
    print(f'\nTop {args.top} largest buildings (by estimated cell count):')
    print(f'  {"cells":>10}  {"roof":>8}  {"walls":>8}  {"tile":>18}  id')
    for cells, bid, tile, rcells, wcells in top[:args.top]:
        print(f'  {cells:>10,.0f}  {rcells:>8,.0f}  {wcells:>8,.0f}  {tile:>18}  {bid}')

    if args.out:
        payload = {
            'total_buildings':  total_buildings,
            'total_cells_est':  total_cells,
            'elapsed_seconds':  elapsed,
            'histogram': [
                {'lo': lo, 'hi': None if hi == math.inf else hi, 'count': hist[(lo, hi)]}
                for lo, hi in HIST_BUCKETS
            ],
            'top': [
                {'cells': c, 'id': i, 'tile': t, 'roof_cells': r, 'wall_cells': w}
                for c, i, t, r, w in top[:args.top]
            ],
        }
        with open(args.out, 'w') as f:
            json.dump(payload, f, indent=2)
        print(f'\nWrote JSON output to {args.out}')


if __name__ == '__main__':
    main()
