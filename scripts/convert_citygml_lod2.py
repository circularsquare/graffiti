#!/usr/bin/env python3
"""
Convert TUM-enhanced NYC LoD2 CityGML to a Three.js-ready JSON.

Differences from convert_citygml.py:
  - Source CRS is EPSG:32118 (NY Long Island, metres) — not 2263 (feet).
  - Z values are already metres; no feet→m conversion.
  - The full-NYC file is ~30 GB, so we stream with lxml.iterparse
    instead of loading the whole tree into memory.
  - Uses each Building's gml:Envelope for fast bbox rejection
    before parsing surfaces.

Output format matches convert_citygml.py exactly so it's a drop-in
swap for public/buildings.json.

Usage
-----
    python scripts/convert_citygml_lod2.py data/tum_lod2/NYC_Buildings_LoD2_CityGML.gml
    # → public/buildings_lod2.json
"""

import sys, os, json, math, argparse
# Force line-buffered stdout so progress prints appear immediately even
# when piped or run inside an IDE terminal.
try:
    sys.stdout.reconfigure(line_buffering=True)
except AttributeError:
    pass
import numpy as np
from lxml import etree
from pyproj import Transformer
import mapbox_earcut as earcut

# ── Coordinate projection ─────────────────────────────────────────────────────

# TUM LoD2 uses NAD83 / New York Long Island (EPSG:32118), metres.
_to_wgs84 = Transformer.from_crs("EPSG:32118", "EPSG:4326", always_xy=True)
_to_32118 = Transformer.from_crs("EPSG:4326", "EPSG:32118", always_xy=True)

# Same reference point as src/geo.js (must match convert_citygml.py)
REF_LNG = -74.01175
REF_LAT =  40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))

# FiDi bounding box (lat/lng) — only buildings overlapping this are emitted
BBOX = dict(south=40.7020, north=40.7075, west=-74.0155, east=-74.0080)

# Pre-project bbox to EPSG:32118 so envelope checks are pure float comparisons.
_bx, _by = _to_32118.transform(
    [BBOX['west'],  BBOX['east'],  BBOX['west'],  BBOX['east']],
    [BBOX['south'], BBOX['south'], BBOX['north'], BBOX['north']],
)
BBOX_SP_MIN_X, BBOX_SP_MAX_X = min(_bx), max(_bx)
BBOX_SP_MIN_Y, BBOX_SP_MAX_Y = min(_by), max(_by)


def sp_to_local(x_m, y_m, z_m):
    """EPSG:32118 metres → local (x, y, z) metres. y = up, z = south (+)."""
    lng, lat = _to_wgs84.transform(x_m, y_m)
    lx =  (lng - REF_LNG) * METERS_PER_LNG
    ly =   z_m
    lz = -(lat - REF_LAT) * METERS_PER_LAT
    return (lx, ly, lz)


def envelope_in_bbox(lower, upper):
    """AABB overlap test in EPSG:32118 space — no reprojection per building."""
    return (upper[0] >= BBOX_SP_MIN_X and lower[0] <= BBOX_SP_MAX_X
            and upper[1] >= BBOX_SP_MIN_Y and lower[1] <= BBOX_SP_MAX_Y)


# ── CityGML parsing ───────────────────────────────────────────────────────────

GML_NS  = 'http://www.opengis.net/gml'
BLDG_NS = 'http://www.opengis.net/citygml/building/2.0'
CORE_NS = 'http://www.opengis.net/citygml/2.0'


def local_tag(el):
    t = el.tag
    return t.split('}')[-1] if '}' in t else t


def parse_poslist(text):
    nums = list(map(float, text.split()))
    return [(nums[i], nums[i+1], nums[i+2]) for i in range(0, len(nums) - 2, 3)]


def get_outer_ring(polygon_el):
    for el in polygon_el.iter():
        if local_tag(el) == 'posList' and el.text:
            return parse_poslist(el.text.strip())
    return []


