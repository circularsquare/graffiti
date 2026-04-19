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

# OSM tile grid — 250 m cells. Building tiles use a finer 125 m grid, so one
# OSM cell covers a 2×2 block of building cells. We still index by OSM cell
# throughout this script.
GRID_SIZE = 250

# Douglas-Peucker tolerance for water polygon simplification (metres). NYC
# harbor coastlines in OSM are sampled every 10–30 cm; simplifying to 1 m
# roughly halves vertex / triangle count without visibly changing the shore
# at the distances we render from. Small ponds (bbox diagonal < 5 m) skip
# simplification so we don't accidentally collapse them to a line.
WATER_SIMPLIFY_TOL_M = 1.0

# When writing and fetching, keep only OSM cells within this many cells of a
# NYC building tile. Our building coverage (DoITT CityGML) defines the 5
# boroughs we care about; rectangular bbox fetch otherwise pulls in a lot of
# New Jersey and mid-harbour cells we never show. 6 cells = 1500 m pad —
# wide enough that the far bank of the Hudson and the middle of Upper NY
# Bay still carry water; NJ and open ocean still get dropped.
BUILDING_PROXIMITY_CELLS = 6

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

def read_building_manifest():
    with open(BUILDING_MANIFEST) as f:
        return json.load(f)


def compute_bbox(manifest):
    """Return (south, west, north, east) in lng/lat with one OSM-cell of
    padding so streets at the coverage edge are included."""
    min_x = min(t['bounds']['minX'] for t in manifest) - GRID_SIZE
    max_x = max(t['bounds']['maxX'] for t in manifest) + GRID_SIZE
    min_z = min(t['bounds']['minZ'] for t in manifest) - GRID_SIZE
    max_z = max(t['bounds']['maxZ'] for t in manifest) + GRID_SIZE
    # +Z = south; top-left (NW) is (min_x, min_z), bottom-right (SE) is (max_x, max_z)
    west_lng,  north_lat = local_to_lng_lat(min_x, min_z)
    east_lng,  south_lat = local_to_lng_lat(max_x, max_z)
    return south_lat, west_lng, north_lat, east_lng


def compute_building_osm_cells(manifest):
    """Set of OSM (gx, gz) cells that any building tile bbox overlaps.
    Proximity filter below uses this to cull chunks / output cells that
    don't touch NYC's 5-borough coverage."""
    cells = set()
    for t in manifest:
        b = t['bounds']
        gx0 = math.floor(b['minX'] / GRID_SIZE)
        gx1 = math.floor((b['maxX'] - 1e-6) / GRID_SIZE)
        gz0 = math.floor(b['minZ'] / GRID_SIZE)
        gz1 = math.floor((b['maxZ'] - 1e-6) / GRID_SIZE)
        for gx in range(gx0, gx1 + 1):
            for gz in range(gz0, gz1 + 1):
                cells.add((gx, gz))
    return cells


def cell_near_building(gx, gz, building_cells, pad=BUILDING_PROXIMITY_CELLS):
    for dx in range(-pad, pad + 1):
        for dz in range(-pad, pad + 1):
            if (gx + dx, gz + dz) in building_cells:
                return True
    return False


def chunk_near_building(chunk, building_cells, pad=BUILDING_PROXIMITY_CELLS):
    """True if any OSM cell inside `chunk`'s lng/lat bbox (expanded by `pad`
    cells) is in `building_cells`. Used to skip Overpass chunks that cover
    only New Jersey / open ocean / other regions we never render."""
    s, w, n, e = chunk
    sw_x, sw_z = lng_lat_to_local(w, s)
    ne_x, ne_z = lng_lat_to_local(e, n)
    min_x, max_x = min(sw_x, ne_x), max(sw_x, ne_x)
    min_z, max_z = min(sw_z, ne_z), max(sw_z, ne_z)
    gx0 = math.floor(min_x / GRID_SIZE) - pad
    gx1 = math.floor(max_x / GRID_SIZE) + pad
    gz0 = math.floor(min_z / GRID_SIZE) - pad
    gz1 = math.floor(max_z / GRID_SIZE) + pad
    for gx in range(gx0, gx1 + 1):
        for gz in range(gz0, gz1 + 1):
            if (gx, gz) in building_cells:
                return True
    return False


# ── Overpass fetch ────────────────────────────────────────────────────────────

