import type { RoomClock } from '../protocol/clock.js';
import type { RoomWriteRefusalLimit } from './host/adapters.js';

/** How many conflicts a connection may have refused within a window when the rules name none. */
const DEFAULT_CONFLICT_LIMIT: RoomWriteRefusalLimit = { count: 10, windowMs: 60_000 };

/**
 * Counts one connection's conflict refusals in a sliding window (COLLAB-SERVER-7.7): `record()`
 * notes one now and says whether the connection is still within the limit.
 */
export function createConflictLimit(
  clock: RoomClock,
  limit: RoomWriteRefusalLimit = DEFAULT_CONFLICT_LIMIT,
): { record(): boolean } {
  const times: number[] = [];
  return {
    record() {
      const now = clock.now();
      while (times.length > 0 && now - (times[0] ?? now) >= limit.windowMs) times.shift();
      times.push(now);
      return times.length <= limit.count;
    },
  };
}
