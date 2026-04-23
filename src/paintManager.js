// Paint system: per-cell color overlays on building + terrain meshes.
//
// createPaintManager() owns:
//   - The color palette and its DOM swatches
//   - The per-building merged paint meshes (buildingPaintMeshes etc.)
//   - The cell-geometry cache populated off-thread by tileWorker
//   - The cellGroups lookup (pre-baked paint-group membership)
//   - The stroke-based undo stack (mousedown→mouseup = one entry, up to 50)
//   - hitCell / tryPaint / tryErase
//   - Seeding (seedTileCells on building load, seedTerrainCells on terrain load)
//
// The shared Maps (cellGeomCache, buildingPaintMeshes, paintGroup, seedConfig,
// …) are exposed as `tileManagerBindings` / `terrainManagerBindings` so main.js
// can spread them into the manager constructors without naming each field.
//
// terrainManager / osmManager / getNearBuildingMeshes come in as getters
// because paint is created before those managers exist — main.js wires the
// construction order to resolve the cycle.

import * as THREE from 'three';
import { GRID_SIZE } from './loadCityGML.js';
import { BLOCK_SIZE } from './gridShader.js';
import { worldToGrid, gridToWorld } from './geo.js';
import { paintStore } from './paintStore.js';

// ─── Palette ──────────────────────────────────────────────────────────────────
//
// Based on sweet24 (by bess, lospec.com/palette-list/sweet24), with: shifted
// red, true orange replacing the mustard, added yellow + blue + indigo, dark
// brown/purple removed. 26 colors total, roughly hue-sorted: neutrals → pinks →
// red → oranges → yellow → browns → greens → blues → purple.
const COLORS = [
  { name: 'erase',       hex: null,       css: '#555',     isErase: true  },
  { name: 'black',       hex: 0x1d1b24,   css: '#1d1b24'                  },
  { name: 'dark gray',   hex: 0x46464d,   css: '#46464d'                  },
  { name: 'gray',        hex: 0x7a7576,   css: '#7a7576'                  },
  { name: 'cream',       hex: 0xcec7b1,   css: '#cec7b1'                  },
  { name: 'white',       hex: 0xedefe2,   css: '#edefe2'                  },
  { name: 'pink',        hex: 0xf594aa,   css: '#f594aa'                  },
  { name: 'red',         hex: 0xd6403a,   css: '#d6403a'                  },
  { name: 'salmon',      hex: 0xe68556,   css: '#e68556'                  },
  { name: 'orange',      hex: 0xd66c1c,   css: '#d66c1c'                  },
  { name: 'sand',        hex: 0xe1bf7d,   css: '#e1bf7d'                  },
  { name: 'brown',       hex: 0x936a4d,   css: '#936a4d'                  },
  { name: 'dark brown',  hex: 0x5e3b2f,   css: '#5e3b2f'                  },
  { name: 'gold',        hex: 0xe0a41c,   css: '#e0a41c'                  },
  { name: 'yellow',      hex: 0xf7d020,   css: '#f7d020'                  },
  { name: 'lime',        hex: 0xb9d850,   css: '#b9d850'                  },
  { name: 'bright green',hex: 0x5fc242,   css: '#5fc242'                  },
  { name: 'green',       hex: 0x66a650,   css: '#66a650'                  },
  { name: 'deep teal',   hex: 0x325c4e,   css: '#325c4e'                  },
  { name: 'aqua',        hex: 0x82dcd7,   css: '#82dcd7'                  },
  { name: 'turquoise',   hex: 0x22b4ac,   css: '#22b4ac'                  },
  { name: 'sky',         hex: 0x1c7aa0,   css: '#1c7aa0'                  },
  { name: 'navy',        hex: 0x2d4068,   css: '#2d4068'                  },
  { name: 'blue',        hex: 0x4269c0,   css: '#4269c0'                  },
  { name: 'indigo',      hex: 0x5946b9,   css: '#5946b9'                  },
  { name: 'lavender',    hex: 0xac90cc,   css: '#ac90cc'                  },
  { name: 'dark purple', hex: 0x5e2a6f,   css: '#5e2a6f'                  },
  { name: 'magenta',     hex: 0xa04070,   css: '#a04070'                  },
  { name: 'wine',        hex: 0x6d2047,   css: '#6d2047'                  },
];
const SEED_COLORS = COLORS.filter(c => !c.isErase);
const SEED_COLOR_HEX = SEED_COLORS.map(c => c.hex); // flat hex array forwarded to the tile worker

// ─── Constants ────────────────────────────────────────────────────────────────

const PAINT_DIST      = 15;                  // max reach in metres
const SMALL_CELL_AREA = GRID_SIZE ** 2 * 0.5; // 2.0 m² — matches tileWorker SLIVER_AREA, used only by the debug HUD's SLIVER label
const SEED_FRACTION   = 0;                   // fraction of cells to randomly seed on load (applied in tileWorker.js)

// ─── Plain-array geometry helpers ─────────────────────────────────────────────

function cross3(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function dot3(a, b)  { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function sub3(a, b)  { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function lerp3(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]), a[2]+t*(b[2]-a[2])]; }
function lerp2(a, b, t) { return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])]; }
function norm3(v)    { const l = Math.sqrt(dot3(v,v)); return l ? [v[0]/l,v[1]/l,v[2]/l] : v; }

function geomArea(verts) {
  let area = 0;
  for (let i = 0; i < verts.length; i += 9) {
    const ex = verts[i+3]-verts[i],   ey = verts[i+4]-verts[i+1], ez = verts[i+5]-verts[i+2];
    const fx = verts[i+6]-verts[i],   fy = verts[i+7]-verts[i+1], fz = verts[i+8]-verts[i+2];
    area += 0.5 * Math.sqrt((ey*fz-ez*fy)**2 + (ez*fx-ex*fz)**2 + (ex*fy-ey*fx)**2);
  }
  return area;
}

