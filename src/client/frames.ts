import * as awarenessProtocol from '@y/protocols/awareness';
import * as syncProtocol from '@y/protocols/sync';
import { applyUpdate, type Doc } from '@y/y';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { encodeAwarenessFrame } from '../protocol/frames.js';
import {
  type AuthMessage,
  MESSAGE_TYPES,
  readAuthMessage,
  readStatelessMessage,
} from '../protocol/messages.js';

/** What reading a server frame needs from the provider. */
export interface FrameContext {
  doc: Doc;
  awareness: awarenessProtocol.Awareness;
  /** The transaction origin of updates the server sends. */
  origin: unknown;
  onRemoteUpdate(update: Uint8Array, isSyncStep2: boolean): void;
  onAuth(message: AuthMessage): void;
  onStateless(payload: string): void;
}

function readSync(decoder: decoding.Decoder, reply: encoding.Encoder, context: FrameContext) {
  const syncType = decoding.readVarUint(decoder);
  if (syncType === syncProtocol.messageYjsSyncStep1) {
    encoding.writeVarUint(reply, MESSAGE_TYPES.sync);
    syncProtocol.readSyncStep1(decoder, reply, context.doc);
    return;
  }
  const update = decoding.readVarUint8Array(decoder);
  applyUpdate(context.doc, update, context.origin);
  context.onRemoteUpdate(update, syncType === syncProtocol.messageYjsSyncStep2);
}

function writeAllAwareness(reply: encoding.Encoder, awareness: awarenessProtocol.Awareness) {
  encoding.writeUint8Array(
    reply,
    encodeAwarenessState(awareness, [...awareness.getStates().keys()]),
  );
}

/**
 * Reads every message in a server frame and returns the reply to send, or `null`. Message types
 * this version does not know end the frame, as a newer server may add them.
 */
export function readServerFrame(
  frame: Uint8Array,
  context: FrameContext,
): Uint8Array<ArrayBuffer> | null {
  const decoder = decoding.createDecoder(frame);
  const reply = encoding.createEncoder();
  while (decoding.hasContent(decoder)) {
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_TYPES.sync) readSync(decoder, reply, context);
    else if (type === MESSAGE_TYPES.awareness) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(context.awareness, update, context.origin);
    } else if (type === MESSAGE_TYPES.queryAwareness) writeAllAwareness(reply, context.awareness);
    else if (type === MESSAGE_TYPES.auth) {
      const message = readAuthMessage(decoder);
      if (message) context.onAuth(message);
    } else if (type === MESSAGE_TYPES.stateless) context.onStateless(readStatelessMessage(decoder));
    else break;
  }
  return encoding.length(reply) > 0 ? encoding.toUint8Array(reply) : null;
}

/** An awareness frame with the given clients' states, or with `states` in their place. */
export function encodeAwarenessState(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
  states?: Map<number, Record<string, unknown>>,
): Uint8Array<ArrayBuffer> {
  return encodeAwarenessFrame(awarenessProtocol.encodeAwarenessUpdate(awareness, clients, states));
}
