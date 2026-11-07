import type { RoomClock, RoomTimer } from '../protocol/clock.js';

/** What one store attempt reported. `retry` asks for another attempt after a backoff. */
export type StoreOutcome = 'stored' | 'retry' | 'abandoned';

export interface StoreSchedulerOptions {
  clock: RoomClock;
  /** A change is stored this long after the last one. */
  debounceMs: number;
  /** ...but never later than this after the first unstored change. */
  maxDebounceMs: number;
  /** The first retry waits this long, doubling up to `retryMaxMs`. */
  retryInitialMs: number;
  retryMaxMs: number;
  store: () => Promise<StoreOutcome>;
}

/** Stores a room's changes after a debounce, one store at a time. */
export interface StoreScheduler {
  /** Records a change to store. */
  markDirty(): void;
  isDirty(): boolean;
  /** Stores pending changes now and resolves once no store is running, stored or not. */
  flush(): Promise<void>;
  /**
   * Stores pending changes now and resolves once they are stored, retrying as long as storage
   * fails, or once a store is abandoned or the scheduler cancelled.
   */
  drain(): Promise<void>;
  /** Drops pending changes and timers. */
  cancel(): void;
}

export function createStoreScheduler(options: StoreSchedulerOptions): StoreScheduler {
  const { clock } = options;
  let dirty = false;
  let firstDirtyAt = 0;
  let timer: RoomTimer | null = null;
  let running: Promise<StoreOutcome> | null = null;
  let retryDelay = options.retryInitialMs;
  let cancelled = false;
  // Resolved after every store attempt.
  const attempted: (() => void)[] = [];

  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const schedule = (delayMs: number) => {
    clearTimer();
    timer = clock.setTimeout(() => void flush(), delayMs);
  };

  const run = async (): Promise<StoreOutcome> => {
    dirty = false;
    const outcome = await options.store();
    for (const resolve of attempted.splice(0)) resolve();
    if (outcome === 'retry') {
      dirty = true;
      firstDirtyAt = clock.now();
      schedule(retryDelay);
      retryDelay = Math.min(retryDelay * 2, options.retryMaxMs);
    } else {
      retryDelay = options.retryInitialMs;
    }
    return outcome;
  };

  // Changes made while a store runs are stored by the same flush, one store after another.
  const flush = async (): Promise<void> => {
    clearTimer();
    while (running) await running;
    while (dirty) {
      running = run();
      const outcome = await running.finally(() => {
        running = null;
      });
      if (outcome !== 'stored') return;
    }
  };

  const drain = async (): Promise<void> => {
    await flush();
    while (dirty && !cancelled) {
      await new Promise<void>((resolve) => attempted.push(resolve));
      while (running) await running;
    }
  };

  const markDirty = () => {
    const now = clock.now();
    if (!dirty) firstDirtyAt = now;
    dirty = true;
    if (running) return;
    schedule(Math.max(0, Math.min(options.debounceMs, firstDirtyAt + options.maxDebounceMs - now)));
  };

  return {
    markDirty,
    isDirty: () => dirty,
    flush,
    drain,
    cancel: () => {
      clearTimer();
      dirty = false;
      cancelled = true;
      for (const resolve of attempted.splice(0)) resolve();
    },
  };
}
