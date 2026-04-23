#!/usr/bin/env python3
"""
Convert LiDAR-derived NYC tree point shapefile (6M trees, Nature Scientific Data 2023)
to per-tile JSON files for the graffiti game.

Input:  data/lidar_trees/TreePoint/{Bronx,Brooklyn,Manh,Queens,StateI}P.shp  (EPSG:26918)
        public/tiles/cell_*.bin                                              (building roofs)
Output: public/trees/cell_{gx}_{gz}.json                                    — flat [x,z,h,r,y, ...]

Tiles are world-space axis-aligned squares (CELL_SIZE metres), keyed by
floor(x / CELL_SIZE), floor(z / CELL_SIZE).  TreeManager fetches tiles by
grid coord and treats 404 as "no trees here" — no manifest needed.

Per-tree record (5 values): x, z, h (canopy height m), r (crown radius m),
y_abs (absolute world Y; 0 means "ground tree, use terrain at runtime",
any positive value means "rooftop tree, place directly at this Y").

Rooftop detection: read building roof triangles from public/tiles/cell_*.bin,
spatial-index them into a 50 m grid, then for each tree do a point-in-triangle
test on the XZ plane and barycentric-interpolate Y. If any roof covers the
tree, we take the max Y (handles stacked mezzanines / plaza-over-parking).

Shapefile fields (read, not all used):
    VALUE  mean canopy height, decimetres (÷10 → m)
    Area   crown area, m²     (→ crown radius via sqrt(A/π))

Usage:
    python scripts/build_trees.py                 # all 5 boroughs (default)
    python scripts/build_trees.py --bbox fidi     # lower Manhattan only
"""

import json, math, os, argparse, shutil, glob, struct
from collections import defaultdict

import numpy as np
import shapefile
from pyproj import Transformer

REF_LNG = -74.01175
REF_LAT =  40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))  # ≈ 84 390

CELL_SIZE     = 150   # must match TreeManager.js
MIN_HEIGHT_DM =  40   # drop sub-4 m detections (shrubs / small ornamentals / LiDAR noise)
THIN_FRACTION = 0.5   # keep this fraction of survivors (cheap density control)
THIN_SEED     = 42    # deterministic — same build always picks the same subset

# Must match TreeManager.js — used to compute the rendered canopy radius for
# the ground-tree wall-clip filter below.
SIZE_SCALE   = 0.8
MAX_CANOPY_R = 5
WALL_BUFFER  = 0.23   # extra clearance beyond rendered canopy so trees don't kiss walls

FIDI_BBOX = dict(south=40.695, north=40.730, west=-74.025, east=-73.985)

BOROUGHS = ['BronxP', 'BrooklynP', 'ManhP', 'QueensP', 'StateIP']

# Building tile binary format (mirrors src/tileWorker.js).
TILE_MAGIC      = 0x49544647  # 'GFTI'
INDEX_CELL_SIZE = 50          # metres per spatial-index cell for roof triangles
ROOF_EDGE_MARGIN = 2.0        # discard rooftop trees within this many metres of a roof edge


def parse_roof_tris(data):
    """Return (N, 9) float32 array of roof triangles from one tile's bytes.
       9 floats per triangle: [x0,y0,z0, x1,y1,z1, x2,y2,z2] absolute world-space."""
    if len(data) < 8:
        return None
    magic, _version, _reserved, bcount = struct.unpack_from('<IBBH', data, 0)
    if magic != TILE_MAGIC:
        return None
    off = 8
    # Pass 1: per-building metadata (tri counts + variable-length id).
    per_building = []
    total_floats = 0
    for _ in range(bcount):
        roof_tris, wall_tris, id_len = struct.unpack_from('<HHB', data, off)
        off += 5 + id_len
        per_building.append((roof_tris, wall_tris))
        total_floats += (roof_tris + wall_tris) * 9
    # Align to 4-byte boundary before the float blob.
    off = (off + 3) & ~3
    all_floats = np.frombuffer(data, dtype=np.float32, count=total_floats, offset=off)
    # Pass 2: slice out just the roof sections; skip the wall sections.
    chunks = []
    foff = 0
    for roof_tris, wall_tris in per_building:
        roof_floats = roof_tris * 9
        if roof_floats > 0:
            chunks.append(all_floats[foff:foff + roof_floats].reshape(roof_tris, 9))
        foff += roof_floats + wall_tris * 9
    if not chunks:
        return None
    return np.vstack(chunks)


def load_all_roof_tris(tiles_dir):
    paths = sorted(glob.glob(os.path.join(tiles_dir, 'cell_*.bin')))
    print(f'Reading {len(paths):,} building tiles for rooftop detection …')
    chunks = []
    for path in paths:
        with open(path, 'rb') as f:
            data = f.read()
        arr = parse_roof_tris(data)
        if arr is not None:
            chunks.append(arr)
    if not chunks:
        return np.empty((0, 9), dtype=np.float32)
    return np.vstack(chunks)


