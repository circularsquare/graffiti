#!/usr/bin/env python3
"""Sanity test for the new Sutherland-Hodgman / Liang-Barsky clip helpers in
fetch_osm_features.py. Runs a handful of hand-crafted cases and prints PASS
or a short diagnostic, exiting non-zero on any failure."""

import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from fetch_osm_features import (
    _clip_tri_to_bbox, _clip_polyline_to_bbox, bucket_triangles_by_cell,
    bucket_polyline_by_cell, GRID_SIZE, BLEED_M,
)

fails = 0

def check(name, cond, extra=''):
    global fails
    if cond:
        print(f'PASS  {name}')
    else:
        print(f'FAIL  {name}  {extra}')
        fails += 1

# ── Triangle clipping ────────────────────────────────────────────────────────

# Triangle wholly inside bbox -> one triangle back, same verts.
flat = _clip_tri_to_bbox(10, 10, 20, 10, 15, 20, 0, 100, 0, 100)
check('tri wholly inside', len(flat) == 6,
      f'got {len(flat)} floats, expected 6')

# Triangle wholly outside bbox -> empty.
flat = _clip_tri_to_bbox(200, 200, 300, 200, 250, 300, 0, 100, 0, 100)
check('tri wholly outside', flat == [],
      f'got {flat}')

# Triangle straddling right edge: one vertex inside, two outside right.
# Clipped polygon = triangle (apex at (50,50), two verts on x=100).
flat = _clip_tri_to_bbox(50, 50, 150, 40, 150, 60, 0, 100, 0, 100)
check('tri straddles one edge -> 1 fan tri', len(flat) == 6,
      f'got {len(flat)/6:g} tris')

# Triangle with one vertex inside, one outside top, one outside right.
# Clipped polygon is a pentagon (5 verts) -> 3 fan tris.
flat = _clip_tri_to_bbox(50, 50, 150, 50, 50, 150, 0, 100, 0, 100)
check('tri straddles two edges -> 3 fan tris', len(flat) == 18,
      f'got {len(flat)/6:g} tris')

# Huge triangle covering whole bbox: clipped result should be the bbox itself
# (4 verts -> 2 fan tris). Corners of clipped poly should all be on bbox.
flat = _clip_tri_to_bbox(-1000, -1000, 5000, -1000, 2000, 5000, 0, 100, 0, 100)
xs = [flat[i] for i in range(0, len(flat), 2)]
zs = [flat[i] for i in range(1, len(flat), 2)]
inside = all(-1e-6 <= x <= 100 + 1e-6 and -1e-6 <= z <= 100 + 1e-6 for x, z in zip(xs, zs))
check('huge tri -> verts all inside bbox', inside and len(flat) == 12,
      f'got {len(flat)/6:g} tris, inside={inside}')

# ── bucket_triangles_by_cell at the scale the runtime cares about ───────────

# 10-km-ish triangle — pre-fix behaviour would bucket this whole into every
# cell of its bbox. Post-fix: each cell only gets the piece that actually
# intersects its own cell bbox (+ BLEED_M).
buckets = bucket_triangles_by_cell([
    0, 0,   10000, 0,   5000, 10000,
])
max_cell_floats = max(len(v) for v in buckets.values())
# Expect each cell's payload to be bounded: a single triangle clipped to one
# cell has ≤5 sub-tris = 30 floats, regardless of GRID_SIZE.
check('10 km tri: per-cell payload bounded',
      max_cell_floats <= 42,
      f'max cell has {max_cell_floats} floats ({max_cell_floats/6:g} tris)')
check('10 km tri: many cells have content',
      len(buckets) > 100,
      f'got {len(buckets)} cells')

# ── Polyline clipping ────────────────────────────────────────────────────────

# Polyline wholly inside -> one sub-polyline, same points.
subs = _clip_polyline_to_bbox(
    [(10, 10), (20, 20), (30, 15)], 0, 100, 0, 100,
)
check('polyline wholly inside', len(subs) == 1 and len(subs[0]) == 3,
      f'got subs={subs}')

# Polyline wholly outside -> empty.
subs = _clip_polyline_to_bbox(
    [(200, 200), (300, 250)], 0, 100, 0, 100,
)
check('polyline wholly outside', subs == [],
      f'got subs={subs}')

# Polyline enters and exits (crosses the bbox). One sub-polyline of two pts.
subs = _clip_polyline_to_bbox(
    [(-10, 50), (110, 50)], 0, 100, 0, 100,
)
check('polyline crosses bbox -> 1 sub, 2 pts',
      len(subs) == 1 and len(subs[0]) == 2,
      f'got subs={subs}')

# Polyline leaves, re-enters, leaves again, re-enters -> three sub-polylines
# (the middle segment grazes the bbox left-to-right making its own sub).
subs = _clip_polyline_to_bbox(
    [(10, 50), (-10, 50), (-10, 30), (110, 30), (110, 70), (10, 70)],
    0, 100, 0, 100,
)
check('polyline multi-enter -> 3 subs',
      len(subs) == 3,
      f'got {len(subs)} subs = {subs}')

# Simple leave-and-return: polyline dips out through left and comes back,
# producing two sub-polylines.
subs = _clip_polyline_to_bbox(
    [(10, 50), (-10, 50), (10, 70)],
    0, 100, 0, 100,
)
check('polyline dips out left -> 2 subs',
      len(subs) == 2,
      f'got {len(subs)} subs = {subs}')

# ── bucket_polyline_by_cell: crossing multiple cells ────────────────────────

# A straight east-west polyline from x=10 to x=500 (bleed-adjusted spans
# cells 0, 1, and 2 — x=500 is the cell-1/cell-2 boundary and BLEED_M puts
# a sliver in cell 2).
buckets = bucket_polyline_by_cell([(10, 100), (500, 100)])
check('polyline spans 2+ cells with bleed', len(buckets) >= 2,
      f'got {len(buckets)} buckets = {list(buckets.keys())}')
# Endpoint well inside the middle of cell 0 → should only show up in cell 0.
buckets = bucket_polyline_by_cell([(10, 100), (200, 100)])
check('polyline wholly in cell 0', len(buckets) == 1 and (0, 0) in buckets,
      f'got buckets = {list(buckets.keys())}')

# Long street (10 km) spanning 40 cells — pre-fix each cell got the whole
# 10 km polyline; post-fix each cell gets only its slice.
buckets = bucket_polyline_by_cell([(0, 100), (10000, 100)])
max_pts_per_cell = max(sum(len(s) for s in subs) for subs in buckets.values())
check('10 km street: per-cell points bounded',
      max_pts_per_cell <= 4,
      f'max cell has {max_pts_per_cell} points')

if fails:
    print(f'\n{fails} FAILURE(s)')
    sys.exit(1)
print('\nAll tests passed.')
