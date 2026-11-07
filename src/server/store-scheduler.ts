import type { RoomClock, RoomTimer } from '../protocol/clock.js';
import type { RoomSaveStatus } from '../protocol/messages.js';

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
  /** Called each time the save status changes. */
  onStatus?: ((status: RoomSaveStatus) => void) | undefined;
}

/** Stores a room's changes after a debounce, one store at a time. */
export interface StoreScheduler {
  /** Records a change to store. */
  markDirty(): void;
  /** Whether some change is not stored yet. */
  isDirty(): boolean;
  status(): RoomSaveStatus;
  /** Stores pending changes now and resolves once no store is running, stored or not. */
  flush(): Promise<void>;
  /**
   * Resolves `true` once every change recorded so far is stored, or `false` once a store is
   * abandoned or the scheduler cancelled first. It starts no store of its own.
   */
  whenStored(): Promise<boolean>;
  /** Stores pending changes now and waits, retrying as long as storage fails, as `whenStored`. */
  drain(): Promise<boolean>;
  /** Drops pending changes and timers; nothing is stored after. */
  cancel(): void;
}

interface Waiter {
  /** The change count the waiter needs stored. */
  version: number;
  resolve(stored: boolean): void;
}

/** The callers of `whenStored` still waiting. */
function createWaiters() {
  const waiting: Waiter[] = [];
  return {
    add: (version: number) => new Promise<boolean>((resolve) => waiting.push({ version, resolve })),
    /** Resolves the waiters `storedVersion` covers, or every waiter, `false`, once `ended`. */
    settle: (storedVersion: number, ended: boolean) => {
      for (const waiter of [...waiting]) {
        if (!ended && waiter.version > storedVersion) continue;
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(!ended);
      }
    },
  };
}

/** One timer that each `set` replaces. */
function createTimer(clock: RoomClock) {
  let timer: RoomTimer | null = null;
  const clear = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  return {
    clear,
    set: (callback: () => void, delayMs: number) => {
      clear();
      timer = clock.setTimeout(callback, delayMs);
    },
  };
}

export function createStoreScheduler(options: StoreSchedulerOptions): StoreScheduler {
  const { clock } = options;
  // Every change bumps `version`; a store covers the changes made before it started.
  let version = 0;
  let storedVersion = 0;
  // Set once a store is abandoned or the scheduler cancelled.
  let ended = false;
  let firstDirtyAt: number | null = null;
  const timer = createTimer(clock);
  let running: Promise<StoreOutcome> | null = null;
  let retrying = false;
  let retryDelay = options.retryInitialMs;
  let status: RoomSaveStatus = 'saved';
  const waiters = createWaiters();

  const isDirty = () => version > storedVersion;
  const updateStatus = () => {
    const next = running ? 'saving' : !isDirty() ? 'saved' : retrying ? 'retrying' : 'unsaved';
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };
  const schedule = (delayMs: number) => timer.set(() => void flush(), delayMs);

  const run = async (): Promise<StoreOutcome> => {
    const covered = version;
    firstDirtyAt = null;
    const outcome = await options.store();
    retrying = outcome === 'retry';
    if (outcome === 'stored') {
      storedVersion = Math.max(storedVersion, covered);
      retryDelay = options.retryInitialMs;
    } else if (outcome === 'retry') {
      schedule(retryDelay);
      retryDelay = Math.min(retryDelay * 2, options.retryMaxMs);
    } else ended = true;
    waiters.settle(storedVersion, ended);
    return outcome;
  };

  // Changes made while a store runs are stored by the same flush, one store after another.
  const flush = async (): Promise<void> => {
    timer.clear();
    while (running) await running;
    while (isDirty() && !ended) {
      running = run();
      updateStatus();
      const outcome = await running.finally(() => {
        running = null;
        updateStatus();
      });
      if (outcome !== 'stored') return;
    }
  };

  const whenStored = (): Promise<boolean> =>
    isDirty() && !ended ? waiters.add(version) : Promise.resolve(!isDirty());

  const markDirty = () => {
    version += 1;
    if (ended) return;
    const now = clock.now();
    firstDirtyAt ??= now;
    // A running store's flush stores this change next; a failed store's retry timer covers it.
    if (!running && !retrying) {
      schedule(
        Math.max(0, Math.min(options.debounceMs, firstDirtyAt + options.maxDebounceMs - now)),
      );
    }
    updateStatus();
  };

  return {
    markDirty,
    isDirty,
    status: () => status,
    flush,
    whenStored,
    drain: () => {
      const stored = whenStored();
      void flush();
      return stored;
    },
    cancel: () => {
      timer.clear();
      ended = true;
      waiters.settle(storedVersion, ended);
    },
  };
}
