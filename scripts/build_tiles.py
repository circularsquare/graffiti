#!/usr/bin/env python3
"""
Batch-convert all DA GML files to fine-grained spatial grid tiles and generate
a tile manifest.

Each DA's buildings are split into GRID_SIZE × GRID_SIZE metre cells. Buildings
from different DAs that share a cell are merged into one file. The result is
many small tiles (~tens of KB each) that the runtime can load and unload
precisely as the player moves, rather than 20 large DA-sized tiles.

Outputs:
    public/tiles/cell_{gx}_{gz}.bin    — one binary file per non-empty cell
    public/tiles/manifest.json         — tile index with world-space bounds

Tile binary format (little-endian):
    Header (8 bytes):
        uint32 magic         'GFTI' = 0x49544647
        uint8  version       1
        uint8  reserved
        uint16 buildingCount
    Per-building metadata (variable):
        uint16 roofTriCount
        uint16 wallTriCount
        uint8  idLength
        bytes  id (UTF-8)
    [zero padding to 4-byte boundary]
    Float32 vertex blob (one contiguous block):
        for each building, in order:
            roofTriCount * 9 floats   (absolute world-space X, Y, Z)
            wallTriCount * 9 floats   (same)

Usage:
    python scripts/build_tiles.py
    python scripts/build_tiles.py --bbox -1000 8500 -22000 500   # subset filter
    python scripts/build_tiles.py --manhattan                    # preset

Bounds in manifest are in absolute local metres, same coordinate system as
geo.js (X = east, Z = south, both relative to REF_LNG/REF_LAT in
convert_citygml.py).
"""

import sys, os, json, math, struct, argparse, re, glob as _glob
sys.path.insert(0, os.path.dirname(__file__))
from convert_citygml import parse_buildings, sp_to_local

# Windows' default cp1252 stdout can't encode the box-drawing chars we print
# for progress headings. Force UTF-8 so `npm run build-tiles` works there too.
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

DATA_DIR   = os.path.join(os.path.dirname(__file__), '..', 'data', 'DA_WISE_GMLs')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'tiles')

DA_COUNT  = 20
GRID_SIZE = 100  # metres per cell side — roughly one Manhattan short-block

# Runtime paint-cell edge length (metres). Must match GRID_SIZE in
# src/loadCityGML.js; cellEstimate = surface_area / PAINT_CELL_SIZE² is our
# build-time proxy for the number of 1×1 m paint cells a tile will produce.
PAINT_CELL_SIZE = 1.0

# Tile binary format constants (must match src/tileWorker.js).
TILE_MAGIC   = 0x49544647   # 'GFTI'
TILE_VERSION = 1

# Manhattan island in our local frame (X = east of REF_LNG -74.01175,
# Z = south of REF_LAT 40.70475). Wide enough to include Roosevelt Island and
# the immediate edges of Hoboken / LIC for waterfront context. Tightened
# numbers can come later if we want a tighter island-only build.
MANHATTAN_BBOX = (-1500, 8500, -22000, 1000)  # (minX, maxX, minZ, maxZ)


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
    paint-cell count — each cell is PAINT_CELL_SIZE² so cells ≈ area / 1 m².
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


def encode_tile(gx, gz, buildings):
    """
    Pack a list of buildings into the tile binary format. Vertex coords are
    absolute world-space (same as the JSON format used to ship); we considered
    shifting X/Z to tile-local for float32 precision but it would have rippled
    through the paint pipeline, and absolute float32 ULP at NYC scale (~3 mm
    at 25 km from origin) is still 3× under our tightest geometric tolerance.
    """
    # gx, gz unused — kept in the signature so callers don't have to change if
    # we re-introduce tile-local encoding later.
    del gx, gz

    if len(buildings) > 0xFFFF:
        raise ValueError(f'Tile has {len(buildings)} buildings, exceeds uint16')

    parts = []
    # Header
    parts.append(struct.pack('<IBBH', TILE_MAGIC, TILE_VERSION, 0, len(buildings)))

    # Metadata table
    floats_total = 0
    for b in buildings:
        bid = b['id'].encode('utf-8')
        if len(bid) > 255:
            raise ValueError(f"Building id too long ({len(bid)} bytes): {b['id']!r}")
        roof = b.get('roof', [])
        wall = b.get('walls', [])
        if len(roof) % 9 or len(wall) % 9:
            raise ValueError(f"Vertex array length not multiple of 9 (id {b['id']!r})")
        roof_tris = len(roof) // 9
        wall_tris = len(wall) // 9
        if roof_tris > 0xFFFF or wall_tris > 0xFFFF:
            raise ValueError(f"Triangle count exceeds uint16 (id {b['id']!r})")
        parts.append(struct.pack('<HHB', roof_tris, wall_tris, len(bid)))
        parts.append(bid)
        floats_total += (roof_tris + wall_tris) * 9

    # Pad to 4-byte alignment so the float blob can be read as a Float32Array
    # view without copying.
    meta_bytes = sum(len(p) for p in parts)
    pad = (-meta_bytes) & 3
    if pad:
        parts.append(b'\x00' * pad)

    # Float blob (absolute world-space coords).
    if floats_total > 0:
        import numpy as np
        buf = np.empty(floats_total, dtype='<f4')
        off = 0
        for b in buildings:
            for arr in (b.get('roof', []), b.get('walls', [])):
                if not arr:
                    continue
                src = np.asarray(arr, dtype='<f4')
                buf[off:off + src.size] = src
                off += src.size
        parts.append(buf.tobytes())

    return b''.join(parts)


def in_bbox(cx, cz, bbox):
    if bbox is None:
        return True
    minX, maxX, minZ, maxZ = bbox
    return minX <= cx <= maxX and minZ <= cz <= maxZ


