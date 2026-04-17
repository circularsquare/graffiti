#!/usr/bin/env python3
"""
Fetch OSM features (streets + water + green spaces) via the Overpass API and
tile them into 250 m grid cells, matching the building-tile layout.

Outputs:
    public/osm/cell_{gx}_{gz}.json   — one file per non-empty cell
    public/osm/manifest.json         — tile index with world-space bounds

Per-cell JSON:
{
  "streets": [ { "type": "residential", "points": [[x, z], ...], "name"?: "..." }, ... ],
  "water":   [ [x, z, x, z, x, z, ...], ... ],   // flat XZ triangle lists, one per polygon
  "green":   [ [x, z, x, z, x, z, ...], ... ]
}

Usage:
    python scripts/fetch_osm_features.py

All coordinates are in local metres, same system as geo.js (X = east, Z = south,
relative to REF_LNG / REF_LAT).
"""

import os, sys, json, math, time
import urllib.request, urllib.parse
import mapbox_earcut as earcut
import numpy as np

# Must match build_tiles.py so street / building tiles align.
GRID_SIZE = 250

REF_LNG = -74.01175
REF_LAT = 40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))

HERE              = os.path.dirname(__file__)
OUTPUT_DIR        = os.path.join(HERE, '..', 'public', 'osm')
BUILDING_MANIFEST = os.path.join(HERE, '..', 'public', 'tiles', 'manifest.json')
CHUNK_CACHE_DIR   = os.path.join(HERE, '..', 'data', 'overpass_chunks')

# Try mirrors in order; kumi is usually faster than the main instance.
OVERPASS_URLS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
]

# Chunk size when splitting the full bbox for Overpass. ~0.05° ≈ 5 km at NYC
# latitude — small enough to stay well under the default 180 s Overpass
# timeout even for dense highway queries.
CHUNK_DEG = 0.05


# ── Coordinate helpers ────────────────────────────────────────────────────────

def local_to_lng_lat(x, z):
    return REF_LNG + x / METERS_PER_LNG, REF_LAT - z / METERS_PER_LAT


def lng_lat_to_local(lng, lat):
    return ((lng - REF_LNG) * METERS_PER_LNG,
            -(lat - REF_LAT) * METERS_PER_LAT)


# ── Bbox derivation ───────────────────────────────────────────────────────────

def compute_bbox():
    """Read the building manifest, return (south, west, north, east) in lng/lat
    with one cell of padding so streets at the coverage edge are included."""
    with open(BUILDING_MANIFEST) as f:
        manifest = json.load(f)
    min_x = min(t['bounds']['minX'] for t in manifest) - GRID_SIZE
    max_x = max(t['bounds']['maxX'] for t in manifest) + GRID_SIZE
    min_z = min(t['bounds']['minZ'] for t in manifest) - GRID_SIZE
    max_z = max(t['bounds']['maxZ'] for t in manifest) + GRID_SIZE
    # +Z = south; top-left (NW) is (min_x, min_z), bottom-right (SE) is (max_x, max_z)
    west_lng,  north_lat = local_to_lng_lat(min_x, min_z)
    east_lng,  south_lat = local_to_lng_lat(max_x, max_z)
    return south_lat, west_lng, north_lat, east_lng


# ── Overpass fetch ────────────────────────────────────────────────────────────

# All features we want. Ways for small/medium polygons, relations for big
# multipolygons like rivers and Central Park.
OVERPASS_QUERY = """
[out:json][timeout:300];
(
  way["highway"]({bbox});

  way["natural"~"^(water|wood|grassland|scrub|heath|wetland|beach)$"]({bbox});
  way["waterway"="riverbank"]({bbox});
  relation["natural"="water"]({bbox});
  relation["waterway"="riverbank"]({bbox});

  way["leisure"~"^(park|garden|playground|recreation_ground|pitch|nature_reserve|golf_course)$"]({bbox});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|orchard|farmland)$"]({bbox});
  relation["leisure"~"^(park|garden|recreation_ground|nature_reserve|golf_course)$"]({bbox});
  relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"]({bbox});
);
out geom;
"""


