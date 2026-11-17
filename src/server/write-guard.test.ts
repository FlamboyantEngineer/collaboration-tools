import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  type Transaction,
  type Type,
} from '@y/y';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { changeOf, largeRoom } from '../../test/room-fixtures.js';
import type { RoomWriteChange } from './host/adapters.js';
import { openShadowGuard, type ShadowDrift, type ShadowSelfCheck } from './write-guard.js';

const CHANGE: RoomWriteChange = {
  room: 'notes',
  actor: { id: 'u' },
  capabilities: new Set(),
  changes: new Map(),
};

/** A self-check that verifies only on idle and records each repair. */
function quietCheck(repairs: ShadowDrift[] = [], overrides: Partial<ShadowSelfCheck> = {}) {
  return {
    clock: createManualClock(),
    idleMs: 2000,
    onRepair: (reason: ShadowDrift) => repairs.push(reason),
    ...overrides,
  };
}

/** Applies `update` to `room` as the room server does once the guard allows it. */
function take(room: Doc, update: Uint8Array) {
  applyUpdate(room, update);
}

describe('openShadowGuard', () => {
  it('COLLAB-SERVER-7.2 checks each update of a large room at the cost of the update, not the room', () => {
    const room = largeRoom();
    const seen: Transaction[] = [];
    const guard = openShadowGuard(
      room,
      () => ({
        check: ({ transaction }) => seen.push(transaction) > 0,
      }),
      quietCheck(),
    );
    const writer = new Doc();
    applyUpdate(writer, encodeStateAsUpdate(room));
    const keystrokes = Array.from({ length: 100 }, (_, index) => {
      const before = encodeStateVector(writer);
      (writer.get('content').get(index * 7) as Type).insert(3, 'y');
      return encodeStateAsUpdate(writer, before);
    });

    const started = performance.now();
    for (const keystroke of keystrokes) {
      expect(guard.check(CHANGE, keystroke)).toBe(true);
      take(room, keystroke);
    }
    const perCheckMs = (performance.now() - started) / keystrokes.length;

    expect(encodeStateAsUpdate(room).length).toBeGreaterThan(1_000_000);
    expect(seen).toHaveLength(100);
    // Well under a millisecond per check and apply; a copy of this room takes tens of milliseconds.
    expect(perCheckMs).toBeLessThan(5);
    guard.destroy();
    writer.destroy();
    room.destroy();
  });

  it('COLLAB-SERVER-7.2 passes the owned candidate transaction even when observers enqueue cleanup', () => {
    const room = new Doc();
    room.get('body').insert(0, 'before');
    const before = new WeakMap<Transaction, string>();
    const guard = openShadowGuard(
      room,
      (shadow) => {
        shadow.on('beforeTransaction', (transaction: Transaction) =>
          before.set(transaction, shadow.get('body').toString()),
        );
        shadow.on('afterTransaction', (transaction: Transaction) => {
          if (transaction.changed.size > 0) shadow.transact(() => undefined);
        });
        return {
          check: ({ transaction }) => {
            expect(before.get(transaction)).toBe('before');
            expect(transaction.changed.size).toBeGreaterThan(0);
            expect(transaction.doc.get('body').toString()).toBe('after before');
            return true;
          },
        };
      },
      quietCheck(),
    );
    expect(
      guard.check(
        CHANGE,
        changeOf(room, (copy) => copy.get('body').insert(0, 'after ')),
      ),
    ).toBe(true);
    guard.destroy();
    room.destroy();
  });

  it('COLLAB-SERVER-7.2 rebuilds the shadow from the room as soon as it refuses', () => {
    const room = new Doc();
    room.get('body').insert(0, 'seed');
    const shadows: Doc[] = [];
    const guard = openShadowGuard(
      room,
      (shadow) => {
        shadows.push(shadow);
        return {
          check: ({ transaction }) => !transaction.doc.get('body').toString().includes('no'),
        };
      },
      quietCheck(),
    );
    const refused = changeOf(room, (copy) => copy.get('body').insert(0, 'no '));
    const allowed = changeOf(room, (copy) => copy.get('body').insert(4, '!'));

    expect(guard.check(CHANGE, refused)).toBe(false);
    expect(shadows.map((shadow) => shadow.isDestroyed)).toEqual([true, false]);
    expect(shadows[1]?.get('body').toString()).toBe('seed');
    room.get('body').insert(0, 'host ');
    expect(guard.check(CHANGE, allowed)).toBe(true);
    expect(shadows[1]?.get('body').toString()).toBe('host seed!');
    guard.destroy();
    expect(shadows[1]?.isDestroyed).toBe(true);
  });

  it('COLLAB-SERVER-7.2 refuses while a guard cannot be reopened, and recovers once it can', () => {
    const room = new Doc();
    let failing = false;
    const guard = openShadowGuard(
      room,
      () => {
        if (failing) throw new Error('guard failed');
        return {
          check: ({ transaction }) => {
            if (transaction.doc.get('body').toString() === 'boom') throw new Error('broken guard');
            return true;
          },
        };
      },
      quietCheck(),
    );
    const boom = changeOf(room, (copy) => copy.get('body').insert(0, 'boom'));
    const fine = changeOf(room, (copy) => copy.get('body').insert(0, 'fine'));

    failing = true;
    expect(guard.check(CHANGE, boom)).toBe(false);
    expect(guard.check(CHANGE, fine)).toBe(false);
    failing = false;
    expect(guard.check(CHANGE, fine)).toBe(true);
    guard.destroy();
  });

  it('COLLAB-SERVER-7.6 keeps the shadow equal to the room after every accepted and every refused change', () => {
    const room = new Doc();
    room.get('body').insert(0, 'seed');
    let shadow: Doc | null = null;
    const repairs: ShadowDrift[] = [];
    const guard = openShadowGuard(
      room,
      (opened) => {
        shadow = opened;
        return {
          check: ({ transaction }) => !transaction.doc.get('body').toString().includes('#'),
        };
      },
      quietCheck(repairs),
    );
    const sameAsRoom = () =>
      shadow !== null &&
      shadow.get('body').toString() === room.get('body').toString() &&
      encodeStateVector(shadow).join() === encodeStateVector(room).join();

    for (let step = 0; step < 40; step++) {
      const text = step % 3 === 0 ? '#' : String(step % 10);
      const update = changeOf(room, (copy) => copy.get('body').insert(step % 4, text));
      const allowed = guard.check(CHANGE, update);
      expect(allowed).toBe(text !== '#');
      if (allowed) take(room, update);
      expect(sameAsRoom()).toBe(true);
    }
    expect(repairs).toEqual([]);
    guard.destroy();
  });

  it('COLLAB-SERVER-7.6 rebuilds and reports a shadow whose counters drift from the room', () => {
    const room = new Doc();
    room.get('body').insert(0, 'seed');
    const shadows: Doc[] = [];
    const repairs: ShadowDrift[] = [];
    const guard = openShadowGuard(
      room,
      (shadow) => {
        shadows.push(shadow);
        return { check: () => true };
      },
      quietCheck(repairs),
    );
    // Something outside the guard writes to its shadow: the next room change finds it drifted.
    shadows[0]?.get('body').insert(0, 'forged ');
    take(
      room,
      changeOf(room, (copy) => copy.get('body').insert(4, '!')),
    );

    expect(repairs).toEqual(['counters']);
    expect(shadows[0]?.isDestroyed).toBe(true);
    expect(shadows[1]?.get('body').toString()).toBe('seed!');
    guard.destroy();
  });

  it('COLLAB-SERVER-7.6 verifies the guard every N changes and on idle, rebuilding a drifted reading', () => {
    const room = new Doc();
    const clock = createManualClock();
    const repairs: ShadowDrift[] = [];
    let verified = 0;
    let drifted = false;
    let opens = 0;
    const guard = openShadowGuard(
      room,
      () => {
        opens++;
        return {
          check: () => true,
          verify: () => {
            verified++;
            return !drifted;
          },
        };
      },
      quietCheck(repairs, { clock, verifyEvery: 3, idleMs: 500 }),
    );
    const edit = () =>
      take(
        room,
        changeOf(room, (copy) => copy.get('body').insert(0, 'x')),
      );

    edit();
    edit();
    expect(verified).toBe(0);
    edit();
    expect(verified).toBe(1);
    clock.advance(499);
    expect(verified).toBe(1);
    clock.advance(1);
    expect(verified).toBe(2);
    clock.advance(5_000);
    expect(verified).toBe(2);

    drifted = true;
    edit();
    clock.advance(500);
    expect(repairs).toEqual(['reading']);
    expect(opens).toBe(2);
    guard.destroy();
    expect(clock.pendingDelays()).toEqual([]);
  });

  it('COLLAB-SERVER-7.6 rebuilds and reports a shadow that differs from the room by a deletion alone', () => {
    const room = new Doc();
    room.get('body').insert(0, 'seed text');
    const clock = createManualClock();
    const shadows: Doc[] = [];
    const repairs: ShadowDrift[] = [];
    const guard = openShadowGuard(
      room,
      (shadow) => {
        shadows.push(shadow);
        // A guard whose reading agrees with its shadow, whatever the shadow holds.
        return { check: () => true, verify: () => true };
      },
      quietCheck(repairs, { clock, idleMs: 500 }),
    );
    // The shadow loses a word the room keeps: a deletion changes no state vector.
    shadows[0]?.get('body').delete(0, 5);
    take(
      room,
      changeOf(room, (copy) => copy.get('body').insert(9, '!')),
    );
    expect(repairs).toEqual([]);
    clock.advance(500);
    expect(repairs).toEqual(['content']);
    expect(shadows[1]?.get('body').toString()).toBe('seed text!');
    guard.destroy();
  });

  it('COLLAB-SERVER-7.6 verifies a busy room by count by default, and at the latest ten idle periods in', () => {
    const room = new Doc();
    const clock = createManualClock();
    let verified = 0;
    const guard = openShadowGuard(
      room,
      () => ({
        check: () => true,
        verify: () => {
          verified++;
          return true;
        },
      }),
      quietCheck([], { clock, idleMs: 500 }),
    );
    const edit = () =>
      take(
        room,
        changeOf(room, (copy) => copy.get('body').insert(0, 'x')),
      );
    // A change every 400 ms never lets the room go idle: ten idle periods after the first, it
    // verifies anyway.
    for (let step = 0; step < 14; step++) {
      edit();
      clock.advance(400);
    }
    expect(verified).toBe(1);
    // With changes faster than that, every hundredth change verifies.
    verified = 0;
    for (let step = 0; step < 100; step++) edit();
    expect(verified).toBe(1);
    guard.destroy();
  });
});
