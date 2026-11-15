import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from '@y/protocols/awareness';
import type { Doc } from '@y/y';
import { encodeAwarenessFrame, encodeSyncUpdate } from '../protocol/frames.js';
import { encodeStorageMessage } from '../protocol/messages.js';
import { type AwarenessExpiry, createAwarenessExpiry } from './awareness-expiry.js';
import { type AwarenessOwners, createAwarenessOwners } from './awareness-owners.js';
import type { RoomActor, RoomWriteRules, StoredRoomVersion } from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import { createStoreScheduler, type StoreScheduler } from './store-scheduler.js';
import {
  emitEvent,
  openStoredDoc,
  recordMetric,
  type RoomStoreContext,
  storeRoom,
  toError,
} from './stored-room.js';
import { openShadowGuard, type ShadowGuard } from './write-guard.js';

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
  readonly presence: AwarenessExpiry;
  readonly store: StoreScheduler;
  /** The host's write rules for the room, read when it loaded. */
  readonly rules: RoomWriteRules;
  readonly guard: ShadowGuard | null;
  /** False while a canonical operation or invalidation fences client writes. */
  accepting: boolean;
  version(): StoredRoomVersion | null;
  advance(version: StoredRoomVersion): void;
  /** Prevents any later persistence attempt from this instance. */
  fence(): void;
  /** Notes that `actor` changed the room, for the next stored event. */
  edited(actor: RoomActor): void;
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
  reset?: boolean | undefined;
  /** Called once when another writer stored the room first; the room stores nothing after. */
  onConflict(room: LiveRoom): void;
}

function removeMember(room: LiveRoom, member: RoomMember) {
  if (!room.members.delete(member)) return;
  const released = room.owners.release(member);
  room.presence.forget(released);
  const known = released.filter((id) => room.awareness.meta.has(id));
  removeAwarenessStates(room.awareness, released, member);
  if (known.length > 0) {
    room.broadcast(encodeAwarenessFrame(encodeAwarenessUpdate(room.awareness, known)));
  }
  for (const id of released) {
    if (!room.awareness.getStates().has(id)) room.awareness.meta.delete(id);
  }
}

function createRoomPresence(
  doc: Doc,
  host: ResolvedRoomHost,
  broadcast: (frame: Uint8Array<ArrayBuffer>) => void,
) {
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  clearInterval(awareness._checkInterval as ReturnType<typeof setInterval>);
  const presence = createAwarenessExpiry({
    clock: host.clock,
    onExpired: (ids) => {
      const present = ids.filter((id) => awareness.states.has(id));
      if (present.length === 0) return;
      removeAwarenessStates(awareness, present, 'timeout');
      broadcast(encodeAwarenessFrame(encodeAwarenessUpdate(awareness, present)));
    },
  });
  return { awareness, presence };
}

function destroyRoom(room: LiveRoom) {
  room.store.cancel();
  try {
    room.guard?.destroy();
  } finally {
    room.presence.destroy();
    try {
      room.awareness.destroy();
    } finally {
      room.doc.destroy();
    }
  }
}

function createRoomRules(host: ResolvedRoomHost, name: string, doc: Doc) {
  const rules = host.permissions.rulesFor(name) ?? {};
  const guard = rules.openGuard ? openShadowGuard(doc, rules.openGuard) : null;
  return { rules, guard };
}

/**
 * Loads a room from the host's persistence (COLLAB-SERVER-4.1, COLLAB-SERVER-8.1). A room that
 * starts a new generation stores it before anyone joins, so a stored room never goes back to an
 * older generation.
 */
export async function loadRoom(options: LoadRoomOptions): Promise<RoomLoad> {
  const { name, host, timing } = options;
  const load = await openStoredDoc(name, host, options.reset);
  if (!load.ok) return load;
  const { doc, baseRevision, version, newGeneration } = load.opened;
  let rules: RoomWriteRules;
  let guard: ShadowGuard | null;
  try {
    ({ rules, guard } = createRoomRules(host, name, doc));
  } catch (error) {
    doc.destroy();
    return { ok: false, error: toError(error) };
  }
  const { awareness, presence } = createRoomPresence(doc, host, (frame) => room.broadcast(frame));
  const context: RoomStoreContext = {
    name,
    doc,
    host,
    baseRevision,
    version,
    conflicted: false,
    editors: new Map(),
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
    presence,
    store,
    rules,
    guard,
    accepting: true,
    version: () => (context.version ? { ...context.version } : null),
    advance: (next) => {
      context.version = next;
      context.baseRevision = next.revision;
    },
    fence: () => {
      room.accepting = false;
      context.conflicted = true;
      store.cancel();
    },
    edited: (actor) => {
      if (!context.editors.has(actor.id)) context.editors.set(actor.id, actor);
    },
    broadcast: (frame, except) => room.members.forEach((m) => m !== except && m.send(frame)),
    leave: (member) => removeMember(room, member),
    destroy: () => destroyRoom(room),
  };
  if (newGeneration) {
    recordMetric(host, { type: 'generation', room: name, reason: newGeneration });
    if ((await storeRoom(context)) !== 'stored') {
      room.destroy();
      return { ok: false, error: new Error('The room could not store its new generation.') };
    }
  }
  emitEvent(host, { type: 'loaded', room: name });
  // Every change, from a member or from the host, reaches every member, its sender included: the
  // echo is how a client learns the server holds its change.
  doc.on('update', (update: Uint8Array) => {
    room.broadcast(encodeSyncUpdate(update));
    store.markDirty();
  });
  return { ok: true, room };
}
