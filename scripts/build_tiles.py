#!/usr/bin/env python3
"""
Batch-convert all DA GML files to fine-grained spatial grid tiles and generate
a tile manifest.

Each DA's buildings are split into GRID_SIZE × GRID_SIZE metre cells. Buildings
from different DAs that share a cell are merged into one file. The result is
many small tiles (~1 MB each) that the runtime can load and unload precisely as
the player moves, rather than 20 large DA-sized tiles.

Outputs:
    public/tiles/cell_{gx}_{gz}.json   — one file per non-empty grid cell
    public/tiles/manifest.json         — tile index with world-space bounds

Usage:
    python scripts/build_tiles.py

Bounds in manifest are in local metres, same coordinate system as geo.js
(X = east, Z = south, both relative to REF_LNG/REF_LAT in convert_citygml.py).
"""

import sys, os, json, math, glob as _glob
sys.path.insert(0, os.path.dirname(__file__))
from convert_citygml import parse_buildings

# Windows' default cp1252 stdout can't encode the box-drawing chars we print
# for progress headings. Force UTF-8 so `npm run build-tiles` works there too.
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

DATA_DIR   = os.path.join(os.path.dirname(__file__), '..', 'data', 'DA_WISE_GMLs')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'tiles')

DA_COUNT  = 20
GRID_SIZE = 125  # metres per cell side — roughly one Manhattan long-block / 1.5 short blocks

# Runtime paint-cell edge length (metres). Must match GRID_SIZE in
# src/loadCityGML.js; cellEstimate = surface_area / PAINT_CELL_SIZE² is our
# build-time proxy for the number of 2×2 m paint cells a tile will produce.
PAINT_CELL_SIZE = 2.0


def building_centroid_and_bounds(b):
    """
    Scan a building's flat vertex arrays to find its bounding box centre and
    tight XZ bounds. Returns (cx, cz, min_x, max_x, min_z, max_z).
    """
    min_x = min_z =  math.inf
    max_x = max_z = -math.inf
    for arr in (b['roof'], b['walls']):
        for i in range(0, len(arr) - 2, 3):
            x, z = arr[i], arr[i + 2]
            if x < min_x: min_x = x
            if x > max_x: max_x = x
            if z < min_z: min_z = z
            if z > max_z: max_z = z
    if min_x == math.inf:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
    cx = (min_x + max_x) / 2
    cz = (min_z + max_z) / 2
    return cx, cz, min_x, max_x, min_z, max_z


def building_surface_area(b):
    """
    Sum the area of every triangle across roof + walls. Used as a proxy for
    paint-cell count — each cell is PAINT_CELL_SIZE² so cells ≈ area / 4 m².
    Vertices are flat [x, y, z, x, y, z, …] in 3 × 3-tuple triangle groups.
    """
    total = 0.0
    for arr in (b['roof'], b['walls']):
        for i in range(0, len(arr) - 8, 9):
            ax, ay, az = arr[i],     arr[i + 1], arr[i + 2]
            bx, by, bz = arr[i + 3], arr[i + 4], arr[i + 5]
            cx, cy, cz = arr[i + 6], arr[i + 7], arr[i + 8]
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx - ax, cy - ay, cz - az
            # |u × v| / 2
            nx = uy * vz - uz * vy
            ny = uz * vx - ux * vz
            nz = ux * vy - uy * vx
            total += 0.5 * math.sqrt(nx * nx + ny * ny + nz * nz)
    return total


def grid_key(cx, cz):
    return (math.floor(cx / GRID_SIZE), math.floor(cz / GRID_SIZE))


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Clean up every tile from a previous run so stale grids (different
    # GRID_SIZE, old da*.json format, etc.) don't linger on disk.
    removed = 0
    for pattern in ('da*.json', 'cell_*.json'):
        for path in _glob.glob(os.path.join(OUTPUT_DIR, pattern)):
            os.remove(path)
            removed += 1
    if removed:
        print(f'Removed {removed} old tile files\n')

    # cell_data accumulates buildings across all DAs before any file is written,
    # so buildings from different DAs in the same geographic cell are merged.
    #
    # key: (gx, gz) int tuple
    # value: { 'buildings': [...], 'min_x', 'max_x', 'min_z', 'max_z' }
    cell_data = {}

    total_buildings = 0

    for n in range(1, DA_COUNT + 1):
        gml_name = f'DA{n}_3D_Buildings_Merged.gml'
        gml_path = os.path.join(DATA_DIR, gml_name)

        if not os.path.exists(gml_path):
            print(f'[skip] {gml_name} not found')
            continue

        print(f'\n── DA{n} ──────────────────────────────────')
        buildings = parse_buildings(gml_path, no_filter=True)

        placed = 0
        for b in buildings:
            cx, cz, bmin_x, bmax_x, bmin_z, bmax_z = building_centroid_and_bounds(b)
            key = grid_key(cx, cz)

            if key not in cell_data:
                cell_data[key] = {
                    'buildings': [],
                    'min_x':  math.inf, 'max_x': -math.inf,
                    'min_z':  math.inf, 'max_z': -math.inf,
                    'area':   0.0,
                }

            entry = cell_data[key]
            entry['buildings'].append(b)
            entry['area'] += building_surface_area(b)
            if bmin_x < entry['min_x']: entry['min_x'] = bmin_x
            if bmax_x > entry['max_x']: entry['max_x'] = bmax_x
            if bmin_z < entry['min_z']: entry['min_z'] = bmin_z
            if bmax_z > entry['max_z']: entry['max_z'] = bmax_z
            placed += 1

        total_buildings += placed
        print(f'  Placed {placed} buildings into {len(cell_data)} cells (total so far)')

    # ── Write phase ───────────────────────────────────────────────────────────

    print(f'\n{"─" * 50}')
    print(f'Writing {len(cell_data)} cell tiles …')

    manifest = []
    total_size_kb = 0

    for (gx, gz), entry in sorted(cell_data.items()):
        tile_id  = f'cell_{gx}_{gz}'
        out_path = os.path.join(OUTPUT_DIR, f'{tile_id}.json')

        with open(out_path, 'w') as f:
            json.dump(entry['buildings'], f, separators=(',', ':'))

        size_kb = os.path.getsize(out_path) / 1024
        total_size_kb += size_kb

        manifest.append({
            'id':            tile_id,
            'file':          f'/tiles/{tile_id}.json',
            'bounds': {
                'minX': entry['min_x'], 'maxX': entry['max_x'],
                'minZ': entry['min_z'], 'maxZ': entry['max_z'],
            },
            'buildingCount': len(entry['buildings']),
            # Proxy for paint-cell count, used by TileManager to budget adaptive
            # load radius (sparse areas load further out). Overestimates because
            # it doesn't account for face merging or per-face UV centring, but
            # consistent scaling is what matters for the budget comparison.
            'cellEstimate':  int(round(entry['area'] / (PAINT_CELL_SIZE ** 2))),
        })

        # Free building data as we go so memory drops progressively.
        entry['buildings'] = None

    manifest_path = os.path.join(OUTPUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f'\n{"─" * 50}')
    print(f'Cell tiles written : {len(manifest)}')
    print(f'Total buildings    : {total_buildings}')
    print(f'Total size         : {total_size_kb / 1024:.1f} MB')
    print(f'Avg per tile       : {total_size_kb / max(len(manifest), 1):.0f} KB')
    print(f'Manifest           : {manifest_path}')


if __name__ == '__main__':
    main()