_ENV_PATH   = './{%s}boundedBy/{%s}Envelope' % (GML_NS, GML_NS)
_LOWER_PATH = './{%s}lowerCorner' % GML_NS
_UPPER_PATH = './{%s}upperCorner' % GML_NS


def get_envelope(bldg_el):
    """Return ((minX, minY[, minZ]), (maxX, maxY[, maxZ])) or None. Fast: direct
    find() on the known boundedBy path instead of walking the full subtree."""
    env = bldg_el.find(_ENV_PATH)
    if env is None:
        return None
    lower_el = env.find(_LOWER_PATH)
    upper_el = env.find(_UPPER_PATH)
    if lower_el is None or upper_el is None or not lower_el.text or not upper_el.text:
        return None
    lower = tuple(float(v) for v in lower_el.text.split())
    upper = tuple(float(v) for v in upper_el.text.split())
    if len(lower) < 2 or len(upper) < 2:
        return None
    return (lower, upper)


def triangulate_face(sp_pts):
    verts = np.array([sp_to_local(*p) for p in sp_pts], dtype=np.float64)

    if len(verts) > 1 and np.allclose(verts[0], verts[-1]):
        verts = verts[:-1]

    n = len(verts)
    if n < 3:
        return []

    if n == 3:
        return verts.flatten().tolist()

    e0 = verts[1] - verts[0]
    norm0 = np.linalg.norm(e0)
    if norm0 < 1e-10:
        return []
    e0 /= norm0

    cross = np.cross(e0, verts[2] - verts[0])
    cross_norm = np.linalg.norm(cross)
    if cross_norm < 1e-10:
        return []
    face_normal = cross / cross_norm
    e1 = np.cross(face_normal, e0)

    verts_2d = np.column_stack([verts @ e0, verts @ e1]).astype(np.float32)
    indices = earcut.triangulate_float32(verts_2d, np.array([n], dtype=np.uint32))
    if not len(indices):
        return []

    out = []
    for i in indices:
        out.extend(verts[i].tolist())
    return out


def parse_building(bldg_el):
    roof_tris = []
    wall_tris = []

    for surface_el in bldg_el.iter():
        t = local_tag(surface_el)
        if t not in ('RoofSurface', 'WallSurface'):
            continue

        is_roof = (t == 'RoofSurface')

        for poly_el in surface_el.iter():
            if local_tag(poly_el) != 'Polygon':
                continue
            ring = get_outer_ring(poly_el)
            if len(ring) < 3:
                continue
            tris = triangulate_face(ring)
            if is_roof:
                roof_tris.extend(tris)
            else:
                wall_tris.extend(tris)

    if not roof_tris and not wall_tris:
        return None

    gml_id = (
        bldg_el.get('{%s}id' % GML_NS)
        or bldg_el.get('gml:id', '')
        or bldg_el.get('id', '')
    )

    return {'id': gml_id, 'roof': roof_tris, 'walls': wall_tris}


# ── Streaming main ────────────────────────────────────────────────────────────

