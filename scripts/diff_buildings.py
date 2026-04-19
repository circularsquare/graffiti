#!/usr/bin/env python3
"""
Spatial diff between public/buildings.json (DoITT) and public/buildings_lod2.json (TUM).

Building IDs differ across the two sources, so we match by centroid proximity
and flag LoD2 buildings with no DoITT neighbour within a small radius. Outputs
each unmatched building's approximate lat/lng (for pasting into Google Maps)
plus its height and triangle count.
"""

import json, math, sys, os

# Must match convert_citygml*.py + src/geo.js
REF_LNG = -74.01175
REF_LAT =  40.70475
METERS_PER_LAT = 111320.0
METERS_PER_LNG = 111320.0 * math.cos(math.radians(REF_LAT))

MATCH_RADIUS = 20.0  # metres — wider than 5m to absorb roof-shape centroid offsets


def load(path):
    with open(path) as f:
        return json.load(f)


def footprint_centroid_and_stats(bldg):
    """Compute centroid using only the base ring (bottom 1m of vertices) so
    pitched roofs don't pull the centroid sideways. Returns
    (cx, cz, min_y, max_y, tri_count) in local metres."""
    xs_all, ys_all, zs_all = [], [], []
    for arr in (bldg['roof'], bldg['walls']):
        for i in range(0, len(arr) - 2, 3):
            xs_all.append(arr[i])
            ys_all.append(arr[i + 1])
            zs_all.append(arr[i + 2])
    if not xs_all:
        return None
    min_y, max_y = min(ys_all), max(ys_all)
    base_cutoff = min_y + 1.0
    base_xs = [x for x, y in zip(xs_all, ys_all) if y <= base_cutoff]
    base_zs = [z for z, y in zip(zs_all, ys_all) if y <= base_cutoff]
    if not base_xs:
        base_xs, base_zs = xs_all, zs_all  # fallback if no clear base
    cx = sum(base_xs) / len(base_xs)
    cz = sum(base_zs) / len(base_zs)
    tris = (len(bldg['roof']) + len(bldg['walls'])) // 9
    return cx, cz, min_y, max_y, tris


def local_to_latlng(x, z):
    lng = REF_LNG + x / METERS_PER_LNG
    lat = REF_LAT - z / METERS_PER_LAT
    return lat, lng


def main():
    old = load('public/buildings.json')
    new = load('public/buildings_lod2.json')
    print(f'DoITT: {len(old)}  LoD2: {len(new)}  (+{len(new) - len(old)})')

    old_centroids = [footprint_centroid_and_stats(b) for b in old]
    old_centroids = [c for c in old_centroids if c is not None]

    unmatched = []
    for b in new:
        c = footprint_centroid_and_stats(b)
        if c is None:
            continue
        cx, cz, miny, maxy, tris = c
        best_d2 = float('inf')
        best_old = None
        for o in old_centroids:
            ox, oz, omy, oMy, ot = o
            d2 = (ox - cx) ** 2 + (oz - cz) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_old = o
        if best_d2 ** 0.5 > MATCH_RADIUS:
            lat, lng = local_to_latlng(cx, cz)
            old_h = (best_old[3] - best_old[2]) if best_old else 0
            unmatched.append({
                'id': b['id'],
                'lat': lat,
                'lng': lng,
                'height_m': maxy - miny,
                'base_y': miny,
                'tris': tris,
                'nearest_m': best_d2 ** 0.5,
                'nearest_h': old_h,
            })

    print(f'\n{len(unmatched)} LoD2 buildings with no DoITT footprint match within {MATCH_RADIUS} m:')
    print(f'  (compares base-ring centroids, ignoring roof-shape pull)\n')

    # For each unmatched LoD2 building, dump all DoITT buildings within 60m
    # so we can see whether DoITT splits the same volume into many pieces.
    NEIGHBOUR_RADIUS = 60.0
    for u in sorted(unmatched, key=lambda r: -r['height_m']):
        gmaps = f"https://www.google.com/maps/@{u['lat']:.6f},{u['lng']:.6f},19z"
        # Find this building's centroid in local metres for the neighbour scan
        target_lng = u['lng']
        target_lat = u['lat']
        cx_t = (target_lng - REF_LNG) * METERS_PER_LNG
        cz_t = -(target_lat - REF_LAT) * METERS_PER_LAT
        nearby = []
        for (ox, oz, omy, oMy, ot) in old_centroids:
            d = ((ox - cx_t) ** 2 + (oz - cz_t) ** 2) ** 0.5
            if d <= NEIGHBOUR_RADIUS:
                nearby.append((d, oMy - omy, ot))
        nearby.sort()
        print(f"  LoD2 h={u['height_m']:>6.1f}m tris={u['tris']:>4}  {gmaps}")
        if nearby:
            for (d, h, t) in nearby[:6]:
                print(f"      DoITT @{d:>5.1f}m: h={h:>6.1f}m tris={t:>4}")
        else:
            print(f"      no DoITT buildings within {NEIGHBOUR_RADIUS}m")
        print()

    # Reverse direction: any DoITT buildings with no LoD2 match? If LoD2 is a
    # superset, this should be 0 — anything > 0 means the diff is a substitution,
    # not a pure addition.
    new_centroids = [footprint_centroid_and_stats(b) for b in new]
    new_centroids = [c for c in new_centroids if c is not None]
    doitt_unmatched = 0
    for o in old_centroids:
        ox, oz, _, _, _ = o
        best_d2 = min(((nx - ox) ** 2 + (nz - oz) ** 2)
                      for (nx, nz, _, _, _) in new_centroids)
        if best_d2 ** 0.5 > MATCH_RADIUS:
            doitt_unmatched += 1
    print(f'Reverse check: {doitt_unmatched} DoITT buildings have no LoD2 match within {MATCH_RADIUS}m')


if __name__ == '__main__':
    main()
