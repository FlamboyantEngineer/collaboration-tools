import type { RoomClock, RoomHost, RoomLogger, RoomTimer } from './adapters.js';

/** A {@link RoomHost} with every optional adapter filled in. */
export type ResolvedRoomHost = Required<{ [Key in keyof RoomHost]: NonNullable<RoomHost[Key]> }>;

/** A logger that drops every message. */
export const SILENT_LOGGER: RoomLogger = Object.freeze({
  warn: () => undefined,
  error: () => undefined,
});

/** The platform's clock: `Date.now` and the global timers. */
export const PLATFORM_CLOCK: RoomClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): RoomTimer =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer: RoomTimer) => {
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>);
  },
});

/** Fills in the adapters a host left out with their defaults. */
export function resolveRoomHost(host: RoomHost): ResolvedRoomHost {
  return {
    auth: host.auth,
    persistence: host.persistence,
    logger: host.logger ?? SILENT_LOGGER,
    clock: host.clock ?? PLATFORM_CLOCK,
  };
}