def _chunk_cache_path(chunk):
    s, w, n, e = chunk
    return os.path.join(CHUNK_CACHE_DIR, f'{s:.4f}_{w:.4f}_{n:.4f}_{e:.4f}.json')


def _post_overpass(query, timeout=180):
    """POST a query against mirrors in order. Returns parsed JSON or raises."""
    data = urllib.parse.urlencode({'data': query}).encode()
    last_err = None
    for url in OVERPASS_URLS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=data, headers={
                    'User-Agent': 'graffiti-nyc-osm-fetch/0.1',
                })
                with urllib.request.urlopen(req, timeout=timeout + 30) as resp:
                    return json.loads(resp.read())
            except urllib.error.HTTPError as e:
                last_err = e
                print(f'    {url}: HTTP {e.code}')
                if e.code in (429, 504, 502, 503):
                    # Back off before trying again / next mirror.
                    time.sleep(8 * (attempt + 1))
                else:
                    break  # hard failure — don't retry on this URL
            except Exception as e:
                last_err = e
                print(f'    {url}: {e}')
                time.sleep(4)
    raise RuntimeError(f'All Overpass mirrors failed: {last_err}')


def fetch_chunk(chunk, timeout=180):
    s, w, n, e = chunk
    query = OVERPASS_QUERY.format(bbox=f'{s},{w},{n},{e}').replace('timeout:300', f'timeout:{timeout}').strip()
    return _post_overpass(query, timeout=timeout).get('elements', [])


def fetch_overpass(bbox, use_cache=True):
    """Split the bbox into CHUNK_DEG × CHUNK_DEG chunks and fetch each.
    Per-chunk JSON is cached under data/overpass_chunks/ so re-running after
    a partial failure resumes where it left off. Returns merged, deduped
    elements in the same shape as a raw Overpass response."""
    south, west, north, east = bbox

    # Build the chunk grid. Using a loop rather than numpy so we don't pull
    # another dep in for one job.
    chunks = []
    lat = south
    while lat < north:
        nlat = min(lat + CHUNK_DEG, north)
        lng = west
        while lng < east:
            elng = min(lng + CHUNK_DEG, east)
            chunks.append((lat, lng, nlat, elng))
            lng = elng
        lat = nlat

    print(f'Splitting bbox into {len(chunks)} chunks of up to {CHUNK_DEG}°')
    os.makedirs(CHUNK_CACHE_DIR, exist_ok=True)

    all_elements = []
    seen = set()  # (type, id) dedupe across overlapping chunk edges
    failed = []

    for i, chunk in enumerate(chunks):
        path = _chunk_cache_path(chunk)
        if use_cache and os.path.exists(path):
            with open(path) as f:
                els = json.load(f).get('elements', [])
            print(f'  [{i+1:3d}/{len(chunks)}] cached  {len(els):5d} elements')
        else:
            print(f'  [{i+1:3d}/{len(chunks)}] fetching ({chunk[0]:.3f}, {chunk[1]:.3f}) – ({chunk[2]:.3f}, {chunk[3]:.3f})')
            t0 = time.time()
            try:
                els = fetch_chunk(chunk)
            except Exception as e:
                print(f'    FAILED: {e} — skipping (re-run with --refresh or just re-run to retry)')
                failed.append(chunk)
                continue
            with open(path, 'w') as f:
                json.dump({'bbox': list(chunk), 'elements': els}, f)
            print(f'    +{len(els)} elements in {time.time() - t0:.1f}s')

        for el in els:
            key = (el['type'], el.get('id'))
            if key in seen:
                continue
            seen.add(key)
            all_elements.append(el)

    if failed:
        print(f'\n!! {len(failed)} chunks failed — re-run to retry (cached chunks are kept).')

    return {'elements': all_elements}


# ── Ring stitching for multipolygon relations ────────────────────────────────