// Sutherland-Hodgman clip against one half-plane in UV space.
// axisIdx: 0=U, 1=V  sign: +1 → keep where axis>=value, -1 → keep where axis<=value
function clipHalfPlane(poly, axisIdx, value, sign) {
  if (!poly.length) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i], next = poly[(i + 1) % poly.length];
    const cv = curr.uv[axisIdx], nv = next.uv[axisIdx];
    const cIn = sign > 0 ? cv >= value : cv <= value;
    const nIn = sign > 0 ? nv >= value : nv <= value;
    if (cIn) out.push(curr);
    if (cIn !== nIn) {
      const t = (value - cv) / (nv - cv);
      out.push({ pos: lerp3(curr.pos, next.pos, t), uv: lerp2(curr.uv, next.uv, t) });
    }
  }
  return out;
}

/**
 * Clip srcMesh geometry to the UV cell [cellU, cellU+1] × [cellV, cellV+1].
 * Two filters reject triangles from unrelated faces:
 *   1. Normal direction — dot product with cellNormal must be > 0.7 (rejects perpendicular/opposite walls)
 *   2. Depth — triangle centroid must be within COPLANAR_TOL of the hit plane dot(p, n) = planeD
 *      (rejects parallel faces that are set back, e.g. ledges/steps behind the clicked surface)
 * Returns flat vertex array (x,y,z triples), offset 5 cm along cellNormal.
 */
function buildCellGeometry(srcMesh, cellU, cellV, cellNormal, planeD, meshType, cameraPos) {
  const pos = srcMesh.geometry.attributes.position.array;
  const uv  = srcMesh.geometry.attributes.uv.array;
  const verts = [];
  const OFFSET        = 0.012;
  const COPLANAR_TOL  = 0.15; // 15 cm — rejects steps/ledges, accepts tessellation seams
  const cn = [cellNormal.x, cellNormal.y, cellNormal.z];

  // Always offset toward the player regardless of face winding. Convert camera
  // to mesh local space (tiles are translation-only, so this is just a shift),
  // then check which side of the face plane it's on.
  const camLocal = cameraPos.clone();
  srcMesh.worldToLocal(camLocal);
  const offsetSign = (dot3([camLocal.x, camLocal.y, camLocal.z], cn) - planeD) >= 0 ? 1 : -1;

  // When meshType is known, iterate only that half of the merged mesh (roof
  // tris vs wall tris live in contiguous ranges — see tileWorker
  // buildMergedMeshData). Cuts per-call cost roughly in half since the other
  // half is always rejected by the normal-dot filter anyway.
  const ranges = srcMesh.userData.triRanges;
  const range  = (meshType && ranges && ranges[meshType]) ? ranges[meshType] : null;
  const tiStart = range ? range.start : 0;
  const tiEnd   = range ? range.start + range.count : (pos.length / 9) | 0;

  for (let ti = tiStart; ti < tiEnd; ti++) {
    const pi = ti * 9, ui = ti * 6;

    const tri = [
      { pos: [pos[pi],   pos[pi+1], pos[pi+2]], uv: [uv[ui],   uv[ui+1]] },
      { pos: [pos[pi+3], pos[pi+4], pos[pi+5]], uv: [uv[ui+2], uv[ui+3]] },
      { pos: [pos[pi+6], pos[pi+7], pos[pi+8]], uv: [uv[ui+4], uv[ui+5]] },
    ];

    // Quick UV bounding-box reject
    const us = [tri[0].uv[0], tri[1].uv[0], tri[2].uv[0]];
    const vs = [tri[0].uv[1], tri[1].uv[1], tri[2].uv[1]];
    if (Math.max(...us) < cellU || Math.min(...us) > cellU + 1) continue;
    if (Math.max(...vs) < cellV || Math.min(...vs) > cellV + 1) continue;

    // Reject triangles whose normal doesn't match the clicked face
    const triNorm = norm3(cross3(sub3(tri[1].pos, tri[0].pos), sub3(tri[2].pos, tri[0].pos)));
    if (dot3(triNorm, cn) < 0.7) continue;

    // Reject triangles set back from the clicked surface (parallel faces at different depth)
    const cx = (tri[0].pos[0] + tri[1].pos[0] + tri[2].pos[0]) / 3;
    const cy = (tri[0].pos[1] + tri[1].pos[1] + tri[2].pos[1]) / 3;
    const cz = (tri[0].pos[2] + tri[1].pos[2] + tri[2].pos[2]) / 3;
    if (Math.abs(cx*cn[0] + cy*cn[1] + cz*cn[2] - planeD) > COPLANAR_TOL) continue;

    // Clip polygon to cell bounds
    let poly = tri;
    poly = clipHalfPlane(poly, 0, cellU,     +1);
    poly = clipHalfPlane(poly, 0, cellU + 1, -1);
    poly = clipHalfPlane(poly, 1, cellV,     +1);
    poly = clipHalfPlane(poly, 1, cellV + 1, -1);
    if (poly.length < 3) continue;

    // Fan-triangulate and offset toward the player (offsetSign accounts for winding)
    for (let k = 1; k < poly.length - 1; k++) {
      for (const v of [poly[0], poly[k], poly[k+1]]) {
        verts.push(
          v.pos[0] + cn[0]*OFFSET*offsetSign,
          v.pos[1] + cn[1]*OFFSET*offsetSign,
          v.pos[2] + cn[2]*OFFSET*offsetSign,
        );
      }
    }
  }
  return verts;
}

