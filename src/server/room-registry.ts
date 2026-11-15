import type { RoomRecoveryState } from './durable-barrier.js';
import type { ResolvedRoomHost } from './host/host.js';
import { type LiveRoom, loadRoom, type RoomLoad, type StoreTiming } from './live-room.js';
import {
  createRoomOperations,
  type RoomCommitResult,
  type RoomSnapshot,
} from './room-operations.js';
import { emitEvent, toError } from './stored-room.js';

export interface RoomRegistryOptions {
  host: ResolvedRoomHost;
  timing: StoreTiming;
  /** Called when another writer stored a room first. The room then unloads without storing. */
  onConflict(room: LiveRoom): void;
}

/**
 * The rooms in memory. A room is held by its connections and handles; it loads on the first hold
 * and unloads, after storing what is pending, once the last hold is released. Nothing else keeps
 * an entry, so a refused or failed join leaves none behind.
 */
export interface RoomRegistry {
  /** Holds a room, loading it when no one holds it yet. */
  acquire(name: string): Promise<RoomLoad>;
  /** Releases one hold on a room that `acquire` returned. */
  release(room: LiveRoom): void;
  /** The loaded rooms. */
  rooms(): LiveRoom[];
  /** The loaded instance for a canonical name. */
  find(name: string): LiveRoom | undefined;
  /** The number of rooms loaded or loading. */
  size(): number;
  /** Stores every room and unloads them all. */
  close(): Promise<void>;
  commit<T>(
    name: string,
    operation: (snapshot: RoomSnapshot) => Promise<RoomCommitResult<T>>,
  ): Promise<T>;
  invalidate(name: string): Promise<RoomRecoveryState[]>;
}

interface Entry {
  name: string;
  load: Promise<RoomLoad>;
  room: LiveRoom | null;
  holds: number;
  /** Set while the room stores before it unloads; a hold taken meanwhile keeps it loaded. */
  unloading: boolean;
}

function createEntry(
  name: string,
  load: Promise<RoomLoad>,
  settle: (entry: Entry, result: RoomLoad) => RoomLoad,
): Entry {
  const entry: Entry = {
    name,
    load: load.then((result) => settle(entry, result)),
    room: null,
    holds: 0,
    unloading: false,
  };
  return entry;
}

async function closeEntries(entries: readonly Entry[], destroy: (entry: Entry) => void) {
  for (const entry of entries) {
    const loaded = await entry.load;
    if (!loaded.ok) continue;
    await loaded.room.store.flush();
    if (loaded.room.store.isDirty())
      throw new Error(`Room ${entry.name} has recoverable unsaved changes.`);
  }
  for (const entry of entries) destroy(entry);
}

function createRoomEntries(
  options: RoomRegistryOptions,
  state: { reset: Set<string>; entries: Map<string, Entry> },
  callbacks: { onConflict(room: LiveRoom): void; settle(entry: Entry, result: RoomLoad): RoomLoad },
) {
  return (name: string): Entry => {
    const load = loadRoom({
      name,
      host: options.host,
      timing: options.timing,
      onConflict: callbacks.onConflict,
      reset: state.reset.has(name),
    }).catch((error: unknown): RoomLoad => ({ ok: false, error: toError(error) }));
    const entry = createEntry(name, load, callbacks.settle);
    state.entries.set(name, entry);
    return entry;
  };
}

export function createRoomRegistry(options: RoomRegistryOptions): RoomRegistry {
  const entries = new Map<string, Entry>();
  // Every loaded room's entry, including one a conflict took out of `entries`.
  const byRoom = new Map<LiveRoom, Entry>();
  let closing = false;
  const reset = new Set<string>();

  const forget = (entry: Entry) => {
    if (entries.get(entry.name) === entry) entries.delete(entry.name);
  };
  const destroy = (entry: Entry) => {
    forget(entry);
    const { room } = entry;
    if (!room) return;
    entry.room = null;
    byRoom.delete(room);
    room.destroy();
    emitEvent(options.host, { type: 'unloaded', room: room.name });
  };

  const onConflict = (room: LiveRoom) => {
    room.fence();
    const entry = byRoom.get(room);
    // Later joins load what the other writer stored.
    if (entry) forget(entry);
    options.onConflict(room);
  };

  const settle = (entry: Entry, result: RoomLoad) => {
    if (result.ok) {
      reset.delete(entry.name);
      entry.room = result.room;
      byRoom.set(result.room, entry);
    } else forget(entry);
    return result;
  };

  const create = createRoomEntries(options, { reset, entries }, { onConflict, settle });

  const unload = async (entry: Entry, room: LiveRoom) => {
    entry.unloading = true;
    // A room whose storage fails stays loaded, retrying, until its changes are stored.
    while (entry.holds === 0 && entries.get(entry.name) === entry && room.store.isDirty()) {
      if (!(await room.store.drain())) break;
    }
    entry.unloading = false;
    if (entry.holds === 0) destroy(entry);
  };

  const acquire = async (name: string): Promise<RoomLoad> => {
    const entry = entries.get(name) ?? create(name);
    entry.holds += 1;
    const result = await entry.load;
    if (!result.ok) entry.holds -= 1;
    return result;
  };

  const release = (room: LiveRoom) => {
    const entry = byRoom.get(room);
    if (!entry) return;
    entry.holds -= 1;
    if (entry.holds === 0 && !entry.unloading && !closing) void unload(entry, room);
  };

  const close = async () => {
    closing = true;
    await operations.idle();
    await Promise.all([...entries.values()].map((entry) => entry.load));
    await closeEntries([...byRoom.values()], destroy);
  };

  const operations = createRoomOperations({
    acquire,
    release,
    forget: (room) => {
      const entry = byRoom.get(room);
      if (entry) {
        reset.add(entry.name);
        destroy(entry);
      }
    },
  });

  return {
    ...operations,
    acquire,
    release,
    rooms: () => [...byRoom.keys()],
    find: (name) => entries.get(name)?.room ?? undefined,
    size: () => entries.size,
    close,
  };
}
