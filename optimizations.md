# Graffiti — Perf Optimization Tracker

Baseline (2026-04-19, on a "pretty good" computer): ~20% CPU, ~8% GPU while tiles load.

D = difficulty, R = risk, I = impact. Check the box when done.

## Tile-load CPU (the ~20% spike)

| # | Done | Change | D | R | I | Notes |
|---|---|---|---|---|---|---|
| 1 | [ ] | Pre-bake cell polygons + seeds in `build_tiles.py`; ship them in the tile file | M-H | M | H | Deletes phase-2 entirely — no Sutherland-Hodgman on client. Recommended fix from prior seeding-perf investigation. Adds disk size; offset by #2. |
| 2 | [ ] | Switch tile format JSON → binary (Float32Array positions/indices, versioned header) | L-M | L | H | Cuts `JSON.parse` (dominant main-thread cost on 300 KB tile), ~4× smaller than raw JSON (~2× vs. gzipped), zero-copy into geometry. |
| 3 | [ ] | Drop `TILE_LOAD_RADIUS` 400→300 m (and `UNLOAD` 550→400) | L | L | H | ~¾ the tiles (~32 → ~18). Linear win on everything loading-related. Risk: more visible pop-in when sprinting. |
| 4 | [ ] | Early-reject in `scanCells` Sutherland-Hodgman (exact tri-AABB vs. cell-AABB test before the 4 clips) | L | L | M | Most tri × cell pairs in the bbox don't actually overlap; currently paying 4 clip passes to find out. |
| 5 | [ ] | Cache edge keys inside `scanCells` so `buildCellGroups` reuses them | L | L | M | Straight reuse — same data, computed once. |
| 6 | [ ] | Skip `dedupOverlappingCells` when faces are well-separated (precheck normals + planeD) | L | L | M | Quadratic in worst case (cylinders). Most FiDi rectangles hit the fast path trivially. |
| 7 | [ ] | Run 2 worker instances; load 2 tiles in parallel | L | M | M | Halves wall-clock load latency; doubles peak mem during loads. Keep single-worker mode for low-mem hardware. |

## Steady-state CPU (idle render loop)

| # | Done | Change | D | R | I | Notes |
|---|---|---|---|---|---|---|
| 8 | [x] | Gate `updateDebugHud()` raycast behind `if (!debugHudOn) return;` at the top | L | L | L-M | Already done — [src/main.js:487](src/main.js#L487). No change needed. |
| 9 | [ ] | Cache paint-mesh visibility in `updateCulling`; invalidate only on rebuild | L | L | L | Iterates all `buildingPaintMeshByBuilding` on each cull today. |
| 10 | [ ] | Skip physics downward raycast when airborne-and-moving-up | L | L | L | Tiny, but every frame. |

## GPU (the ~8%)

| # | Done | Change | D | R | I | Notes |
|---|---|---|---|---|---|---|
| 11 | [ ] | Merge per-tile walls into one `BufferGeometry` (and roofs into one); keyed by `buildingId` via per-vertex attribute | M | M | H | Biggest GPU win. Draw calls from ~2 × buildings (~1600 inside CULL_RADIUS) → ~2 per tile (~16). Raycast works on merged mesh; paint targeting uses `buildingId` attribute. |
| 12 | [ ] | Merge paint overlays across buildings in a tile: one mesh per color per tile | M | M | M | Symmetric with #11 for paint layer. Draw calls scale with colors × tiles, not colors × buildings. |
| 15 | [ ] | Lower FOV 100→90 when not sprinting | L | L | L | Smaller frustum = fewer draw calls/frame. Cosmetic. |

## Other

| # | Done | Change | D | R | I | Notes |
|---|---|---|---|---|---|---|
| 16 | [ ] | Enable brotli on prod tile server | L | L | M | Covered by #2 if going binary; without #2, brotli on JSON is ~25% bandwidth win over gzip. |
| 17 | [ ] | `requestIdleCallback`-chunk `wrapMeshData` in `TileManager._doLoad` | M | L | L-M | Already on spec.md "Next Steps". Smooths main-thread hitch when big tile arrives; total work unchanged. |
| 18 | [x] | `THREE.Group` per tile so `group.visible=false` short-circuits scene traversal for off-range tiles | L | L | M-H | From todo.txt "still to try". Done 2026-04-19: TileManager wraps tile meshes in a Group; main.js `updateCulling` toggles group visibility per-tile and skips the inner mesh loop for out-of-range tiles. Targets the `WebGLRenderer.render ~40% self time` trace. Result: no noticeable change in observed CPU/GPU. |
| 19 | [x] | Option "A" from the middle-ground discussion: merge roof + wall into ONE mesh per building | M | L | M | Done 2026-04-19: tileWorker `buildMergedMeshData` concatenates per-building; faces tagged with `meshType`; `BUILDING_MAT` shared material; `mesh.userData.buildingKeys` drives map registration + unload; `cellDataByType` keyed by meshType for phase-2 seed data. Halves draw calls (walls+roofs go 2× → 1× per building). **Pending test — observed effect TBD.** |
| 20 | [x] | Cap render loop to 60 Hz on high-refresh monitors | L | L | L-M | Done 2026-04-19: `FRAME_INTERVAL = 1000/60 - 0.5` gate at the top of `animate()`. On a 144 Hz monitor this ~2.4× reduces render work. |
| 21 | [x] | triRanges: narrow `buildCellGeometry` to the correct meshType half of the merged mesh | L | L | M | Done 2026-04-19, fixes a regression from #19. Perf trace showed `buildCellGeometry` at 21.8% self-time entirely from the `seedTileCells → rebuildBuildingPaint` path, where server-saved paint from prior sessions has cellKeys the current worker doesn't emit → cache miss → full triangle-iteration clip. Option A's merge doubled per-call cost by iterating roof+wall combined. Fix: worker records `triRanges[meshType] = {start, count}` on each merged mesh; `buildCellGeometry(mesh, …, meshType)` iterates only the matching half. Result: `buildCellGeometry` self time dropped from 21.8% → 12.5%. |
| 22 | [x] | Nuke stale server paint in `data/paint/` | L | M | H | Done 2026-04-19. 874 files / 213 MB of graffiti from prior code versions had cellKeys the current worker no longer emits — that's why `buildCellGeometry` was a hotspot at all. After deletion: `buildCellGeometry` ~0%, `seedTileCells` total 28.6% → 7.7%, freeze-on-fast-movement gone. `WebGLRenderer.render` is now the dominant cost (49.7% self) which is the natural ceiling at this draw-call count. |

## Recommended order

#8 + #3 first (10 min, measurable) → #11 (biggest GPU lever) → #1 + #2 together as a "binary pre-baked tiles" sprint (biggest CPU lever) → #7 only if profiling still shows the worker as bottleneck.
