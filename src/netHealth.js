// Shared circuit breaker for every network op in the app (paint API, tile
// CDN, terrain CDN, OSM CDN). One offline signal / one backoff window / one
// consolidated log, so a spotty connection doesn't turn into dozens of
// independent retry storms and a flood of identical console entries.
//
// Contract for callers:
//   - Before issuing a request, check `netReady()`. Skip the request if false.
//     The enclosing load loop (TileManager.tick, TerrainManager.tick,
//     paintStore's pull timers) keeps firing on its normal cadence, so the
//     next ready tick retries naturally.
//   - On a successful response, call `reportNetSuccess()`. HTTP 4xx/5xx still
//     count as success — the server responded, the network works. Only
//     transport-level failures (TypeError from fetch; "Failed to fetch",
//     DNS/TLS errors, CORS preflight rejections because no response came
//     back) should trip the breaker.
//   - On a transport failure, call `reportNetFailure(op)`. Concurrent
//     failures collapse into a single log + single backoff window; `op` is
//     a human-readable label ("load tile", "save paint", etc.) that reaches
//     the console only on the FIRST failure of an outage.
//
// Backoff doubles-ish up to 120s so a persistent outage (e.g. user wandered
// into a dead-zone) doesn't hammer the endpoint every 5s. A single success
// clears the state — no half-recovery states.
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

let failures   = 0;
let pauseUntil = 0;
let offline    = false;
const listeners = new Set();

export function netReady() {
  return Date.now() >= pauseUntil;
}

/** ms remaining in the current backoff window, or 0 if the breaker is
 *  closed. Callers use this to defer their own retries past the pause
 *  instead of banging into it and re-opening the window. */
export function netBackoffRemaining() {
  return Math.max(0, pauseUntil - Date.now());
}

export function isOffline() {
  return offline;
}

export function reportNetFailure(op) {
  // Dedupe parallel failures in the same outage: one failure opens the
  // window and logs; any follow-up calls while the window is still open
  // are silent no-ops. Only after the window expires can a subsequent
  // failure extend it (meaning we tried again and it still failed).
  if (Date.now() < pauseUntil) return;
  const first = failures === 0;
  failures++;
  const i = Math.min(failures - 1, BACKOFF_MS.length - 1);
  pauseUntil = Date.now() + BACKOFF_MS[i];
  if (first) {
    console.warn(`netHealth: ${op} failed — network unreachable, backing off`);
    setOffline(true);
  }
}

export function reportNetSuccess() {
  if (failures === 0) return;
  console.info('netHealth: network recovered');
  failures   = 0;
  pauseUntil = 0;
  setOffline(false);
}

function setOffline(v) {
  if (offline === v) return;
  offline = v;
  for (const fn of listeners) fn(v);
}

/** Subscribe to online↔offline transitions. Fires on state change only;
 *  caller handles initial render from `isOffline()`. Returns an unsubscribe. */
export function subscribeNet(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
