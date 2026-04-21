#!/usr/bin/env python3
"""
Fetch OSM features (streets + water + green spaces) via the Overpass API and
tile them into 125 m grid cells.

Outputs:
    public/osm/cell_{gx}_{gz}.bin.gz — one gzipped binary file per non-empty cell
    public/osm/manifest.json          — tile index with world-space bounds

The binary layout is defined inline in encode_tile_binary(). Tile coords are
stored as int32 decimetres relative to each tile's world origin, so the whole
dataset ships at ~1/5 the size of the old JSON format after gzip. See
src/OsmManager.js for the decoder.

Usage:
    python scripts/fetch_osm_features.py

All coordinates are in local metres, same system as geo.js (X = east, Z = south,
relative to REF_LNG / REF_LAT).
"""

import os, sys, json, math, time, struct, gzip
import urllib.request, urllib.parse
import mapbox_earcut as earcut
import numpy as np

# Binary tile format — see encode_tile_binary() below. Written gzipped to
# cell_{gx}_{gz}.bin.gz so the on-wire size is ~5× smaller than the old
# per-cell JSON and hosting doesn't need to negotiate Content-Encoding.
BIN_MAGIC   = 0x4D534F47   # 'GOSM' little-endian
BIN_VERSION = 1
# Coords are stored as int32 decimeters relative to the tile's world origin
# (gx * GRID_SIZE, gz * GRID_SIZE). int32 range (±214 km) covers large ocean
# triangles that extend far past a 125 m cell; 10 cm precision is finer than
# the 0.24 m/px terrain canvas can resolve.
BIN_COORD_SCALE = 10   # metres → decimetres

# OSM tile grid — 125 m cells. Smaller tiles make each per-tile drape in
# OsmManager cheaper (O(triangles), which scale with area), so the frame
# hitches when new tiles load are shorter and less noticeable.
GRID_SIZE = 125

# Douglas-Peucker tolerance for water polygon simplification (metres). NYC
# harbor coastlines in OSM are sampled every 10–30 cm; simplifying to 1 m
# roughly halves vertex / triangle count without visibly changing the shore
# at the distances we render from. Small ponds (bbox diagonal < 5 m) skip
# simplification so we don't accidentally collapse them to a line.
WATER_SIMPLIFY_TOL_M = 1.0

# When writing and fetching, keep only OSM cells within this many cells of a
# NYC building tile. Our building coverage (DoITT CityGML) defines the 5
# boroughs we care about; rectangular bbox fetch otherwise pulls in a lot of
# New Jersey and mid-harbour cells we never show. 24 cells = 3000 m pad —
# wide enough to cover all of Jamaica Bay (~3 km from the nearest shore
# buildings to the bay's midpoint). The tradeoff: cells up to ~1.5 km into NJ
# (roughly the Hoboken waterfront) are now included, but since NJ has no
# building tiles those cells only appear near the Manhattan waterfront in-game.
BUILDING_PROXIMITY_CELLS = 24

# Features within BLEED_M of a cell boundary are ALSO assigned to the cell
# across that boundary. That way when two tiles rasterise their feature lists
# onto per-tile 1024² canvases, the pixels near the shared edge both include
# the feature and rasterise to the same colour — eliminating the hairline
# seam you'd otherwise see at 125 m boundaries in the terrain shader's OSM
# texture sampling. Must match src/OsmManager.js::OSM_TEXTURE_BLEED_M.
BLEED_M = 2.0

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

