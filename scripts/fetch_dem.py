#!/usr/bin/env python3
"""
Fetch USGS 3DEP 1-meter bare-earth DEM tiles covering the building manifest
bbox. Tiles are GeoTIFFs served off prd-tnm.s3.amazonaws.com.

Bare-earth: buildings and vegetation are removed at the classification step,
so sampling this for terrain never picks up a rooftop.

Outputs:
    data/dem/*.tif              — raw USGS 1 m DEM tiles (gitignored)
    data/dem/_tnm_response.json — cached TNM Access API response

Usage:
    python scripts/fetch_dem.py            # fetch missing tiles
    python scripts/fetch_dem.py --refresh  # re-query API and re-download
    python scripts/fetch_dem.py --dry-run  # list tiles & sizes, fetch nothing

Baking heightmaps into per-cell tile JSON happens later in build_tiles.py.
This script only owns the download.
"""

import os, sys, json, math, re, argparse, time
import urllib.request, urllib.parse, urllib.error

# Same reference point as convert_citygml.py / geo.js / fetch_osm_features.py
REF_LNG = -74.01175
REF_LAT = 40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))

HERE              = os.path.dirname(__file__)
OUTPUT_DIR        = os.path.join(HERE, '..', 'data', 'dem')
BUILDING_MANIFEST = os.path.join(HERE, '..', 'public', 'tiles', 'manifest.json')
TNM_CACHE         = os.path.join(OUTPUT_DIR, '_tnm_response.json')

# TNM Access API — https://apps.nationalmap.gov/tnmaccess/
TNM_ENDPOINT = 'https://tnmaccess.nationalmap.gov/api/v1/products'
TNM_DATASET  = 'Digital Elevation Model (DEM) 1 meter'

# Proximity grid — same 250 m cells the OSM fetcher uses for building-adjacency
# checks. A 4-cell pad (1 km) around any building cell is enough to avoid
# coverage holes at the edges while still dropping NJ, open harbour, and
# open-ocean DEM tiles that would otherwise come back from a rectangular bbox
# query. Used both to tighten the TNM bbox and to cull the response.
PROXIMITY_GRID_SIZE = 250
PROXIMITY_PAD_CELLS = 4


def local_to_lng_lat(x, z):
    return REF_LNG + x / METERS_PER_LNG, REF_LAT - z / METERS_PER_LAT


def lng_lat_to_local(lng, lat):
    return ((lng - REF_LNG) * METERS_PER_LNG,
            -(lat - REF_LAT) * METERS_PER_LAT)


def read_manifest():
    with open(BUILDING_MANIFEST) as f:
        manifest = json.load(f)
    if not manifest:
        sys.exit('manifest.json is empty — run `npm run build-tiles` first.')
    return manifest


def building_cells(manifest):
    """Set of (gx, gz) proximity cells overlapped by any building tile bbox."""
    cells = set()
    g = PROXIMITY_GRID_SIZE
    for t in manifest:
        b = t['bounds']
        gx0 = math.floor(b['minX'] / g)
        gx1 = math.floor((b['maxX'] - 1e-6) / g)
        gz0 = math.floor(b['minZ'] / g)
        gz1 = math.floor((b['maxZ'] - 1e-6) / g)
        for gx in range(gx0, gx1 + 1):
            for gz in range(gz0, gz1 + 1):
                cells.add((gx, gz))
    return cells


def compute_bbox(manifest):
    """Rectangular lng/lat envelope of the manifest, padded. This goes to the
    TNM query — which only speaks rectangles — and is later tightened per-tile
    against `building_cells` so we drop NJ / harbour / ocean items."""
    pad = PROXIMITY_GRID_SIZE * PROXIMITY_PAD_CELLS
    min_x = min(t['bounds']['minX'] for t in manifest) - pad
    max_x = max(t['bounds']['maxX'] for t in manifest) + pad
    min_z = min(t['bounds']['minZ'] for t in manifest) - pad
    max_z = max(t['bounds']['maxZ'] for t in manifest) + pad
    # +Z = south, so min_z is the northern edge and max_z is the southern edge.
    west_lng,  north_lat = local_to_lng_lat(min_x, min_z)
    east_lng,  south_lat = local_to_lng_lat(max_x, max_z)
    return west_lng, south_lat, east_lng, north_lat


