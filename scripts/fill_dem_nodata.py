#!/usr/bin/env python3
"""
Fill NODATA in the USGS 3DEP DEM tiles used by bake_terrain.py.

For every data/dem/*.tif that doesn't already have a sibling *_filled.tif,
run rasterio.fill.fillnodata (GDAL's GDALFillNodata under the hood) and write
the result beside the source. bake_terrain.py then reads the filled variants.

Why: bake_terrain samples each cell's 64x64 inner grid plus a 1-cell perimeter
pad that carries neighbour-tile samples. At a shared seam sample that happened
to be NODATA, the runtime worker's fillNoData had to invent a value from its
own non-NODATA neighbours — and the adjacent tile, which owns the same point
as an inner sample, invented a different value from its own grid. Divergent
values broke the "identical samples at shared corners" invariant the seam
closing relies on, leaving holes at tile borders. Filling at the DEM means
every tile sees the same elevation at every shared point by construction.

Usage:
    python scripts/fill_dem_nodata.py
    python scripts/fill_dem_nodata.py --refresh     # re-fill existing _filled.tif
"""

import os, sys, glob, argparse, time
import numpy as np
import rasterio
from rasterio.fill import fillnodata

HERE = os.path.dirname(__file__)
DEM_DIR = os.path.join(HERE, '..', 'data', 'dem')
MAX_SEARCH = 100.0  # pixels; at 1 m/px, that's 100 m of interpolation reach.

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true',
                    help='Re-fill even if an existing _filled.tif is present')
    args = ap.parse_args()

    # Source DEMs: every *.tif that isn't itself one of our filled outputs.
    srcs = sorted(p for p in glob.glob(os.path.join(DEM_DIR, '*.tif'))
                  if not p.endswith('_filled.tif'))
    if not srcs:
        sys.exit(f'No DEMs in {DEM_DIR}. Expected USGS 3DEP .tif tiles.')

    total_filled = 0
    written = skipped = 0
    for i, src in enumerate(srcs):
        base = os.path.splitext(src)[0]
        dst = base + '_filled.tif'
        label = f'[{i+1}/{len(srcs)}] {os.path.basename(src)}'

        if not args.refresh and os.path.exists(dst):
            print(f'{label} — skip (already filled)')
            skipped += 1
            continue

        t0 = time.time()
        with rasterio.open(src) as ds:
            profile = ds.profile
            band = ds.read(1)
            nodata = ds.nodata

        # fillnodata interprets mask: 0 = fill this pixel, >0 = valid source.
        if nodata is None:
            mask = np.ones(band.shape, dtype=np.uint8)
        else:
            mask = (band != nodata).astype(np.uint8)
        n_missing = int((mask == 0).sum())

        if n_missing == 0:
            # Nothing to fill — still write the _filled.tif so bake_terrain has
            # a uniform filename convention and we don't have to special-case.
            filled = band
        else:
            filled = fillnodata(band, mask=mask, max_search_distance=MAX_SEARCH)

        with rasterio.open(dst, 'w', **profile) as out:
            out.write(filled, 1)
        total_filled += n_missing
        written += 1

        dt = time.time() - t0
        print(f'{label} — {n_missing} NODATA filled in {dt:.1f}s')

    print(f'Done. written={written} skipped={skipped} '
          f'total NODATA filled={total_filled}')


if __name__ == '__main__':
    main()
