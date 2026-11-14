import type { ResolvedRoomHost } from './host/host.js';
import { type LiveRoom, loadRoom, type RoomLoad, type StoreTiming } from './live-room.js';
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
  /** The number of rooms loaded or loading. */
  size(): number;
  /** Stores every room and unloads them all. */
  close(): Promise<void>;
}

interface Entry {
  name: string;
  load: Promise<RoomLoad>;
  room: LiveRoom | null;
  holds: number;
  /** Set while the room stores before it unloads; a hold taken meanwhile keeps it loaded. */
  unloading: boolean;
}

/** Stores a room once more as the registry closes, and logs changes that could not be stored. */
async function storeBeforeClose(entry: Entry, host: ResolvedRoomHost) {
  const result = await entry.load;
  if (!result.ok) return;
  await result.room.store.flush();
  if (result.room.store.isDirty()) {
    host.logger.error('The room closed with changes it could not store.', { room: entry.name });
  }
}

export function createRoomRegistry(options: RoomRegistryOptions): RoomRegistry {
  const entries = new Map<string, Entry>();
  // Every loaded room's entry, including one a conflict took out of `entries`.
  const byRoom = new Map<LiveRoom, Entry>();
  let closing = false;

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
    const entry = byRoom.get(room);
    // Later joins load what the other writer stored.
    if (entry) forget(entry);
    options.onConflict(room);
  };

  const settle = (entry: Entry, result: RoomLoad) => {
    if (result.ok) {
      entry.room = result.room;
      byRoom.set(result.room, entry);
    } else forget(entry);
    return result;
  };

  const create = (name: string): Entry => {
    const load = loadRoom({ name, host: options.host, timing: options.timing, onConflict }).catch(
      (error: unknown): RoomLoad => ({ ok: false, error: toError(error) }),
    );
    const entry: Entry = {
      name,
      load: load.then((result) => settle(entry, result)),
      room: null,
      holds: 0,
      unloading: false,
    };
    entries.set(name, entry);
    return entry;
  };

  const unload = async (entry: Entry, room: LiveRoom) => {
    entry.unloading = true;
    // A room whose storage fails stays loaded, retrying, until its changes are stored.
    if (entries.get(entry.name) === entry) await room.store.drain();
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
    await Promise.all([...entries.values()].map((entry) => storeBeforeClose(entry, options.host)));
    for (const entry of [...byRoom.values()]) destroy(entry);
  };

  return {
    acquire,
    release,
    rooms: () => [...byRoom.keys()],
    size: () => entries.size,
    close,
  };
}
