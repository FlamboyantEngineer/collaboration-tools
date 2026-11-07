import { describe, expect, it } from 'vitest';
import { createMemoryPersistence } from './memory-persistence.js';

function counter() {
  let next = 0;
  return () => `r${(next += 1)}`;
}

describe('createMemoryPersistence', () => {
  it('COLLAB-HOST-3.1 reports a room it never stored as missing', async () => {
    const persistence = createMemoryPersistence();

    await expect(persistence.load('room-a')).resolves.toEqual({ status: 'missing' });
  });

  it('COLLAB-HOST-3.1 returns the state it stored, with a new revision and the next sequence', async () => {
    const persistence = createMemoryPersistence({ createRevision: counter() });

    const first = await persistence.store({
      room: 'room-a',
      update: new Uint8Array([1]),
      baseRevision: null,
    });
    const second = await persistence.store({
      room: 'room-a',
      update: new Uint8Array([2]),
      baseRevision: 'r1',
    });

    expect(first).toEqual({ status: 'stored', revision: 'r1', sequence: 1 });
    expect(second).toEqual({ status: 'stored', revision: 'r2', sequence: 2 });
    await expect(persistence.load('room-a')).resolves.toEqual({
      status: 'found',
      state: { update: new Uint8Array([2]), revision: 'r2', sequence: 2 },
    });
  });

  it('COLLAB-HOST-3.2 refuses a store built on a revision that is no longer current', async () => {
    const persistence = createMemoryPersistence({ createRevision: counter() });
    await persistence.store({ room: 'room-a', update: new Uint8Array([1]), baseRevision: null });

    const stale = await persistence.store({
      room: 'room-a',
      update: new Uint8Array([9]),
      baseRevision: null,
    });

    expect(stale).toEqual({ status: 'conflict', current: { revision: 'r1', sequence: 1 } });
    expect(persistence.peek('room-a')?.update).toEqual(new Uint8Array([1]));
  });

  it('COLLAB-HOST-3.2 refuses a store on a revision for a room that has none', async () => {
    const persistence = createMemoryPersistence();

    const result = await persistence.store({
      room: 'room-a',
      update: new Uint8Array([1]),
      baseRevision: 'r7',
    });

    expect(result).toEqual({ status: 'conflict', current: null });
  });

  it('COLLAB-HOST-3.3 keeps its own copy of every state it receives or returns', async () => {
    const update = new Uint8Array([1, 2]);
    const persistence = createMemoryPersistence({
      initial: { 'room-a': { update, revision: 'seed', sequence: 4 } },
    });

    update[0] = 9;
    const loaded = await persistence.load('room-a');
    if (loaded.status !== 'found') throw new Error('expected the seeded state');
    loaded.state.update[1] = 9;

    expect(persistence.peek('room-a')).toEqual({
      update: new Uint8Array([1, 2]),
      revision: 'seed',
      sequence: 4,
    });
  });

  it('COLLAB-HOST-3.1 continues the sequence of a seeded room', async () => {
    const persistence = createMemoryPersistence({
      createRevision: counter(),
      initial: { 'room-a': { update: new Uint8Array([1]), revision: 'seed', sequence: 4 } },
    });

    const result = await persistence.store({
      room: 'room-a',
      update: new Uint8Array([2]),
      baseRevision: 'seed',
    });

    expect(result).toEqual({ status: 'stored', revision: 'r1', sequence: 5 });
  });
});
