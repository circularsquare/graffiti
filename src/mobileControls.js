// Mobile controls: drag-to-look, left joystick, fly up/down buttons.
//
// The desktop control surface is keyboard + pointer-lock mouse-look; we
// reuse as much of it as possible by synthesizing the existing `keys`
// entries (KeyW/A/S/D, Space, ShiftLeft) from touch input instead of
// building a parallel movement API. The only thing we drive directly is
// the camera's YXZ euler for look drag.
//
// Usage:
//   if (IS_MOBILE) initMobileControls({ canvas, camera, keys, paint, physics, canInteract });

import * as THREE from 'three';

// Robust mobile detection. Touch capability alone misfires on touchscreen
// desktops/laptops (Firefox/Chrome on Windows commonly report maxTouchPoints>0
// on touch-capable hardware even when the user is driving with a mouse). The
// strict media query alone misfires on some Android builds that report
// pointer:fine despite a touchscreen. Combine them: require touch capability
// AND a mobile-ish input profile (no hover, or coarse pointer). Real desktops
// with a mouse always report hover:hover + pointer:fine, so they're excluded
// even when a touchscreen is attached.
export const IS_MOBILE = (() => {
  if (typeof window === 'undefined') return false;
  const hasTouch = ('ontouchstart' in window) || (navigator?.maxTouchPoints ?? 0) > 0;
  const noHover  = window.matchMedia?.('(hover: none)').matches ?? false;
  const coarse   = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return hasTouch && (noHover || coarse);
})();

// Mirror IS_MOBILE into a root class so CSS rules that can't rely on the
// media query (broken on "request desktop site", some Android builds that
// report pointer:fine) still apply. Set synchronously at module import so
// the class is on <html> before first paint.
if (IS_MOBILE && typeof document !== 'undefined') {
  document.documentElement.classList.add('mobile');
}

const LOOK_SENS         = 0.005;   // radians per pixel
const TAP_MAX_MS        = 220;
const TAP_MAX_MOVE_PX   = 10;
const JOY_DEAD_ZONE     = 0.15;
const JOY_RADIUS        = 52;      // knob travel in px (base is ~2.2× this wide)
// Mobile lacks a sprint key, so baseline walk/fly runs a bit faster than
// desktop to compensate: 1.15× just past the dead zone → 1.75× at full throw.
const SPEED_BASE        = 1.15;
const SPEED_BOOST_MAX   = 1.2;     // TEMP for testing (full throw = 1.15 + 2.0 = 3.15×)

