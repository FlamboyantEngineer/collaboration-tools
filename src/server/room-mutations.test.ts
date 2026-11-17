import { Doc, encodeStateVector } from '@y/y';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import type { LiveRoom } from './live-room.js';
import { mutateRoom } from './room-mutations.js';
import { openShadowGuard, type ShadowDrift } from './write-guard.js';

describe('mutateRoom', () => {
  it('COLLAB-SERVER-7.6 gives the room an admitted change before it records the writer', () => {
    const doc = new Doc();
    doc.get('body').insert(0, 'seed text');
    const repairs: ShadowDrift[] = [];
    let shadow: Doc | null = null;
    const guard = openShadowGuard(
      doc,
      (opened) => {
        shadow = opened;
        return { check: () => true };
      },
      { clock: createManualClock(), idleMs: 2000, onRepair: (reason) => repairs.push(reason) },
    );
    const held: string[] = [];
    // Records the writer, failing once the room already holds the change.
    const room = {
      name: 'notes',
      doc,
      rules: {},
      guard,
      accepting: true,
      edited: () => {
        held.push(doc.get('body').toString());
        throw new Error('The bookkeeping failed.');
      },
    } as unknown as LiveRoom;

    expect(() =>
      mutateRoom(room, { actor: { id: 'service' }, capabilities: [] }, (copy) =>
        copy.get('body').delete(0, 5),
      ),
    ).toThrow('The bookkeeping failed.');
    expect(held).toEqual(['text']);
    expect((shadow as Doc | null)?.get('body').toString()).toBe('text');
    expect(encodeStateVector(shadow ?? new Doc())).toEqual(encodeStateVector(doc));
    expect(repairs).toEqual([]);
    guard.destroy();
  });
});