def item_bbox_local(item):
    """Return (minX, minZ, maxX, maxZ) in local metres for a TNM item, or None
    if the item lacks a usable bounding box."""
    bb = item.get('boundingBox') or {}
    try:
        w, e = float(bb['minX']), float(bb['maxX'])
        s, n = float(bb['minY']), float(bb['maxY'])
    except (KeyError, TypeError, ValueError):
        return None
    sw_x, sw_z = lng_lat_to_local(w, s)
    ne_x, ne_z = lng_lat_to_local(e, n)
    return (min(sw_x, ne_x), min(sw_z, ne_z), max(sw_x, ne_x), max(sw_z, ne_z))


# USGS 1 m DEMs are staged in a 10 km spatial grid and every product title
# embeds that grid coord as "xNNyNNN". Multiple surveys over the same
# spatial tile (e.g. NJ_SdL5 + NY_CMPG on x56y450) both come back from TNM;
# we only need one. The largest file is almost always the right keeper —
# partial-coverage surveys compress their NODATA pixels away, so a small
# file is a sliver of the tile, and a large one covers most of it.
TILE_KEY_RE = re.compile(r'x(\d+)y(\d+)', re.IGNORECASE)


def spatial_tile_key(item):
    m = TILE_KEY_RE.search(item.get('title') or '')
    return (int(m.group(1)), int(m.group(2))) if m else None


def dedupe_by_spatial_tile(items):
    """Keep one item per 10 km USGS spatial tile. Tiles at the NJ/NY
    boundary are shared between NJ and NY surveys — the NJ survey's file
    is often physically larger because it carries the NJ side of the tile,
    but its NYC side is all NODATA. So prefer non-NJ surveys when any
    exist for a given spatial tile; otherwise fall back to the largest
    file (best coverage heuristic for same-region surveys).

    Items with no parseable tile key pass through untouched."""
    groups = {}
    passthrough = []
    for it in items:
        key = spatial_tile_key(it)
        if key is None:
            passthrough.append(it)
            continue
        groups.setdefault(key, []).append(it)

    def _is_nj(it):
        return 'NJ' in (it.get('title') or '')

    result = []
    for members in groups.values():
        non_nj = [m for m in members if not _is_nj(m)]
        pool   = non_nj if non_nj else members
        best   = max(pool, key=lambda it: int(it.get('sizeInBytes') or 0))
        result.append(best)
    return result + passthrough


def item_near_building(item, cells, pad=PROXIMITY_PAD_CELLS):
    """True if any proximity cell (±pad) inside the item's footprint is in
    `cells`. Items with no parseable bbox fall through as True so we don't
    silently drop them."""
    env = item_bbox_local(item)
    if env is None:
        return True
    min_x, min_z, max_x, max_z = env
    g = PROXIMITY_GRID_SIZE
    gx0 = math.floor(min_x / g) - pad
    gx1 = math.floor(max_x / g) + pad
    gz0 = math.floor(min_z / g) - pad
    gz1 = math.floor(max_z / g) + pad
    for gx in range(gx0, gx1 + 1):
        for gz in range(gz0, gz1 + 1):
            if (gx, gz) in cells:
                return True
    return False


