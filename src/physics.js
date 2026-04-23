// Player movement, capsule collision, gravity, and spawn placement.
//
// createPhysics() is wired up once by main.js with refs to the camera, input
// state (keys + PointerLockControls), the terrain sampler, and three getters
// that return the currently-near colliders / buildings. Those getters exist
// because updateCulling() reassigns the arrays wholesale each time it runs,
// so a cached reference would go stale.
//
// Everything mutable (velY, isFlying, jumpRequested, eyeVisualOffset, etc.)
// is scoped inside the factory closure. The only state main.js still touches
// directly is camera.position, which physics mutates in place.

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

// Exported: used by spawn/teleport code in main.js for Y placement math.
export const WALK_HEIGHT = 1.8;        // eye height above surface
export const PLAYER_RADIUS = 0.9;      // body collision radius; also spawn clearance

// Swept-collision sub-step size. Horizontal motion is split into chunks no
// larger than this so a single fast frame can't skip entirely past a thin
// wall before resolveCapsule runs. Needs to be < 2 × PLAYER_RADIUS so the
// capsule always overlaps a zero-thickness wall at some sub-step; half
// PLAYER_RADIUS leaves comfortable margin. At fly-boost (~40 m/s) with a
// 50 ms frame this yields ~5 sub-steps — still cheap per frame.
const MAX_COLLISION_STEP = PLAYER_RADIUS * 0.5;

// Player scale — all lengths/speeds below sit ×0.6 against a prior ~3 m-tall
// "giant" pass so proportions vs. city geometry feel natural (human ≈ 1.8 m
// tall, walks ~5 m/s sprinting).
const WALK_SPEED    = 6.0;
const SPRINT_SPEED  = 14.4;
const FLY_SPEED     = 13.2;
const FLY_VERT      = 8.4;
const STEP_UP_HEIGHT = 1.0;             // max lip auto-climbed when walking

// Visual-only eye smoothing on step-ups. Physics snaps the capsule to the new
// surface instantly (required — otherwise the step reads as a wall and blocks
// forward motion), but the rendered eye lags by the step height and catches
// up exponentially so small cliff edges feel less jarring.
const EYE_STEP_SMOOTH_TAU = 0.12;

const GRAVITY      = 20;                // m/s²
const TERMINAL_VEL = -30;
const JUMP_HEIGHT  = 2.0;               // peak of a standing jump
const JUMP_VEL     = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT); // v² = 2gh

// Smoothed fly-mode velocity time constant — ~250ms to reach ~92% of target.
const FLY_SMOOTH_TAU = 0.10;

// Space double-tap window for the walk↔fly toggle.
const DOUBLE_TAP_MS = 280;

// Capsule collision samples: 4 spheres stacked from eye level down to just
// above the feet. Offsets are fractions of WALK_HEIGHT so they track player
// scale automatically.
const CAPSULE_SAMPLE_OFFSETS = [0, -0.3 * WALK_HEIGHT, -0.6 * WALK_HEIGHT, -(WALK_HEIGHT - 0.15)];
const MAX_CAPSULE_ITERS = 4;

const DOWN = new THREE.Vector3(0, -1, 0);

// ─── closestPointOnTriangle ───────────────────────────────────────────────────
//
// Ericson, Real-Time Collision Detection §5.1.5. Pre-allocated temps below.

const _cptAB = new THREE.Vector3();
const _cptAC = new THREE.Vector3();
const _cptAP = new THREE.Vector3();
const _cptBP = new THREE.Vector3();
const _cptCP = new THREE.Vector3();
const _cptBC = new THREE.Vector3();

