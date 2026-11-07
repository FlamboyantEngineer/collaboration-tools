import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from '@y/protocols/awareness';
import type { Doc } from '@y/y';
import { encodeAwarenessFrame, encodeSyncUpdate } from '../protocol/frames.js';
import { encodeStorageMessage } from '../protocol/messages.js';
import { type AwarenessOwners, createAwarenessOwners } from './awareness-owners.js';
import type { RoomWriteRules } from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import { createStoreScheduler, type StoreScheduler } from './store-scheduler.js';
import { openStoredDoc, recordMetric, type RoomStoreContext, storeRoom } from './stored-room.js';

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
  readonly rules: RoomWriteRules;
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

function removeMember(room: LiveRoom, member: RoomMember) {
  if (!room.members.delete(member)) return;
  const released = room.owners.release(member);
  const known = released.filter((id) => room.awareness.meta.has(id));
  removeAwarenessStates(room.awareness, released, member);
  if (known.length > 0) {
    room.broadcast(encodeAwarenessFrame(encodeAwarenessUpdate(room.awareness, known)));
  }
}

/**
 * Loads a room from the host's persistence (COLLAB-SERVER-4.1, COLLAB-SERVER-8.1). A room that
 * starts a new generation stores it before anyone joins, so a stored room never goes back to an
 * older generation.
 */
export async function loadRoom(options: LoadRoomOptions): Promise<RoomLoad> {
  const { name, host, timing } = options;
  const load = await openStoredDoc(name, host);
  if (!load.ok) return load;
  const { doc, baseRevision, newGeneration } = load.opened;
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
    onStatus: (status) => room.broadcast(encodeStorageMessage({ type: 'status', status })),
  });
  const room: LiveRoom = {
    name,
    doc,
    awareness,
    members: new Set(),
    owners: createAwarenessOwners(),
    store,
    rules: host.permissions.rulesFor(name) ?? {},
    broadcast: (frame, except) => room.members.forEach((m) => m !== except && m.send(frame)),
    leave: (member) => removeMember(room, member),
    destroy: () => {
      store.cancel();
      awareness.destroy();
      doc.destroy();
    },
  };
  if (newGeneration) {
    recordMetric(host, { type: 'generation', room: name, reason: newGeneration });
    if ((await storeRoom(context)) !== 'stored') {
      room.destroy();
      return { ok: false, error: new Error('The room could not store its new generation.') };
    }
  }
  // Every change, from a member or from the host, reaches every member, its sender included: the
  // echo is how a client learns the server holds its change.
  doc.on('update', (update: Uint8Array) => {
    room.broadcast(encodeSyncUpdate(update));
    store.markDirty();
  });
  return { ok: true, room };
}
