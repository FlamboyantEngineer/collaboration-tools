import type { RoomTimer } from '../protocol/clock.js';
import { encodeAwarenessFrame } from '../protocol/frames.js';
import { CLOSE_CODES, encodeStatelessMessage } from '../protocol/messages.js';
import { encodeAwarenessEntries } from './awareness-owners.js';
import type { RoomConnectionControl, RoomConnectionTarget } from './connection-control.js';
import type { RoomConnectionLimits } from './connection-pending.js';
import {
  flushRooms,
  recoverRooms,
  type RoomFlushOptions,
  type RoomFlushReceipt,
  type RoomRecoveryState,
  waitForOperation,
} from './durable-barrier.js';
import type { RoomHost } from './host/adapters.js';
import { type ResolvedRoomHost, resolveRoomHost } from './host/host.js';
import { createRoomHandle, type RoomHandle } from './room-handle.js';
import type { RoomCommitResult, RoomSnapshot } from './room-operations.js';
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
  /** Bounds pending admission, loading and queued frames. */
  connectionLimits?: RoomConnectionLimits | undefined;
  /** Maximum pending payload bytes including per-frame accounting overhead. */
  maxPendingBytes?: number | undefined;
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

/** Runs rooms for the connections a host passes it. */
export interface RoomServer {
  /** Admits a connection whose socket the host accepted, and joins it to its room. */
  connect(socket: RoomServerSocket, request: RoomServerRequest): RoomServerConnection;
  /** Immediately closes matching admitted or pending connections. */
  revoke(target: RoomConnectionTarget): void;
  /** Refreshes matching connections through the auth adapter. */
  reauthorize(target: RoomConnectionTarget): Promise<void>;
  /**
   * Loads a room, or holds the loaded one, until the handle is released. Rejects when storage is
   * unavailable. A host warms a room up by opening it and releasing it later.
   */
  openRoom(room: string): Promise<RoomHandle>;
  /** Sends a stateless message to every member of a loaded room. */
  broadcastStateless(room: string, payload: string): void;
  /** Serializes a canonical commit after earlier stores, holding later checkpoints until it completes. */
  commitRoom<T>(
    room: string,
    commit: (snapshot: RoomSnapshot) => Promise<RoomCommitResult<T>>,
  ): Promise<T>;
  /** Waits for older stores, closes members and fences old handles before the next load. */
  invalidate(room: string): Promise<RoomRecoveryState[]>;
  /** Stores every room's pending changes now. */
  flush(options?: RoomFlushOptions): Promise<RoomFlushReceipt[]>;
  /** Snapshots of unsaved changes retained after a failed barrier or shutdown. */
  recover(): RoomRecoveryState[];
  /** The number of rooms loaded or loading. */
  roomCount(): number;
  /** Closes every connection, stores every room and unloads it. Later connections are refused. */
  close(options?: RoomFlushOptions): Promise<void>;
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

function createConnectionControls(controls: Set<RoomConnectionControl>) {
  return {
    revoke: (target: RoomConnectionTarget) => {
      for (const control of controls) control.revoke(target);
    },
    reauthorize: async (target: RoomConnectionTarget) => {
      await Promise.all([...controls].map((control) => control.refresh(target)));
    },
  };
}

export function createRoomServer(options: RoomServerOptions): RoomServer {
  const host = resolveRoomHost(options.host);
  const registry = createRegistry(options, host);
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
    keepalive ??= host.clock.setTimeout(sendKeepalive, options.keepaliveMs ?? 10_000);
  };

  const dependencies = {
    host,
    registry,
    limits: options.connectionLimits,
    maxPendingBytes: options.maxPendingBytes ?? 4 * 1024 * 1024,
    controls: new Set<RoomConnectionControl>(),
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
    return createRoomHandle({
      room: load.room,
      release: () => registry.release(load.room),
      isClosed: () => closed,
      clock: host.clock,
    });
  };

  const close = (options?: RoomFlushOptions) => {
    if (closing) return closing;
    closed = true;
    if (keepalive !== null) host.clock.clearTimeout(keepalive);
    for (const shutdown of [...dependencies.connections]) shutdown();
    closing = waitForOperation(registry.close(), host.clock, options).catch((error: unknown) => {
      closing = null;
      throw error;
    });
    return closing;
  };

  return {
    connect,
    ...createConnectionControls(dependencies.controls),
    openRoom,
    commitRoom: (name, commit) => {
      if (closed) return Promise.reject(new Error('The room server is closed.'));
      return registry.commit(name, commit);
    },
    invalidate: (name) => {
      if (closed) return Promise.reject(new Error('The room server is closed.'));
      return registry.invalidate(name);
    },
    broadcastStateless: (room, payload) => {
      registry.find(room)?.broadcast(encodeStatelessMessage(payload));
    },
    flush: (options) => flushRooms(registry.rooms(), host.clock, options),
    recover: () => recoverRooms(registry.rooms()),
    roomCount: () => registry.size(),
    close,
  };
}
