import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, Type } from '@y/y';
import { describe, expect, it } from 'vitest';
import type { RoomWriteRules } from './host/adapters.js';
import { checkWrite } from './write-rules.js';

const PARAGRAPHS = 6_000;
const LINE = 'The quick brown fox jumps over the lazy dog while the band plays on. '.repeat(2);

/** A room about a megabyte in size: nested paragraphs edited by several writers, and comments. */
function largeRoom(): Doc {
  const room = new Doc();
  room.transact(() => {
    const paragraphs = Array.from({ length: PARAGRAPHS }, () => {
      const paragraph = new Type();
      paragraph.insert(0, LINE);
      return paragraph;
    });
    room.get('content').insert(0, paragraphs);
  });
  for (let writer = 0; writer < 3; writer++) {
    const peer = new Doc();
    applyUpdate(peer, encodeStateAsUpdate(room));
    const paragraphs = peer.get('content').toArray() as Type[];
    peer.transact(() => {
      for (let edit = 0; edit < 2_000; edit++) {
        paragraphs[(edit * 37 + writer) % PARAGRAPHS]?.insert(edit % 40, 'x');
      }
    });
    applyUpdate(room, encodeStateAsUpdate(peer, encodeStateVector(room)));
  }
  for (let thread = 0; thread < 500; thread++) room.get('comments').setAttr(`t${thread}`, 'note');
  return room;
}

/** The update `change` makes to a copy of `room`. */
function changeOf(room: Doc, change: (copy: Doc) => void): Uint8Array {
  const copy = new Doc();
  applyUpdate(copy, encodeStateAsUpdate(room));
  const before = encodeStateVector(copy);
  change(copy);
  return encodeStateAsUpdate(copy, before);
}

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
