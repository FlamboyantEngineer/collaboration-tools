import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** What a connection may do in its room. */
export type RoomAccess = 'read-write' | 'read-only';

/**
 * The first varUint of every frame. Sync, awareness, auth and query-awareness are the y-websocket
 * message types; stateless carries a host string to or from the room, and storage reports what
 * the room has stored.
 */
export const MESSAGE_TYPES = Object.freeze({
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  stateless: 5,
  storage: 6,
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
  /** The client's document is from an older generation of the room. */
  gone: 4410,
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

/**
 * Whether a room's changes are stored: `saved` when every change is, `unsaved` while changes
 * wait for the next store, `saving` while a store runs and `retrying` after a store failed.
 */
export type RoomSaveStatus = 'saved' | 'unsaved' | 'saving' | 'retrying';

/** The save statuses in their wire order. */
const SAVE_STATUSES: readonly RoomSaveStatus[] = ['saved', 'unsaved', 'saving', 'retrying'];

/** The storage message subtypes. */
export const STORAGE_SUBTYPES = Object.freeze({ status: 0, receiptRequest: 1, receipt: 2 });

/**
 * A storage message: the server's save `status`, a client's `receipt-request`, which asks to be
 * told once everything it sent before is stored, and the server's `receipt` for that request.
 */
export type StorageMessage =
  | { type: 'status'; status: RoomSaveStatus }
  | { type: 'receipt-request'; id: number }
  | { type: 'receipt'; id: number };

/** Encodes a whole storage frame, message type included: the subtype, then one varUint. */
export function encodeStorageMessage(message: StorageMessage): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPES.storage);
  if (message.type === 'status') {
    encoding.writeVarUint(encoder, STORAGE_SUBTYPES.status);
    encoding.writeVarUint(encoder, SAVE_STATUSES.indexOf(message.status));
  } else {
    const isRequest = message.type === 'receipt-request';
    encoding.writeVarUint(
      encoder,
      isRequest ? STORAGE_SUBTYPES.receiptRequest : STORAGE_SUBTYPES.receipt,
    );
    encoding.writeVarUint(encoder, message.id);
  }
  return encoding.toUint8Array(encoder);
}

/**
 * Reads a storage message after its message type. Returns `null` for a subtype or status this
 * version does not know, which a reader ignores.
 */
export function readStorageMessage(decoder: decoding.Decoder): StorageMessage | null {
  const subtype = decoding.readVarUint(decoder);
  const value = decoding.readVarUint(decoder);
  if (subtype === STORAGE_SUBTYPES.receiptRequest) return { type: 'receipt-request', id: value };
  if (subtype === STORAGE_SUBTYPES.receipt) return { type: 'receipt', id: value };
  const status = SAVE_STATUSES[value];
  return subtype === STORAGE_SUBTYPES.status && status ? { type: 'status', status } : null;
}
