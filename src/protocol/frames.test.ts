import * as syncProtocol from '@y/protocols/sync';
import { Doc, encodeStateVector } from '@y/y';
import * as decoding from 'lib0/decoding';
import { describe, expect, it } from 'vitest';
import { encodeAwarenessFrame, encodeSyncStep1, encodeSyncUpdate } from './frames.js';
import { CLOSE_CODES, MESSAGE_TYPES } from './messages.js';

describe('frame encoders', () => {
  it('COLLAB-PROTOCOL-1.4 writes sync step 1, sync update and awareness frames', () => {
    const doc = new Doc();
    doc.get('text').insert(0, 'a');

    const step1 = decoding.createDecoder(encodeSyncStep1(doc));
    const update = decoding.createDecoder(encodeSyncUpdate(new Uint8Array([1, 2])));
    const awareness = decoding.createDecoder(encodeAwarenessFrame(new Uint8Array([3])));

    expect([decoding.readVarUint(step1), decoding.readVarUint(step1)]).toEqual([
      MESSAGE_TYPES.sync,
      syncProtocol.messageYjsSyncStep1,
    ]);
    expect(decoding.readVarUint8Array(step1)).toEqual(encodeStateVector(doc));
    expect([decoding.readVarUint(update), decoding.readVarUint(update)]).toEqual([
      MESSAGE_TYPES.sync,
      syncProtocol.messageYjsUpdate,
    ]);
    expect(decoding.readVarUint8Array(update)).toEqual(new Uint8Array([1, 2]));
    expect(decoding.readVarUint(awareness)).toBe(MESSAGE_TYPES.awareness);
    expect(decoding.readVarUint8Array(awareness)).toEqual(new Uint8Array([3]));
  });

  it('COLLAB-PROTOCOL-1.4 names the server close codes', () => {
    expect(CLOSE_CODES).toEqual({
      shutdown: 1001,
      unavailable: 1011,
      badRequest: 4400,
      unauthenticated: 4401,
      forbidden: 4403,
      notFound: 4404,
      conflict: 4409,
    });
  });
});
