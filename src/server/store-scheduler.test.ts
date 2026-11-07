import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { createDeferred } from '../../test/promise-fixtures.js';
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

  it('COLLAB-SERVER-4.2 holds new changes for a failed store’s retry instead of debouncing them', async () => {
    const { clock, stores, store } = scheduler(['retry', 'stored']);
    const start = clock.now();

    store.markDirty();
    clock.advance(100);
    await settle();
    clock.advance(10);
    store.markDirty();
    clock.advance(40);
    await settle();

    expect(stores.map((at) => at - start)).toEqual([100, 150]);
    expect(store.isDirty()).toBe(false);
  });

  it('COLLAB-SERVER-8.3 COLLAB-SERVER-8.4 reports its status and resolves waiters once their changes are stored', async () => {
    const { clock, store } = scheduler(['stored', 'abandoned']);
    const clean = await store.whenStored();
    store.markDirty();
    const first = store.whenStored();
    const status = store.status();
    clock.advance(100);
    await settle();

    store.markDirty();
    const second = store.whenStored();
    clock.advance(100);
    await settle();

    expect([clean, status]).toEqual([true, 'unsaved']);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    await expect(store.whenStored()).resolves.toBe(false);
  });
});

it('COLLAB-SERVER-4.2 does not schedule a retry after cancellation during a store', async () => {
  const clock = createManualClock();
  const pending = createDeferred<StoreOutcome>();
  const store = createStoreScheduler({
    clock,
    debounceMs: 100,
    maxDebounceMs: 250,
    retryInitialMs: 50,
    retryMaxMs: 150,
    store: () => pending.promise,
  });
  store.markDirty();
  const receipt = store.whenStored();
  const flushing = store.flush();
  store.cancel();
  pending.resolve('retry');
  await flushing;

  await expect(receipt).resolves.toBe(false);
  expect(clock.pendingDelays()).toEqual([]);
});