def stitch_rings(ways):
    """Stitch a list of unclosed polylines into closed rings by matching
    endpoints. Input: list of list of (x, z). Returns list of closed rings
    (each is a polyline where first == last).

    Drops any fragment that can't be closed — rare in OSM data but possible
    for malformed relations.
    """
    remaining = [list(w) for w in ways if len(w) >= 2]
    rings = []
    EPS = 1e-6

    def eq(a, b):
        return abs(a[0] - b[0]) < EPS and abs(a[1] - b[1]) < EPS

    while remaining:
        ring = remaining.pop(0)
        # If already closed, done.
        guard = 0
        while not eq(ring[0], ring[-1]) and guard < 1000:
            guard += 1
            # Find a fragment that connects to ring[-1].
            matched = False
            for i, w in enumerate(remaining):
                if eq(w[0], ring[-1]):
                    ring.extend(w[1:])
                    remaining.pop(i)
                    matched = True
                    break
                elif eq(w[-1], ring[-1]):
                    ring.extend(reversed(w[:-1]))
                    remaining.pop(i)
                    matched = True
                    break
            if not matched:
                break
        if eq(ring[0], ring[-1]) and len(ring) >= 4:
            rings.append(ring)
    return rings


# ── Polygon triangulation ─────────────────────────────────────────────────────

def triangulate(outer, holes=None):
    """Triangulate a polygon (outer ring + optional holes) via mapbox-earcut.
    Rings: list of (x, z). Returns a flat list of XZ triples (6 values per tri).

    mapbox-earcut's second arg is CUMULATIVE ring-end indices: the first entry
    marks the end of the outer ring, each subsequent entry marks the end of a
    hole. The final entry must equal the total vertex count.
    """
    if len(outer) < 4:
        return []
    all_pts = list(outer[:-1])  # drop closing duplicate
    ring_ends = [len(all_pts)]
    if holes:
        for h in holes:
            if len(h) < 4:
                continue
            all_pts.extend(h[:-1])
            ring_ends.append(len(all_pts))
    if len(all_pts) < 3:
        return []
    arr = np.array(all_pts, dtype=np.float64)
    try:
        tris = earcut.triangulate_float64(arr, np.array(ring_ends, dtype=np.uint32))
    except Exception as e:
        print(f'  [triangulate] skip: {e}')
        return []
    out = []
    for ti in range(0, len(tris), 3):
        a, b, c = tris[ti], tris[ti+1], tris[ti+2]
        out.extend([all_pts[a][0], all_pts[a][1],
                    all_pts[b][0], all_pts[b][1],
                    all_pts[c][0], all_pts[c][1]])
    return out


# ── Feature classification ────────────────────────────────────────────────────

def feature_kind(tags):
    """Bucket an OSM element's tags into 'street', 'water', 'green', or None."""
    if tags.get('highway'):
        return 'street'
    if tags.get('natural') == 'water' or tags.get('waterway') == 'riverbank':
        return 'water'
    if tags.get('leisure') in {
        'park', 'garden', 'playground', 'recreation_ground',
        'pitch', 'nature_reserve', 'golf_course'
    }:
        return 'green'
    if tags.get('landuse') in {
        'grass', 'forest', 'meadow', 'recreation_ground',
        'cemetery', 'village_green', 'orchard', 'farmland'
    }:
        return 'green'
    if tags.get('natural') in {'wood', 'grassland', 'scrub', 'heath', 'wetland'}:
        return 'green'
    return None


# ── Cell traversal (DDA) ──────────────────────────────────────────────────────