# Fallback bbox used when --bbox is passed without an explicit value. Covers
# the 5 NYC boroughs with a small margin — roughly the historical coverage
# the building manifest used to span before the FiDi-iteration trim.
DEFAULT_FULL_BBOX = (40.49, -74.27, 40.92, -73.68)   # (south, west, north, east)


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
  way["waterway"~"^(riverbank|dock|basin)$"]({bbox});
  way["landuse"="reservoir"]({bbox});
  way["water"="reservoir"]({bbox});
  way["leisure"="marina"]({bbox});
  relation["natural"~"^(water|bay|strait)$"]({bbox});
  relation["waterway"~"^(riverbank|dock|basin)$"]({bbox});
  relation["landuse"="reservoir"]({bbox});
  relation["water"="reservoir"]({bbox});
  relation["leisure"="marina"]({bbox});

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
    """POST a query against mirrors in order. Returns parsed JSON or raises.

    For a given mirror we only retry on 429/503-style rate-limit responses
    (where a short backoff is worth a second try). On a timeout or other
    generic failure we move straight to the next mirror — the same mirror
    is almost always still overloaded a few seconds later, and retrying it
    just doubles the wall-time cost of every failed chunk.
    """
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
                    # Back off and try this mirror once more — rate limits
                    # often clear in a few seconds.
                    time.sleep(8 * (attempt + 1))
                    continue
                break  # hard failure — don't retry on this URL
            except Exception as e:
                last_err = e
                print(f'    {url}: {e}')
                break  # timeout / network error — try next mirror immediately
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
    # reservoir covers older-style tagging; water=reservoir the modern sub-tag.
    # waterway=dock covers enclosed harbor basins (Red Hook, Navy Yard, etc.).
    # leisure=marina covers marina water areas.
    if (tags.get('natural') in {'water', 'bay', 'strait'}
            or tags.get('waterway') in {'riverbank', 'dock', 'basin'}
            or tags.get('landuse') == 'reservoir'
            or tags.get('water') == 'reservoir'
            or tags.get('leisure') == 'marina'):
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
    """Set of cells touched by a polyline, or within BLEED_M of one of its
    points. The bleed lets features near a cell boundary appear in both
    adjacent tiles so their canvas rasterisations match at the shared edge.

    Used for the cell bbox enumeration; per-cell polyline content is built by
    bucket_polyline_by_cell which clips to each cell's bleed-expanded bbox."""
    cells = set()
    if not points:
        return cells
    if len(points) == 1:
        x, z = points[0]
        cells.update(_bleed_cells_for_point(x, z))
        return cells
    for p0, p1 in zip(points, points[1:]):
        for c in segment_cells(p0, p1):
            cells.add(c)
    # Also include bleed cells around each vertex — near-edge points get
    # their boundary-crossing neighbour added. Cheap because BLEED_M ≪
    # GRID_SIZE, so each point adds at most 1-3 neighbour cells.
    for (x, z) in points:
        cells.update(_bleed_cells_for_point(x, z))
    return cells


