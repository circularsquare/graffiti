#!/usr/bin/env python3
"""
Stream the 30 GB TUM LoD2 CityGML file, bucket buildings into 125 m grid cells,
and write per-cell tile JSONs + a manifest the runtime can stream.

Output layout mirrors build_tiles.py exactly so the runtime can swap manifests:

    public/tiles_lod2/cell_{gx}_{gz}.json
    public/tiles_lod2/manifest.json

Default bbox covers all of Manhattan. Override via --south/--north/--west/--east.

Usage
-----
    python scripts/build_tiles_lod2.py
    python scripts/build_tiles_lod2.py --south 40.74 --north 40.78    # midtown only
"""

import sys, os, json, math, argparse
from lxml import etree

sys.path.insert(0, os.path.dirname(__file__))
from convert_citygml_lod2 import (
    BLDG_NS, CORE_NS,
    _to_32118,
    parse_building, get_envelope, _clear_at_root,
)

# Force line-buffered stdout (Windows / IDE terminals otherwise buffer prints).
try:
    sys.stdout.reconfigure(line_buffering=True)
except AttributeError:
    pass

# Match build_tiles.py — runtime expects 100 m cells and computes cellEstimate
# from surface area / paint-cell-size².
GRID_SIZE       = 100
PAINT_CELL_SIZE = 1.0

DEFAULT_INPUT  = 'data/tum_lod2/NYC_Buildings_LoD2_CityGML.gml'
DEFAULT_OUTPUT = 'public/tiles_lod2'

# All of Manhattan by default — wide enough to catch Hudson Yards, Billionaire's
# Row, and recent FiDi towers, which is where any post-2014 buildings would be.
DEFAULT_BBOX = dict(south=40.700, north=40.880, west=-74.020, east=-73.910)


def building_centroid_and_bounds(b):
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
    return (min_x + max_x) / 2, (min_z + max_z) / 2, min_x, max_x, min_z, max_z


def building_surface_area(b):
    total = 0.0
    for arr in (b['roof'], b['walls']):
        for i in range(0, len(arr) - 8, 9):
            ax, ay, az = arr[i],     arr[i + 1], arr[i + 2]
            bx, by, bz = arr[i + 3], arr[i + 4], arr[i + 5]
            cx, cy, cz = arr[i + 6], arr[i + 7], arr[i + 8]
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx - ax, cy - ay, cz - az
            nx = uy * vz - uz * vy
            ny = uz * vx - ux * vz
            nz = ux * vy - uy * vx
            total += 0.5 * math.sqrt(nx * nx + ny * ny + nz * nz)
    return total


def grid_key(cx, cz):
    return (math.floor(cx / GRID_SIZE), math.floor(cz / GRID_SIZE))


