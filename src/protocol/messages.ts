import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** What a connection may do in its room. */
export type RoomAccess = 'read-write' | 'read-only';

/**
 * The first varUint of every frame. Sync, awareness, auth and query-awareness are the y-websocket
 * message types; stateless carries a host string to or from the room.
 */
export const MESSAGE_TYPES = Object.freeze({
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  stateless: 5,
});

/**
 * The close codes a server closes a socket with. A client reconnects after any of them except a
 * refusal, which arrives as an auth denied message first.
 */
export const CLOSE_CODES = Object.freeze({
  /** The server is shutting down. */
  shutdown: 1001,
  /** Storage failed while the room opened; try again later. */
  unavailable: 1011,
  /** The URL names no room, or a frame cannot be read. */
  badRequest: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
  /** Another writer stored the room first; reconnect to load what it stored. */
  conflict: 4409,
});

/** The auth message subtypes. `denied` is y-protocols' permission-denied message. */
export const AUTH_SUBTYPES = Object.freeze({ denied: 0, granted: 1 });

export type AuthMessage =
  { type: 'granted'; access: RoomAccess } | { type: 'denied'; reason: string };

const ACCESS_VALUES: ReadonlySet<string> = new Set<RoomAccess>(['read-write', 'read-only']);

/** Whether `value` is a {@link RoomAccess}. */
export function isRoomAccess(value: unknown): value is RoomAccess {
  return typeof value === 'string' && ACCESS_VALUES.has(value);
}

/** Encodes a whole auth frame, message type included. */
export function encodeAuthMessage(message: AuthMessage): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPES.auth);
  if (message.type === 'granted') {
    encoding.writeVarUint(encoder, AUTH_SUBTYPES.granted);
    encoding.writeVarString(encoder, message.access);
  } else {
    encoding.writeVarUint(encoder, AUTH_SUBTYPES.denied);
    encoding.writeVarString(encoder, message.reason);
  }
  return encoding.toUint8Array(encoder);
}

/**
 * Reads an auth message after its message type. Returns `null` for a subtype or access this
 * version does not know, which a reader ignores.
 */
export function readAuthMessage(decoder: decoding.Decoder): AuthMessage | null {
  const subtype = decoding.readVarUint(decoder);
  const text = decoding.readVarString(decoder);
  if (subtype === AUTH_SUBTYPES.denied) return { type: 'denied', reason: text };
  if (subtype === AUTH_SUBTYPES.granted && isRoomAccess(text)) {
    return { type: 'granted', access: text };
  }
  return null;
}

/** Encodes a whole stateless frame carrying `payload`. */
export function encodeStatelessMessage(payload: string): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPES.stateless);
  encoding.writeVarString(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/** Reads a stateless message's payload after its message type. */
export function readStatelessMessage(decoder: decoding.Decoder): string {
  return decoding.readVarString(decoder);
}