// Terrain paint cells are simple block faces — no clipping, no cellGeomCache.
// Each face's 6 vertices (2 tris) already exist in the terrain mesh's
// position buffer; the worker emits quads in a known order and TerrainManager
// precomputes a (meshType, ix, iz) → first-vertex-index lookup at tile load.
// We just copy the 18 floats out and offset by the face normal × OFFSET.
// Empty Float32Array if the face isn't emitted on this block (e.g. a cliff
// side pointing at a taller neighbour), which lets the rebuild loop skip it.
function buildTerrainCellGeometry(state, meshType, ix, iz, iy) {
  if (!state || !state.faceStarts) return new Float32Array(0);
  const faceIdx = state.faceStarts[meshType];
  if (!faceIdx) return new Float32Array(0);
  const vi = faceIdx[iz * state.res + ix];
  if (vi < 0) return new Float32Array(0);

  const OFFSET = 0.012;
  const pos = state.mesh.geometry.attributes.position.array;
  const nrm = state.mesh.geometry.attributes.normal.array;
  const nx = nrm[vi * 3], ny = nrm[vi * 3 + 1], nz = nrm[vi * 3 + 2];
  const ox = nx * OFFSET, oy = ny * OFFSET, oz = nz * OFFSET;
  const base = vi * 3;

  // Top face: single cell per (ix, iz), copy the 2-tri quad as-is.
  if (meshType === 'top') {
    const out = new Float32Array(18);
    for (let k = 0; k < 6; k++) {
      out[k * 3    ] = pos[base + k * 3    ] + ox;
      out[k * 3 + 1] = pos[base + k * 3 + 1] + oy;
      out[k * 3 + 2] = pos[base + k * 3 + 2] + oz;
    }
    return out;
  }

  // Side face: clip the quad to the Y band [iy*BLOCK_SIZE, (iy+1)*BLOCK_SIZE]
  // so paint matches the visible grid cell the user clicked. The worker emits
  // each side as 2 tris (p0,p1,p2 / p0,p2,p3) with p0 at vert 0, p1 at 1,
  // p2 at 2, p3 at 5 — see terrainWorker.js::emitQuad. Winding differs per
  // face (west is top,bot,bot,top; east/N/S are top,top,bot,bot) — both are
  // valid convex perimeters, which is all Sutherland–Hodgman needs.
  const p0 = [pos[base +  0], pos[base +  1], pos[base +  2]];
  const p1 = [pos[base +  3], pos[base +  4], pos[base +  5]];
  const p2 = [pos[base +  6], pos[base +  7], pos[base +  8]];
  const p3 = [pos[base + 15], pos[base + 16], pos[base + 17]];
  const poly = [p0, p1, p2, p3];

  const yLo = iy * BLOCK_SIZE;
  const yHi = yLo + BLOCK_SIZE;

  // Sutherland–Hodgman clip of a convex polygon against one half-plane on
  // the Y axis. keepBelow=true keeps points with y <= threshold.
  function clipY(inPoly, threshold, keepBelow) {
    const out = [];
    const n = inPoly.length;
    if (n === 0) return out;
    for (let i = 0; i < n; i++) {
      const curr = inPoly[i];
      const prev = inPoly[(i - 1 + n) % n];
      const currIn = keepBelow ? curr[1] <= threshold : curr[1] >= threshold;
      const prevIn = keepBelow ? prev[1] <= threshold : prev[1] >= threshold;
      if (currIn !== prevIn) {
        const t = (threshold - prev[1]) / (curr[1] - prev[1]);
        out.push([
          prev[0] + (curr[0] - prev[0]) * t,
          threshold,
          prev[2] + (curr[2] - prev[2]) * t,
        ]);
      }
      if (currIn) out.push(curr);
    }
    return out;
  }

  const clipped = clipY(clipY(poly, yHi, true), yLo, false);
  if (clipped.length < 3) return new Float32Array(0);

  // Triangulate as a fan from vertex 0. Output is (n-2) triangles = (n-2)*9
  // floats. For a quad sliced by 2 horizontal planes, n ≤ 6.
  const triCount = clipped.length - 2;
  const out = new Float32Array(triCount * 9);
  let o = 0;
  const writeVert = (p) => {
    out[o++] = p[0] + ox;
    out[o++] = p[1] + oy;
    out[o++] = p[2] + oz;
  };
  for (let i = 1; i <= triCount; i++) {
    writeVert(clipped[0]);
    writeVert(clipped[i]);
    writeVert(clipped[i + 1]);
  }
  return out;
}

// Parse `terrain_{gx}_{gz}:{meshType}` → { gx, gz } (or null if not terrain).
// Robust to negative coordinates (e.g. terrain_-3_-32:top).
function _parseTerrainBuildingKey(buildingKey) {
  const m = /^terrain_(-?\d+)_(-?\d+):/.exec(buildingKey);
  return m ? { gx: +m[1], gz: +m[2] } : null;
}

