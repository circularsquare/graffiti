"""One-shot cleanup: remove paint cells whose block-center lies over OSM water.

Before water blocking existed client-side, `seedTerrainCells` happily rolled
seed paint onto river/bay cells and the runtime saved it to disk.  This script
walks every data/paint/terrain_*.json, looks up water triangles from the OSM
binary tiles (public/osm/cell_{gx}_{gz}.bin.gz), and drops any cell whose
block-center is inside water.  The `__seed_complete__` sentinel is preserved
so already-seeded tiles don't re-seed the water back in on next visit.

Run once:  python scripts/clear_water_paint.py
Re-running is a no-op (naturally idempotent).
"""

import gzip
import json
import os
import re
import struct
import sys

HERE        = os.path.dirname(__file__)
PAINT_DIR   = os.path.join(HERE, '..', 'data', 'paint')
OSM_DIR     = os.path.join(HERE, '..', 'public', 'osm')

# Must match fetch_osm_features.py.
GRID_SIZE   = 125
BIN_MAGIC   = 0x4D534F47
BIN_VERSION = 1
BIN_INV     = 0.1           # decimetre → metre

# Must match bake_terrain.py (SAMPLES = 64).
SAMPLES     = 64
STEP        = GRID_SIZE / SAMPLES

SENTINEL    = '__seed_complete__'

TERRAIN_NAME_RE = re.compile(r'^terrain_(-?\d+)_(-?\d+)\.json$')
# terrain_{gx}_{gz}:{meshType}:{ix}:{iz}:{iy}
CELL_KEY_RE     = re.compile(r'^terrain_(-?\d+)_(-?\d+):[^:]+:(\d+):(\d+):-?\d+$')


def decode_water_triangles(osm_path):
    """Return a list of (x0, z0, x1, z1, x2, z2) triangles in tile-local metres.

    Decodes only the water section of the OSM binary tile format documented in
    scripts/fetch_osm_features.py::encode_tile_binary.
    """
    with gzip.open(osm_path, 'rb') as f:
        buf = f.read()

    p = 0
    magic, version, _res, gx, gz, type_count, _res2 = struct.unpack_from('<IBBhhBB', buf, p)
    p += 12
    if magic != BIN_MAGIC or version != BIN_VERSION:
        raise ValueError(f'{osm_path}: bad magic/version')

    # Skip type table.
    for _ in range(type_count):
        slen = buf[p]; p += 1 + slen
    p = (p + 3) & ~3

    # Skip streets.
    street_count = struct.unpack_from('<I', buf, p)[0]; p += 4
    for _ in range(street_count):
        _type_idx, name_len, point_count = struct.unpack_from('<BBH', buf, p); p += 4
        p += name_len
        p = (p + 3) & ~3
        p += point_count * 8

    origin_x = gx * GRID_SIZE
    origin_z = gz * GRID_SIZE

    # Water.
    poly_count = struct.unpack_from('<I', buf, p)[0]; p += 4
    tris = []
    for _ in range(poly_count):
        coord_count = struct.unpack_from('<I', buf, p)[0]; p += 4
        # coords are int32 decimetres relative to (origin_x, origin_z).
        coords = struct.unpack_from(f'<{coord_count}i', buf, p)
        p += coord_count * 4
        # coords form flat [x,z, x,z, ...] with 6 values per triangle.
        for i in range(0, coord_count, 6):
            x0 = coords[i    ] * BIN_INV + origin_x
            z0 = coords[i + 1] * BIN_INV + origin_z
            x1 = coords[i + 2] * BIN_INV + origin_x
            z1 = coords[i + 3] * BIN_INV + origin_z
            x2 = coords[i + 4] * BIN_INV + origin_x
            z2 = coords[i + 5] * BIN_INV + origin_z
            tris.append((x0, z0, x1, z1, x2, z2))
    return tris


def point_in_any_triangle(px, pz, tris):
    """Sign-of-cross-product point-in-triangle test, OR'd across all tris."""
    for x0, z0, x1, z1, x2, z2 in tris:
        # Fast bbox reject.
        if px < min(x0, x1, x2) or px > max(x0, x1, x2): continue
        if pz < min(z0, z1, z2) or pz > max(z0, z1, z2): continue
        d1 = (px - x1) * (z0 - z1) - (x0 - x1) * (pz - z1)
        d2 = (px - x2) * (z1 - z2) - (x1 - x2) * (pz - z2)
        d3 = (px - x0) * (z2 - z0) - (x2 - x0) * (pz - z0)
        has_neg = d1 < 0 or d2 < 0 or d3 < 0
        has_pos = d1 > 0 or d2 > 0 or d3 > 0
        if not (has_neg and has_pos):
            return True
    return False


def main():
    if not os.path.isdir(PAINT_DIR):
        print(f'No paint dir at {PAINT_DIR}, nothing to do.')
        return

    paint_files = [f for f in os.listdir(PAINT_DIR) if TERRAIN_NAME_RE.match(f)]
    print(f'Scanning {len(paint_files)} terrain paint files …')

    total_removed = 0
    files_touched = 0
    for fname in sorted(paint_files):
        m = TERRAIN_NAME_RE.match(fname)
        gx, gz = int(m.group(1)), int(m.group(2))

        osm_path = os.path.join(OSM_DIR, f'cell_{gx}_{gz}.bin.gz')
        if not os.path.exists(osm_path):
            continue  # no OSM tile → no water to check

        tris = decode_water_triangles(osm_path)
        if not tris:
            continue

        paint_path = os.path.join(PAINT_DIR, fname)
        with open(paint_path, 'r') as f:
            data = json.load(f)

        # Cell XZ centres are block-local.  meshType is irrelevant for the water
        # test — if a block sits over water, all its faces (top + any sides) are
        # underwater and should lose their paint.
        removed = 0
        for key in list(data.keys()):
            if key == SENTINEL:
                continue
            km = CELL_KEY_RE.match(key)
            if not km:
                continue
            ix, iz = int(km.group(3)), int(km.group(4))
            px = gx * GRID_SIZE + (ix + 0.5) * STEP
            pz = gz * GRID_SIZE + (iz + 0.5) * STEP
            if point_in_any_triangle(px, pz, tris):
                del data[key]
                removed += 1

        if removed:
            with open(paint_path, 'w') as f:
                json.dump(data, f, separators=(',', ':'))
            total_removed += removed
            files_touched += 1
            print(f'  {fname}: dropped {removed} cell(s)')

    print(f'\nDone. {total_removed} water cell(s) cleared across {files_touched} file(s).')


if __name__ == '__main__':
    main()
