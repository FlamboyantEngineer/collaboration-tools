import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import {
  AUTH_SUBTYPES,
  type AuthMessage,
  encodeAuthMessage,
  encodeStatelessMessage,
  isRoomAccess,
  MESSAGE_TYPES,
  readAuthMessage,
  readStatelessMessage,
} from './messages.js';

function decoderAfterType(frame: Uint8Array, type: number) {
  const decoder = decoding.createDecoder(frame);
  expect(decoding.readVarUint(decoder)).toBe(type);
  return decoder;
}

describe('protocol messages', () => {
  it('COLLAB-PROTOCOL-1.1 numbers the message types as the y-websocket protocol does', () => {
    expect(MESSAGE_TYPES).toEqual({
      sync: 0,
      awareness: 1,
      auth: 2,
      queryAwareness: 3,
      stateless: 5,
    });
  });

  it.each<AuthMessage>([
    { type: 'granted', access: 'read-write' },
    { type: 'granted', access: 'read-only' },
    { type: 'denied', reason: 'forbidden' },
  ])('COLLAB-PROTOCOL-1.2 round-trips the auth message %o', (message) => {
    const frame = encodeAuthMessage(message);

    expect(readAuthMessage(decoderAfterType(frame, MESSAGE_TYPES.auth))).toEqual(message);
  });

  it('COLLAB-PROTOCOL-1.2 writes a refusal as the y-protocols permission-denied message', () => {
    const decoder = decoderAfterType(
      encodeAuthMessage({ type: 'denied', reason: 'expired' }),
      MESSAGE_TYPES.auth,
    );

    expect(decoding.readVarUint(decoder)).toBe(AUTH_SUBTYPES.denied);
    expect(decoding.readVarString(decoder)).toBe('expired');
  });

  it('COLLAB-PROTOCOL-1.2 ignores an auth subtype or access it does not know', () => {
    const unknown = (subtype: number, text: string) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, subtype);
      encoding.writeVarString(encoder, text);
      return readAuthMessage(decoding.createDecoder(encoding.toUint8Array(encoder)));
    };

    expect(unknown(7, 'read-write')).toBeNull();
    expect(unknown(AUTH_SUBTYPES.granted, 'readonly')).toBeNull();
    expect(isRoomAccess('read-only')).toBe(true);
    expect(isRoomAccess('admin')).toBe(false);
  });

  it('COLLAB-PROTOCOL-1.3 round-trips a stateless payload', () => {
    const frame = encodeStatelessMessage('{"saved":true}');

    expect(readStatelessMessage(decoderAfterType(frame, MESSAGE_TYPES.stateless))).toBe(
      '{"saved":true}',
    );
  });
});