def build_roof_index(triangles):
    """Grid triangles by their XZ bbox. Returns {(gx, gz): np.int32 array of tri ids}."""
    n = len(triangles)
    xs = triangles[:, [0, 3, 6]]
    zs = triangles[:, [2, 5, 8]]
    min_gx = np.floor(xs.min(axis=1) / INDEX_CELL_SIZE).astype(np.int32)
    max_gx = np.floor(xs.max(axis=1) / INDEX_CELL_SIZE).astype(np.int32)
    min_gz = np.floor(zs.min(axis=1) / INDEX_CELL_SIZE).astype(np.int32)
    max_gz = np.floor(zs.max(axis=1) / INDEX_CELL_SIZE).astype(np.int32)

    index = defaultdict(list)
    for t_id in range(n):
        for gx in range(min_gx[t_id], max_gx[t_id] + 1):
            for gz in range(min_gz[t_id], max_gz[t_id] + 1):
                index[(gx, gz)].append(t_id)
    # Freeze lists into numpy arrays for faster downstream indexing.
    return {k: np.asarray(v, dtype=np.int32) for k, v in index.items()}


def _seg_dist_xz(px, pz, ax, az, bx, bz):
    """XZ distance from point (px,pz) to line segments (ax,az)→(bx,bz), vectorized."""
    abx, abz = bx - ax, bz - az
    apx, apz = px - ax, pz - az
    denom = abx * abx + abz * abz
    t = np.where(denom > 0, np.clip((apx * abx + apz * abz) / denom, 0.0, 1.0), 0.0)
    cx = ax + t * abx
    cz = az + t * abz
    return np.sqrt((px - cx) ** 2 + (pz - cz) ** 2)


def roof_y_at(x, z, triangles, index):
    """Return max roof Y at (x, z), or 0.0 if no building covers this point.
       Rejects trees within ROOF_EDGE_MARGIN metres of every covering triangle's edge
       (catches street-tree canopies that barely overhang the roof perimeter)."""
    gx = int(math.floor(x / INDEX_CELL_SIZE))
    gz = int(math.floor(z / INDEX_CELL_SIZE))
    candidates = index.get((gx, gz))
    if candidates is None or len(candidates) == 0:
        return 0.0
    t = triangles[candidates]
    x0 = t[:, 0]; y0 = t[:, 1]; z0 = t[:, 2]
    x1 = t[:, 3]; y1 = t[:, 4]; z1 = t[:, 5]
    x2 = t[:, 6]; y2 = t[:, 7]; z2 = t[:, 8]
    d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
    safe = d != 0
    d_safe = np.where(safe, d, 1.0)
    a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d_safe
    b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d_safe
    c = 1.0 - a - b
    inside = safe & (a >= 0) & (b >= 0) & (c >= 0)
    if not np.any(inside):
        return 0.0
    # Edge-proximity filter: compute distance from (x,z) to each edge of covering tris.
    ti = t[inside]
    d01 = _seg_dist_xz(x, z, ti[:,0], ti[:,2], ti[:,3], ti[:,5])
    d12 = _seg_dist_xz(x, z, ti[:,3], ti[:,5], ti[:,6], ti[:,8])
    d20 = _seg_dist_xz(x, z, ti[:,6], ti[:,8], ti[:,0], ti[:,2])
    min_edge = np.minimum(np.minimum(d01, d12), d20)
    well_inside = min_edge >= ROOF_EDGE_MARGIN
    if not np.any(well_inside):
        return 0.0
    ai = a[inside][well_inside]; bi = b[inside][well_inside]; ci = c[inside][well_inside]
    ys = ai * y0[inside][well_inside] + bi * y1[inside][well_inside] + ci * y2[inside][well_inside]
    return float(ys.max())


