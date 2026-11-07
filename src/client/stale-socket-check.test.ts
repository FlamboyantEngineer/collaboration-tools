import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { createStaleSocketCheck } from './stale-socket-check.js';

function setup() {
  const clock = createManualClock(0);
  let lastMessageAt = 0;
  const onStale = vi.fn();
  const check = createStaleSocketCheck({
    clock,
    timeoutMs: 10_000,
    cadenceMs: 1_000,
    lastMessageAt: () => lastMessageAt,
    onStale,
  });
  return { clock, check, onStale, received: () => (lastMessageAt = clock.now()) };
}

/** A clock whose scheduled passes run only when the test calls `run`, however late. */
function setupManual() {
  const clock = createManualClock(0);
  const timers: (() => void)[] = [];
  const onStale = vi.fn();
  const check = createStaleSocketCheck({
    clock: {
      ...clock,
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => timers.splice(0),
    },
    timeoutMs: 10_000,
    cadenceMs: 1_000,
    lastMessageAt: () => 0,
    onStale,
  });
  return { clock, check, onStale, run: () => timers.shift()?.() };
}

describe('createStaleSocketCheck', () => {
  it('COLLAB-CLIENT-2.2 reports a socket silent past the timeout once', () => {
    const { clock, check, onStale } = setup();
    check.start();

    clock.advance(10_000);
    const early = onStale.mock.calls.length;
    clock.advance(1_000);
    clock.advance(5_000);

    expect(early).toBe(0);
    expect(onStale).toHaveBeenCalledOnce();
  });

  it('COLLAB-CLIENT-2.2 keeps a socket that keeps receiving', () => {
    const { clock, check, onStale, received } = setup();
    check.start();

    for (let second = 0; second < 30; second += 1) {
      clock.advance(1_000);
      received();
    }

    expect(onStale).not.toHaveBeenCalled();
  });

  it('COLLAB-CLIENT-2.2 gives a full timeout after a late pass, for messages queued behind it', () => {
    const { clock, check, onStale, run } = setupManual();
    check.start();

    // A long task delays the first pass to 11 seconds, past the timeout.
    clock.advance(11_000);
    run();
    const afterLatePass = onStale.mock.calls.length;
    while (onStale.mock.calls.length === 0 && clock.now() < 30_000) {
      clock.advance(1_000);
      run();
    }

    expect(afterLatePass).toBe(0);
    expect(clock.now()).toBe(22_000);
  });

  it('COLLAB-CLIENT-2.2 measures silence from the first of several late passes', () => {
    const { clock, check, onStale, run } = setupManual();
    check.start();

    // Every pass runs three cadences late, as timers do in a throttled tab.
    while (onStale.mock.calls.length === 0 && clock.now() < 60_000) {
      clock.advance(3_000);
      run();
    }

    expect(onStale).toHaveBeenCalledOnce();
    expect(clock.now()).toBe(15_000);
  });

  it('COLLAB-CLIENT-2.2 runs no pass after stop', () => {
    const { clock, check, onStale } = setup();
    check.start();
    check.stop();

    clock.advance(60_000);

    expect(onStale).not.toHaveBeenCalled();
    expect(clock.pendingDelays()).toEqual([]);
  });
});
