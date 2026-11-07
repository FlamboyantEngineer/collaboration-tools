import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { settle } from '../../test/server-sockets.js';
import { createStoreScheduler, type StoreOutcome } from './store-scheduler.js';

function scheduler(outcomes: StoreOutcome[] = []) {
  const clock = createManualClock();
  const stores: number[] = [];
  const store = createStoreScheduler({
    clock,
    debounceMs: 100,
    maxDebounceMs: 250,
    retryInitialMs: 50,
    retryMaxMs: 150,
    store: () => {
      stores.push(clock.now());
      return Promise.resolve(outcomes.shift() ?? 'stored');
    },
  });
  return { clock, stores, store };
}

describe('createStoreScheduler', () => {
  it('COLLAB-SERVER-4.2 stores after a quiet debounce, but no later than the maximum', async () => {
    const { clock, stores, store } = scheduler();
    const start = clock.now();

    store.markDirty();
    clock.advance(80);
    store.markDirty();
    clock.advance(80);
    store.markDirty();
    clock.advance(80);
    store.markDirty();
    clock.advance(100);
    await settle();

    expect(stores).toEqual([start + 250]);
    expect(store.isDirty()).toBe(false);
  });

  it('COLLAB-SERVER-4.2 retries a failed store with a doubling backoff up to the maximum', async () => {
    const { clock, stores, store } = scheduler(['retry', 'retry', 'retry', 'stored']);
    const start = clock.now();

    store.markDirty();
    for (const step of [100, 50, 100, 150]) {
      clock.advance(step);
      await settle();
    }

    expect(stores.map((at) => at - start)).toEqual([100, 150, 250, 400]);
    expect(store.isDirty()).toBe(false);
  });

  it('COLLAB-SERVER-4.2 drains until stored, and a cancel ends the wait', async () => {
    const { clock, stores, store } = scheduler(['retry', 'stored', 'retry']);
    store.markDirty();
    let drained = false;
    void store.drain().then(() => (drained = true));
    await settle();
    const afterFirst = drained;
    clock.advance(50);
    await settle();

    store.markDirty();
    let cancelled = false;
    void store.drain().then(() => (cancelled = true));
    await settle();
    store.cancel();
    await settle();

    expect(afterFirst).toBe(false);
    expect(drained).toBe(true);
    expect(stores).toHaveLength(3);
    expect(cancelled).toBe(true);
    expect(clock.pendingDelays()).toEqual([]);
  });
});
