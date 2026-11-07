/** The opaque handle a {@link RoomClock} returns for a scheduled callback. */
export type RoomTimer = unknown;

/** The time source for debounces, timeouts and retries, so tests and hosts control time. */
export interface RoomClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): RoomTimer;
  clearTimeout(timer: RoomTimer): void;
}

/** The platform's clock: `Date.now` and the global timers. */
export const PLATFORM_CLOCK: RoomClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): RoomTimer =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer: RoomTimer) => {
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>);
  },
});
