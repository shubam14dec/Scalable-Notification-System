/**
 * Tunnel watchdog. The decision logic is a pure state machine (`tick`) so it
 * can be unit-tested exhaustively; `startWatchdog` is the setInterval driver
 * that health-checks THROUGH the tunnel and calls the pure core.
 */

export interface WdState {
  /** Consecutive health-check failures since the last success. */
  failures: number;
  /** Timestamps (ms) of recent rotations, pruned to the 120s window. */
  rotations: number[];
  /** If set, rotations are suppressed until `at` passes this timestamp. */
  pausedUntil: number | null;
  /** Timestamp of the last event processed (for clock-jump detection). */
  lastTickAt: number | null;
}

export type WdEvent =
  | { kind: 'health_ok'; at: number }
  | { kind: 'health_fail'; at: number }
  | { kind: 'child_exit'; at: number }
  | { kind: 'clock_jump'; at: number };

export type WdAction = 'none' | 'check_now' | 'rotate' | 'pause';

export interface WdResult {
  state: WdState;
  action: WdAction;
}

export function initWatchdogState(): WdState {
  return { failures: 0, rotations: [], pausedUntil: null, lastTickAt: null };
}

const ROTATE_WINDOW_MS = 120_000;
const MAX_ROTATIONS = 5;
const PAUSE_MS = 60_000;
const FAIL_THRESHOLD = 3;

/**
 * Advance the watchdog by one event. Pure: returns a fresh state + the action
 * the driver should take. Never mutates the input.
 *
 * - health_ok    → reset the failure counter.
 * - health_fail  → 3rd consecutive failure triggers a rotate.
 * - child_exit   → rotate immediately.
 * - clock_jump   → check_now (the machine woke from a sleep; probe at once).
 * - 5 rotations within 120s → pause for 60s (action 'pause'); while paused,
 *   every event is swallowed as 'none' until `at` passes pausedUntil.
 */
export function tick(state: WdState, event: WdEvent): WdResult {
  const now = event.at;
  const s: WdState = {
    failures: state.failures,
    rotations: [...state.rotations],
    pausedUntil: state.pausedUntil,
    lastTickAt: now,
  };

  // Suppress everything while paused.
  if (s.pausedUntil !== null && now <= s.pausedUntil) {
    return { state: s, action: 'none' };
  }
  // Pause has elapsed — clear it and carry on.
  if (s.pausedUntil !== null && now > s.pausedUntil) {
    s.pausedUntil = null;
  }

  switch (event.kind) {
    case 'health_ok':
      s.failures = 0;
      return { state: s, action: 'none' };

    case 'clock_jump':
      return { state: s, action: 'check_now' };

    case 'health_fail':
      s.failures += 1;
      if (s.failures >= FAIL_THRESHOLD) {
        s.failures = 0;
        return rotate(s, now);
      }
      return { state: s, action: 'none' };

    case 'child_exit':
      s.failures = 0;
      return rotate(s, now);
  }
}

function rotate(s: WdState, now: number): WdResult {
  const recent = s.rotations.filter((t) => now - t < ROTATE_WINDOW_MS);
  recent.push(now);
  s.rotations = recent;
  if (recent.length >= MAX_ROTATIONS) {
    s.pausedUntil = now + PAUSE_MS;
    return { state: s, action: 'pause' };
  }
  return { state: s, action: 'rotate' };
}

// ---- driver ----

export interface WatchdogOptions {
  /** Current public tunnel URL (re-read each tick; changes on rotate). */
  getTunnelUrl: () => string;
  /** Perform a rotation (kill + respawn + rewire). Awaited; errors logged. */
  onRotate: () => void | Promise<void>;
  /** Called when a pause window opens (5 rotations in 120s). */
  onPause?: (until: number) => void;
  intervalMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface WatchdogController {
  stop(): void;
  /** Feed a child-process exit into the machine (immediate rotate). */
  notifyChildExit(): void;
}

export function startWatchdog(opts: WatchdogOptions): WatchdogController {
  const interval = opts.intervalMs ?? 20_000;
  const fetchTimeout = opts.fetchTimeoutMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  let state = initWatchdogState();
  let stopped = false;
  let busy = false;

  async function apply(result: WdResult): Promise<void> {
    state = result.state;
    if (result.action === 'rotate') {
      log('watchdog: rotating tunnel');
      await opts.onRotate();
    } else if (result.action === 'pause') {
      log('watchdog: too many rotations — pausing for 60s');
      opts.onPause?.(state.pausedUntil ?? now());
    }
  }

  async function checkHealth(): Promise<'health_ok' | 'health_fail'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeout);
    try {
      const res = await fetch(`${opts.getTunnelUrl()}/health`, {
        signal: controller.signal,
      });
      return res.ok ? 'health_ok' : 'health_fail';
    } catch {
      return 'health_fail';
    } finally {
      clearTimeout(timer);
    }
  }

  async function runTick(): Promise<void> {
    if (stopped || busy) return;
    busy = true;
    try {
      const at = now();
      // A large gap since the last tick means the machine slept (laptop
      // suspend / clock jump); probe immediately instead of trusting stale
      // state.
      if (state.lastTickAt !== null && at - state.lastTickAt > 60_000) {
        await apply(tick(state, { kind: 'clock_jump', at }));
        if (stopped) return;
      }
      const kind = await checkHealth();
      if (stopped) return;
      await apply(tick(state, { kind, at: now() }));
    } catch (err) {
      log(`watchdog tick error: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }

  const handle = setInterval(() => void runTick(), interval);

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
    notifyChildExit() {
      if (stopped || busy) return;
      busy = true;
      void (async () => {
        try {
          await apply(tick(state, { kind: 'child_exit', at: now() }));
        } catch (err) {
          log(`watchdog child-exit error: ${(err as Error).message}`);
        } finally {
          busy = false;
        }
      })();
    },
  };
}