// Face-centroid segment of a cellKey. Must match tileWorker.centroidKey().
// Distinguishes laterally-separated faces on the same building that share a
// normal direction and fall in the same 50 cm pdKey bucket.
function centroidKeyStr(centroid) {
  return `${Math.round(centroid[0] * 100)}_${Math.round(centroid[1] * 100)}_${Math.round(centroid[2] * 100)}`;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPaintManager({
  scene,
  camera,
  controls,
  crosshairEl,
  colorbarEl,
  overlayEl,
  getTerrainManager,     // () => terrainManager (deferred — paint is created before managers)
  getOsmManager,         // () => osmManager
  getNearBuildingMeshes, // () => nearBuildingMeshes (refreshed by updateCulling)
  buildingMeshMap,       // shared Map populated by TileManager
  shiftBuildingsY,       // flat-mode flag forwarded to seedConfig
}) {
  // ─── Shared state maps ─────────────────────────────────────────────────────
  //
  // These are owned by paint but also referenced by TileManager / TerrainManager
  // (via the *ManagerBindings exports below) and by main's updateCulling /
  // debug HUD. Every consumer holds the same reference — do not reassign.

  // cellKey → Float32Array of pre-offset vertex triples. Populated by the
  // worker's seed scan (seedTileCells) and lazily by rebuildBuildingPaint for
  // user-painted cells. Rebuilds just concatenate cached arrays — no triangle
  // scan needed after initial load, so paint/erase is instant.
  const cellGeomCache      = new Map();
  const cellGeomByBuilding = new Map(); // buildingKey → Set<cellKey> — so unloads don't scan the whole cache

  // Paint groups — pre-baked in tileWorker.buildCellGroups. Every member of a
  // group maps to the SAME shared Set instance, so `.get(k)` is O(1) and
  // reference-identical across members (tryPaint/tryErase just iterate the set).
  const cellGroups             = new Map(); // cellKey → Set<cellKey>
  const cellGroupKeysByBuilding = new Map(); // buildingKey → Set<cellKey> — for O(building) unload cleanup

  const buildingPaintMeshes         = new Map(); // "buildingId:meshType" → mesh
  const buildingPaintMeshByBuilding = new Map(); // "buildingId:meshType" → Set<mesh>

  // Shared material for all paint overlays — vertex colors carry the hue so we
  // never need per-mesh material instances. NEVER call .dispose() on this.
  const PAINT_MAT = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -24,
  });
  const _paintColor = new THREE.Color(); // scratch — reused per cell to avoid allocation

  const paintGroup = new THREE.Group();
  scene.add(paintGroup);

  const pendingRebuild = new Set();   // buildingKeys awaiting rebuild

  const paintRay      = new THREE.Raycaster();
  const _seedWaterRay = new THREE.Raycaster();
  _seedWaterRay.ray.direction.set(0, -1, 0);

  // ─── Color state ────────────────────────────────────────────────────────────
  let activeColorIdx = 5; // start on white
  let colorPickMode  = false;

  const swatchEls = COLORS.map((c, i) => {
    const el = document.createElement('div');
    el.className = 'color-swatch' + (i === activeColorIdx ? ' active' : '');
    el.title = c.name;
    el.style.background = c.css;
    if (c.isErase) {
      el.textContent = '✕';
      el.classList.add('erase'); // spans both columns in the 2-col grid
    }
    el.addEventListener('click', () => {
      setActiveColor(i);
      colorPickMode = false;
      controls.lock();
    });
    colorbarEl.appendChild(el);
    return el;
  });

  function setActiveColor(i) {
    swatchEls[activeColorIdx].classList.remove('active');
    activeColorIdx = i;
    swatchEls[activeColorIdx].classList.add('active');
    crosshairEl.style.background = COLORS[i].css;
  }
  setActiveColor(activeColorIdx); // sync crosshair to initial color

  function cycleActiveColor(backward = false) {
    const delta = backward ? -1 : 1;
    setActiveColor((activeColorIdx + delta + COLORS.length) % COLORS.length);
  }

  function pickColorFromAim() {
    const h = hitCell();
    if (!h) return;
    const cellData = paintStore.cells.get(h.cellKey);
    if (cellData?.color == null) return;
    const idx = COLORS.findIndex(c => c.hex === cellData.color);
    if (idx >= 0) setActiveColor(idx);
  }

  function openColorPicker() {
    colorPickMode = true;
    controls.unlock();
  }

  function closeColorPicker() {
    colorPickMode = false;
  }

  // ─── Undo ───────────────────────────────────────────────────────────────────
  //
  // Stroke-based undo: one mousedown→mouseup = one undo entry, so a drag that
  // paints 30 cells reverts in one Ctrl+Z. Each entry is a cellKey → prev-state
  // map (null = cell was absent). beginStroke/endStroke wrap a stroke;
  // recordPreState accumulates pre-state only the first time a key is touched,
  // preserving the true pre-stroke state when a drag revisits cells.
  const UNDO_LIMIT = 50;
  const undoStack = [];
  const redoStack = []; // cleared on any new stroke; populated by applyUndo
  let currentStroke = null;

  function snapshotCells(primaryKey) {
    const snap = new Map();
    const add = k => snap.set(k, paintStore.cells.get(k) ?? null);
    add(primaryKey);
    const group = cellGroups.get(primaryKey);
    if (group && group.size > 1) for (const k of group) add(k);
    return snap;
  }

  function beginStroke() {
    if (!currentStroke) currentStroke = new Map();
  }

  function endStroke() {
    if (currentStroke && currentStroke.size > 0) {
      undoStack.push(currentStroke);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0; // new stroke invalidates any outstanding redo branch
    }
    currentStroke = null;
  }

  function recordPreState(primaryKey) {
    // If called outside a stroke (defensive), commit as a standalone 1-cell action.
    const standalone = !currentStroke;
    const target = currentStroke ?? new Map();
    const snap = snapshotCells(primaryKey);
    for (const [k, v] of snap) if (!target.has(k)) target.set(k, v);
    if (standalone && target.size > 0) {
      undoStack.push(target);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }
  }

  // Flip a snapshot: apply `snap` (k → newState), return a map of k → previous
  // state so the inverse operation can restore it. Shared by undo + redo.
  function flipSnapshot(snap) {
    const inverse = new Map();
    for (const [k, next] of snap) {
      inverse.set(k, paintStore.cells.get(k) ?? null);
      if (next === null) paintStore.erase(k);
      else paintStore.paint(k, next);
    }
    return inverse;
  }

  function applyUndo() {
    endStroke(); // commit any in-progress stroke first
    const last = undoStack.pop();
    if (!last) return;
    const forward = flipSnapshot(last);
    redoStack.push(forward);
    if (redoStack.length > UNDO_LIMIT) redoStack.shift();
  }

  function applyRedo() {
    endStroke();
    const fwd = redoStack.pop();
    if (!fwd) return;
    const back = flipSnapshot(fwd);
    undoStack.push(back);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  // ─── Rebuild scheduling ─────────────────────────────────────────────────────

  function schedulePaintRebuild(buildingKey) {
    if (pendingRebuild.size === 0) requestAnimationFrame(flushPaintRebuilds);
    pendingRebuild.add(buildingKey);
  }

  function flushPaintRebuilds() {
    const t = performance.now();
    for (const bk of pendingRebuild) {
      const srcMesh = buildingMeshMap.get(bk);
      if (srcMesh) rebuildBuildingPaint(srcMesh, bk);
    }
    pendingRebuild.clear();
    performance.measure('paint:rebuild', { start: t, end: performance.now() });
  }

  // ─── Per-building merged paint mesh ─────────────────────────────────────────
  function rebuildBuildingPaint(srcMesh, buildingKey) {
    // buildingKey comes from the caller (either flushPaintRebuilds or
    // seedTileCells) because one merged srcMesh covers both roof + wall. The
    // paint system still keys paint meshes + cellGeomCache by buildingKey, so
    // each meshType rebuilds independently.
    const prefix = buildingKey + ':';
    // Extract meshType (part after the building id) so buildCellGeometry on a
    // cache miss iterates only the matching half of the merged mesh.
    const colonIdx = buildingKey.indexOf(':');
    const meshType = colonIdx >= 0 ? buildingKey.slice(colonIdx + 1) : null;

    // Remove the existing paint mesh for this building (at most one now).
    const existing = buildingPaintMeshes.get(buildingKey);
    if (existing) {
      existing.geometry.dispose(); // material is shared — never dispose it
      paintGroup.remove(existing);
      buildingPaintMeshes.delete(buildingKey);
    }
    buildingPaintMeshByBuilding.delete(buildingKey);

    // Collect cell geometry references + per-cell RGB in parallel arrays, summing
    // the total float count as we go so the merged position/color buffers can
    // be allocated once and filled directly. Avoids the old pattern of
    // allocating a Float32Array per cell for color then copying it again into
    // the merged buffer — hot path when a building has many painted cells.
    const posArrays    = []; // Float32Array[] of XYZ triples (reused from cache)
    const colorTriples = []; // flat [r, g, b, r, g, b, ...] — one triple per posArrays entry
    let totalFloats = 0;

    // Terrain cells bypass cellGeomCache: their geometry is trivially derivable
    // from the terrain mesh's position buffer + a (meshType, ix, iz)-indexed
    // face lookup maintained on the tile state. Caching 20k × simple quads per
    // tile would waste ~100 MB at steady state for zero compute gain.
    const terrainCoords = _parseTerrainBuildingKey(buildingKey);
    const terrainManager = getTerrainManager();
    const terrainState  = terrainCoords
      ? terrainManager.getState(terrainCoords.gx, terrainCoords.gz)
      : null;
    if (terrainCoords && !terrainState) return; // tile unloaded between paint and rebuild

    for (const k of paintStore.cellsForBuilding(buildingKey)) {
      const v = paintStore.cells.get(k);
      if (!v) continue;

      let arr;
      if (terrainState) {
        const parts = k.slice(prefix.length).split(':');
        const ix = parseInt(parts[0]), iz = parseInt(parts[1]);
        const iy = parseInt(parts[2]);
        arr = buildTerrainCellGeometry(terrainState, meshType, ix, iz, iy);
      } else {
        if (!cellGeomCache.has(k)) {
          const parts = k.slice(prefix.length).split(':');
          const cu = parseInt(parts[0]), cv = parseInt(parts[1]);
          const verts = buildCellGeometry(srcMesh, cu, cv, new THREE.Vector3(...v.normal), v.planeD, meshType, camera.position);
          cellGeomCache.set(k, new Float32Array(verts));
          let geomSet = cellGeomByBuilding.get(buildingKey);
          if (!geomSet) { geomSet = new Set(); cellGeomByBuilding.set(buildingKey, geomSet); }
          geomSet.add(k);
        }
        arr = cellGeomCache.get(k);
      }
      if (!arr || !arr.length) continue;

      posArrays.push(arr);
      // setHex applies sRGB→linear conversion to match THREE.MeshBasicMaterial({ color }).
      _paintColor.setHex(v.color);
      colorTriples.push(_paintColor.r, _paintColor.g, _paintColor.b);
      totalFloats += arr.length;
    }

    if (!totalFloats) return;

    const allPos   = new Float32Array(totalFloats);
    const allColor = new Float32Array(totalFloats); // parallel — 3 floats/vert, matches allPos
    let off = 0;
    for (let i = 0; i < posArrays.length; i++) {
      const a = posArrays[i];
      allPos.set(a, off);
      const r = colorTriples[i * 3], g = colorTriples[i * 3 + 1], b = colorTriples[i * 3 + 2];
      const vCnt = a.length / 3;
      for (let j = 0; j < vCnt; j++) {
        allColor[off + j * 3    ] = r;
        allColor[off + j * 3 + 1] = g;
        allColor[off + j * 3 + 2] = b;
      }
      off += a.length;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(allColor, 3));
    // polygonOffset beats any OSM layer's (-1/-6) so paint wins the depth test vs draped OSM at grazing angles.
    const mesh = new THREE.Mesh(geo, PAINT_MAT);
    mesh.visible = srcMesh.visible;
    mesh.userData.paintMeshKey = buildingKey; // stashed so TileManager._unload can delete by lookup
    paintGroup.add(mesh);
    buildingPaintMeshes.set(buildingKey, mesh);
    buildingPaintMeshByBuilding.set(buildingKey, new Set([mesh]));
  }

  // When any cell changes, schedule a rebuild for its building (debounced to one per frame).
  paintStore.subscribe((cellKey) => {
    // Buildings: drop pdKey, centroidKey, cellV, cellU (4 trailing segments)
    // Terrain:   drop iy, iz, ix                        (3 trailing segments)
    const parts = cellKey.split(':');
    const trailing = cellKey.startsWith('terrain_') ? 3 : 4;
    for (let i = 0; i < trailing; i++) parts.pop();
    schedulePaintRebuild(parts.join(':'));
  });

  // The pull loop fires this instead once per building touched, so a reconcile
  // that changes 200 cells still triggers one rebuild per building per frame.
  paintStore.subscribeBuildings((buildingKey) => {
    schedulePaintRebuild(buildingKey);
  });

  // ─── Seeding ────────────────────────────────────────────────────────────────
  //
  // Apply the worker's pre-computed cell data to paint caches. The triangle scan
  // + clipping + seed dice roll all happened off-thread; this pass just copies
  // Float32Arrays into cellGeomCache and calls paintStore.seed for cells that
  // aren't already user-painted. Still chunked so a giant tile doesn't push
  // rebuildBuildingPaint calls into one frame.
  async function seedTileCells(meshes) {
    // Yield when accumulated work crosses the frame budget rather than at a
    // fixed mesh count. A dense tile with a few chunky buildings was spiking
    // past budget inside one chunk; a sparse tile wasted frames yielding
    // every 50 meshes. Time-based yielding handles both.
    const BUDGET_MS = 8;
    const now       = Date.now();
    const tSeed     = performance.now();

    // Tile is "seed-locked" only after every mesh has been processed without
    // being abandoned mid-way (see abandoned flag below). Resolved lazily from
    // the first mesh we touch since seedTileCells takes meshes, not a tileId.
    let tileId      = null;
    let abandoned   = false;
    let tChunkStart = performance.now();

    for (let mi = 0; mi < meshes.length; mi++) {
      const srcMesh = meshes[mi];
      if (!srcMesh.parent) { abandoned = true; continue; } // tile unloaded before we got here

      const perType = srcMesh.userData.cellDataByType;
      if (perType) {
        const { buildingId } = srcMesh.userData;

        // Iterate each meshType's CellBundle independently — cellKeys, seeds,
        // and paint-mesh keys are all scoped to (building, meshType).
        for (const meshType in perType) {
          const cellData = perType[meshType];
          const bk = `${buildingId}:${meshType}`;
          if (!tileId) tileId = paintStore.tileIdOfBuilding(bk);

          let geomSet = cellGeomByBuilding.get(bk);
          if (!geomSet) { geomSet = new Set(); cellGeomByBuilding.set(bk, geomSet); }

          const { cellKeys, cellGeoms, seeds, cellGroups: groups } = cellData;
          for (let i = 0; i < cellKeys.length; i++) {
            cellGeomCache.set(cellKeys[i], cellGeoms[i]);
            geomSet.add(cellKeys[i]);
          }

          // Paint groups — every member of a group points at the same Set instance.
          if (groups && groups.length) {
            let groupKeySet = cellGroupKeysByBuilding.get(bk);
            if (!groupKeySet) { groupKeySet = new Set(); cellGroupKeysByBuilding.set(bk, groupKeySet); }
            for (const members of groups) {
              const shared = new Set(members);
              for (const k of members) {
                cellGroups.set(k, shared);
                groupKeySet.add(k);
              }
            }
          }

          // Skip seed rolls once the tile is marked complete on disk — the
          // pattern is locked in and further rolls would grow coverage past
          // the intended ~10%. Partial tiles (never reached the sentinel) stay
          // unlocked and get another shot on every reload.
          const tileLocked = tileId && paintStore.isTileSeedComplete(tileId);

          if (!tileLocked) {
            for (const s of seeds) {
              const cellKey = cellKeys[s.idx];
              if (paintStore.cells.has(cellKey)) continue; // preserve existing (user or prior-session seed)
              paintStore.seed(cellKey, {
                color:     s.color,
                normal:    s.normal,
                planeD:    s.planeD,
                paintedAt: now,
              });
            }
          }

          rebuildBuildingPaint(srcMesh, bk);
        }

        // Free the bundle — its Float32Arrays now live in cellGeomCache.
        srcMesh.userData.cellDataByType = null;
      }

      // rAF instead of requestIdleCallback: idle time can starve to zero under
      // continuous movement, which was the original "bottom third seeded, rest
      // empty" symptom. rAF fires every frame so seeding makes steady progress.
      if (mi + 1 < meshes.length && performance.now() - tChunkStart > BUDGET_MS) {
        await new Promise(r => requestAnimationFrame(r));
        tChunkStart = performance.now();
      }
    }

    // Only mark the tile seed-complete if we made it through every mesh without
    // abandonment. If any mesh was skipped because its parent was gone, the tile
    // stays unlocked and the next load gets another shot.
    if (tileId && !abandoned) paintStore.markTileSeedComplete(tileId);

    performance.measure('tile:seed', { start: tSeed, end: performance.now() });
  }

  // Seed ~SEED_FRACTION of terrain top-face cells per tile, gated by the same
  // persistent seed-complete sentinel as buildings. Sides are stacked in iy
  // bands we'd need the block's Y range to sample correctly; top faces exist
  // on every block and give uniform coverage, so this is top-only.
  //
  // Runs synchronously — one tile is ~4096 top faces, which is fast enough
  // that the tile can't unload mid-seed (unload only happens on tick()).
  // Caller (onTerrainLoaded) invokes this before its rebuild pass so a single
  // rebuildBuildingPaint call covers server-persisted cells and fresh seeds
  // together.
  function seedTerrainCells(state) {
    if (!state.faceStarts) return;
    if (paintStore.isTileSeedComplete(state.tileId)) return;

    // Skip cells over OSM water. If the covering OSM tile isn't loaded+draped
    // yet we bail without marking the tile complete — the next terrain reload
    // will retry once OSM has caught up. An empty array means "no water here",
    // the fast path for inland tiles.
    const waterMeshes = getOsmManager().waterMeshesForCell(state.gx, state.gz);
    if (waterMeshes === null) return;

    const meshType = 'top';
    const faceIdx  = state.faceStarts[meshType];
    if (!faceIdx) { paintStore.markTileSeedComplete(state.tileId); return; }

    const bk  = `${state.tileId}:${meshType}`;
    const res = state.res;
    const now = Date.now();
    const b   = state.bounds;
    const step = (b.maxX - b.minX) / res;

    if (SEED_FRACTION === 0) { paintStore.markTileSeedComplete(state.tileId); return; }

    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        if (faceIdx[iz * res + ix] < 0) continue;
        if (Math.random() >= SEED_FRACTION) continue;
        const cellKey = `${bk}:${ix}:${iz}:0`;
        if (paintStore.cells.has(cellKey)) continue; // preserve user paint / prior seed

        if (waterMeshes.length) {
          const [wx, wz] = gridToWorld(b.minX + (ix + 0.5) * step, b.minZ + (iz + 0.5) * step);
          _seedWaterRay.ray.origin.set(wx, 10000, wz);
          if (_seedWaterRay.intersectObjects(waterMeshes, false).length) continue;
        }

        const color = SEED_COLOR_HEX[(Math.random() * SEED_COLOR_HEX.length) | 0];
        paintStore.seed(cellKey, {
          color,
          normal:    [0, 1, 0],
          planeD:    0,
          paintedAt: now,
        });
      }
    }

    paintStore.markTileSeedComplete(state.tileId);
  }

  // ─── Hit test / paint / erase ───────────────────────────────────────────────

  /**
   * Given a tentative cellKey built from a raycast hit's face planeD, return
   * the canonical cellKey in cellGeomCache for the same visual cell. The worker
   * dedupes overlapping cells by merging them under one anchor face's pdKey —
   * but a raycast that hits a different face would compute a different pdKey,
   * so we scan this building's cells for the same (cu, cv, centroidKey) and
   * pick the nearest pdKey (within 1 bucket = 50 cm of planeD). The centroidKey
   * match keeps the fallback from crossing onto a different face that happens
   * to share (cu, cv) via its own UV origin.
   */
  function canonicalCellKey(buildingKey, cu, cv, ck, pdKey) {
    const tentative = `${buildingKey}:${cu}:${cv}:${ck}:${pdKey}`;
    if (cellGeomCache.has(tentative)) return tentative;
    const geomSet = cellGeomByBuilding.get(buildingKey);
    if (!geomSet) return tentative;
    const targetPrefix = `${buildingKey}:${cu}:${cv}:${ck}:`;
    let bestKey = null, bestDist = Infinity;
    for (const k of geomSet) {
      if (!k.startsWith(targetPrefix)) continue;
      const kpd = parseInt(k.slice(targetPrefix.length));
      const d = Math.abs(kpd - pdKey);
      if (d < bestDist) { bestDist = d; bestKey = k; }
    }
    return bestKey && bestDist <= 1 ? bestKey : tentative;
  }

  function hitCell() {
    paintRay.setFromCamera(new THREE.Vector2(0, 0), camera);
    const terrainManager = getTerrainManager();
    const osmManager     = getOsmManager();
    // Terrain meshes are always raycast targets alongside the building near-set.
    // Distance filter below handles PAINT_DIST; terrain hits pass through the
    // terrain branch further down. OSM water meshes are included so we can
    // reject aim points over water — water sits ~2.4 mm above terrain so the
    // first hit is always water wherever water exists.
    const hits = paintRay.intersectObjects(
      [...getNearBuildingMeshes(), ...terrainManager.meshes(), ...osmManager.waterMeshes()], false,
    );
    if (!hits.length || hits[0].distance > PAINT_DIST) return null;
    const hit  = hits[0];
    const mesh = hit.object;
    if (mesh.userData.isWater) return null;

    // Terrain branch — one block face per cell, no UVs, no planeDKey. The tile's
    // buildingKeys cover all 5 face types; we pick the one matching the hit
    // normal and index by (ix, iz) within the tile. The cellKey is already
    // canonical (the tile owns exactly one cell per face per block).
    if (mesh.name === 'terrain') {
      const ud = mesh.userData;
      const b  = ud.bounds;
      if (!b) return null;
      const state = terrainManager.getState(ud.terrainGX, ud.terrainGZ);
      if (!state) return null;
      // Terrain cells live in grid space; the raycast hit is in world space and
      // `b` is the cell's grid-space AABB. Rotate the hit point into grid space
      // and classify the side-face normal against grid-cardinal axes.
      const step = (b.maxX - b.minX) / state.res;
      const [hu, hv] = worldToGrid(hit.point.x, hit.point.z);

      const tNormal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
      const [gnx, gnz] = worldToGrid(tNormal.x, tNormal.z);
      let tMeshType;
      if      (tNormal.y >  0.5) tMeshType = 'top';
      else if (gnx < -0.5) tMeshType = 'sideW';
      else if (gnx >  0.5) tMeshType = 'sideE';
      else if (gnz < -0.5) tMeshType = 'sideN';
      else                 tMeshType = 'sideS';

      // Side-face quads sit exactly on cell boundaries in grid space (west at
      // x = ix·step, east at x = (ix+1)·step, etc.). Flooring the raw hit point
      // is ambiguous at that boundary — for sideE/sideS it deterministically
      // lands one cell past the owning block, and for sideW/sideN float ε can
      // flip either way. Nudge the probe inward (along the inward face normal)
      // so we always classify into the block that actually owns the face.
      let probeU = hu, probeV = hv;
      const nudge = step * 0.5;
      if      (tMeshType === 'sideW') probeU += nudge;
      else if (tMeshType === 'sideE') probeU -= nudge;
      else if (tMeshType === 'sideN') probeV += nudge;
      else if (tMeshType === 'sideS') probeV -= nudge;

      let ix = Math.floor((probeU - b.minX) / step);
      let iz = Math.floor((probeV - b.minZ) / step);
      if (ix < 0) ix = 0; else if (ix >= state.res) ix = state.res - 1;
      if (iz < 0) iz = 0; else if (iz >= state.res) iz = state.res - 1;

      // Cliff sides split into vertical strips aligned with the Y grid lines
      // drawn by gridShader, so one paint cell corresponds to one visible grid
      // square. Top faces stay single-cell (iy = 0) — their grid is already
      // supplied by (ix, iz) on the horizontal.
      const iy = tMeshType === 'top'
        ? 0
        : Math.floor(hit.point.y / BLOCK_SIZE);

      const tBuildingKey = `${ud.terrainTileId}:${tMeshType}`;
      const tCellKey = `${tBuildingKey}:${ix}:${iz}:${iy}`;
      return {
        cellU: ix, cellV: iz,
        normal: tNormal,
        planeD: 0,
        mesh,
        cellKey: tCellKey,
      };
    }

    // Buildings require UVs — reject if the raycast landed on a degenerate tri
    // that didn't produce UV coords.
    if (!hit.uv) return null;

    // Prefer the face's averaged normal + planeD when available. The worker's
    // seed cache generates cellKeys from face.planeD; using per-triangle planeD
    // here would round into a different 50 cm bucket for any triangle whose
    // normal drifted slightly from the face average. Worker dedupe then anchors
    // the cell on one face's pdKey; canonicalCellKey below redirects any
    // neighboring pdKey onto that anchor.
    let normal, planeD, ck;
    const faces   = mesh.userData.faces;
    const triFace = mesh.userData.triFace;
    const fi = (faces && triFace) ? triFace[hit.faceIndex] : -1;
    if (fi >= 0) {
      const f = faces[fi];
      normal = new THREE.Vector3(f.normal[0], f.normal[1], f.normal[2])
        .transformDirection(mesh.matrixWorld).normalize();
      planeD = f.planeD;
      ck = centroidKeyStr(f.centroid);
    } else {
      // Degenerate hit with no face data — we can't recover the face centroid,
      // so fall back to the hit point itself. Same-face subsequent hits will
      // disagree on this, but fi<0 hits are rare enough (CityGML cleanup edge
      // cases) that we accept the imperfect fallback over dropping the click.
      normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
      planeD = normal.dot(hit.point);
      ck = centroidKeyStr([hit.point.x, hit.point.y, hit.point.z]);
    }

    const cellU = Math.floor(hit.uv.x);
    const cellV = Math.floor(hit.uv.y);
    const pd    = Math.round(planeD * 2);
    const { buildingId } = mesh.userData;
    // meshType lives on each face now (merged mesh holds both roof + wall).
    // Fallback infers from normal for degenerate-triangle hits where fi < 0.
    const meshType = (fi >= 0 && faces && faces[fi] && faces[fi].meshType)
      ? faces[fi].meshType
      : (Math.abs(normal.y) > 0.5 ? 'roof' : 'wall');
    const cellKey = canonicalCellKey(`${buildingId}:${meshType}`, cellU, cellV, ck, pd);

    return { cellU, cellV, normal, planeD, mesh, cellKey };
  }

  function tryPaint() {
    const activeColor = COLORS[activeColorIdx];
    if (activeColor.isErase) { tryErase(); return; }
    const h = hitCell();
    if (!h) return;

    // Dedupe: skip if the target cell is already this color. Keeps hold-to-paint
    // drags from re-snapshotting + re-painting the same cell every frame.
    const existing = paintStore.cells.get(h.cellKey);
    if (existing && existing.color === activeColor.hex) return;

    recordPreState(h.cellKey);

    const cellData = { color: activeColor.hex, normal: h.normal.toArray(), planeD: h.planeD, paintedAt: Date.now() };

    // Paint the primary cell immediately so it appears this frame. h.cellKey
    // has already been canonicalized, so painting here replaces whatever was
    // stored for this visual cell rather than creating a sibling entry.
    paintStore.paint(h.cellKey, cellData);

    // Paint-group members are pre-baked by the tile worker. Defer the batch so
    // the primary cell renders this frame without competing for it.
    const group = cellGroups.get(h.cellKey);
    if (group && group.size > 1) {
      setTimeout(() => {
        const others = [];
        for (const k of group) if (k !== h.cellKey) others.push([k, cellData]);
        if (others.length) paintStore.paintBatch(others);
      }, 0);
    }
  }

  function tryErase() {
    const h = hitCell();
    if (!h) return;

    // Dedupe: skip if there's nothing painted at this cell.
    if (!paintStore.cells.has(h.cellKey)) return;

    recordPreState(h.cellKey);

    paintStore.erase(h.cellKey);

    const group = cellGroups.get(h.cellKey);
    if (group && group.size > 1) {
      setTimeout(() => {
        const others = [];
        for (const k of group) if (k !== h.cellKey) others.push(k);
        if (others.length) paintStore.eraseBatch(others);
      }, 0);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  const seedConfig = { fraction: SEED_FRACTION, colors: SEED_COLOR_HEX, shiftBuildingsY };

  return {
    // Bundles spread into TileManager / TerrainManager constructors.
    tileManagerBindings: {
      cellGeomCache,
      cellGeomByBuilding,
      cellGroups,
      cellGroupKeysByBuilding,
      buildingPaintMeshes,
      buildingPaintMeshByBuilding,
      paintGroup,
      seedConfig,
    },
    terrainManagerBindings: {
      buildingPaintMeshes,
      buildingPaintMeshByBuilding,
      paintGroup,
    },

    // Callbacks invoked by the managers' own callbacks.
    seedTileCells,
    seedTerrainCells,
    rebuildBuildingPaint,

    // User-input actions.
    tryPaint,
    tryErase,
    beginStroke,
    endStroke,
    applyUndo,
    applyRedo,
    cycleActiveColor,
    pickColorFromAim,
    openColorPicker,
    closeColorPicker,
    get isColorPicking() { return colorPickMode; },

    // Read-only access for updateCulling (mesh visibility toggles) and the
    // debug HUD. These are refs to the internal Maps — do not mutate from
    // outside.
    buildingPaintMeshByBuilding,
    cellGeomCache,
    cellGroups,
    get buildingPaintMeshCount() { return buildingPaintMeshes.size; },

    // Debug HUD helpers (pure functions, safe to export as-is).
    hitCell,
    centroidKeyStr,
    geomArea,
    SMALL_CELL_AREA,
  };
}