def query_tnm(bbox, use_cache=True):
    if use_cache and os.path.exists(TNM_CACHE):
        with open(TNM_CACHE) as f:
            return json.load(f)
    west, south, east, north = bbox
    params = {
        'datasets': TNM_DATASET,
        'bbox': f'{west},{south},{east},{north}',
        'outputFormat': 'JSON',
        'max': 500,
    }
    url = f'{TNM_ENDPOINT}?{urllib.parse.urlencode(params)}'
    print(f'  → {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'graffiti-nyc-dem-fetch/0.1'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read())
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(TNM_CACHE, 'w') as f:
        json.dump(payload, f, indent=2)
    return payload


def human_bytes(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.1f} {unit}'
        n /= 1024


def download(url, dest, expected_size=None):
    """Stream a URL to `dest`. Skip if file already exists and matches size."""
    if os.path.exists(dest) and expected_size and os.path.getsize(dest) == expected_size:
        return 'cached'
    tmp = dest + '.part'
    req = urllib.request.Request(url, headers={'User-Agent': 'graffiti-nyc-dem-fetch/0.1'})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, 'wb') as out:
        total = int(resp.headers.get('Content-Length', 0) or 0)
        read = 0
        t0 = time.time()
        while True:
            chunk = resp.read(1 << 20)  # 1 MB
            if not chunk:
                break
            out.write(chunk)
            read += len(chunk)
            if total:
                pct = read / total * 100
                rate = read / max(time.time() - t0, 1e-3) / (1 << 20)
                print(f'\r    {pct:5.1f}%  {human_bytes(read)}/{human_bytes(total)}  '
                      f'{rate:4.1f} MB/s', end='', flush=True)
        print()
    os.replace(tmp, dest)
    return 'downloaded'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true',
                    help='Re-query the TNM API and re-download all tiles')
    ap.add_argument('--dry-run', action='store_true',
                    help='List tiles and total size, fetch nothing')
    args = ap.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print('Reading building manifest bbox…')
    manifest = read_manifest()
    cells = building_cells(manifest)
    bbox = compute_bbox(manifest)
    w, s, e, n = bbox
    span_km = max((e - w) * METERS_PER_LNG, (n - s) * METERS_PER_LAT) / 1000
    print(f'  bbox (lng/lat): W {w:.4f}  S {s:.4f}  E {e:.4f}  N {n:.4f}  (~{span_km:.1f} km)')
    print(f'  {len(cells)} populated {PROXIMITY_GRID_SIZE} m building cells')

    print('Querying USGS TNM Access API for 1 m DEM products…')
    payload = query_tnm(bbox, use_cache=not args.refresh)
    raw = payload.get('items') or []
    raw_bytes = sum(int(it.get('sizeInBytes') or 0) for it in raw)
    print(f'  {len(raw)} tiles from API ({human_bytes(raw_bytes)} total)')

    near = [it for it in raw if item_near_building(it, cells)]
    print(f'  dropped {len(raw) - len(near)} not near a building tile '
          f'→ {len(near)} tiles, {human_bytes(sum(int(it.get("sizeInBytes") or 0) for it in near))}')

    items = dedupe_by_spatial_tile(near)
    total_bytes = sum(int(it.get('sizeInBytes') or 0) for it in items)
    print(f'  deduped to {len(items)} unique spatial tiles, '
          f'{human_bytes(total_bytes)} total')

    if not items:
        errors = payload.get('errors') or []
        if errors:
            print('  TNM reported errors:', errors)
        sys.exit('  No 1 m DEM products returned for this bbox. '
                 'Check bbox or confirm coverage on apps.nationalmap.gov.')

    if args.dry_run:
        for it in items:
            size = int(it.get('sizeInBytes') or 0)
            print(f'  - {it.get("title", "?")}  ({human_bytes(size)})')
        return

    print('Downloading tiles…')
    cached = downloaded = failed = 0
    for i, it in enumerate(items, 1):
        url = it.get('downloadURL')
        if not url:
            print(f'  [{i}/{len(items)}] skipping — no downloadURL')
            failed += 1
            continue
        name = os.path.basename(urllib.parse.urlparse(url).path) or f'tile_{i}.tif'
        dest = os.path.join(OUTPUT_DIR, name)
        size = int(it.get('sizeInBytes') or 0)
        print(f'  [{i}/{len(items)}] {name}  ({human_bytes(size) if size else "?"})')
        try:
            result = download(url, dest, expected_size=size or None)
            if result == 'cached':
                print('    cached')
                cached += 1
            else:
                downloaded += 1
        except (urllib.error.URLError, TimeoutError, OSError) as ex:
            print(f'    failed: {ex}')
            failed += 1

    print(f'Done. downloaded={downloaded} cached={cached} failed={failed}')


if __name__ == '__main__':
    main()