def segment_cells(p0, p1):
    """Yield all (gx, gz) cells the segment p0→p1 passes through."""
    x0, z0 = p0
    x1, z1 = p1
    gx0 = math.floor(x0 / GRID_SIZE); gz0 = math.floor(z0 / GRID_SIZE)
    gx1 = math.floor(x1 / GRID_SIZE); gz1 = math.floor(z1 / GRID_SIZE)
    if gx0 == gx1 and gz0 == gz1:
        yield gx0, gz0
        return
    dx, dz = x1 - x0, z1 - z0
    step_x = 1 if dx > 0 else (-1 if dx < 0 else 0)
    step_z = 1 if dz > 0 else (-1 if dz < 0 else 0)
    if dx:
        nb = (gx0 + (1 if step_x > 0 else 0)) * GRID_SIZE
        t_max_x, t_delta_x = (nb - x0) / dx, GRID_SIZE / abs(dx)
    else:
        t_max_x = t_delta_x = float('inf')
    if dz:
        nb = (gz0 + (1 if step_z > 0 else 0)) * GRID_SIZE
        t_max_z, t_delta_z = (nb - z0) / dz, GRID_SIZE / abs(dz)
    else:
        t_max_z = t_delta_z = float('inf')

    gx, gz = gx0, gz0
    yield gx, gz
    while (gx, gz) != (gx1, gz1):
        if t_max_x < t_max_z:
            gx += step_x; t_max_x += t_delta_x
        else:
            gz += step_z; t_max_z += t_delta_z
        yield gx, gz


def polyline_cells(points):
    """Set of cells touched by a polyline."""
    cells = set()
    if not points:
        return cells
    if len(points) == 1:
        x, z = points[0]
        cells.add((math.floor(x / GRID_SIZE), math.floor(z / GRID_SIZE)))
        return cells
    for p0, p1 in zip(points, points[1:]):
        for c in segment_cells(p0, p1):
            cells.add(c)
    return cells