export function initMobileControls({ canvas, camera, keys, paint, physics, canInteract }) {
  // ─── DOM ───────────────────────────────────────────────────────────────────
  //
  // Inject everything at runtime so the desktop HTML stays clean.

  const joyWrap = document.createElement('div');
  joyWrap.id = 'mobile-joystick';
  const joyKnob = document.createElement('div');
  joyKnob.className = 'mobile-joystick-knob';
  joyWrap.appendChild(joyKnob);

  // SVG glyphs (not unicode ▲▼) — iOS can colour-emojify geometric symbols
  // depending on font fallback chain, and we want consistent rendering.
  const TRIANGLE_UP_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M4 18 L12 6 L20 18 Z"/></svg>';
  const TRIANGLE_DOWN_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M4 6 L20 6 L12 18 Z"/></svg>';

  const flyUpBtn = document.createElement('button');
  flyUpBtn.id = 'mobile-fly-up';
  flyUpBtn.className = 'mobile-fly-btn';
  flyUpBtn.setAttribute('aria-label', 'Fly up');
  flyUpBtn.innerHTML = TRIANGLE_UP_SVG;

  const flyDownBtn = document.createElement('button');
  flyDownBtn.id = 'mobile-fly-down';
  flyDownBtn.className = 'mobile-fly-btn';
  flyDownBtn.setAttribute('aria-label', 'Fly down');
  flyDownBtn.innerHTML = TRIANGLE_DOWN_SVG;

  // Fly-mode toggle: sits above the joystick, left-aligned with it. Active
  // highlight when flying. Feathered bird-wing silhouette from the user.
  const flyToggleBtn = document.createElement('button');
  flyToggleBtn.id = 'mobile-fly-toggle';
  flyToggleBtn.setAttribute('aria-label', 'Toggle fly mode');
  flyToggleBtn.innerHTML =
    '<svg viewBox="0 0 122.88 121.46" fill="currentColor" aria-hidden="true">' +
    '<path d="M12.35,121.46c-8.01-9.72-11.92-19.29-12.31-28.71C-0.78,73.01,10.92,58.28,28.3,47.67 ' +
    'c18.28-11.16,37.08-13.93,55.36-22.25C92.79,21.27,103.68,14.47,121.8,0c5.92,15.69-12.92,40.9-43.52,54.23 ' +
    'c9.48,0.37,19.69-2.54,30.85-9.74c-0.76,19.94-16.46,32.21-51.3,36.95c7.33,2.45,16.09,2.58,27.27-0.58 ' +
    'C74.33,116.81,29.9,91.06,12.35,121.46L12.35,121.46z"/></svg>';

  // Note: #map-btn lives in index.html and is wired up in main.js so the
  // toggle applies on both desktop and mobile.

  for (const el of [joyWrap, flyUpBtn, flyDownBtn, flyToggleBtn]) {
    document.body.appendChild(el);
  }

  // Up button is always visible (walk: jump; fly: ascend). Fly-down is
  // meaningful only in fly mode.
  function syncFlyMode(isFlying) {
    flyDownBtn.style.display = isFlying ? '' : 'none';
    flyToggleBtn.classList.toggle('active', isFlying);
    if (!isFlying) {
      // Clear any held vertical keys so exiting fly mode doesn't leave
      // Space / ShiftLeft stuck true.
      releaseFlyBtn(flyUpBtn,   'Space');
      releaseFlyBtn(flyDownBtn, 'ShiftLeft');
    }
  }
  // Initial state mirrors the physics walk/fly it booted into (usually walk,
  // unless restored from a saved-player state that had flying: true).
  syncFlyMode(physics.isFlying);

  flyToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowFlying = physics.toggleFly();
    syncFlyMode(nowFlying);
  });

  // ─── Look drag ─────────────────────────────────────────────────────────────

  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const PITCH_LIMIT = Math.PI / 2 - 0.01;

  let lookPointerId = null;
  let lookStartX = 0, lookStartY = 0;
  let lookLastX = 0, lookLastY = 0;
  let lookStartTime = 0;
  let lookMovedBeyondTap = false;

  // Attach to canvas so UI taps (which stopPropagation) never reach here.
  // We listen with pointerdown on the canvas and then move/up on window so
  // a drag that leaves the canvas bounds still tracks.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (lookPointerId !== null) return;
    if (!canInteract()) return;
    lookPointerId = e.pointerId;
    lookStartX = lookLastX = e.clientX;
    lookStartY = lookLastY = e.clientY;
    lookStartTime = performance.now();
    lookMovedBeyondTap = false;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookPointerId) return;
    const dx = e.clientX - lookLastX;
    const dy = e.clientY - lookLastY;
    lookLastX = e.clientX;
    lookLastY = e.clientY;

    if (!lookMovedBeyondTap) {
      const totalDx = e.clientX - lookStartX;
      const totalDy = e.clientY - lookStartY;
      if (totalDx * totalDx + totalDy * totalDy > TAP_MAX_MOVE_PX * TAP_MAX_MOVE_PX) {
        lookMovedBeyondTap = true;
      }
    }

    // "Drag-the-world" feel: finger drags right → world slides right → camera
    // yaws left. Opposite sign from desktop mouse-look but standard on touch.
    euler.setFromQuaternion(camera.quaternion);
    euler.y += dx * LOOK_SENS;
    euler.x += dy * LOOK_SENS;
    if (euler.x >  PITCH_LIMIT) euler.x =  PITCH_LIMIT;
    if (euler.x < -PITCH_LIMIT) euler.x = -PITCH_LIMIT;
    camera.quaternion.setFromEuler(euler);
  });

  const _tapNdc = new THREE.Vector2();
  function tapToNdc(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    _tapNdc.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      ((clientY - rect.top)  / rect.height) * -2 + 1,
    );
    return _tapNdc;
  }

  function endLook(e) {
    if (e.pointerId !== lookPointerId) return;
    const dt = performance.now() - lookStartTime;
    const wasTap = !lookMovedBeyondTap && dt < TAP_MAX_MS;
    lookPointerId = null;
    if (wasTap && canInteract()) {
      // Tap-to-paint at the finger's location, not the screen centre. No
      // brush sweep. paint.tryPaint handles the erase-color branch itself.
      const ndc = tapToNdc(e.clientX, e.clientY);
      paint.beginStroke();
      paint.tryPaint(ndc);
      paint.endStroke();
    }
  }
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);

  // ─── Joystick ──────────────────────────────────────────────────────────────

  let joyPointerId = null;
  let joyCenterX = 0, joyCenterY = 0;
  const activeJoyKeys = new Set();

  function setJoyKey(code, on) {
    if (on) { keys[code] = true; activeJoyKeys.add(code); }
    else    { keys[code] = false; activeJoyKeys.delete(code); }
  }

  function releaseJoystick() {
    joyPointerId = null;
    joyKnob.style.transform = 'translate(-50%, -50%)';
    for (const code of activeJoyKeys) keys[code] = false;
    activeJoyKeys.clear();
    physics.setMoveSpeedMult(1);
  }

  joyWrap.addEventListener('pointerdown', (e) => {
    if (joyPointerId !== null) return;
    if (!canInteract()) return;
    e.stopPropagation();
    joyPointerId = e.pointerId;
    const rect = joyWrap.getBoundingClientRect();
    joyCenterX = rect.left + rect.width  / 2;
    joyCenterY = rect.top  + rect.height / 2;
    joyWrap.setPointerCapture(e.pointerId);
    updateJoystick(e.clientX, e.clientY);
  });

  joyWrap.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyPointerId) return;
    e.stopPropagation();
    updateJoystick(e.clientX, e.clientY);
  });

  function endJoy(e) {
    if (e.pointerId !== joyPointerId) return;
    e.stopPropagation();
    releaseJoystick();
  }
  joyWrap.addEventListener('pointerup', endJoy);
  joyWrap.addEventListener('pointercancel', endJoy);

  function updateJoystick(clientX, clientY) {
    let dx = clientX - joyCenterX;
    let dy = clientY - joyCenterY;
    const len = Math.sqrt(dx * dx + dy * dy);
    const clamp = Math.min(len, JOY_RADIUS);
    const knobX = len > 0 ? (dx / len) * clamp : 0;
    const knobY = len > 0 ? (dy / len) * clamp : 0;
    joyKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;

    // Normalised throw, deadzoned.
    const nx = len > 0 ? (dx / len) * (clamp / JOY_RADIUS) : 0;
    const ny = len > 0 ? (dy / len) * (clamp / JOY_RADIUS) : 0;
    const mag = Math.sqrt(nx * nx + ny * ny);

    if (mag < JOY_DEAD_ZONE) {
      setJoyKey('KeyW', false);
      setJoyKey('KeyS', false);
      setJoyKey('KeyA', false);
      setJoyKey('KeyD', false);
      physics.setMoveSpeedMult(1);
      return;
    }

    // Horizontal = strafe, vertical = forward/back. Screen-y is inverted
    // (positive = down), so ny < 0 means push-up = forward.
    setJoyKey('KeyW', ny < -JOY_DEAD_ZONE);
    setJoyKey('KeyS', ny >  JOY_DEAD_ZONE);
    setJoyKey('KeyA', nx < -JOY_DEAD_ZONE);
    setJoyKey('KeyD', nx >  JOY_DEAD_ZONE);

    // Speed scales with throw past deadzone: just-past = SPEED_BASE, full =
    // SPEED_BASE + SPEED_BOOST_MAX. Mobile has no sprint, so SPEED_BASE > 1
    // gives a modest always-on boost over desktop's walk/fly speeds.
    const throwT = Math.min(1, (mag - JOY_DEAD_ZONE) / (1 - JOY_DEAD_ZONE));
    physics.setMoveSpeedMult(SPEED_BASE + SPEED_BOOST_MAX * throwT);
  }

  // ─── Fly buttons ───────────────────────────────────────────────────────────

  function bindFlyBtn(btn, code) {
    btn.addEventListener('pointerdown', (e) => {
      if (!canInteract()) return;
      e.stopPropagation();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('pressed');
      keys[code] = true;
    });
    const release = (e) => {
      e.stopPropagation();
      releaseFlyBtn(btn, code);
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  }
  function releaseFlyBtn(btn, code) {
    btn.classList.remove('pressed');
    keys[code] = false;
  }
  // Up button is walk-mode jump (tap only) + fly-mode ascend (hold). Branches
  // on physics.isFlying at pointerdown so the user can switch modes without
  // the button needing to re-bind.
  flyUpBtn.addEventListener('pointerdown', (e) => {
    if (!canInteract()) return;
    e.stopPropagation();
    flyUpBtn.setPointerCapture(e.pointerId);
    flyUpBtn.classList.add('pressed');
    if (physics.isFlying) keys['Space'] = true;
    else                  physics.requestJump();
  });
  const releaseUp = (e) => {
    e.stopPropagation();
    flyUpBtn.classList.remove('pressed');
    keys['Space'] = false;  // harmless in walk mode; clears ascend in fly mode
  };
  flyUpBtn.addEventListener('pointerup', releaseUp);
  flyUpBtn.addEventListener('pointercancel', releaseUp);
  flyUpBtn.addEventListener('pointerleave', releaseUp);

  bindFlyBtn(flyDownBtn, 'ShiftLeft');

  // ─── Safety net ────────────────────────────────────────────────────────────
  //
  // Phones that drop focus (e.g. notification pull-down) never fire pointerup.
  // Clear everything on blur / visibilitychange.

  const clearAll = () => {
    lookPointerId = null;
    releaseJoystick();
    releaseFlyBtn(flyUpBtn,   'Space');
    releaseFlyBtn(flyDownBtn, 'ShiftLeft');
  };
  window.addEventListener('blur', clearAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearAll();
  });
}
