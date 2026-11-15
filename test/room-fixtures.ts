import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, Type } from '@y/y';

const PARAGRAPHS = 6_000;
const LINE = 'The quick brown fox jumps over the lazy dog while the band plays on. '.repeat(2);

/** A room about a megabyte in size: nested paragraphs edited by several writers, and comments. */
export function largeRoom(): Doc {
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
export function changeOf(room: Doc, change: (copy: Doc) => void): Uint8Array {
  const copy = new Doc();
  applyUpdate(copy, encodeStateAsUpdate(room));
  const before = encodeStateVector(copy);
  change(copy);
  return encodeStateAsUpdate(copy, before);
}
