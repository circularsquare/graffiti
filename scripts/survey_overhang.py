"""One-shot diagnostic: for every building tile, find the max distance any
vertex extends from the tile's cell-center origin. Used to pick the int16
quantization precision for the binary tile format.

For each axis, reports:
  - max distance from cell center (worst per-tile across the whole dataset)
  - p99, p99.9 distances (so we know what 5 mm res @ ±163 m would clip)
  - min / max Y absolute (to decide uint16 0-655 m vs signed)

Safe to delete after running.
"""
import json
import os
import re
import glob
import sys

TILES_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'tiles')
TILE_FNAME_RE = re.compile(r'cell_(-?\d+)_(-?\d+)\.json$')
TILE_SIZE = 100  # metres — must match build_tiles.py GRID_SIZE

def scan():
    paths = glob.glob(os.path.join(TILES_DIR, 'cell_*.json'))
    n = len(paths)
    print(f'Scanning {n:,} tiles…', flush=True)

    # Per-tile worst-case overhang: max |v - center| in X and Z.
    overhang_xz = []      # max(|x|, |z|) per tile, in metres from cell center
    overhang_x  = []
    overhang_z  = []
    y_min       = float('inf')
    y_max       = float('-inf')

    # Worst single building (for follow-up).
    worst = (0.0, None, None)  # (overhang_m, tile_id, building_id)

    for i, path in enumerate(paths):
        m = TILE_FNAME_RE.search(path)
        if not m:
            continue
        gx, gz = int(m.group(1)), int(m.group(2))
        cx = gx * TILE_SIZE + TILE_SIZE / 2
        cz = gz * TILE_SIZE + TILE_SIZE / 2

        with open(path) as f:
            buildings = json.load(f)

        tile_max_x = 0.0
        tile_max_z = 0.0
        for b in buildings:
            for arr in (b.get('roof', []), b.get('walls', [])):
                for j in range(0, len(arr) - 2, 3):
                    dx = abs(arr[j]   - cx)
                    dy = arr[j + 1]
                    dz = abs(arr[j + 2] - cz)
                    if dx > tile_max_x: tile_max_x = dx
                    if dz > tile_max_z: tile_max_z = dz
                    if dy < y_min: y_min = dy
                    if dy > y_max: y_max = dy

            d = max(tile_max_x, tile_max_z)
            if d > worst[0]:
                worst = (d, f'cell_{gx}_{gz}', b.get('id'))

        overhang_x.append(tile_max_x)
        overhang_z.append(tile_max_z)
        overhang_xz.append(max(tile_max_x, tile_max_z))

        if (i + 1) % 5000 == 0:
            print(f'  {i + 1:,} / {n:,}', flush=True)

    overhang_xz.sort()
    overhang_x.sort()
    overhang_z.sort()
    def pct(a, p):
        return a[min(int(len(a) * p), len(a) - 1)]

    print()
    print(f'XZ overhang (max of |x|, |z| from cell centre, metres):')
    print(f'  median: {pct(overhang_xz, 0.5):.2f}')
    print(f'  p90:    {pct(overhang_xz, 0.90):.2f}')
    print(f'  p99:    {pct(overhang_xz, 0.99):.2f}')
    print(f'  p99.9:  {pct(overhang_xz, 0.999):.2f}')
    print(f'  max:    {overhang_xz[-1]:.2f}')
    print(f'X alone max: {overhang_x[-1]:.2f}    Z alone max: {overhang_z[-1]:.2f}')
    print()
    print(f'Y range (absolute, metres): {y_min:.2f} … {y_max:.2f}')
    print()
    print(f'Worst tile: {worst[1]} (building {worst[2]}) — {worst[0]:.2f} m from centre')
    print()
    print(f'Implication for int16 ±range needed (overhang = max distance from centre):')
    print(f'  max overhang = {overhang_xz[-1]:.1f} m → resolution must be ≥ {overhang_xz[-1] / 32767 * 1000:.2f} mm')

if __name__ == '__main__':
    scan()
