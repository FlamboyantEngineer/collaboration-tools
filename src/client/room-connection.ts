import { removeAwarenessStates } from '@y/protocols/awareness';
import { decodeContentIds, Doc } from '@y/y';
import type { RoomTimer } from '../protocol/clock.js';
import { encodeSyncStep1, encodeSyncUpdate } from '../protocol/frames.js';
import type { AuthMessage, RefusedMessage, StorageMessage } from '../protocol/messages.js';
import type { ConnectionStateStore } from './connection-state.js';
import { encodeFill } from './refused-changes.js';
import { openSocketSession, type SocketConfig, type SocketSession } from './socket-session.js';
import type { StoreReceipts } from './store-receipts.js';
import type { UnconfirmedUpdates } from './unconfirmed-updates.js';

/**
 * The provider's document replaced by the room's content after the room refused one of its
 * changes (COLLAB-CLIENT-3.5): `doc` holds what the room holds, `previous` what the writer had.
 */
export interface RoomReload<Document = Doc> {
  /** Why the room refused the change, such as `conflict`. */
  reason: string;
  doc: Document;
  previous: Document;
}

/** Everything a provider's connection reads and changes, shared by its handlers. */
export interface RoomConnection extends SocketConfig {
  /** The document the room syncs with; a reload replaces it. */
  doc: Doc;
  /** The document a reload replaces, until the room's content reached its replacement. */
  reload: { reason: string; previous: Doc } | null;
  readonly reloadListeners: Set<(reload: RoomReload) => void>;
  /** Stops listening to each document whose local changes the provider sends. */
  readonly watching: Map<Doc, () => void>;
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

/**
 * Sends what a lost socket took with it, one update for each change so the room takes each that
 * it can (COLLAB-CLIENT-3.4), then the receipt requests that follow it.
 */
function resendMissing(connection: RoomConnection) {
  const { session } = connection;
  if (!session) return;
  for (const update of connection.unconfirmed.encodeEach()) session.send(encodeSyncUpdate(update));
  connection.receipts.sendPending(session.send);
}

/** Sends each local update of `doc` the provider did not receive from the room. */
export function watchDoc(connection: RoomConnection, doc: Doc): void {
  if (connection.watching.has(doc)) return;
  const handleDocUpdate = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin !== connection.origin) sendLocalUpdate(connection, update, doc);
  };
  doc.on('update', handleDocUpdate);
  connection.watching.set(doc, () => doc.off('update', handleDocUpdate));
}

/** Stops sending the local updates of `doc`, or of every document. */
export function unwatchDocs(connection: RoomConnection, doc?: Doc): void {
  for (const [watched, stop] of [...connection.watching]) {
    if (doc && watched !== doc) continue;
    stop();
    connection.watching.delete(watched);
  }
}

function notifyReload(connection: RoomConnection, reload: RoomReload) {
  for (const listener of [...connection.reloadListeners]) {
    try {
      listener(reload);
    } catch (error) {
      connection.report('A reload listener threw.', error);
    }
  }
}

/** Replaces the document with a new one that syncs the room's content from scratch. */
function startReload(connection: RoomConnection, reason: string) {
  const previous = connection.doc;
  const doc = new Doc({ gc: previous.gc });
  connection.reload = { reason, previous };
  connection.doc = doc;
  watchDoc(connection, doc);
  connection.session?.send(encodeSyncStep1(doc));
}

/** Hands the reloaded document over once it holds the room's content. */
function finishReload(connection: RoomConnection) {
  const { reload } = connection;
  if (!reload) return;
  connection.reload = null;
  unwatchDocs(connection, reload.previous);
  notifyReload(connection, {
    reason: reload.reason,
    doc: connection.doc,
    previous: reload.previous,
  });
}

/**
 * The room refused one of the provider's changes and kept it connected (COLLAB-CLIENT-3.5): the
 * change is never sent again; its fill goes first, then the document's later changes, which the
 * room dropped while it lacked the refused change's places; the document reloads the room's
 * content unless it already left the refused change behind.
 */
function handleRefused(connection: RoomConnection, message: RefusedMessage) {
  const { unconfirmed, session, store } = connection;
  let refused;
  try {
    refused = unconfirmed.take(decodeContentIds(message.ids));
  } catch (error) {
    connection.report('A refused message could not be read.', error);
    return;
  }
  markUnconfirmed(connection);
  if (!refused) return;
  store.update({ refusedChanges: store.get().refusedChanges + 1 });
  const fill = encodeFill(refused);
  if (fill) {
    unconfirmed.recordFill(fill, refused.doc);
    for (const update of unconfirmed.encodeEach(refused.doc))
      session?.send(encodeSyncUpdate(update));
    markUnconfirmed(connection);
  }
  if (refused.doc === connection.doc && !connection.reload) startReload(connection, message.reason);
}

/** Asks the server to say once it has stored every local change made so far. */
export function requestReceipt(connection: RoomConnection): Promise<boolean> {
  // A refused provider stays stopped until `connect()`, which may reconnect with a fresh token.
  if (connection.store.get().refusal !== null && !connection.shouldConnect) {
    return Promise.resolve(false);
  }
  const receipt = connection.receipts.request();
  const { session } = connection;
  if (session && connection.store.get().synced) connection.receipts.sendPending(session.send);
  return receipt;
}

function handleRemoteUpdate(connection: RoomConnection, update: Uint8Array, isSyncStep2: boolean) {
  const { store } = connection;
  connection.unconfirmed.confirm(update);
  markUnconfirmed(connection);
  // A reload's own sync step 1 is answered on a socket already synced.
  if (isSyncStep2 && connection.reload) finishReload(connection);
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
  if (message.type === 'generation') {
    connection.store.update({ roomGeneration: message.generation });
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
      onOpen: () =>
        connection.store.update({ status: 'connected', refusal: null, roomGeneration: null }),
      onRemoteUpdate: (update, isSyncStep2) => handleRemoteUpdate(connection, update, isSyncStep2),
      withheld: () => connection.unconfirmed.ids(),
      onAuth: (message) => handleAuth(connection, message),
      onStateless: (payload) => notifyStateless(connection, payload),
      onStorage: (message) => handleStorage(connection, message),
      onRefused: (message) => handleRefused(connection, message),
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

/** Sends a local update of `doc` and tracks it: as a change of its own when it went out at once. */
function sendLocalUpdate(connection: RoomConnection, update: Uint8Array, doc: Doc): void {
  const sent = connection.session?.send(encodeSyncUpdate(update)) ?? false;
  connection.unconfirmed.record(update, doc, sent);
  markUnconfirmed(connection);
}