# All features we want. Ways for small/medium polygons, relations for big
# multipolygons like rivers and Central Park.
OVERPASS_QUERY = """
[out:json][timeout:300];
(
  way["highway"]({bbox});

  way["natural"~"^(water|bay|strait|wood|grassland|scrub|heath|wetland|beach)$"]({bbox});
  way["waterway"="riverbank"]({bbox});
  way["landuse"="reservoir"]({bbox});
  relation["natural"~"^(water|bay|strait)$"]({bbox});
  relation["waterway"="riverbank"]({bbox});
  relation["landuse"="reservoir"]({bbox});

  way["leisure"~"^(park|garden|playground|recreation_ground|pitch|nature_reserve|golf_course)$"]({bbox});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|orchard|farmland)$"]({bbox});
  relation["leisure"~"^(park|garden|recreation_ground|nature_reserve|golf_course)$"]({bbox});
  relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"]({bbox});
);
(._;>;);
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


def fetch_overpass(bbox, building_cells, use_cache=True):
    """Split the bbox into CHUNK_DEG × CHUNK_DEG chunks and fetch each.
    Chunks that don't overlap any NYC building cell (within
    BUILDING_PROXIMITY_CELLS) are skipped entirely — no fetch, no parse.
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

    # Drop chunks that don't touch NYC. Each chunk is ~5 km; the proximity
    # pad (750 m default) is much smaller, so any chunk with no building
    # cells near its bbox is entirely off-coverage.
    total_chunks = len(chunks)
    chunks = [c for c in chunks if chunk_near_building(c, building_cells)]
    print(f'Splitting bbox into {len(chunks)} chunks of up to {CHUNK_DEG}° '
          f'(skipped {total_chunks - len(chunks)} off-coverage)')
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

# Parks/reserves whose polygons enclose huge bays or harbours — painting them
# green covers up the water inside. Easier to blocklist by name than to clip
# geometry. Substring match, case-insensitive.
PARK_NAME_BLOCKLIST = [
    'jamaica bay',           # Wildlife Refuge — polygon covers the whole bay
    'gateway national',      # NRA — same story, includes Jamaica Bay unit
]


def _park_name_blocklisted(name):
    if not name:
        return False
    lower = name.lower()
    return any(b in lower for b in PARK_NAME_BLOCKLIST)


def feature_kind(tags):
    """Bucket an OSM element's tags into 'street', 'water', 'green', or None."""
    if tags.get('highway'):
        return 'street'
    # 'bay' / 'strait' catch older tagging (e.g. Upper NY Bay) where the water
    # body isn't wrapped in a 'natural=water' + 'water=bay' combo. landuse=
    # reservoir covers Central Park's Jacqueline Kennedy Onassis Reservoir.
    if (tags.get('natural') in {'water', 'bay', 'strait'}
            or tags.get('waterway') == 'riverbank'
            or tags.get('landuse') == 'reservoir'):
        return 'water'
    if tags.get('leisure') in {
        'park', 'garden', 'playground', 'recreation_ground',
        'pitch', 'nature_reserve', 'golf_course'
    }:
        return None if _park_name_blocklisted(tags.get('name')) else 'green'
    if tags.get('landuse') in {
        'grass', 'forest', 'meadow', 'recreation_ground',
        'cemetery', 'village_green', 'orchard', 'farmland'
    }:
        return None if _park_name_blocklisted(tags.get('name')) else 'green'
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


def simplify_ring(ring, tol):
    """Douglas-Peucker on a closed ring (first == last). Strips closure,
    simplifies the open polyline (preserving endpoints), then re-appends
    the closure. Returns the simplified closed ring.

    Skips simplification when the ring's bbox diagonal is small enough
    that the tolerance would risk collapsing the whole feature (< ~5× tol).
    """
    if len(ring) < 4:
        return ring
    xs = [p[0] for p in ring]; zs = [p[1] for p in ring]
    diag = math.hypot(max(xs) - min(xs), max(zs) - min(zs))
    if diag < 5 * tol:
        return ring

    open_pts = ring[:-1]  # drop closing duplicate
    n = len(open_pts)
    if n < 3:
        return ring

    keep = [False] * n
    keep[0] = keep[-1] = True
    # Iterative DP — stack of (lo, hi) index pairs. Finds the point on
    # segment [lo, hi] with max perpendicular distance; if > tol, keep
    # and recurse on (lo, idx) and (idx, hi).
    stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        x0, z0 = open_pts[lo]
        x1, z1 = open_pts[hi]
        dx, dz = x1 - x0, z1 - z0
        seg_len2 = dx * dx + dz * dz
        max_d2 = -1.0
        idx = -1
        if seg_len2 < 1e-12:
            # Degenerate segment — use raw distance from lo.
            for i in range(lo + 1, hi):
                px, pz = open_pts[i]
                d2 = (px - x0) ** 2 + (pz - z0) ** 2
                if d2 > max_d2:
                    max_d2 = d2; idx = i
        else:
            for i in range(lo + 1, hi):
                px, pz = open_pts[i]
                # Perpendicular distance² from p to infinite line through
                # (x0,z0)-(x1,z1). cross² / seg_len².
                cross = dx * (z0 - pz) - dz * (x0 - px)
                d2 = cross * cross / seg_len2
                if d2 > max_d2:
                    max_d2 = d2; idx = i
        if max_d2 > tol2:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))

    out = [open_pts[i] for i in range(n) if keep[i]]
    out.append(out[0])  # close the ring
    return out


