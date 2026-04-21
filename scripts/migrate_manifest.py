"""One-shot: rewrite tiles/manifest.json (and tiles_lod2/manifest.json if
present) from the old {id, file, bounds, buildingCount, cellEstimate} shape
to the new compact {gx, gz, bounds, cellEstimate} shape. Per-cell tile JSONs
are unchanged, so this avoids a full `npm run build-tiles`.

Safe to delete after running.
"""
import json
import os
import re
import sys

HERE  = os.path.dirname(os.path.abspath(__file__))
PATHS = [
    os.path.join(HERE, '..', 'public', 'tiles',      'manifest.json'),
    os.path.join(HERE, '..', 'public', 'tiles_lod2', 'manifest.json'),
]
ID_RE = re.compile(r'cell_(-?\d+)_(-?\d+)$')

def migrate(path):
    if not os.path.exists(path):
        return
    old_size = os.path.getsize(path)
    with open(path) as f:
        old = json.load(f)
    new = []
    for e in old:
        if 'gx' in e:                        # already migrated
            new.append(e)
            continue
        m = ID_RE.match(e['id'])
        if not m:
            sys.exit(f'{path}: cannot parse id {e["id"]!r}')
        new.append({
            'gx': int(m.group(1)),
            'gz': int(m.group(2)),
            'bounds': e['bounds'],
            'cellEstimate': e.get('cellEstimate', 100),
        })
    with open(path, 'w') as f:
        json.dump(new, f, separators=(',', ':'))
    new_size = os.path.getsize(path)
    print(f'{path}: {len(new)} entries, {old_size/1024/1024:.1f} MB → {new_size/1024/1024:.2f} MB')

for p in PATHS:
    migrate(p)