def tree_clips_building(x, z, r, triangles, index):
    """Return True if the circle at (x,z) with radius r intersects any building
    footprint (roof triangle in XZ). Used to drop ground trees whose canopy
    would poke through a wall — their centre is either inside a footprint,
    or close enough to an edge that the sphere overlaps the cliff face."""
    # Canopy radii are ≤ MAX_CANOPY_R (5 m), INDEX_CELL_SIZE is 50 m, so the
    # query spans at most a 2×2 cell block. Expand on both axes to cover the
    # case where the tree sits near a cell boundary.
    gx_min = int(math.floor((x - r) / INDEX_CELL_SIZE))
    gx_max = int(math.floor((x + r) / INDEX_CELL_SIZE))
    gz_min = int(math.floor((z - r) / INDEX_CELL_SIZE))
    gz_max = int(math.floor((z + r) / INDEX_CELL_SIZE))
    cells = []
    for gx in range(gx_min, gx_max + 1):
        for gz in range(gz_min, gz_max + 1):
            c = index.get((gx, gz))
            if c is not None:
                cells.append(c)
    if not cells:
        return False
    # Triangles whose bbox spans multiple cells appear in each — dedup so the
    # vectorised checks don't do duplicate work.
    cand = np.unique(np.concatenate(cells))
    t = triangles[cand]
    x0 = t[:, 0]; z0 = t[:, 2]
    x1 = t[:, 3]; z1 = t[:, 5]
    x2 = t[:, 6]; z2 = t[:, 8]

    # Centre inside footprint → clip (distance would be 0).
    d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
    safe = d != 0
    d_safe = np.where(safe, d, 1.0)
    a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d_safe
    b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d_safe
    c = 1.0 - a - b
    if np.any(safe & (a >= 0) & (b >= 0) & (c >= 0)):
        return True

    # Outside any triangle but close to an edge → still clipping the wall.
    d01 = _seg_dist_xz(x, z, x0, z0, x1, z1)
    d12 = _seg_dist_xz(x, z, x1, z1, x2, z2)
    d20 = _seg_dist_xz(x, z, x2, z2, x0, z0)
    return bool(np.any(np.minimum(np.minimum(d01, d12), d20) < r))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bbox', choices=['fidi'], default=None,
                        help='Optional bbox filter (default: all 5 boroughs)')
    args = parser.parse_args()

    bbox = FIDI_BBOX if args.bbox == 'fidi' else None

    shp_dir    = os.path.join(os.path.dirname(__file__), '..', 'data',
                              'lidar_trees', 'TreePoint')
    tiles_dir  = os.path.join(os.path.dirname(__file__), '..', 'public', 'tiles')
    output_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'trees')

    if os.path.isdir(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Load building roof triangles + spatial index up front.
    roof_tris  = load_all_roof_tris(tiles_dir)
    print(f'  {len(roof_tris):,} roof triangles')
    print('Indexing roof triangles …')
    roof_index = build_roof_index(roof_tris)
    print(f'  {len(roof_index):,} grid cells')

    to_wgs84 = Transformer.from_crs('EPSG:26918', 'EPSG:4326', always_xy=True)
    rng      = np.random.default_rng(THIN_SEED)
    cells    = defaultdict(list)
    n_total  = 0
    n_keep   = 0
    n_roof   = 0
    n_clip   = 0

    for boro in BOROUGHS:
        input_path = os.path.join(shp_dir, boro)
        print(f'Reading {boro}.shp …')
        r = shapefile.Reader(input_path)
        nb = len(r)
        n_total += nb
        print(f'  {nb:,} points')

        xs    = np.empty(nb, dtype=np.float64)
        ys    = np.empty(nb, dtype=np.float64)
        hs    = np.empty(nb, dtype=np.int32)
        areas = np.empty(nb, dtype=np.float32)

        for i, sr in enumerate(r.iterShapeRecords()):
            pt = sr.shape.points[0]
            xs[i]    = pt[0]
            ys[i]    = pt[1]
            hs[i]    = sr.record[0]
            areas[i] = sr.record[1]

        lngs, lats = to_wgs84.transform(xs, ys)
        lngs, lats = np.asarray(lngs), np.asarray(lats)
        world_x =  (lngs - REF_LNG) * METERS_PER_LNG
        world_z = -(lats - REF_LAT) * METERS_PER_LAT

        keep = hs >= MIN_HEIGHT_DM
        if bbox:
            keep &= (lats >= bbox['south']) & (lats <= bbox['north'])
            keep &= (lngs >= bbox['west'])  & (lngs <= bbox['east'])
        keep &= rng.random(nb) < THIN_FRACTION

        nk = int(keep.sum())
        n_keep += nk
        print(f'  {nk:,} after filter + thin; placing …')

        boro_roof = 0
        boro_clip = 0
        for i in np.where(keep)[0]:
            x    = float(world_x[i])
            z    = float(world_z[i])
            h    = hs[i] / 10.0
            area = float(areas[i])
            rr   = math.sqrt(area / math.pi) if area > 0 else max(0.5, h * 0.3)
            y_abs = roof_y_at(x, z, roof_tris, roof_index)
            if y_abs > 0:
                boro_roof += 1
            else:
                # Ground tree: drop if its rendered canopy would overlap a wall.
                canopy_r = min(rr, MAX_CANOPY_R) * SIZE_SCALE + WALL_BUFFER
                if tree_clips_building(x, z, canopy_r, roof_tris, roof_index):
                    boro_clip += 1
                    continue
            gx = int(math.floor(x / CELL_SIZE))
            gz = int(math.floor(z / CELL_SIZE))
            cells[(gx, gz)].extend([
                round(x, 1), round(z, 1), round(h, 1), round(rr, 1), round(y_abs, 1),
            ])
        n_roof += boro_roof
        n_clip += boro_clip
        print(f'  {boro_roof:,} of those landed on a rooftop; {boro_clip:,} dropped for wall clearance')

    total_bytes = 0
    for (gx, gz), flat in cells.items():
        path = os.path.join(output_dir, f'cell_{gx}_{gz}.json')
        with open(path, 'w') as f:
            json.dump(flat, f, separators=(',', ':'))
        total_bytes += os.path.getsize(path)

    print(f'Wrote {n_keep - n_clip:,} trees ({n_roof:,} rooftop, {n_clip:,} dropped for wall clearance) '
          f'across {len(cells):,} tiles → {output_dir}/ ({total_bytes / 1_000_000:.1f} MB raw)')


if __name__ == '__main__':
    main()