def _clip_polyline_to_bbox(points, x_min, x_max, z_min, z_max):
    """Clip an open polyline to an axis-aligned bbox. Returns a list of
    sub-polylines (each a list of (x, z) points) — a polyline that leaves
    and re-enters the bbox produces multiple pieces. Empty list if no part
    of the polyline is inside the bbox.

    Liang-Barsky per-segment with continuity: consecutive segments whose
    clipped portions share an endpoint get stitched into a single sub-
    polyline; a segment that leaves the bbox terminates the current sub-
    polyline."""
    if len(points) < 2:
        return []
    out = []
    current = []
    for i in range(len(points) - 1):
        ax, az = points[i]
        bx, bz = points[i + 1]
        t0, t1 = 0.0, 1.0
        dx, dz = bx - ax, bz - az
        ok = True
        # Clip parameter t to the intersection of the 4 half-planes.
        for p, q in ((-dx, ax - x_min), (dx,  x_max - ax),
                     (-dz, az - z_min), (dz,  z_max - az)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    if r > t1: ok = False; break
                    if r > t0: t0 = r
                else:
                    if r < t0: ok = False; break
                    if r < t1: t1 = r
        if not ok or t0 > t1:
            # Whole segment outside — terminate any open sub-polyline.
            if current:
                out.append(current)
                current = []
            continue
        sx, sz = ax + t0 * dx, az + t0 * dz
        ex, ez = ax + t1 * dx, az + t1 * dz
        if not current:
            current.append((sx, sz))
        else:
            # Continuity check: if the previous segment's clipped end
            # doesn't match this segment's clipped start, the polyline left
            # and re-entered the bbox between them → start a new sub-poly.
            prev = current[-1]
            if abs(prev[0] - sx) > 1e-6 or abs(prev[1] - sz) > 1e-6:
                out.append(current)
                current = [(sx, sz)]
        current.append((ex, ez))
        # If this segment's clipped end was shortened (t1 < 1), the next
        # segment starts outside → terminate the sub-polyline.
        if t1 < 1.0 - 1e-9:
            out.append(current)
            current = []
    if current:
        out.append(current)
    return out


def bucket_polyline_by_cell(points):
    """Per-cell clipped polylines for a street. Each cell gets only the
    portion of the polyline inside its bleed-expanded bbox; a polyline
    crossing N cells is split into N pieces instead of being duplicated
    whole. Returns { (gx, gz): [sub_polyline, ...] }."""
    if not points:
        return {}
    xs = [p[0] for p in points]
    zs = [p[1] for p in points]
    gx_min = math.floor((min(xs) - BLEED_M) / GRID_SIZE)
    gx_max = math.floor((max(xs) + BLEED_M) / GRID_SIZE)
    gz_min = math.floor((min(zs) - BLEED_M) / GRID_SIZE)
    gz_max = math.floor((max(zs) + BLEED_M) / GRID_SIZE)
    out = {}
    for gx in range(gx_min, gx_max + 1):
        for gz in range(gz_min, gz_max + 1):
            x_min = gx * GRID_SIZE - BLEED_M
            x_max = (gx + 1) * GRID_SIZE + BLEED_M
            z_min = gz * GRID_SIZE - BLEED_M
            z_max = (gz + 1) * GRID_SIZE + BLEED_M
            subs = _clip_polyline_to_bbox(points, x_min, x_max, z_min, z_max)
            if subs:
                out[(gx, gz)] = subs
    return out


def _bleed_cells_for_point(x, z):
    """Cells whose bounds are within BLEED_M of (x, z)."""
    gx_min = math.floor((x - BLEED_M) / GRID_SIZE)
    gx_max = math.floor((x + BLEED_M) / GRID_SIZE)
    gz_min = math.floor((z - BLEED_M) / GRID_SIZE)
    gz_max = math.floor((z + BLEED_M) / GRID_SIZE)
    return {(gx, gz)
            for gx in range(gx_min, gx_max + 1)
            for gz in range(gz_min, gz_max + 1)}


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


def _clip_poly_half_plane(poly, axis, bound, sign):
    """Sutherland-Hodgman clip of a convex polygon against one axis-aligned
    half-plane. `poly` is a list of (x, z); `axis` is 0 (clip on x) or 1
    (clip on z); `sign` is +1 to keep points with value >= bound, -1 for <=.
    Returns the clipped polygon (possibly empty)."""
    if not poly:
        return poly
    out = []
    n = len(poly)
    for i in range(n):
        a = poly[i]
        b = poly[(i + 1) % n]
        a_in = (a[axis] - bound) * sign >= -1e-9
        b_in = (b[axis] - bound) * sign >= -1e-9
        if a_in:
            out.append(a)
        if a_in != b_in:
            denom = b[axis] - a[axis]
            t = (bound - a[axis]) / denom if denom else 0.0
            out.append((a[0] + t * (b[0] - a[0]),
                        a[1] + t * (b[1] - a[1])))
    return out


def _clip_tri_to_bbox(x0, z0, x1, z1, x2, z2, x_min, x_max, z_min, z_max):
    """Clip a triangle to an axis-aligned bbox and fan-triangulate the
    resulting convex polygon. Returns a flat [x,z,x,z,...] triangle list,
    empty if the triangle lies entirely outside the bbox."""
    poly = [(x0, z0), (x1, z1), (x2, z2)]
    poly = _clip_poly_half_plane(poly, 0, x_min,  1)
    poly = _clip_poly_half_plane(poly, 0, x_max, -1)
    poly = _clip_poly_half_plane(poly, 1, z_min,  1)
    poly = _clip_poly_half_plane(poly, 1, z_max, -1)
    if len(poly) < 3:
        return []
    out = []
    for i in range(1, len(poly) - 1):
        out.extend((poly[0][0], poly[0][1],
                    poly[i][0], poly[i][1],
                    poly[i + 1][0], poly[i + 1][1]))
    return out


def bucket_triangles_by_cell(tri):
    """Group a flat XZ triangle list (6 floats per tri) by the cells each
    triangle's bbox touches. Each source triangle is Sutherland-Hodgman
    clipped to each cell's (bleed-expanded) bounds before being written, so
    the per-tile payload stays bounded by what actually intersects the tile.

    Without the clip, a single ocean triangle from Upper NY Bay (~10 km
    across) would be bucketed whole into every cell its bbox overlaps; at
    runtime OsmManager._tessellateTri would then iterate every 2 m terrain
    block in that triangle's full bbox, emitting millions of sub-triangles
    per tile and OOMing the tab. Clipping here bounds each source triangle
    at the tile scale (~125 m), keeping runtime tessellation proportional
    to the tile's own area."""
    buckets = {}
    for ti in range(0, len(tri), 6):
        x0, z0 = tri[ti],     tri[ti + 1]
        x1, z1 = tri[ti + 2], tri[ti + 3]
        x2, z2 = tri[ti + 4], tri[ti + 5]
        gx_min = math.floor((min(x0, x1, x2) - BLEED_M) / GRID_SIZE)
        gx_max = math.floor((max(x0, x1, x2) + BLEED_M) / GRID_SIZE)
        gz_min = math.floor((min(z0, z1, z2) - BLEED_M) / GRID_SIZE)
        gz_max = math.floor((max(z0, z1, z2) + BLEED_M) / GRID_SIZE)
        for gx in range(gx_min, gx_max + 1):
            for gz in range(gz_min, gz_max + 1):
                # Clip to the cell's bleed-expanded bbox — matching the
                # bleed semantics of polyline_cells (features within BLEED_M
                # of a boundary appear in both adjacent tiles, so seam
                # rendering lines up).
                x_min = gx * GRID_SIZE - BLEED_M
                x_max = (gx + 1) * GRID_SIZE + BLEED_M
                z_min = gz * GRID_SIZE - BLEED_M
                z_max = (gz + 1) * GRID_SIZE + BLEED_M
                clipped = _clip_tri_to_bbox(
                    x0, z0, x1, z1, x2, z2,
                    x_min, x_max, z_min, z_max,
                )
                if not clipped:
                    continue
                bucket = buckets.get((gx, gz))
                if bucket is None:
                    bucket = []
                    buckets[(gx, gz)] = bucket
                bucket.extend(clipped)
    return buckets


# ── Binary tile encoding ──────────────────────────────────────────────────────

def _pack_coords(flat_xz, origin_x, origin_z):
    """Convert a flat [x, z, x, z, ...] float list into int32 decimeter bytes
    (little-endian) relative to (origin_x, origin_z)."""
    if not flat_xz:
        return b''
    arr = np.asarray(flat_xz, dtype=np.float64)
    arr[0::2] -= origin_x
    arr[1::2] -= origin_z
    arr *= BIN_COORD_SCALE
    return np.rint(arr).astype('<i4').tobytes()


def _pad4(buf):
    """Pad `buf` (bytearray) with zero bytes up to the next 4-byte boundary."""
    while len(buf) & 3:
        buf.append(0)


def encode_tile_binary(entry, gx, gz):
    """Serialize one tile's streets/water/green to the binary format.

    Layout (little-endian):
      Header: uint32 magic, uint8 version, uint8 reserved,
              int16 gx, int16 gz, uint8 typeCount, uint8 reserved
      Type table:  per type: uint8 len, bytes utf8; then pad to 4B
      Streets:     uint32 count; per street:
                     uint8 typeIdx, uint8 nameLen, uint16 pointCount,
                     bytes name (utf8), pad to 4B,
                     int32 coords[pointCount * 2]   (tile-local decimeters)
      Water:       uint32 polyCount; per poly:
                     uint32 coordCount (= numTris * 6),
                     int32 coords[coordCount]
      Green:       same as water.
    """
    streets = entry.get('streets') or []
    water   = entry.get('water')   or []
    green   = entry.get('green')   or []

    origin_x = gx * GRID_SIZE
    origin_z = gz * GRID_SIZE

    # Type table — inline per tile. Most tiles use only a handful of highway
    # types so the overhead is tiny, and keeping the mapping in-file means
    # bake and runtime stay in sync without a shared enum constant.
    type_list = []
    type_idx  = {}
    for s in streets:
        t = s.get('type') or ''
        if t not in type_idx:
            type_idx[t] = len(type_list)
            type_list.append(t)
    if len(type_list) > 255:
        raise ValueError(f'tile {gx},{gz}: too many street types ({len(type_list)})')

    buf = bytearray()
    buf += struct.pack('<IBBhhBB', BIN_MAGIC, BIN_VERSION, 0, gx, gz, len(type_list), 0)

    for t in type_list:
        tb = t.encode('utf-8')[:255]
        buf.append(len(tb))
        buf += tb
    _pad4(buf)

    buf += struct.pack('<I', len(streets))
    for s in streets:
        pts = s.get('points') or []
        name_bytes = (s.get('name') or '').encode('utf-8')[:255]
        buf += struct.pack('<BBH', type_idx[s.get('type') or ''], len(name_bytes), len(pts))
        buf += name_bytes
        _pad4(buf)
        if pts:
            flat = [v for xz in pts for v in xz]
            buf += _pack_coords(flat, origin_x, origin_z)

    buf += struct.pack('<I', len(water))
    for tris in water:
        buf += struct.pack('<I', len(tris))
        buf += _pack_coords(tris, origin_x, origin_z)

    buf += struct.pack('<I', len(green))
    for tris in green:
        buf += struct.pack('<I', len(tris))
        buf += _pack_coords(tris, origin_x, origin_z)

    return bytes(buf)


def _cleanup_stale_tiles(output_dir, keep_ids):
    """Remove any cell_*.json or cell_*.bin.gz files whose tile_id isn't in
    `keep_ids`. Previous bakes may have left orphans from cells that are now
    empty or off-coverage."""
    removed = 0
    for name in os.listdir(output_dir):
        if not name.startswith('cell_'):
            continue
        tile_id = name.split('.', 1)[0]
        if tile_id in keep_ids and name.endswith('.bin.gz'):
            continue
        # Drop stale .json from the old format and any .bin.gz for cells we
        # no longer emit.
        if name.endswith('.json') or name.endswith('.bin.gz'):
            os.remove(os.path.join(output_dir, name))
            removed += 1
    if removed:
        print(f'Cleaned up {removed} stale tile files')


# ── Main ──────────────────────────────────────────────────────────────────────

def _parse_bbox_override(argv):
    """Return a (south, west, north, east) tuple if --bbox is in argv, else None.

    Forms:
      --bbox                         use DEFAULT_FULL_BBOX (all 5 NYC boroughs)
      --bbox <south,west,north,east> explicit bbox (comma-separated, deg)
    """
    if '--bbox' not in argv:
        return None
    i = argv.index('--bbox')
    val = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith('--') else None
    if val is None:
        return DEFAULT_FULL_BBOX
    try:
        s, w, n, e = (float(x) for x in val.split(','))
    except ValueError:
        print(f'--bbox expected "south,west,north,east", got {val!r}')
        sys.exit(2)
    return s, w, n, e


def _synthetic_building_cells(bbox):
    """When --bbox overrides the manifest-derived bbox, we also need a
    building_cells set that keeps the whole bbox "on coverage" for
    chunk_near_building + cell_near_building. Return every OSM cell (gx, gz)
    whose 125 m bounds intersect the bbox."""
    s, w, n, e = bbox
    sw_x, sw_z = lng_lat_to_local(w, s)
    ne_x, ne_z = lng_lat_to_local(e, n)
    min_x, max_x = min(sw_x, ne_x), max(sw_x, ne_x)
    min_z, max_z = min(sw_z, ne_z), max(sw_z, ne_z)
    gx0 = math.floor(min_x / GRID_SIZE)
    gx1 = math.floor(max_x / GRID_SIZE)
    gz0 = math.floor(min_z / GRID_SIZE)
    gz1 = math.floor(max_z / GRID_SIZE)
    return {(gx, gz) for gx in range(gx0, gx1 + 1) for gz in range(gz0, gz1 + 1)}


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

    bldg_manifest = read_building_manifest()
    bbox_override = _parse_bbox_override(sys.argv)
    if bbox_override is not None:
        bbox = bbox_override
        # Synthetic coverage set so the chunk + write filters don't drop cells
        # just because the (intentionally-trimmed) building manifest is small.
        building_cells = _synthetic_building_cells(bbox)
        print(f'Using --bbox override: {bbox} '
              f'({len(building_cells)} coverage cells)')
    else:
        bbox           = compute_bbox(bldg_manifest)
        building_cells = compute_building_osm_cells(bldg_manifest)
    osm = fetch_overpass(bbox, building_cells, use_cache=use_cache)

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
                highway_type = tags.get('highway')
                name = tags.get('name')
                # Split the polyline into per-cell clipped sub-polylines so
                # a street crossing N cells lives in N tiles as N trimmed
                # pieces, not N copies of the whole polyline. At runtime
                # each sub-polyline becomes its own ribbon, keeping street
                # ribbon geometry proportional to the tile's own area.
                for cell, subs in bucket_polyline_by_cell(pts).items():
                    for sub in subs:
                        if len(sub) < 2:
                            continue
                        street = {
                            'type':   highway_type,
                            'points': [[round(x, 2), round(z, 2)] for x, z in sub],
                        }
                        if name:
                            street['name'] = name
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
    total_raw_kb  = 0
    dropped_off_coverage = 0
    kept_ids = set()
    for (gx, gz), entry in sorted(cell_data.items()):
        if not (entry['streets'] or entry['water'] or entry['green']):
            continue
        if not cell_near_building(gx, gz, building_cells):
            dropped_off_coverage += 1
            continue
        tile_id = f'cell_{gx}_{gz}'
        kept_ids.add(tile_id)

        raw = encode_tile_binary(entry, gx, gz)
        payload = gzip.compress(raw, compresslevel=6)
        out_path = os.path.join(OUTPUT_DIR, f'{tile_id}.bin.gz')
        with open(out_path, 'wb') as f:
            f.write(payload)
        total_raw_kb += len(raw) / 1024
        total_size_kb += len(payload) / 1024

        # streetCount is used by OsmManager.tilesWithStreets(); file URL is
        # derived client-side from `id`. waterCount/greenCount were unused.
        manifest.append({
            'id':    tile_id,
            'bounds': {
                'minX': gx * GRID_SIZE, 'maxX': (gx + 1) * GRID_SIZE,
                'minZ': gz * GRID_SIZE, 'maxZ': (gz + 1) * GRID_SIZE,
            },
            'streetCount': len(entry['streets']),
        })

    _cleanup_stale_tiles(OUTPUT_DIR, kept_ids)

    manifest_path = os.path.join(OUTPUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        # Compact — every byte of the manifest ships to every client on load.
        json.dump(manifest, f, separators=(',', ':'))

    print(f'\n{"─" * 50}')
    print(f'OSM tiles written : {len(manifest)}')
    print(f'Dropped off-coverage : {dropped_off_coverage}')
    print(f'Total size (gz)   : {total_size_kb / 1024:.1f} MB')
    print(f'Total size (raw)  : {total_raw_kb  / 1024:.1f} MB')
    print(f'Avg per tile (gz) : {total_size_kb / max(len(manifest), 1):.1f} KB')
    print(f'Manifest          : {manifest_path} ({os.path.getsize(manifest_path) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
