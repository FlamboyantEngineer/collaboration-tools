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
  isEnded(): boolean;
  status(): RoomSaveStatus;
  /** Stores pending changes now and resolves once no store is running, stored or not. */
  flush(): Promise<void>;
  /**
   * Resolves `true` once every change recorded so far is stored, or `false` once a store is
   * abandoned or the scheduler cancelled first. It starts no store of its own.
   */
  whenStored(signal?: AbortSignal): Promise<boolean>;
  /** Stores pending changes now and waits, retrying as long as storage fails, as `whenStored`. */
  drain(signal?: AbortSignal): Promise<boolean>;
  /** Drops pending changes and timers; nothing is stored after. */
  cancel(): void;
  /** Runs a host commit after earlier stores finish, suspending later stores. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
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
    add: (version: number, signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        const waiter: Waiter = {
          version,
          resolve: (stored) => {
            signal?.removeEventListener('abort', abort);
            resolve(stored);
          },
        };
        const abort = () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          waiter.resolve(false);
        };
        if (signal?.aborted) return abort();
        waiting.push(waiter);
        signal?.addEventListener('abort', abort, { once: true });
      }),
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

function createDirtyTimer(
  options: StoreSchedulerOptions,
  schedule: (delay: number) => void,
  active: () => boolean,
) {
  let firstDirtyAt: number | null = null;
  return {
    reset: () => {
      firstDirtyAt = null;
    },
    mark: () => {
      const now = options.clock.now();
      firstDirtyAt ??= now;
      if (!active())
        schedule(
          Math.max(0, Math.min(options.debounceMs, firstDirtyAt + options.maxDebounceMs - now)),
        );
    },
  };
}

function createExclusive(options: {
  pause(): void;
  resume(): void;
  running(): Promise<StoreOutcome> | null;
}) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    options.pause();
    try {
      while (options.running()) await options.running();
      return await operation();
    } finally {
      options.resume();
    }
  };
}

interface SchedulerState {
  paused: number;
  version: number;
  storedVersion: number;
  ended: boolean;
  running: Promise<StoreOutcome> | null;
  retrying: boolean;
  retryDelay: number;
}

function createStoreAttempt(
  state: SchedulerState,
  options: StoreSchedulerOptions,
  callbacks: {
    reset(): void;
    schedule(delay: number): void;
    settle(version: number, ended: boolean): void;
  },
) {
  return async (): Promise<StoreOutcome> => {
    const covered = state.version;
    callbacks.reset();
    const outcome = await options.store();
    state.retrying = !state.ended && outcome === 'retry';
    if (!state.ended && outcome === 'stored') {
      state.storedVersion = Math.max(state.storedVersion, covered);
      state.retryDelay = options.retryInitialMs;
    } else if (!state.ended && outcome === 'retry') {
      callbacks.schedule(state.retryDelay);
      state.retryDelay = Math.min(state.retryDelay * 2, options.retryMaxMs);
    } else state.ended = true;
    callbacks.settle(state.storedVersion, state.ended);
    return outcome;
  };
}

function createSaveStatus(state: SchedulerState, onStatus: StoreSchedulerOptions['onStatus']) {
  let status: RoomSaveStatus = 'saved';
  return {
    read: () => status,
    update: () => {
      const next: RoomSaveStatus = state.running
        ? 'saving'
        : state.version <= state.storedVersion
          ? 'saved'
          : state.retrying
            ? 'retrying'
            : 'unsaved';
      if (next === status) return;
      status = next;
      onStatus?.(next);
    },
  };
}

export function createStoreScheduler(options: StoreSchedulerOptions): StoreScheduler {
  const { clock } = options;
  const state: SchedulerState = {
    paused: 0,
    version: 0,
    storedVersion: 0,
    ended: false,
    running: null,
    retrying: false,
    retryDelay: options.retryInitialMs,
  };
  const timer = createTimer(clock);
  const saveStatus = createSaveStatus(state, options.onStatus);
  const waiters = createWaiters();

  const isDirty = () => state.version > state.storedVersion;
  const updateStatus = saveStatus.update;
  const schedule = (delayMs: number) => timer.set(() => void flush(), delayMs);
  const dirtyTimer = createDirtyTimer(
    options,
    schedule,
    () => state.running !== null || state.retrying || state.paused > 0,
  );

  const run = createStoreAttempt(state, options, {
    reset: dirtyTimer.reset,
    schedule,
    settle: waiters.settle,
  });

  // Changes made while a store runs are stored by the same flush, one store after another.
  const flush = async (): Promise<void> => {
    timer.clear();
    for (let first = true; ; first = false) {
      while (state.running) await state.running;
      if (!isDirty() || state.ended || state.paused > 0 || (!first && state.retrying)) return;
      state.running = run();
      updateStatus();
      await state.running.finally(() => {
        state.running = null;
        updateStatus();
      });
    }
  };

  const whenStored = (signal?: AbortSignal): Promise<boolean> =>
    isDirty() && !state.ended ? waiters.add(state.version, signal) : Promise.resolve(!isDirty());

  const markDirty = () => {
    state.version += 1;
    if (state.ended) return;
    dirtyTimer.mark();
    updateStatus();
  };

  return {
    exclusive: createExclusive({
      pause: () => {
        state.paused += 1;
        timer.clear();
      },
      running: () => state.running,
      resume: () => {
        state.paused -= 1;
        if (isDirty() && !state.ended && state.paused === 0) schedule(0);
      },
    }),
    markDirty,
    isDirty,
    isEnded: () => state.ended,
    status: saveStatus.read,
    flush,
    whenStored,
    drain: (signal) => {
      const stored = whenStored(signal);
      void flush();
      return stored;
    },
    cancel: () => {
      timer.clear();
      state.ended = true;
      waiters.settle(state.storedVersion, state.ended);
    },
  };
}
