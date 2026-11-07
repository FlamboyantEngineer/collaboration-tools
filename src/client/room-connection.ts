import { removeAwarenessStates } from '@y/protocols/awareness';
import type { RoomTimer } from '../protocol/clock.js';
import { encodeSyncUpdate } from '../protocol/frames.js';
import type { AuthMessage, StorageMessage } from '../protocol/messages.js';
import type { ConnectionStateStore } from './connection-state.js';
import { openSocketSession, type SocketConfig, type SocketSession } from './socket-session.js';
import type { StoreReceipts } from './store-receipts.js';
import type { UnconfirmedUpdates } from './unconfirmed-updates.js';

/** Everything a provider's connection reads and changes, shared by its handlers. */
export interface RoomConnection extends SocketConfig {
  /** The URL for the next attempt, with a fresh token. */
  readonly url: () => string;
  readonly maxBackoffMs: number;
  readonly store: ConnectionStateStore;
  readonly unconfirmed: UnconfirmedUpdates;
  readonly receipts: StoreReceipts;
  readonly statelessListeners: Set<(payload: string) => void>;
  session: SocketSession | null;
  shouldConnect: boolean;
  offline: boolean;
  destroyed: boolean;
  failedAttempts: number;
  reconnectTimer: RoomTimer | null;
}

function markUnconfirmed(connection: RoomConnection) {
  connection.store.update({ hasUnconfirmedChanges: !connection.unconfirmed.isEmpty() });
}

/** Sends what a lost socket took with it, then the receipt requests that follow it. */
function resendMissing(connection: RoomConnection) {
  const { session } = connection;
  if (!session) return;
  const missing = connection.unconfirmed.encodeMissing(connection.doc);
  if (missing) session.send(encodeSyncUpdate(missing));
  connection.receipts.sendPending(session.send);
}

/** Asks the server to say once it has stored every local change made so far. */
export function requestReceipt(connection: RoomConnection): Promise<boolean> {
  if (connection.store.get().refusal !== null) return Promise.resolve(false);
  const receipt = connection.receipts.request();
  const { session } = connection;
  if (session && connection.store.get().synced) connection.receipts.sendPending(session.send);
  return receipt;
}

function handleRemoteUpdate(connection: RoomConnection, update: Uint8Array, isSyncStep2: boolean) {
  const { store } = connection;
  connection.unconfirmed.confirm(update);
  markUnconfirmed(connection);
  if (isSyncStep2 && !store.get().synced) {
    store.update({ synced: true, syncCount: store.get().syncCount + 1 });
    // The step's own content is confirmed first; what is still pending was lost with a socket.
    queueMicrotask(() => resendMissing(connection));
  }
}

function handleAuth(connection: RoomConnection, message: AuthMessage) {
  if (message.type === 'granted') {
    connection.store.update({ access: message.access });
    return;
  }
  connection.shouldConnect = false;
  connection.receipts.end();
  connection.store.update({ refusal: message.reason });
  connection.session?.close();
}

function handleStorage(connection: RoomConnection, message: StorageMessage) {
  if (message.type === 'status') connection.store.update({ saveStatus: message.status });
  else if (message.type === 'receipt') connection.receipts.received(message.id);
}

function notifyStateless(connection: RoomConnection, payload: string) {
  for (const listener of [...connection.statelessListeners]) {
    try {
      listener(payload);
    } catch (error) {
      connection.report('A stateless listener threw.', error);
    }
  }
}

function handleClose(connection: RoomConnection, code: number | null) {
  const { awareness, store } = connection;
  const opened = store.get().status === 'connected';
  connection.session = null;
  const remote = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
  removeAwarenessStates(awareness, remote, connection.origin);
  connection.receipts.resend();
  store.update({
    status: 'disconnected',
    access: 'pending',
    synced: false,
    closeCode: code,
    saveStatus: null,
  });
  connection.failedAttempts = opened ? 0 : connection.failedAttempts + 1;
  scheduleReconnect(connection);
}

function canConnect(connection: RoomConnection) {
  return connection.shouldConnect && !connection.offline && !connection.destroyed;
}

/** Opens a socket unless one is open or the connection should stay closed. */
export function openSession(connection: RoomConnection): void {
  cancelReconnect(connection);
  if (connection.session || !canConnect(connection)) return;
  connection.store.update({ status: 'connecting' });
  try {
    connection.session = openSocketSession(connection.url(), connection, {
      onOpen: () => connection.store.update({ status: 'connected', refusal: null }),
      onRemoteUpdate: (update, isSyncStep2) => handleRemoteUpdate(connection, update, isSyncStep2),
      onAuth: (message) => handleAuth(connection, message),
      onStateless: (payload) => notifyStateless(connection, payload),
      onStorage: (message) => handleStorage(connection, message),
      onClose: (code) => handleClose(connection, code),
    });
  } catch (error) {
    handleClose(connection, null);
    connection.report('Opening a connection failed.', error);
  }
}

/** Schedules the next attempt with exponential backoff: 0 ms after an open socket closed. */
function scheduleReconnect(connection: RoomConnection): void {
  if (!canConnect(connection) || connection.reconnectTimer !== null) return;
  const { failedAttempts } = connection;
  const delay =
    failedAttempts === 0 ? 0 : Math.min(2 ** failedAttempts * 100, connection.maxBackoffMs);
  connection.reconnectTimer = connection.clock.setTimeout(() => openSession(connection), delay);
}

export function cancelReconnect(connection: RoomConnection): void {
  if (connection.reconnectTimer !== null) connection.clock.clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;
}

/** Tracks and sends a local document update. */
export function sendLocalUpdate(connection: RoomConnection, update: Uint8Array): void {
  connection.unconfirmed.record(update, connection.clock.now());
  markUnconfirmed(connection);
  connection.session?.send(encodeSyncUpdate(update));
}
