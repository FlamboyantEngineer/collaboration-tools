/**
 * The contracts a host implements to run rooms (specs/HOST-ADAPTERS.md). The library reaches
 * identity, permissions, storage, logging and time only through these.
 */

import type { Doc } from '@y/y';
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
      /** What the connection may change beyond its access, checked by the room's write rules. */
      capabilities?: readonly string[] | undefined;
      /**
       * When this decision expires, in clock milliseconds. The server asks `refresh` before then,
       * and closes the connection at that time when there is no `refresh` or it fails.
       */
      expiresAt?: number | undefined;
    }
  | { ok: false; reason: RoomRefusal };

/** What a connection's decision is refreshed from. */
export interface RoomRefreshRequest extends RoomAdmissionRequest {
  /** The admitted actor; `room` is the canonical room the connection joined. */
  actor: RoomActor;
}

/** Decides who may join a room and with what access. */
export interface RoomAuth {
  admit(request: RoomAdmissionRequest): Promise<RoomAdmission>;
  /**
   * Decides again for a connection whose decision is about to expire. A refusal closes it; a
   * new access or capabilities apply at once.
   */
  refresh?(request: RoomRefreshRequest): Promise<RoomAdmission>;
}

/** A change a connection's update would make, for a room's finer write check. */
export interface RoomWriteChange {
  room: string;
  actor: RoomActor;
  capabilities: ReadonlySet<string>;
  /**
   * Each top-level type the update changes, with the keys directly under it whose content it
   * changes; a position in a list or text is `null`.
   */
  changes: ReadonlyMap<string, ReadonlySet<string | null>>;
  /**
   * Runs `inspect` on a copy of the room's document. `inspect` may observe the copy, then calls
   * `apply` to apply the update to it. Copying costs a full encode of the room, so call it only
   * for the changes that need it.
   */
  simulate<T>(inspect: (copy: Doc, apply: () => void) => T): T;
}

/** Which connections may change which parts of a room. */
export interface RoomWriteRules {
  /** The capability a connection needs to change each top-level type. */
  required?: Readonly<Record<string, string>> | undefined;
  /** Top-level types no connection may change; only the host's room handles change them. */
  serverOnly?: readonly string[] | undefined;
  /** The capability a type neither list names needs. By default, read-write access is enough. */
  otherwise?: string | undefined;
  /** A finer check of a change the lists allow; `false` refuses it. */
  check?: ((change: RoomWriteChange) => boolean) | undefined;
}

/** Gives each room its write rules. */
export interface RoomPermissions {
  /** The rules for `room`, read once when it loads, or `null` for none beyond access. */
  rulesFor(room: string): RoomWriteRules | null;
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
  /** The stored state cannot be read: the library seeds the room and stores over `version`. */
  | { status: 'corrupt'; reason: string; version: StoredRoomVersion }
  /**
   * The stored state is readable but out of date with the host's own record of the content, such
   * as one changed outside any room: the library seeds the room and stores over `version`.
   */
  | { status: 'stale'; reason: string; version: StoredRoomVersion }
  /** Storage failed: the room does not open. */
  | { status: 'unavailable'; error: Error };

/** How a load's outcome is named in metrics. */
export type RoomLoadOutcome = RoomLoadResult['status'];

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

/** What a room starts from when it starts over. */
export interface RoomSeeds {
  /**
   * A Yjs update that builds the content of `room` from empty, or `null` to start it empty. It is
   * read when a room is missing, corrupt or stale. A seed that throws fails the load.
   */
  seed(room: string): Promise<Uint8Array | null>;
}

/** Why a room started a new generation: the load outcome that made it start over. */
export type RoomGenerationReason = 'missing' | 'corrupt' | 'stale' | 'unmarked';

/** One event a host may count or time. Durations are in clock milliseconds. */
export type RoomMetricEvent =
  | { type: 'load'; room: string; outcome: RoomLoadOutcome; durationMs: number }
  | {
      type: 'store';
      room: string;
      outcome: RoomStoreResult['status'];
      durationMs: number;
      /** The size of the stored update. */
      bytes: number;
    }
  | { type: 'generation'; room: string; reason: RoomGenerationReason };

/** Receives what the library measures. A recorder that throws is ignored. */
export interface RoomMetrics {
  record(event: RoomMetricEvent): void;
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
  /** Defaults to no rules beyond each connection's access. */
  permissions?: RoomPermissions | undefined;
  /** Defaults to starting every new room empty. */
  seeds?: RoomSeeds | undefined;
  /** Defaults to recording nothing. */
  metrics?: RoomMetrics | undefined;
  /** Defaults to a logger that drops every message. */
  logger?: RoomLogger | undefined;
  /** Defaults to the platform clock. */
  clock?: RoomClock | undefined;
}
