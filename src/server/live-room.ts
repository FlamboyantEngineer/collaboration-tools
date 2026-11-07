import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from '@y/protocols/awareness';
import { applyUpdate, Doc, encodeStateAsUpdate } from '@y/y';
import { encodeAwarenessFrame, encodeSyncUpdate } from '../protocol/frames.js';
import { type AwarenessOwners, createAwarenessOwners } from './awareness-owners.js';
import type { RoomLoadResult, RoomStoreResult, RoomWriteRules } from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import { createStoreScheduler, type StoreOutcome, type StoreScheduler } from './store-scheduler.js';

/** What a room needs from each connection in it. */
export interface RoomMember {
  send(frame: Uint8Array<ArrayBuffer>): void;
  /** Closes the member's socket with `code` and `reason`. */
  close(code: number, reason: string): void;
}

export interface StoreTiming {
  debounceMs: number;
  maxDebounceMs: number;
  retryInitialMs: number;
  retryMaxMs: number;
}

/** A room loaded in memory: its document, awareness and members. */
export interface LiveRoom {
  readonly name: string;
  readonly doc: Doc;
  readonly awareness: Awareness;
  readonly members: Set<RoomMember>;
  readonly owners: AwarenessOwners<RoomMember>;
  readonly store: StoreScheduler;
  /** The host's write rules for the room, read when it loaded. */
  readonly rules: RoomWriteRules | null;
  /** Sends `frame` to every member except `except`. */
  broadcast(frame: Uint8Array<ArrayBuffer>, except?: RoomMember): void;
  /** Removes a member and its awareness states. */
  leave(member: RoomMember): void;
  destroy(): void;
}

export type RoomLoad = { ok: true; room: LiveRoom } | { ok: false; error: Error };

export interface LoadRoomOptions {
  name: string;
  host: ResolvedRoomHost;
  timing: StoreTiming;
  /** Called once when another writer stored the room first; the room stores nothing after. */
  onConflict(room: LiveRoom): void;
}

interface RoomStoreContext {
  name: string;
  doc: Doc;
  host: ResolvedRoomHost;
  baseRevision: string | null;
  conflicted: boolean;
  onConflict(): void;
}

async function storeRoom(context: RoomStoreContext): Promise<StoreOutcome> {
  const { host, name } = context;
  if (context.conflicted) return 'abandoned';
  let result: RoomStoreResult;
  try {
    result = await host.persistence.store({
      room: name,
      update: encodeStateAsUpdate(context.doc),
      baseRevision: context.baseRevision,
    });
  } catch (error) {
    result = { status: 'unavailable', error: toError(error) };
  }
  if (result.status === 'stored') {
    context.baseRevision = result.revision;
    return 'stored';
  }
  if (result.status === 'conflict') {
    host.logger.error('Another writer stored the room first.', { room: name });
    context.conflicted = true;
    context.onConflict();
    return 'abandoned';
  }
  host.logger.warn('Storing the room failed; retrying.', { room: name, error: result.error });
  return 'retry';
}

function removeMember(room: LiveRoom, member: RoomMember) {
  if (!room.members.delete(member)) return;
  const released = room.owners.release(member);
  const known = released.filter((id) => room.awareness.meta.has(id));
  removeAwarenessStates(room.awareness, released, member);
  if (known.length > 0) {
    room.broadcast(encodeAwarenessFrame(encodeAwarenessUpdate(room.awareness, known)));
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The document a load result rebuilds, and the revision its next store builds on. */
function openStoredDoc(name: string, loaded: RoomLoadResult, host: ResolvedRoomHost) {
  if (loaded.status === 'found') {
    const doc = new Doc();
    try {
      applyUpdate(doc, loaded.state.update);
      return { doc, baseRevision: loaded.state.revision };
    } catch (error) {
      doc.destroy();
      loaded = {
        status: 'corrupt',
        reason: toError(error).message,
        version: { revision: loaded.state.revision, sequence: loaded.state.sequence },
      };
    }
  }
  if (loaded.status === 'corrupt') {
    host.logger.warn('The stored room cannot be read; it starts empty.', {
      room: name,
      reason: loaded.reason,
    });
    return { doc: new Doc(), baseRevision: loaded.version.revision };
  }
  return { doc: new Doc(), baseRevision: null };
}

/**
 * Loads a room from the host's persistence. A missing room starts empty; a corrupt one starts
 * empty and stores over the unreadable state; an unavailable store fails the load.
 */
export async function loadRoom(options: LoadRoomOptions): Promise<RoomLoad> {
  const { name, host, timing } = options;
  let loaded: RoomLoadResult;
  try {
    loaded = await host.persistence.load(name);
  } catch (error) {
    loaded = { status: 'unavailable', error: toError(error) };
  }
  if (loaded.status === 'unavailable') return { ok: false, error: loaded.error };
  const { doc, baseRevision } = openStoredDoc(name, loaded, host);
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const context: RoomStoreContext = {
    name,
    doc,
    host,
    baseRevision,
    conflicted: false,
    onConflict: () => options.onConflict(room),
  };
  const store = createStoreScheduler({
    ...timing,
    clock: host.clock,
    store: () => storeRoom(context),
  });
  const room: LiveRoom = {
    name,
    doc,
    awareness,
    members: new Set(),
    owners: createAwarenessOwners(),
    store,
    rules: host.permissions.rulesFor(name),
    broadcast: (frame, except) => room.members.forEach((m) => m !== except && m.send(frame)),
    leave: (member) => removeMember(room, member),
    destroy: () => {
      store.cancel();
      awareness.destroy();
      doc.destroy();
    },
  };
  // Every change, from a member or from the host, reaches every member, its sender included: the
  // echo is how a client learns the server holds its change.
  doc.on('update', (update: Uint8Array) => {
    room.broadcast(encodeSyncUpdate(update));
    store.markDirty();
  });
  return { ok: true, room };
}
