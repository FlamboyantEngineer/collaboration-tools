import { applyUpdate, Doc, encodeStateAsUpdate, type Transaction, type Type } from '@y/y';
import { describe, expect, it } from 'vitest';
import { changeOf, largeRoom } from '../../test/room-fixtures.js';
import type { RoomWriteChange } from './host/adapters.js';
import { openShadowGuard } from './write-guard.js';

const CHANGE: RoomWriteChange = {
  room: 'notes',
  actor: { id: 'u' },
  capabilities: new Set(),
  changes: new Map(),
};

/** Applies `update` to `room` as the room server does once the guard allows it. */
function take(room: Doc, update: Uint8Array) {
  applyUpdate(room, update);
}

describe('openShadowGuard', () => {
  it('COLLAB-SERVER-7.2 checks each update of a large room at the cost of the update, not the room', () => {
    const room = largeRoom();
    const seen: Transaction[] = [];
    const guard = openShadowGuard(room, () => ({
      check: ({ transaction }) => seen.push(transaction) > 0,
    }));
    room.on('update', (update: Uint8Array) => guard.follow(update));
    // One writer's keystrokes, each its own update, made on one copy of the room.
    const writer = new Doc();
    applyUpdate(writer, encodeStateAsUpdate(room));
    const keystrokes: Uint8Array[] = [];
    writer.on('update', (update: Uint8Array) => keystrokes.push(update));
    for (let index = 0; index < 100; index++) {
      (writer.get('content').get(index * 7) as Type).insert(3, 'y');
    }

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
  });

  it('COLLAB-SERVER-7.2 rebuilds the shadow from the room at the next check after a refusal', () => {
    const room = new Doc();
    room.get('body').insert(0, 'seed');
    const shadows: Doc[] = [];
    const guard = openShadowGuard(room, (shadow) => {
      shadows.push(shadow);
      return { check: ({ transaction }) => !transaction.doc.get('body').toString().includes('no') };
    });
    room.on('update', (update: Uint8Array) => guard.follow(update));
    const refused = changeOf(room, (copy) => copy.get('body').insert(0, 'no '));
    const allowed = changeOf(room, (copy) => copy.get('body').insert(4, '!'));

    expect(guard.check(CHANGE, refused)).toBe(false);
    expect(shadows.map((shadow) => shadow.isDestroyed)).toEqual([true]);
    room.get('body').insert(0, 'host ');
    expect(guard.check(CHANGE, allowed)).toBe(true);
    expect(shadows[1]?.get('body').toString()).toBe('host seed!');
    guard.destroy();
    expect(shadows[1]?.isDestroyed).toBe(true);
  });

  it('COLLAB-SERVER-7.2 refuses while a guard cannot be reopened, and recovers once it can', () => {
    const room = new Doc();
    let failing = false;
    const guard = openShadowGuard(room, () => {
      if (failing) throw new Error('guard failed');
      return {
        check: ({ transaction }) => {
          if (transaction.doc.get('body').toString() === 'boom') throw new Error('broken guard');
          return true;
        },
      };
    });
    const boom = changeOf(room, (copy) => copy.get('body').insert(0, 'boom'));
    const fine = changeOf(room, (copy) => copy.get('body').insert(0, 'fine'));

    expect(guard.check(CHANGE, boom)).toBe(false);
    failing = true;
    expect(guard.check(CHANGE, fine)).toBe(false);
    failing = false;
    expect(guard.check(CHANGE, fine)).toBe(true);
    guard.destroy();
  });
});