_ENVELOPE_RE = re.compile(
    r'<gml:lowerCorner>\s*([-\d.]+)\s+([-\d.]+).*?</gml:lowerCorner>\s*'
    r'<gml:upperCorner>\s*([-\d.]+)\s+([-\d.]+)',
    re.DOTALL,
)

def da_bbox_local(gml_path):
    """
    Read just the GML's <gml:Envelope> from the file header (first few KB) and
    return its (minX, maxX, minZ, maxZ) in local metres. Skips the
    multi-second lxml parse for DAs that aren't going to contribute.
    Returns None if the envelope can't be found.
    """
    with open(gml_path, 'rb') as f:
        head = f.read(4096).decode('utf-8', errors='replace')
    m = _ENVELOPE_RE.search(head)
    if not m:
        return None
    lx_ft, ly_ft, ux_ft, uy_ft = (float(g) for g in m.groups())
    # State Plane is XY in feet with no Z; pass z=0 since sp_to_local needs it.
    x1, _, z1 = sp_to_local(lx_ft, ly_ft, 0.0)
    x2, _, z2 = sp_to_local(ux_ft, uy_ft, 0.0)
    return (min(x1, x2), max(x1, x2), min(z1, z2), max(z1, z2))


def bbox_overlaps(a, b):
    """Both as (minX, maxX, minZ, maxZ). True iff the rectangles intersect."""
    return not (a[1] < b[0] or a[0] > b[1] or a[3] < b[2] or a[2] > b[3])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bbox', type=float, nargs=4, metavar=('MINX', 'MAXX', 'MINZ', 'MAXZ'),
                        help='Filter buildings to those whose centroid lies in this XZ bbox (local metres).')
    parser.add_argument('--manhattan', action='store_true',
                        help=f'Shortcut for --bbox {" ".join(str(v) for v in MANHATTAN_BBOX)}.')
    parser.add_argument('--das', type=int, nargs='+', metavar='N',
                        help='Whitelist DA numbers to process (e.g. --das 12 for FiDi only). Default: all 1..20.')
    args = parser.parse_args()

    bbox = tuple(args.bbox) if args.bbox else (MANHATTAN_BBOX if args.manhattan else None)
    da_whitelist = set(args.das) if args.das else None

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Clean up every tile from a previous run so stale grids (different
    # GRID_SIZE, JSON-vs-binary format, old da*.json layout) don't linger on
    # disk and shadow new outputs.
    removed = 0
    for pattern in ('da*.json', 'cell_*.json', 'cell_*.bin'):
        for path in _glob.glob(os.path.join(OUTPUT_DIR, pattern)):
            os.remove(path)
            removed += 1
    if removed:
        print(f'Removed {removed} old tile files\n')

    if bbox:
        print(f'Filter: bbox {bbox} (manhattan={args.manhattan})')
    if da_whitelist:
        print(f'Filter: DAs {sorted(da_whitelist)}')

    # cell_data accumulates buildings across all DAs before any file is written,
    # so buildings from different DAs in the same geographic cell are merged.
    cell_data = {}
    total_buildings = 0
    skipped_oob    = 0

    skipped_das = 0
    for n in range(1, DA_COUNT + 1):
        if da_whitelist is not None and n not in da_whitelist:
            skipped_das += 1
            continue

        gml_name = f'DA{n}_3D_Buildings_Merged.gml'
        gml_path = os.path.join(DATA_DIR, gml_name)

        if not os.path.exists(gml_path):
            print(f'[skip] {gml_name} not found')
            continue

        # Cheap envelope check — skip the multi-second lxml parse for DAs
        # whose bbox doesn't intersect our filter. Only kicks in when --bbox
        # or --manhattan is set; full builds run every DA.
        if bbox is not None:
            da_bb = da_bbox_local(gml_path)
            if da_bb is not None and not bbox_overlaps(da_bb, bbox):
                print(f'[skip] DA{n} envelope outside filter bbox')
                skipped_das += 1
                continue

        print(f'\n── DA{n} ──────────────────────────────────')
        buildings = parse_buildings(gml_path, no_filter=True)

        placed = 0
        for b in buildings:
            cx, cz, bmin_x, bmax_x, bmin_z, bmax_z = building_centroid_and_bounds(b)
            if not in_bbox(cx, cz, bbox):
                skipped_oob += 1
                continue
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
        out_path = os.path.join(OUTPUT_DIR, f'{tile_id}.bin')

        with open(out_path, 'wb') as f:
            f.write(encode_tile(gx, gz, entry['buildings']))

        size_kb = os.path.getsize(out_path) / 1024
        total_size_kb += size_kb

        manifest.append({
            'gx': gx,
            'gz': gz,
            'bounds': {
                'minX': entry['min_x'], 'maxX': entry['max_x'],
                'minZ': entry['min_z'], 'maxZ': entry['max_z'],
            },
            'cellEstimate':  int(round(entry['area'] / (PAINT_CELL_SIZE ** 2))),
        })

        # Free building data as we go so memory drops progressively.
        entry['buildings'] = None

    manifest_path = os.path.join(OUTPUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))

    print(f'\n{"─" * 50}')
    print(f'Cell tiles written : {len(manifest)}')
    print(f'Total buildings    : {total_buildings}')
    if skipped_das:
        print(f'Skipped DAs (envelope miss): {skipped_das}')
    if skipped_oob:
        print(f'Skipped buildings (out of bbox): {skipped_oob}')
    print(f'Total size         : {total_size_kb / 1024:.1f} MB')
    print(f'Avg per tile       : {total_size_kb / max(len(manifest), 1):.0f} KB')
    print(f'Manifest           : {manifest_path}')


if __name__ == '__main__':
    main()
