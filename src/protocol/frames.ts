import * as syncProtocol from '@y/protocols/sync';
import type { Doc } from '@y/y';
import * as encoding from 'lib0/encoding';
import { MESSAGE_TYPES } from './messages.js';

/** A sync step 1 frame: the document's state vector, asking for what it is missing. */
export function encodeSyncStep1(doc: Doc): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPES.sync);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** A sync update frame carrying `update`. */
export function encodeSyncUpdate(update: Uint8Array): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPES.sync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** An awareness frame carrying an encoded awareness update. */
export function encodeAwarenessFrame(update: Uint8Array): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPES.awareness);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
