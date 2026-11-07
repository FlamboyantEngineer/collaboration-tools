/**
 * The contracts a host implements to run rooms (specs/HOST-ADAPTERS.md). The library reaches
 * identity, permissions, storage, logging and time only through these.
 */

import type { RoomClock } from '../../protocol/clock.js';
import type { RoomAccess } from '../../protocol/messages.js';

/** The person or service behind a connection. */
export interface RoomActor {
  /** Stable host id; awareness and stored attribution use it. */
  id: string;
  /** Display name, when the host has one. */
  name?: string | undefined;
}

export interface RoomAdmissionRequest {
  /** The room the connection asks for, as the client named it. */
  room: string;
  /** The token the client sent, or `null` when it sent none. */
  token: string | null;
  /** The URL's other query parameters, which a client sets with its `params` option. */
  params: Readonly<Record<string, string>>;
  /** The upgrade request's headers, by lower-case name. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** Why a connection was refused. */
export type RoomRefusal = 'unauthenticated' | 'forbidden' | 'not-found';

export type RoomAdmission =
  | {
      ok: true;
      actor: RoomActor;
      access: RoomAccess;
      /**
       * The room's canonical name, when the client named it by an alias. Every alias of a room
       * then shares one live document. Defaults to the requested name.
       */
      room?: string | undefined;
    }
  | { ok: false; reason: RoomRefusal };

/** Decides who may join a room and with what access. */
export interface RoomAuth {
  admit(request: RoomAdmissionRequest): Promise<RoomAdmission>;
}

/** One stored state of a room. */
export interface StoredRoomState {
  /** A Yjs update that rebuilds the room's document from empty. */
  update: Uint8Array;
  /** The host's opaque id for this state. The library only compares it for equality. */
  revision: string;
  /** Orders the room's stored states: each store gives a higher number than the one before. */
  sequence: number;
}

/** The revision and sequence of a stored state, without its bytes. */
export type StoredRoomVersion = Pick<StoredRoomState, 'revision' | 'sequence'>;

export type RoomLoadResult =
  | { status: 'found'; state: StoredRoomState }
  /** The room has never been stored: the library seeds it. */
  | { status: 'missing' }
  /** The stored state cannot be read: the library starts the room empty and stores over `version`. */
  | { status: 'corrupt'; reason: string; version: StoredRoomVersion }
  /** Storage failed: the room does not open. */
  | { status: 'unavailable'; error: Error };

export interface RoomStoreInput {
  room: string;
  /** A Yjs update that rebuilds the room's document from empty. */
  update: Uint8Array;
  /**
   * The revision this state was built on, or `null` for a room with no stored state. The store
   * fails with `conflict` when the room's current revision is a different one.
   */
  baseRevision: string | null;
}

export type RoomStoreResult =
  | ({ status: 'stored' } & StoredRoomVersion)
  /** Another writer stored the room first; `current` is what it stored. */
  | { status: 'conflict'; current: StoredRoomVersion | null }
  | { status: 'unavailable'; error: Error };

/** Loads and stores room states. */
export interface RoomPersistence {
  load(room: string): Promise<RoomLoadResult>;
  store(input: RoomStoreInput): Promise<RoomStoreResult>;
}

/** Where the library reports what a host operator should see. */
export interface RoomLogger {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/** Everything a host passes to run rooms. */
export interface RoomHost {
  auth: RoomAuth;
  persistence: RoomPersistence;
  /** Defaults to a logger that drops every message. */
  logger?: RoomLogger | undefined;
  /** Defaults to the platform clock. */
  clock?: RoomClock | undefined;
}
