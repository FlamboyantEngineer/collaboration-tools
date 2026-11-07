import type { RoomClock, RoomTimer } from '../src/protocol/clock.js';

interface Scheduled {
  id: number;
  at: number;
  callback: () => void;
}

/** A {@link RoomClock} that moves only when a test advances it. */
export interface ManualClock extends RoomClock {
  /** Moves time forward, running each callback that comes due, in order. */
  advance(ms: number): void;
  /** Delays of the callbacks still scheduled, from now. */
  pendingDelays(): number[];
}

export function createManualClock(start = 1_000): ManualClock {
  let now = start;
  let nextId = 1;
  let scheduled: Scheduled[] = [];

  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = scheduled
        .filter((entry) => entry.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      scheduled = scheduled.filter((entry) => entry !== due);
      now = due.at;
      due.callback();
    }
    now = end;
  };

  return {
    now: () => now,
    setTimeout: (callback, delayMs): RoomTimer => {
      const id = nextId++;
      scheduled.push({ id, at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (timer) => {
      scheduled = scheduled.filter((entry) => entry.id !== timer);
    },
    advance,
    pendingDelays: () => scheduled.map((entry) => entry.at - now).sort((a, b) => a - b),
  };
}
