import type { RoomClock, RoomTimer } from '../protocol/clock.js';

/** Clients renew their presence every 15 s; a state not renewed for this long is gone. */
const AWARENESS_TIMEOUT_MS = 30_000;
const CHECK_INTERVAL_MS = AWARENESS_TIMEOUT_MS / 10;

/** When each presence in a room was last renewed, on the room's clock. */
export interface AwarenessExpiry {
  /** Records that these client ids published a state now. */
  renewed(ids: readonly number[]): void;
  /** Stops tracking ids whose states are gone. */
  forget(ids: readonly number[]): void;
  destroy(): void;
}

interface AwarenessExpiryOptions {
  clock: RoomClock;
  /** Called with the ids not renewed for `AWARENESS_TIMEOUT_MS`, which are then forgotten. */
  onExpired(ids: number[]): void;
}

/** Checks for expired presence every 3 s, holding a timer only while some presence is tracked. */
export function createAwarenessExpiry(options: AwarenessExpiryOptions): AwarenessExpiry {
  const { clock } = options;
  const renewedAt = new Map<number, number>();
  let timer: RoomTimer | null = null;

  const check = () => {
    timer = null;
    const now = clock.now();
    const expired = [...renewedAt].filter(([, at]) => now - at >= AWARENESS_TIMEOUT_MS);
    for (const [id] of expired) renewedAt.delete(id);
    if (expired.length > 0) options.onExpired(expired.map(([id]) => id));
    arm();
  };
  const arm = () => {
    if (timer === null && renewedAt.size > 0) timer = clock.setTimeout(check, CHECK_INTERVAL_MS);
  };

  return {
    renewed: (ids) => {
      const now = clock.now();
      for (const id of ids) renewedAt.set(id, now);
      arm();
    },
    forget: (ids) => {
      for (const id of ids) renewedAt.delete(id);
    },
    destroy: () => {
      renewedAt.clear();
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