def make_bbox_filter(bbox):
    """Pre-project the lat/lng bbox to EPSG:32118 so envelope checks are pure
    float comparisons. Returns (min_x, max_x, min_y, max_y) in metres."""
    xs, ys = _to_32118.transform(
        [bbox['west'],  bbox['east'],  bbox['west'],  bbox['east']],
        [bbox['south'], bbox['south'], bbox['north'], bbox['north']],
    )
    return min(xs), max(xs), min(ys), max(ys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input',  nargs='?', default=DEFAULT_INPUT,
                    help=f'Path to LoD2 GML (default: {DEFAULT_INPUT})')
    ap.add_argument('--out',  default=DEFAULT_OUTPUT,
                    help=f'Output directory (default: {DEFAULT_OUTPUT})')
    ap.add_argument('--south', type=float, default=DEFAULT_BBOX['south'])
    ap.add_argument('--north', type=float, default=DEFAULT_BBOX['north'])
    ap.add_argument('--west',  type=float, default=DEFAULT_BBOX['west'])
    ap.add_argument('--east',  type=float, default=DEFAULT_BBOX['east'])
    args = ap.parse_args()

    bbox = dict(south=args.south, north=args.north, west=args.west, east=args.east)
    bb_min_x, bb_max_x, bb_min_y, bb_max_y = make_bbox_filter(bbox)

    print(f'Streaming {args.input}', flush=True)
    print(f'  File size: {os.path.getsize(args.input) / (1024**3):.2f} GB', flush=True)
    print(f'  bbox lat[{bbox["south"]}..{bbox["north"]}] lng[{bbox["west"]}..{bbox["east"]}]', flush=True)
    print(f'  bbox EPSG:32118 X[{bb_min_x:.0f}..{bb_max_x:.0f}] Y[{bb_min_y:.0f}..{bb_max_y:.0f}]', flush=True)
    print(f'  Grid: {GRID_SIZE} m cells', flush=True)
    print(f'  Output: {args.out}', flush=True)

    os.makedirs(args.out, exist_ok=True)

    # Wipe stale tile files from any prior run so a smaller bbox doesn't leave
    # leftovers from a wider one (the runtime would happily load them).
    removed = 0
    for fname in os.listdir(args.out):
        if fname.startswith('cell_') and fname.endswith('.json'):
            os.remove(os.path.join(args.out, fname))
            removed += 1
        elif fname == 'manifest.json':
            os.remove(os.path.join(args.out, fname))
            removed += 1
    if removed:
        print(f'  Removed {removed} stale files\n', flush=True)

    cell_data = {}      # (gx, gz) → { buildings: [...], min_x, max_x, min_z, max_z, area }
    raw_events    = 0
    processed     = 0
    in_bbox       = 0

    member_tag = '{%s}cityObjectMember' % CORE_NS
    bldg_path  = './{%s}Building'        % BLDG_NS

    context = etree.iterparse(
        args.input, events=('end',), tag=member_tag, huge_tree=True,
    )

    for _event, member_el in context:
        raw_events += 1
        if raw_events % 50000 == 0:
            print(f'  [scan] {raw_events:,} members | {in_bbox:,} in bbox '
                  f'| {len(cell_data):,} cells', flush=True)

        bldg_el = member_el.find(bldg_path)
        if bldg_el is None:
            _clear_at_root(member_el)
            continue
        processed += 1

        env = get_envelope(bldg_el)
        if env is None:
            _clear_at_root(member_el)
            continue
        (lo, hi) = env
        if not (hi[0] >= bb_min_x and lo[0] <= bb_max_x
                and hi[1] >= bb_min_y and lo[1] <= bb_max_y):
            _clear_at_root(member_el)
            continue

        b = parse_building(bldg_el)
        _clear_at_root(member_el)
        if b is None:
            continue
        in_bbox += 1

        cx, cz, bmin_x, bmax_x, bmin_z, bmax_z = building_centroid_and_bounds(b)
        key = grid_key(cx, cz)
        entry = cell_data.get(key)
        if entry is None:
            entry = {
                'buildings': [],
                'min_x':  math.inf, 'max_x': -math.inf,
                'min_z':  math.inf, 'max_z': -math.inf,
                'area':   0.0,
            }
            cell_data[key] = entry
        entry['buildings'].append(b)
        entry['area'] += building_surface_area(b)
        if bmin_x < entry['min_x']: entry['min_x'] = bmin_x
        if bmax_x > entry['max_x']: entry['max_x'] = bmax_x
        if bmin_z < entry['min_z']: entry['min_z'] = bmin_z
        if bmax_z > entry['max_z']: entry['max_z'] = bmax_z

    print(f'\nScan complete. {raw_events:,} members, {processed:,} buildings, '
          f'{in_bbox:,} in bbox, {len(cell_data):,} cells.', flush=True)

    print(f'\nWriting {len(cell_data):,} cell tiles …', flush=True)
    manifest      = []
    total_size_kb = 0
    for (gx, gz), entry in sorted(cell_data.items()):
        tile_id  = f'cell_{gx}_{gz}'
        out_path = os.path.join(args.out, f'{tile_id}.json')
        with open(out_path, 'w') as f:
            json.dump(entry['buildings'], f, separators=(',', ':'))
        total_size_kb += os.path.getsize(out_path) / 1024
        manifest.append({
            'gx': gx,
            'gz': gz,
            'bounds': {
                'minX': entry['min_x'], 'maxX': entry['max_x'],
                'minZ': entry['min_z'], 'maxZ': entry['max_z'],
            },
            'cellEstimate':  int(round(entry['area'] / (PAINT_CELL_SIZE ** 2))),
        })
        entry['buildings'] = None  # free as we go

    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))

    print(f'  Tiles written: {len(manifest):,}', flush=True)
    print(f'  Total size:    {total_size_kb / 1024:.1f} MB', flush=True)
    print(f'  Avg per tile:  {total_size_kb / max(len(manifest), 1):.0f} KB', flush=True)


if __name__ == '__main__':
    main()
