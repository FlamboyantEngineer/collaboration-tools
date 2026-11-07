import { Awareness } from '@y/protocols/awareness';
import type { Doc } from '@y/y';
import { PLATFORM_CLOCK, type RoomClock } from '../protocol/clock.js';
import { encodeStatelessMessage } from '../protocol/messages.js';
import { buildRoomUrl } from '../protocol/room-url.js';
import {
  createConnectionStateStore,
  type RoomConnectionListener,
  type RoomConnectionState,
} from './connection-state.js';
import { encodeAwarenessState } from './frames.js';
import {
  cancelReconnect,
  openSession,
  type RoomConnection,
  sendLocalUpdate,
} from './room-connection.js';
import {
  type ConnectivityEvents,
  PLATFORM_SOCKET_FACTORY,
  type RoomSocketFactory,
} from './room-socket.js';
import { createUnconfirmedUpdates } from './unconfirmed-updates.js';

export interface RoomProviderOptions {
  /** The server's endpoint; the room is appended as a path segment. */
  endpoint: string;
  room: string;
  doc: Doc;
  /** Defaults to a new awareness for `doc`, which the provider destroys with itself. */
  awareness?: Awareness | undefined;
  /** Read before each connection attempt, so a host can refresh an expiring token. */
  getToken?: (() => string | null) | undefined;
  /** Extra query parameters for each connection. */
  params?: Readonly<Record<string, string>> | undefined;
  /** Defaults to the platform `WebSocket`. */
  createSocket?: RoomSocketFactory | undefined;
  /** Defaults to the platform clock. */
  clock?: RoomClock | undefined;
  /** Closes the socket while offline and reconnects when back online, such as a window. */
  connectivity?: ConnectivityEvents | null | undefined;
  /** Whether to connect right away. Defaults to `true`. */
  connect?: boolean | undefined;
  /** The longest wait between reconnect attempts. Defaults to 2500 ms. */
  maxBackoffMs?: number | undefined;
  /** A socket silent for longer than this closes and reconnects. Defaults to 45000 ms. */
  socketTimeoutMs?: number | undefined;
}

/** A shared document kept in sync with a room on a server. */
export interface RoomProvider {
  readonly doc: Doc;
  readonly awareness: Awareness;
  getState(): RoomConnectionState;
  subscribe(listener: RoomConnectionListener): () => void;
  /** Listens to stateless messages from the room. */
  onStateless(listener: (payload: string) => void): () => void;
  /** Sends a stateless message to the room; returns `false` when no socket is open. */
  sendStateless(payload: string): boolean;
  /** Whether a transaction with this origin came from the server. */
  isRemoteOrigin(origin: unknown): boolean;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

const DEFAULT_MAX_BACKOFF_MS = 2_500;
const DEFAULT_SOCKET_TIMEOUT_MS = 45_000;

function createConnection(options: RoomProviderOptions): RoomConnection {
  return {
    url: () =>
      buildRoomUrl({
        endpoint: options.endpoint,
        room: options.room,
        token: options.getToken?.() ?? null,
        params: options.params,
      }),
    doc: options.doc,
    awareness: options.awareness ?? new Awareness(options.doc),
    origin: Object.freeze({ room: options.room }),
    clock: options.clock ?? PLATFORM_CLOCK,
    createSocket: options.createSocket ?? PLATFORM_SOCKET_FACTORY,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    socketTimeoutMs: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
    store: createConnectionStateStore(),
    unconfirmed: createUnconfirmedUpdates(),
    statelessListeners: new Set(),
    session: null,
    shouldConnect: options.connect !== false,
    offline: false,
    destroyed: false,
    failedAttempts: 0,
    reconnectTimer: null,
  };
}

/** Listens to the document, awareness and connectivity; returns what stops listening. */
function listen(connection: RoomConnection, connectivity: ConnectivityEvents | null | undefined) {
  const { doc, awareness } = connection;
  const handleDocUpdate = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin !== connection.origin) sendLocalUpdate(connection, update);
  };
  const handleAwarenessUpdate = (
    changes: Record<'added' | 'updated' | 'removed', number[]>,
    updateOrigin: unknown,
  ) => {
    // What the room sent is the room's already.
    if (updateOrigin === connection.origin) return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    connection.session?.send(encodeAwarenessState(awareness, clients));
  };
  const goOffline = () => {
    connection.offline = true;
    cancelReconnect(connection);
    connection.session?.close();
  };
  const goOnline = () => {
    connection.offline = false;
    connection.failedAttempts = 0;
    openSession(connection);
  };
  doc.on('update', handleDocUpdate);
  awareness.on('update', handleAwarenessUpdate);
  connectivity?.addEventListener('offline', goOffline);
  connectivity?.addEventListener('online', goOnline);
  return () => {
    doc.off('update', handleDocUpdate);
    awareness.off('update', handleAwarenessUpdate);
    connectivity?.removeEventListener('offline', goOffline);
    connectivity?.removeEventListener('online', goOnline);
  };
}

/** Creates a {@link RoomProvider} (specs/CLIENT.md). */
export function createRoomProvider(options: RoomProviderOptions): RoomProvider {
  const connection = createConnection(options);
  const { awareness, store } = connection;
  const stopListening = listen(connection, options.connectivity);

  const connect = () => {
    if (connection.destroyed) return;
    connection.shouldConnect = true;
    connection.failedAttempts = 0;
    openSession(connection);
  };
  const disconnect = () => {
    connection.shouldConnect = false;
    cancelReconnect(connection);
    connection.session?.send(encodeAwarenessState(awareness, [awareness.clientID], new Map()));
    connection.session?.close();
  };
  const destroy = () => {
    if (connection.destroyed) return;
    disconnect();
    connection.destroyed = true;
    stopListening();
    if (!options.awareness) awareness.destroy();
    connection.statelessListeners.clear();
  };

  openSession(connection);

  return {
    doc: connection.doc,
    awareness,
    getState: store.get,
    subscribe: store.subscribe,
    onStateless: (listener) => {
      connection.statelessListeners.add(listener);
      return () => {
        connection.statelessListeners.delete(listener);
      };
    },
    sendStateless: (payload) => connection.session?.send(encodeStatelessMessage(payload)) ?? false,
    isRemoteOrigin: (candidate) => candidate === connection.origin,
    connect,
    disconnect,
    destroy,
  };
}
