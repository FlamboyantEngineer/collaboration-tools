import { applyAwarenessUpdate, Awareness } from '@y/protocols/awareness';
import { Doc } from '@y/y';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it, vi } from 'vitest';
import { encodeStatelessMessage, MESSAGE_TYPES } from '../protocol/messages.js';
import { type FrameContext, readServerFrame } from './frames.js';

function context(doc = new Doc()): FrameContext {
  return {
    doc,
    awareness: new Awareness(doc),
    origin: {},
    onRemoteUpdate: vi.fn(),
    onAuth: vi.fn(),
    onStateless: vi.fn(),
  };
}

describe('readServerFrame', () => {
  it('COLLAB-CLIENT-4.1 answers a query with every awareness state it knows', () => {
    const reader = context();
    reader.awareness.setLocalState({ name: 'Ada' });
    const query = encoding.encode((encoder) =>
      encoding.writeVarUint(encoder, MESSAGE_TYPES.queryAwareness),
    );

    const reply = readServerFrame(query, reader);
    if (!reply) throw new Error('expected a reply');
    const decoder = decoding.createDecoder(reply);
    const peer = new Awareness(new Doc());
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_TYPES.awareness);
    applyAwarenessUpdate(peer, decoding.readVarUint8Array(decoder), null);

    expect(peer.getStates().get(reader.awareness.clientID)).toEqual({ name: 'Ada' });
  });

  it('COLLAB-PROTOCOL-1.1 stops reading a frame at a message type it does not know', () => {
    const reader = context();
    const frame = encoding.encode((encoder) => {
      encoding.writeVarUint(encoder, 42);
      encoding.writeUint8Array(encoder, encodeStatelessMessage('after'));
    });

    expect(readServerFrame(frame, reader)).toBeNull();
    expect(reader.onStateless).not.toHaveBeenCalled();
  });

  it('COLLAB-PROTOCOL-1.1 reads several messages from one frame', () => {
    const reader = context();
    const frame = encoding.encode((encoder) => {
      encoding.writeUint8Array(encoder, encodeStatelessMessage('one'));
      encoding.writeUint8Array(encoder, encodeStatelessMessage('two'));
    });

    readServerFrame(frame, reader);

    expect(reader.onStateless).toHaveBeenNthCalledWith(1, 'one');
    expect(reader.onStateless).toHaveBeenNthCalledWith(2, 'two');
  });
});
