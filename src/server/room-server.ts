import type { Doc } from '@y/y';
import type { RoomTimer } from '../protocol/clock.js';
import { encodeAwarenessFrame } from '../protocol/frames.js';
import { CLOSE_CODES, encodeStatelessMessage } from '../protocol/messages.js';
import { encodeAwarenessEntries } from './awareness-owners.js';
import type { RoomHost } from './host/adapters.js';
import { type ResolvedRoomHost, resolveRoomHost } from './host/host.js';
import { createRoomRegistry } from './room-registry.js';
import {
  connectMember,
  type RoomServerConnection,
  type RoomServerRequest,
  type RoomServerSocket,
  type RoomStatelessMessage,
} from './server-connection.js';

export interface RoomServerOptions {
  host: RoomHost;
  /** A change is stored this long after the last one. Defaults to 2000 ms. */
  storeDebounceMs?: number | undefined;
  /** ...but never later than this after the first unstored change. Defaults to 10000 ms. */
  storeMaxDebounceMs?: number | undefined;
  /** A failed store is retried after this long, doubling up to 30000 ms. Defaults to 1000 ms. */
  storeRetryMs?: number | undefined;
  /**
   * How often every member gets a frame while its room is quiet, so the client's stale-socket
   * check sees a live socket. Keep it well below the client's `socketTimeoutMs`. Defaults to
   * 10000 ms.
   */
  keepaliveMs?: number | undefined;
  /** Receives every stateless message a member sends. */
  onStateless?: ((message: RoomStatelessMessage) => void) | undefined;
}

/** A host's hold on a loaded room, to change its document directly. */
export interface RoomHandle {
  readonly room: string;
  /**
   * The room's live document. A change made here, in a transaction with an origin of the host's
   * choosing, reaches every member and is stored like a member's.
   */
  readonly doc: Doc;
  /** Lets the room unload once nothing else holds it. Releasing twice does nothing. */
  release(): void;
}

/** Runs rooms for the connections a host passes it. */
export interface RoomServer {
  /** Admits a connection whose socket the host accepted, and joins it to its room. */
  connect(socket: RoomServerSocket, request: RoomServerRequest): RoomServerConnection;
  /**
   * Loads a room, or holds the loaded one, until the handle is released. Rejects when storage is
   * unavailable. A host warms a room up by opening it and releasing it later.
   */
  openRoom(room: string): Promise<RoomHandle>;
  /** Sends a stateless message to every member of a loaded room. */
  broadcastStateless(room: string, payload: string): void;
  /** Stores every room's pending changes now. */
  flush(): Promise<void>;
  /** The number of rooms loaded or loading. */
  roomCount(): number;
  /** Closes every connection, stores every room and unloads it. Later connections are refused. */
  close(): Promise<void>;
}

const KEEPALIVE_FRAME = encodeAwarenessFrame(encodeAwarenessEntries([]));

function createRegistry(options: RoomServerOptions, host: ResolvedRoomHost) {
  const retryMs = options.storeRetryMs ?? 1_000;
  return createRoomRegistry({
    host,
    timing: {
      debounceMs: options.storeDebounceMs ?? 2_000,
      maxDebounceMs: options.storeMaxDebounceMs ?? 10_000,
      retryInitialMs: retryMs,
      retryMaxMs: Math.max(retryMs, 30_000),
    },
    onConflict: (room) => {
      for (const member of [...room.members]) member.close(CLOSE_CODES.conflict, 'conflict');
    },
  });
}

export function createRoomServer(options: RoomServerOptions): RoomServer {
  const host = resolveRoomHost(options.host);
  const registry = createRegistry(options, host);
  const keepaliveMs = options.keepaliveMs ?? 10_000;
  let closed = false;
  let closing: Promise<void> | null = null;
  let keepalive: RoomTimer | null = null;

  // The timer runs only while rooms are loaded, so an idle server holds no timer.
  const sendKeepalive = () => {
    keepalive = null;
    const rooms = registry.rooms();
    for (const room of rooms) room.broadcast(KEEPALIVE_FRAME);
    if (rooms.length > 0) startKeepalive();
  };
  const startKeepalive = () => {
    keepalive ??= host.clock.setTimeout(sendKeepalive, keepaliveMs);
  };

  const dependencies = {
    host,
    registry,
    onStateless: options.onStateless,
    onJoin: () => startKeepalive(),
    connections: new Set<() => void>(),
  };

  const connect = (socket: RoomServerSocket, request: RoomServerRequest) => {
    if (!closed) return connectMember(socket, request, dependencies);
    socket.close(CLOSE_CODES.shutdown, 'shutdown');
    return { receive: () => undefined, closed: () => undefined };
  };

  const openRoom = async (room: string): Promise<RoomHandle> => {
    if (closed) throw new Error('The room server is closed.');
    const load = await registry.acquire(room);
    if (!load.ok) throw load.error;
    if (closed) {
      registry.release(load.room);
      throw new Error('The room server is closed.');
    }
    startKeepalive();
    let released = false;
    return {
      room,
      doc: load.room.doc,
      release: () => {
        if (released) return;
        released = true;
        registry.release(load.room);
      },
    };
  };

  const close = () => {
    if (closing) return closing;
    closed = true;
    if (keepalive !== null) host.clock.clearTimeout(keepalive);
    for (const shutdown of [...dependencies.connections]) shutdown();
    closing = registry.close();
    return closing;
  };

  return {
    connect,
    openRoom,
    broadcastStateless: (room, payload) => {
      registry
        .rooms()
        .find((live) => live.name === room)
        ?.broadcast(encodeStatelessMessage(payload));
    },
    flush: async () => {
      await Promise.all(registry.rooms().map((room) => room.store.flush()));
    },
    roomCount: () => registry.size(),
    close,
  };
}
