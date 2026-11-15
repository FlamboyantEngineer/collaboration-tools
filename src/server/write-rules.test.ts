import { encodeStateAsUpdate, type Type } from '@y/y';
import { describe, expect, it } from 'vitest';
import { changeOf, largeRoom } from '../../test/room-fixtures.js';
import type { RoomWriteRules } from './host/adapters.js';
import { checkWrite } from './write-rules.js';

describe('checkWrite', () => {
  it('COLLAB-SERVER-7.2 tells top-level types apart for each update of a large room without copying it', () => {
    const room = largeRoom();
    const rules: RoomWriteRules = { required: { comments: 'comment' }, otherwise: 'edit' };
    const keystroke = changeOf(room, (copy) => {
      (copy.get('content').get(4_321) as Type).insert(10, 'y');
    });
    const reply = changeOf(room, (copy) => copy.get('comments').setAttr('t77', 'reply'));
    const decide = (update: Uint8Array, capabilities: string[]) =>
      checkWrite(rules, {
        room: 'notes',
        doc: room,
        actor: { id: 'u' },
        capabilities: new Set(capabilities),
        update,
        guard: null,
      });

    const started = performance.now();
    for (let run = 0; run < 100; run++) {
      decide(keystroke, ['comment']);
      decide(reply, ['comment']);
    }
    const perCheckMs = (performance.now() - started) / 200;

    expect(encodeStateAsUpdate(room).length).toBeGreaterThan(1_000_000);
    expect(decide(keystroke, ['edit', 'comment'])).toEqual({ verdict: 'allowed' });
    expect(decide(keystroke, ['comment'])).toEqual({ verdict: 'refused', types: ['content'] });
    expect(decide(reply, ['comment'])).toEqual({ verdict: 'allowed' });
    // About 5 µs on a laptop; copying the room for one check takes tens of milliseconds.
    expect(perCheckMs).toBeLessThan(1);
  });
});
