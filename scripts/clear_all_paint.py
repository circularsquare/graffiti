"""One-shot clear: delete every paint file in data/paint/.

Run once:  python scripts/clear_all_paint.py
"""

import os
import sys

HERE      = os.path.dirname(__file__)
PAINT_DIR = os.path.join(HERE, '..', 'data', 'paint')


def main():
    if not os.path.isdir(PAINT_DIR):
        print(f'No paint dir at {PAINT_DIR}, nothing to do.')
        return

    files = [f for f in os.listdir(PAINT_DIR) if f.endswith('.json')]
    if not files:
        print('Paint dir is already empty.')
        return

    print(f'Deleting {len(files)} paint file(s) …')
    for fname in sorted(files):
        os.remove(os.path.join(PAINT_DIR, fname))
        print(f'  deleted {fname}')

    print(f'\nDone. {len(files)} file(s) removed.')


if __name__ == '__main__':
    main()
