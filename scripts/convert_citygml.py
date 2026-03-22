#!/usr/bin/env python3
"""
Convert NYC DoITT CityGML 3D building data to a Three.js-ready JSON.

The input is EPSG:2263 (NY State Plane, feet). We project to local
metres centred on the same FiDi reference point used in geo.js so the
two data sources are directly swappable.

Usage
-----
    pip install -r scripts/requirements.txt
    python scripts/convert_citygml.py data/your_file.gml
    # → public/buildings.json

The output is an array of objects:
    { id, roof: [x,y,z, ...], walls: [x,y,z, ...] }
Each array is a flat list of pre-triangulated vertices (every 9 floats = 1 triangle).
"""

import sys, os, json, math, argparse
import numpy as np
from lxml import etree
from pyproj import Transformer
import mapbox_earcut as earcut

# ── Coordinate projection ─────────────────────────────────────────────────────

# NY State Plane (EPSG:2263, feet, NAD83) → WGS84 lat/lng
_to_wgs84 = Transformer.from_crs("EPSG:2263", "EPSG:4326", always_xy=True)

# Same reference point as src/geo.js
REF_LNG = -74.01175
REF_LAT =  40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))  # ≈ 84,390
FEET_TO_M = 0.3048

# FiDi bounding box (lat/lng) — only buildings overlapping this are emitted
BBOX = dict(south=40.7020, north=40.7075, west=-74.0155, east=-74.0080)


def sp_to_local(x_ft, y_ft, z_ft):
    """State Plane feet → local (x, y, z) metres. y = up, z = south (+)."""
    lng, lat = _to_wgs84.transform(x_ft, y_ft)
    lx =  (lng - REF_LNG) * METERS_PER_LNG
    ly =   z_ft * FEET_TO_M                      # elevation → Y-up
    lz = -(lat - REF_LAT) * METERS_PER_LAT       # north → -Z
    return (lx, ly, lz)


def in_bbox(state_plane_pts):
    """Quick check: is any sample point inside the FiDi bbox?"""
    for (x, y, _z) in state_plane_pts[:4]:       # sample first 4 vertices only
        lng, lat = _to_wgs84.transform(x, y)
        if BBOX['south'] <= lat <= BBOX['north'] and BBOX['west'] <= lng <= BBOX['east']:
            return True
    return False


# ── CityGML parsing ───────────────────────────────────────────────────────────

def local_tag(el):
    """Strip namespace URI so we can match tags by local name only."""
    t = el.tag
    return t.split('}')[-1] if '}' in t else t


def parse_poslist(text):
    """'x1 y1 z1 x2 y2 z2 …' → list of (x,y,z) float tuples."""
    nums = list(map(float, text.split()))
    return [(nums[i], nums[i+1], nums[i+2]) for i in range(0, len(nums) - 2, 3)]


def get_outer_ring(polygon_el):
    """Return the state-plane coord list of the outer ring of a gml:Polygon."""
    for el in polygon_el.iter():
        if local_tag(el) == 'posList' and el.text:
            return parse_poslist(el.text.strip())
    return []


def triangulate_face(sp_pts):
    """
    Project a planar 3D polygon to its own face plane, run earcut, return
    a flat list of triangle vertices in local-metre space.
    """
    # Convert to local metres
    verts = np.array([sp_to_local(*p) for p in sp_pts], dtype=np.float64)

    # Drop duplicate closing vertex
    if len(verts) > 1 and np.allclose(verts[0], verts[-1]):
        verts = verts[:-1]

    n = len(verts)
    if n < 3:
        return []

    if n == 3:
        return verts.flatten().tolist()

    # Build a local 2-D coordinate frame for this face
    e0 = verts[1] - verts[0]
    norm0 = np.linalg.norm(e0)
    if norm0 < 1e-10:
        return []
    e0 /= norm0

    cross = np.cross(e0, verts[2] - verts[0])
    cross_norm = np.linalg.norm(cross)
    if cross_norm < 1e-10:
        return []                        # degenerate / collinear face
    face_normal = cross / cross_norm
    e1 = np.cross(face_normal, e0)      # second axis in face plane

    # Project all vertices to 2-D  (shape: n×2, float32)
    verts_2d = np.column_stack([verts @ e0, verts @ e1]).astype(np.float32)

    # Triangulate with earcut (handles concave polygons correctly)
    # No holes → empty uint32 array
    # ring_end_indices: index past the last vertex of each ring; [n] = one outer ring
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
        bldg_el.get('{http://www.opengis.net/gml}id')
        or bldg_el.get('gml:id', '')
        or bldg_el.get('id', '')
    )

    return {'id': gml_id, 'roof': roof_tris, 'walls': wall_tris}


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_buildings(input_path, no_filter=False):
    """
    Parse a CityGML file and return a list of building dicts.
    Each dict: { 'id': str, 'roof': [float, ...], 'walls': [float, ...] }
    Coordinates are in local metres (same system as geo.js).
    """
    print(f'Parsing {input_path} …')
    tree = etree.parse(input_path)
    root = tree.getroot()

    buildings = []
    skipped_bbox = 0
    skipped_empty = 0

    all_bldgs = [el for el in root.iter() if local_tag(el) == 'Building']
    print(f'  Found {len(all_bldgs)} Building elements')

    for bldg_el in all_bldgs:
        sample = []
        for el in bldg_el.iter():
            if local_tag(el) == 'posList' and el.text:
                sample = parse_poslist(el.text.strip())
                break

        if not no_filter and sample and not in_bbox(sample):
            skipped_bbox += 1
            continue

        b = parse_building(bldg_el)
        if b:
            buildings.append(b)
        else:
            skipped_empty += 1

    print(f'  {len(buildings)} buildings converted')
    if not no_filter:
        print(f'  {skipped_bbox} outside FiDi bbox, {skipped_empty} had no geometry')
    else:
        print(f'  {skipped_empty} had no geometry')

    return buildings


def convert(input_path, output_path, no_filter=False):
    """
    Convert a CityGML file to Three.js-ready JSON.

    Returns { 'count': int, 'bounds': { minX, maxX, minZ, maxZ } }
    where bounds are in local metres (same coordinate system as geo.js).
    """
    buildings = parse_buildings(input_path, no_filter=no_filter)

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

    size_kb = os.path.getsize(output_path) / 1024
    print(f'  Written to {output_path}  ({size_kb:.0f} KB)')

    bounds = (
        {'minX': min_x, 'maxX': max_x, 'minZ': min_z, 'maxZ': max_z}
        if buildings else
        {'minX': 0, 'maxX': 0, 'minZ': 0, 'maxZ': 0}
    )
    return {'count': len(buildings), 'bounds': bounds}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='NYC CityGML → Three.js JSON')
    parser.add_argument('input', help='Path to .gml file (drop in data/)')
    parser.add_argument('--out', default='public/buildings.json',
                        help='Output JSON path (default: public/buildings.json)')
    parser.add_argument('--no-filter', action='store_true',
                        help='Disable the FiDi bounding-box filter (emit all buildings)')
    args = parser.parse_args()
    convert(args.input, args.out, no_filter=args.no_filter)