def bbox_cells(points):
    """All cells covered by the bounding box of a polyline/polygon."""
    xs = [p[0] for p in points]; zs = [p[1] for p in points]
    gx0 = math.floor(min(xs) / GRID_SIZE); gx1 = math.floor(max(xs) / GRID_SIZE)
    gz0 = math.floor(min(zs) / GRID_SIZE); gz1 = math.floor(max(zs) / GRID_SIZE)
    return {(gx, gz) for gx in range(gx0, gx1 + 1) for gz in range(gz0, gz1 + 1)}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    use_cache = '--refresh' not in sys.argv

    if not use_cache and os.path.isdir(CHUNK_CACHE_DIR):
        # Clear per-chunk cache so --refresh actually re-fetches.
        removed = 0
        for name in os.listdir(CHUNK_CACHE_DIR):
            if name.endswith('.json'):
                os.remove(os.path.join(CHUNK_CACHE_DIR, name))
                removed += 1
        if removed:
            print(f'Dropped {removed} cached chunks')

    bbox = compute_bbox()
    osm  = fetch_overpass(bbox, use_cache=use_cache)

    elements = osm.get('elements', [])
    print(f'\nParsing {len(elements)} OSM elements …')

    # cell_data: (gx, gz) → { streets: [], water: [], green: [] }
    cell_data = {}

    def cell_entry(cell):
        e = cell_data.get(cell)
        if e is None:
            e = {'streets': [], 'water': [], 'green': []}
            cell_data[cell] = e
        return e

    # Counters for reporting.
    n_streets = n_water = n_green = 0

    for el in elements:
        tags = el.get('tags', {}) or {}
        kind = feature_kind(tags)
        if kind is None:
            continue

        if el['type'] == 'way':
            geom = el.get('geometry')
            if not geom or len(geom) < 2:
                continue
            pts = [lng_lat_to_local(pt['lon'], pt['lat']) for pt in geom]

            if kind == 'street':
                street = {
                    'type':   tags.get('highway'),
                    'points': [[round(x, 2), round(z, 2)] for x, z in pts],
                }
                name = tags.get('name')
                if name:
                    street['name'] = name
                for cell in polyline_cells(pts):
                    cell_entry(cell)['streets'].append(street)
                n_streets += 1
            else:
                # Polygon feature — way's geometry is a closed ring (first == last)
                # or should be treated as one if the tags say so.
                if len(pts) >= 4 and (pts[0] == pts[-1] or
                                      math.hypot(pts[0][0] - pts[-1][0],
                                                 pts[0][1] - pts[-1][1]) < 0.01):
                    if pts[0] != pts[-1]:
                        pts = pts + [pts[0]]
                    tri = triangulate(pts)
                    if tri:
                        rounded = [round(v, 2) for v in tri]
                        for cell in bbox_cells(pts):
                            cell_entry(cell)[kind].append(rounded)
                        if kind == 'water': n_water += 1
                        else:               n_green += 1

        elif el['type'] == 'relation':
            # Only polygon features (water, green) use the multipolygon path.
            # Highway=* on a relation means a route relation (bus, bicycle,
            # etc.) — not a polygon, and the member ways are already emitted
            # as individual streets above.
            if kind == 'street':
                continue

            # Multipolygon: stitch outer ways into closed rings, inner ways into holes.
            outers_frags, inners_frags = [], []
            for m in el.get('members', []):
                if m.get('type') != 'way':
                    continue
                mgeom = m.get('geometry')
                if not mgeom or len(mgeom) < 2:
                    continue
                line = [lng_lat_to_local(pt['lon'], pt['lat']) for pt in mgeom]
                if m.get('role') == 'outer':
                    outers_frags.append(line)
                elif m.get('role') == 'inner':
                    inners_frags.append(line)

            outer_rings = stitch_rings(outers_frags)
            inner_rings = stitch_rings(inners_frags)

            # Assign each hole to the outer ring that contains it (by centroid).
            def point_in_ring(p, ring):
                inside = False
                x, z = p
                for i in range(len(ring) - 1):
                    x0, z0 = ring[i]
                    x1, z1 = ring[i + 1]
                    if (z0 > z) != (z1 > z):
                        xc = x0 + (z - z0) * (x1 - x0) / (z1 - z0)
                        if x < xc:
                            inside = not inside
                return inside

            outer_holes = {i: [] for i in range(len(outer_rings))}
            for h in inner_rings:
                hx = sum(p[0] for p in h[:-1]) / max(len(h) - 1, 1)
                hz = sum(p[1] for p in h[:-1]) / max(len(h) - 1, 1)
                for i, o in enumerate(outer_rings):
                    if point_in_ring((hx, hz), o):
                        outer_holes[i].append(h)
                        break

            for i, outer in enumerate(outer_rings):
                tri = triangulate(outer, holes=outer_holes[i])
                if not tri:
                    continue
                rounded = [round(v, 2) for v in tri]
                for cell in bbox_cells(outer):
                    cell_entry(cell)[kind].append(rounded)
                if kind == 'water': n_water += 1
                else:               n_green += 1

    # ── Write phase ──────────────────────────────────────────────────────────

    print(f'\nFeatures: {n_streets} streets, {n_water} water, {n_green} green')
    print(f'Writing {len(cell_data)} OSM tiles …')

    manifest = []
    total_size_kb = 0
    for (gx, gz), entry in sorted(cell_data.items()):
        if not (entry['streets'] or entry['water'] or entry['green']):
            continue
        tile_id = f'cell_{gx}_{gz}'
        out_path = os.path.join(OUTPUT_DIR, f'{tile_id}.json')
        with open(out_path, 'w') as f:
            json.dump(entry, f, separators=(',', ':'))
        size_kb = os.path.getsize(out_path) / 1024
        total_size_kb += size_kb

        manifest.append({
            'id':    tile_id,
            'file':  f'/osm/{tile_id}.json',
            'bounds': {
                'minX': gx * GRID_SIZE, 'maxX': (gx + 1) * GRID_SIZE,
                'minZ': gz * GRID_SIZE, 'maxZ': (gz + 1) * GRID_SIZE,
            },
            'streetCount': len(entry['streets']),
            'waterCount':  len(entry['water']),
            'greenCount':  len(entry['green']),
        })

    manifest_path = os.path.join(OUTPUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f'\n{"─" * 50}')
    print(f'OSM tiles written : {len(manifest)}')
    print(f'Total size        : {total_size_kb / 1024:.1f} MB')
    print(f'Avg per tile      : {total_size_kb / max(len(manifest), 1):.0f} KB')
    print(f'Manifest          : {manifest_path}')


if __name__ == '__main__':
    main()
