import type { RoomClock, RoomTimer } from '../protocol/clock.js';

export interface StaleSocketCheckOptions {
  clock: RoomClock;
  /** A socket that received nothing for longer than this is stale. */
  timeoutMs: number;
  /** How often the check runs. */
  cadenceMs: number;
  /** When the socket last received a message, on the clock's time. */
  lastMessageAt: () => number;
  onStale: () => void;
}

export interface StaleSocketCheck {
  start(): void;
  stop(): void;
}

/**
 * Closes a socket that has been silent too long, without closing a live one whose messages are
 * queued behind a long task. A pass that runs late (more than two cadences after the previous one)
 * measures silence from itself, which gives queued messages a full timeout; a late pass that
 * follows another late pass keeps the earlier start, so steady throttling, as in a hidden tab, still
 * closes a dead socket.
 */
export function createStaleSocketCheck(options: StaleSocketCheckOptions): StaleSocketCheck {
  const { clock, timeoutMs, cadenceMs } = options;
  let timer: RoomTimer | null = null;
  let ranAt = 0;
  let wasLate = false;
  let silenceFrom = 0;

  const stop = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const run = () => {
    timer = null;
    const now = clock.now();
    const late = now - ranAt > 2 * cadenceMs;
    if (late && !wasLate) silenceFrom = now;
    wasLate = late;
    ranAt = now;
    if (now - Math.max(options.lastMessageAt(), silenceFrom) > timeoutMs) {
      options.onStale();
      return;
    }
    timer = clock.setTimeout(run, cadenceMs);
  };

  const start = () => {
    stop();
    ranAt = clock.now();
    wasLate = false;
    silenceFrom = 0;
    timer = clock.setTimeout(run, cadenceMs);
  };

  return { start, stop };
}