def bucket_triangles_by_cell(tri):
    """Group a flat XZ triangle list (6 floats per tri) by the cells each
    triangle's bbox touches. Returns { (gx, gz): [flat tris in this cell] }.

    Why per-triangle instead of per-polygon bbox: a huge polygon like Upper
    NY Bay has an envelope thousands of cells wide. Writing the full
    triangulated polygon into each envelope cell would duplicate many MB of
    geometry per tile. Per-triangle assignment keeps each tile's payload
    proportional to the geometry actually overlapping it."""
    buckets = {}
    for ti in range(0, len(tri), 6):
        x0, z0 = tri[ti],     tri[ti + 1]
        x1, z1 = tri[ti + 2], tri[ti + 3]
        x2, z2 = tri[ti + 4], tri[ti + 5]
        gx_min = math.floor(min(x0, x1, x2) / GRID_SIZE)
        gx_max = math.floor(max(x0, x1, x2) / GRID_SIZE)
        gz_min = math.floor(min(z0, z1, z2) / GRID_SIZE)
        gz_max = math.floor(max(z0, z1, z2) / GRID_SIZE)
        for gx in range(gx_min, gx_max + 1):
            for gz in range(gz_min, gz_max + 1):
                bucket = buckets.get((gx, gz))
                if bucket is None:
                    bucket = []
                    buckets[(gx, gz)] = bucket
                bucket.extend((x0, z0, x1, z1, x2, z2))
    return buckets


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

    bldg_manifest  = read_building_manifest()
    bbox           = compute_bbox(bldg_manifest)
    building_cells = compute_building_osm_cells(bldg_manifest)
    osm            = fetch_overpass(bbox, building_cells, use_cache=use_cache)

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
                    if kind == 'water':
                        pts = simplify_ring(pts, WATER_SIMPLIFY_TOL_M)
                        if len(pts) < 4:
                            continue
                    tri = triangulate(pts)
                    if tri:
                        for cell, tris in bucket_triangles_by_cell(tri).items():
                            rounded = [round(v, 2) for v in tris]
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

            if kind == 'water':
                outer_rings = [simplify_ring(r, WATER_SIMPLIFY_TOL_M) for r in outer_rings]
                outer_rings = [r for r in outer_rings if len(r) >= 4]
                inner_rings = [simplify_ring(r, WATER_SIMPLIFY_TOL_M) for r in inner_rings]
                inner_rings = [r for r in inner_rings if len(r) >= 4]

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
                for cell, tris in bucket_triangles_by_cell(tri).items():
                    rounded = [round(v, 2) for v in tris]
                    cell_entry(cell)[kind].append(rounded)
                if kind == 'water': n_water += 1
                else:               n_green += 1

    # ── Write phase ──────────────────────────────────────────────────────────

    print(f'\nFeatures: {n_streets} streets, {n_water} water, {n_green} green')
    print(f'Writing {len(cell_data)} OSM tiles …')

    manifest = []
    total_size_kb = 0
    dropped_off_coverage = 0
    for (gx, gz), entry in sorted(cell_data.items()):
        if not (entry['streets'] or entry['water'] or entry['green']):
            continue
        if not cell_near_building(gx, gz, building_cells):
            dropped_off_coverage += 1
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
    print(f'Dropped off-coverage : {dropped_off_coverage}')
    print(f'Total size        : {total_size_kb / 1024:.1f} MB')
    print(f'Avg per tile      : {total_size_kb / max(len(manifest), 1):.0f} KB')
    print(f'Manifest          : {manifest_path}')


if __name__ == '__main__':
    main()