def parse_buildings_streaming(input_path, no_filter=False, progress_every=100):
    """
    Stream a CityGML file with lxml.iterparse, emitting one Building at a time.
    Memory stays bounded regardless of file size.
    """
    print(f'Streaming {input_path} …', flush=True)
    print(f'  File size: {os.path.getsize(input_path) / (1024**3):.2f} GB', flush=True)
    print(f'  FiDi bbox in EPSG:32118: '
          f'X[{BBOX_SP_MIN_X:.0f}..{BBOX_SP_MAX_X:.0f}] '
          f'Y[{BBOX_SP_MIN_Y:.0f}..{BBOX_SP_MAX_Y:.0f}]', flush=True)

    buildings = []
    seen = 0
    skipped_bbox = 0
    skipped_empty = 0
    skipped_no_envelope = 0

    member_tag = '{%s}cityObjectMember' % CORE_NS
    bldg_path  = './{%s}Building' % BLDG_NS

    # Iterate on cityObjectMember (not Building) — each wraps exactly one
    # Building, and clearing the member releases the whole subtree from root.
    context = etree.iterparse(
        input_path,
        events=('end',),
        tag=member_tag,
        huge_tree=True,
    )

    first_event_logged = False
    raw_events = 0
    no_bldg_members = 0
    for _event, member_el in context:
        if not first_event_logged:
            print('  iterparse fired first event — entering loop', flush=True)
            first_event_logged = True
        raw_events += 1
        if raw_events % 50000 == 0:
            print(f'  [raw] {raw_events:,} cityObjectMembers seen, '
                  f'{no_bldg_members:,} had no Building, '
                  f'{seen:,} processed, {len(buildings):,} kept',
                  flush=True)
        bldg_el = member_el.find(bldg_path)
        if bldg_el is None:
            no_bldg_members += 1
            _clear_at_root(member_el)
            continue

        seen += 1

        if not no_filter:
            env = get_envelope(bldg_el)
            if env is None:
                skipped_no_envelope += 1
                _clear_at_root(member_el)
                continue
            if not envelope_in_bbox(*env):
                skipped_bbox += 1
                _clear_at_root(member_el)
                continue

        b = parse_building(bldg_el)
        if b:
            buildings.append(b)
        else:
            skipped_empty += 1

        _clear_at_root(member_el)

        if seen % progress_every == 0:
            print(f'  …seen {seen:>7,}  kept {len(buildings):>6,}  '
                  f'(bbox-skip {skipped_bbox:,}, empty {skipped_empty:,})')

    print(f'Done. Saw {seen:,} buildings, kept {len(buildings):,}.')
    if not no_filter:
        print(f'  {skipped_bbox:,} outside bbox, '
              f'{skipped_no_envelope:,} no envelope, '
              f'{skipped_empty:,} no geometry')
    else:
        print(f'  {skipped_empty:,} no geometry')

    return buildings


def _clear_at_root(elem):
    """Release a CityModel direct-child (a cityObjectMember) plus all prior
    siblings — keeps the root's child list small so memory stays bounded."""
    elem.clear(keep_tail=True)
    parent = elem.getparent()  # the CityModel root
    if parent is None:
        return
    while elem.getprevious() is not None:
        del parent[0]


def convert(input_path, output_path, no_filter=False):
    buildings = parse_buildings_streaming(input_path, no_filter=no_filter)

    min_x = min_z =  math.inf
    max_x = max_z = -math.inf
    for b in buildings:
        for arr in (b['roof'], b['walls']):
            for i in range(0, len(arr) - 2, 3):
                x, z = arr[i], arr[i + 2]
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if z < min_z: min_z = z
                if z > max_z: max_z = z

    with open(output_path, 'w') as f:
        json.dump(buildings, f, separators=(',', ':'))

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f'Written {output_path}  ({size_mb:.2f} MB)')

    bounds = (
        {'minX': min_x, 'maxX': max_x, 'minZ': min_z, 'maxZ': max_z}
        if buildings else
        {'minX': 0, 'maxX': 0, 'minZ': 0, 'maxZ': 0}
    )
    return {'count': len(buildings), 'bounds': bounds}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='TUM NYC LoD2 CityGML → Three.js JSON')
    parser.add_argument('input', help='Path to .gml file (e.g. data/tum_lod2/NYC_Buildings_LoD2_CityGML.gml)')
    parser.add_argument('--out', default='public/buildings_lod2.json',
                        help='Output JSON path (default: public/buildings_lod2.json)')
    parser.add_argument('--no-filter', action='store_true',
                        help='Disable the FiDi bounding-box filter (emit all buildings)')
    args = parser.parse_args()
    convert(args.input, args.out, no_filter=args.no_filter)