function closestPointOnTriangle(p, a, b, c, out) {
  _cptAB.subVectors(b, a);
  _cptAC.subVectors(c, a);
  _cptAP.subVectors(p, a);
  const d1 = _cptAB.dot(_cptAP);
  const d2 = _cptAC.dot(_cptAP);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);

  _cptBP.subVectors(p, b);
  const d3 = _cptAB.dot(_cptBP);
  const d4 = _cptAC.dot(_cptBP);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.copy(a).addScaledVector(_cptAB, v);
  }

  _cptCP.subVectors(p, c);
  const d5 = _cptAB.dot(_cptCP);
  const d6 = _cptAC.dot(_cptCP);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.copy(a).addScaledVector(_cptAC, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    _cptBC.subVectors(c, b);
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(_cptBC, w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return out.copy(a).addScaledVector(_cptAB, v).addScaledVector(_cptAC, w);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPhysics({
  camera, controls, keys, terrain, floorY,
  initialFlying = false,
  getNearColliders,      // () → [ground, ...buildings, ...terrainMeshes]
  getNearRayColliders,   // () → [ground, ...buildings]  (excludes terrain — see surfaceBelow)
  getNearBuildings,      // () → [...buildings]
}) {
  // Camera clamp when standing on the default floor (no building underfoot).
  const MIN_EYE_Y = floorY + WALK_HEIGHT;

  // ─── Mutable state ──────────────────────────────────────────────────────────
  let isFlying = !!initialFlying;
  let velY = 0;
  // Edge-triggered jump. Set on a Space keydown that isn't the second half of
  // a double-tap fly toggle, consumed (whether or not we actually jumped) on
  // the next walking-mode frame so held Space doesn't rebounce and so a stale
  // first tap doesn't fire after the fly toggle.
  let jumpRequested = false;
  let eyeVisualOffset = 0;
  let lastSpaceTap = 0;
  let lastTime = performance.now();

  // Smoothed fly-mode velocity (m/s). Lerps toward the target velocity built
  // from input each frame so starting/stopping movement in the air ramps in
  // instead of snapping. Walk mode bypasses this and resets it to zero.
  const _flyVel = new THREE.Vector3();

  // ─── Scratch / temps ────────────────────────────────────────────────────────
  const snapRay = new THREE.Raycaster(); // reusable ray for safe-start checks
  const downRay = new THREE.Raycaster();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _capA = new THREE.Vector3();
  const _capB = new THREE.Vector3();
  const _capC = new THREE.Vector3();
  const _capP = new THREE.Vector3();
  const _capClosest = new THREE.Vector3();
  const _surfOrig = new THREE.Vector3();
  const _skyOrigin = new THREE.Vector3();

  const RING_OFFSETS = (() => {
    const offsets = [];
    const r = PLAYER_RADIUS * 0.9;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      offsets.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return offsets;
  })();

  // ─── Floor detection ────────────────────────────────────────────────────────
  //
  // Returns the highest surface the player's footprint is sitting on, or null.
  //
  // Center ray starts at feet + STEP_UP_HEIGHT + 0.15 so it can detect a surface
  // up to STEP_UP_HEIGHT above current feet — this is the step-up: the moment
  // the player's center crosses onto a slightly-higher roof, Y snaps to it.
  //
  // Ring rays (8 compass offsets at ~PLAYER_RADIUS) start at feet + 0.15 and
  // only see surfaces at or below feet — they support the player at current
  // feet level when their center has drifted past a roof edge, without
  // triggering an unwanted snap-up from a taller neighbor the player is merely
  // standing next to.
  function surfaceBelow(pos, maxDrop) {
    let bestY = null;
    const rayColliders = getNearRayColliders();

    // Ray inputs exclude terrain meshes — they're blocky and the 8 ring rays
    // at ±PLAYER_RADIUS produce frame-to-frame jitter as different rings win
    // the MAX on a slope. The terrain-sample read below is the authoritative
    // terrain height (continuous bilinear interp of the mesh's corner heights),
    // and buildings/ground are still raycast because the mesh IS the surface
    // of record there.
    _surfOrig.set(pos.x, pos.y - WALK_HEIGHT + STEP_UP_HEIGHT + 0.15, pos.z);
    downRay.set(_surfOrig, DOWN);
    downRay.far = maxDrop + STEP_UP_HEIGHT + 0.15;
    const centerHits = downRay.intersectObjects(rayColliders, false);
    if (centerHits.length > 0) bestY = centerHits[0].point.y;

    for (let i = 0; i < RING_OFFSETS.length; i++) {
      const [ox, oz] = RING_OFFSETS[i];
      _surfOrig.set(pos.x + ox, pos.y - WALK_HEIGHT + 0.15, pos.z + oz);
      downRay.set(_surfOrig, DOWN);
      downRay.far = maxDrop + 0.15;
      const hits = downRay.intersectObjects(rayColliders, false);
      if (hits.length > 0) {
        const y = hits[0].point.y;
        if (bestY === null || y > bestY) bestY = y;
      }
    }

    // Blocky terrain has vertical step walls. When the player clips into one,
    // the raycast origin sits inside the block and backface culling makes every
    // ray miss — the foot falls through into the ground plane at FLOOR_Y.
    // Consult the heightmap directly so the top of the step is always a
    // candidate surface, whether or not a ray can see it. Only offer it when
    // it's within the normal step-up/drop window so we don't teleport onto a
    // faraway cliff top while the player is standing on a rooftop.
    const terrainY = terrain.sample(pos.x, pos.z);
    if (terrainY !== null) {
      const feetY = pos.y - WALK_HEIGHT;
      if (terrainY >= feetY - maxDrop - 0.15 &&
          terrainY <= feetY + STEP_UP_HEIGHT + 0.15 &&
          (bestY === null || terrainY > bestY)) {
        bestY = terrainY;
      }
    }
    return bestY;
  }

  // ─── Capsule push-out ───────────────────────────────────────────────────────
  //
  // Push the player out of any building triangle that intersects the capsule.
  // Horizontal-only ejection: vertical movement is handled by gravity /
  // surfaceBelow. Iterates a few times so multi-contact corners settle.
  function resolveCapsule(pos) {
    const r = PLAYER_RADIUS;
    const r2 = r * r;
    const lastOff = CAPSULE_SAMPLE_OFFSETS[CAPSULE_SAMPLE_OFFSETS.length - 1];
    const feetY = pos.y - WALK_HEIGHT;
    const colliders = getNearColliders();

    for (let iter = 0; iter < MAX_CAPSULE_ITERS; iter++) {
      let moved = false;

      const capMinX = pos.x - r, capMaxX = pos.x + r;
      const capMinZ = pos.z - r, capMaxZ = pos.z + r;
      const capMinY = pos.y + lastOff - r;
      const capMaxY = pos.y + r;

      // Buildings and terrain both get pushed out of the capsule the same
      // way — including terrain meshes here is how cliffs block at
      // PLAYER_RADIUS and slide on diagonals without any special-case code.
      // colliders is [ground, ...buildings, ...terrainMeshes]; ground's
      // PlaneGeometry has no computed bounding box so it no-ops on the bb
      // check below. Horizontal terrain tops pass the 30°-from-horizontal
      // filter and are skipped, so only vertical cliff sides contribute.
      for (const mesh of colliders) {
        const bb = mesh.geometry.boundingBox;
        if (!bb) continue;
        if (capMaxX < bb.min.x || capMinX > bb.max.x) continue;
        if (capMaxY < bb.min.y || capMinY > bb.max.y) continue;
        if (capMaxZ < bb.min.z || capMinZ > bb.max.z) continue;

        const posAttr = mesh.geometry.getAttribute('position');
        const arr = posAttr.array;
        const triCount = posAttr.count / 3;

        for (let ti = 0; ti < triCount; ti++) {
          const i0 = ti * 9;
          const ax = arr[i0],     ay = arr[i0 + 1], az = arr[i0 + 2];
          const bx = arr[i0 + 3], by = arr[i0 + 4], bz = arr[i0 + 5];
          const cx = arr[i0 + 6], cy = arr[i0 + 7], cz = arr[i0 + 8];

          if (Math.min(ax, bx, cx) > capMaxX || Math.max(ax, bx, cx) < capMinX) continue;
          if (Math.min(ay, by, cy) > capMaxY || Math.max(ay, by, cy) < capMinY) continue;
          if (Math.min(az, bz, cz) > capMaxZ || Math.max(az, bz, cz) < capMinZ) continue;

          // Skip near-horizontal triangles (roofs, floors). Landing and
          // standing on these is handled by gravity / surfaceBelow; letting
          // them contribute to horizontal push causes the player to get
          // ejected sideways when standing near the seam between rooftops
          // of slightly different heights.
          const ex1 = bx - ax, ey1 = by - ay, ez1 = bz - az;
          const ex2 = cx - ax, ey2 = cy - ay, ez2 = cz - az;
          const nx = ey1 * ez2 - ez1 * ey2;
          const ny = ez1 * ex2 - ex1 * ez2;
          const nz = ex1 * ey2 - ey1 * ex2;
          const nLen2 = nx * nx + ny * ny + nz * nz;
          if (nLen2 < 1e-10) continue;
          // Skip if the face is within 30° of horizontal (normal within 30°
          // of vertical). cos(30°)² ≈ 0.75 → |ny|²/|n|² > 0.75.
          if ((ny * ny) / nLen2 > 0.75) continue;

          _capA.set(ax, ay, az);
          _capB.set(bx, by, bz);
          _capC.set(cx, cy, cz);

          for (let yi = 0; yi < CAPSULE_SAMPLE_OFFSETS.length; yi++) {
            _capP.set(pos.x, pos.y + CAPSULE_SAMPLE_OFFSETS[yi], pos.z);
            closestPointOnTriangle(_capP, _capA, _capB, _capC, _capClosest);
            // Skip contacts whose closest point is within STEP_UP_HEIGHT above
            // the player's feet. This covers the top edge of a wall under our
            // own roof (the original case) and also the short wall of a
            // slightly-higher adjacent roof — ignoring it here lets the player
            // walk into the step, and surfaceBelow's center-ray step-up then
            // raises Y onto the higher roof the same frame.
            if (_capClosest.y < feetY + STEP_UP_HEIGHT + 0.1) continue;
            // Push using true 3D separation but project the push horizontally —
            // this keeps narrow-gap corner ejection while preventing a huge
            // horizontal shove from a contact that is mostly vertical.
            const ddx = _capP.x - _capClosest.x;
            const ddy = _capP.y - _capClosest.y;
            const ddz = _capP.z - _capClosest.z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < r2 && d2 > 1e-8) {
              const d = Math.sqrt(d2);
              const push = (r - d) / d;
              pos.x += ddx * push;
              pos.z += ddz * push;
              moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }
  }

  // ─── Frame step ─────────────────────────────────────────────────────────────
  function updateMovement() {
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.05);
    lastTime  = now;

    eyeVisualOffset *= Math.exp(-dt / EYE_STEP_SMOOTH_TAU);
    if (Math.abs(eyeVisualOffset) < 0.001) eyeVisualOffset = 0;

    if (!controls.isLocked) return;

    // ── Horizontal ────────────────────────────────────────────────────────────

    const flyBoost = isFlying && keys['KeyQ'] ? 3 : 1;
    const speed = isFlying
      ? FLY_SPEED * flyBoost
      : (keys['KeyQ'] ? SPRINT_SPEED : WALK_SPEED);

    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    _fwd.normalize();

    // right = cross(fwd, up) = (-fwd.z, 0, fwd.x)
    _right.set(-_fwd.z, 0, _fwd.x);

    // Target horizontal velocity (m/s) from input.
    let tvx = 0, tvz = 0;
    if (keys['KeyW'] || keys['ArrowUp'])    { tvx += _fwd.x;   tvz += _fwd.z; }
    if (keys['KeyS'] || keys['ArrowDown'])  { tvx -= _fwd.x;   tvz -= _fwd.z; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { tvx -= _right.x; tvz -= _right.z; }
    if (keys['KeyD'] || keys['ArrowRight']) { tvx += _right.x; tvz += _right.z; }

    const hLen = Math.sqrt(tvx * tvx + tvz * tvz);
    if (hLen > 0) {
      tvx = (tvx / hLen) * speed;
      tvz = (tvz / hLen) * speed;
    }

    // Target vertical velocity (m/s). Walk mode handles gravity below; in fly
    // mode Space/Shift are direct vertical input.
    let tvy = 0;
    if (isFlying) {
      if (keys['Space'])                            tvy += FLY_VERT * flyBoost;
      if (keys['ShiftLeft'] || keys['ShiftRight'])  tvy -= FLY_VERT * flyBoost;
    }

    let dx, dz, dy;
    if (isFlying) {
      // Exponential smoothing toward the input-driven target velocity. This is
      // what gives the brief "ease in / ease out" feel when starting or
      // stopping in the air.
      const a = 1 - Math.exp(-dt / FLY_SMOOTH_TAU);
      _flyVel.x += (tvx - _flyVel.x) * a;
      _flyVel.y += (tvy - _flyVel.y) * a;
      _flyVel.z += (tvz - _flyVel.z) * a;
      dx = _flyVel.x * dt;
      dy = _flyVel.y * dt;
      dz = _flyVel.z * dt;
    } else {
      // Walking is intentionally snappy.
      _flyVel.set(0, 0, 0);
      dx = tvx * dt;
      dz = tvz * dt;
      dy = 0; // gravity handled below
    }

    // Swept collision: split the horizontal delta into sub-steps no larger
    // than MAX_COLLISION_STEP and run resolveCapsule after each. Applying the
    // full delta in one go let fast fly-boost frames skip entirely past a
    // thin wall (player ends up inside the building); sub-stepping guarantees
    // the capsule overlaps the wall at some step and gets pushed back out.
    // Narrow-gap corner ejection still works — resolveCapsule pushes along
    // the contact normal whether it runs once or many times.
    const prevX = camera.position.x;
    const prevZ = camera.position.z;
    const hDist = Math.hypot(dx, dz);
    const nSteps = Math.max(1, Math.ceil(hDist / MAX_COLLISION_STEP));
    const stepX = dx / nSteps;
    const stepZ = dz / nSteps;
    for (let s = 0; s < nSteps; s++) {
      camera.position.x += stepX;
      camera.position.z += stepZ;
      resolveCapsule(camera.position);
    }
    // If the resolver reversed our intended motion on an axis, zero the
    // smoothed fly velocity so it doesn't keep accumulating against the wall.
    const actualDx = camera.position.x - prevX;
    const actualDz = camera.position.z - prevZ;
    if (dx !== 0 && actualDx * dx < 0) _flyVel.x = 0;
    if (dz !== 0 && actualDz * dz < 0) _flyVel.z = 0;

    // ── Vertical ──────────────────────────────────────────────────────────────

    if (isFlying) {
      velY = 0;
      // Ascending (dy > 0) is unblocked — intentionally allows clipping through
      // ceilings to escape buildings. Descending (dy < 0) is blocked by any
      // surface below, so the smoothed velocity gets zeroed when we hit ground.
      if (dy > 0) {
        camera.position.y += dy;
      } else if (dy < 0) {
        const drop = -dy;
        const footOrigin = new THREE.Vector3(camera.position.x, camera.position.y - WALK_HEIGHT + 0.05, camera.position.z);
        downRay.set(footOrigin, DOWN);
        downRay.far = drop + 0.1;
        const hits = downRay.intersectObjects(getNearColliders(), false);
        const rayBlocked = hits.length > 0 && hits[0].distance <= drop;
        // Heightmap gate for stepped terrain: raycast misses when the foot
        // origin is already inside a block (backface-culled from below), so we
        // also consult the DEM directly. Either source is enough to block.
        const terrainY = terrain.sample(camera.position.x, camera.position.z);
        const terrainBlocks = terrainY !== null &&
          camera.position.y + dy - WALK_HEIGHT < terrainY;
        if (rayBlocked || terrainBlocks) _flyVel.y = 0;
        else camera.position.y += dy;
      }
      // Buried-below-terrain rescue. Cliff blocking/sliding is handled by
      // resolveCapsule (terrain meshes are iterated alongside buildings), so
      // the only case left is the player's feet ending up below the terrain
      // heightmap — typically from a save/teleport that landed inside a
      // block, or numerical drift where the downward ray missed the top face.
      // Snap Y up to the surface so gravity finds it next frame.
      const terrainYRescue = terrain.sample(camera.position.x, camera.position.z);
      if (terrainYRescue !== null && camera.position.y - WALK_HEIGHT < terrainYRescue) {
        camera.position.y = terrainYRescue + WALK_HEIGHT;
        _flyVel.y = 0;
      }
      camera.position.y = Math.max(MIN_EYE_Y, camera.position.y);
    } else {
      // Buried-below-terrain rescue — cliff blocking/sliding is handled by
      // resolveCapsule since terrain meshes are now iterated alongside
      // buildings. The remaining case is feet below the heightmap from a
      // save/teleport or a surfaceBelow ray that missed because its origin
      // was inside the block. Snap Y up so gravity re-grounds next frame.
      const terrainY = terrain.sample(camera.position.x, camera.position.z);
      if (terrainY !== null && camera.position.y - WALK_HEIGHT < terrainY) {
        camera.position.y = terrainY + WALK_HEIGHT;
        velY = 0;
      }

      // Jump — edge-triggered via jumpRequested, which the Space keydown
      // handler sets only on a first tap (not the second tap of a double-tap
      // fly toggle). The landing branch below zeros velY on every touchdown,
      // so velY === 0 is the grounded test. Consume the flag unconditionally
      // so a mid-air tap doesn't get banked for the next landing.
      if (jumpRequested && velY === 0) velY = JUMP_VEL;
      jumpRequested = false;

      // Gravity
      velY = Math.max(velY - GRAVITY * dt, TERMINAL_VEL);
      const dY = velY * dt;

      if (dY < 0) {
        // Falling — look for a surface within this frame's drop distance
        const surf = surfaceBelow(camera.position, Math.abs(dY));
        if (surf !== null) {
          // Land (or stay grounded)
          const newY = surf + WALK_HEIGHT;
          const step = newY - camera.position.y;
          if (step > 0) eyeVisualOffset -= step;
          camera.position.y = newY;
          velY = 0;
        } else {
          camera.position.y += dY;
          // Hard floor fallback
          if (camera.position.y < MIN_EYE_Y) {
            camera.position.y = MIN_EYE_Y;
            velY = 0;
          }
        }
      } else if (dY > 0) {
        // Ascending from a jump. Ceilings don't block — matches fly mode's
        // upward-is-free rule so players can't get trapped under overhangs.
        camera.position.y += dY;
      }
    }
  }

  // ─── Spawn / teleport placement ─────────────────────────────────────────────

  // Returns true if the XZ position has clearance in all 8 horizontal directions.
  function positionIsClear(x, z) {
    const pos = new THREE.Vector3(x, MIN_EYE_Y, z);
    const buildings = getNearBuildings();
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      snapRay.set(pos, new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
      snapRay.far = PLAYER_RADIUS + 0.1;
      if (snapRay.intersectObjects(buildings, false).length > 0) return false;
    }
    return true;
  }

  // True if (x, z) sits directly under any building polygon — a downward ray
  // from well above Manhattan's tallest skyscraper hits a building mesh. Catches
  // the big-interior case that positionIsClear misses (its 1.6 m ring rays can
  // run clean through an empty atrium without ever touching a wall).
  function positionIsUnderBuilding(x, z) {
    _skyOrigin.set(x, 2000, z);
    snapRay.set(_skyOrigin, DOWN);
    snapRay.far = 2100;
    return snapRay.intersectObjects(getNearBuildings(), false).length > 0;
  }

  function placeOnGround(x, z) {
    const terrainY = terrain.sample(x, z);
    const y = terrainY !== null ? terrainY + WALK_HEIGHT : MIN_EYE_Y;
    camera.position.set(x, y, z);
    velY = 0;
  }

  // After buildings load, make sure the camera isn't spawned inside one.
  // Tries expanding rings of candidate positions until a clear spot is found.
  // When the position is already clear, the saved Y is left alone so rooftop
  // saves survive the reload. The per-frame below-terrain rescue in walk mode
  // handles the case where the saved Y ends up inside newly-loaded terrain.
  function snapToSafeStart() {
    const cx = camera.position.x, cz = camera.position.z;
    if (positionIsClear(cx, cz)) return;

    for (let r = 5; r <= 100; r += 5) {
      const steps = Math.max(8, Math.round(r * 1.2));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(angle) * r;
        const z = cz + Math.sin(angle) * r;
        if (positionIsClear(x, z)) {
          placeOnGround(x, z);
          return;
        }
      }
    }
  }

  // Teleport-specific: shift horizontally if the landing spot is under a
  // building polygon. Kept separate from snapToSafeStart so rooftop *saves*
  // (initial page load) aren't ejected — teleport always lands at terrain
  // level, so "under building" there means "inside the building".
  function snapOutOfBuildingFootprint() {
    const cx = camera.position.x, cz = camera.position.z;
    if (!positionIsUnderBuilding(cx, cz)) return;

    for (let r = 5; r <= 120; r += 5) {
      const steps = Math.max(8, Math.round(r * 1.2));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(angle) * r;
        const z = cz + Math.sin(angle) * r;
        if (!positionIsUnderBuilding(x, z)) {
          placeOnGround(x, z);
          return;
        }
      }
    }
  }

  // ─── Input edge-triggers ────────────────────────────────────────────────────
  //
  // Called from the Space keydown handler (after preventDefault + the
  // locked/repeat gate). Two taps within DOUBLE_TAP_MS toggle fly mode; an
  // isolated tap in walk mode queues a jump for the next frame.
  function handleSpaceTap() {
    const now = performance.now();
    const isDoubleTap = now - lastSpaceTap < DOUBLE_TAP_MS;
    if (isDoubleTap) {
      isFlying = !isFlying;
      if (!isFlying) velY = 0; // start falling cleanly when leaving fly mode
      // Clear any pending jump from the first tap so the player doesn't
      // hop the instant they leave fly mode.
      jumpRequested = false;
    } else if (!isFlying) {
      // First tap in walking — queue a jump for updateMovement. If a second
      // tap arrives within DOUBLE_TAP_MS the branch above will clear this.
      jumpRequested = true;
    }
    lastSpaceTap = now;
  }

  return {
    MIN_EYE_Y,
    get isFlying() { return isFlying; },
    get eyeVisualOffset() { return eyeVisualOffset; },
    updateMovement,
    snapToSafeStart,
    snapOutOfBuildingFootprint,
    resetFallVelocity() { velY = 0; },
    handleSpaceTap,
  };
}
