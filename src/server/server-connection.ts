import { CLOSE_CODES, encodeAuthMessage, encodeStatelessMessage } from '../protocol/messages.js';
import { readRoomGeneration } from '../protocol/room-meta.js';
import { parseRoomUrl } from '../protocol/room-url.js';
import type {
  RoomActor,
  RoomAdmission,
  RoomAdmissionRequest,
  RoomRefreshRequest,
  RoomRefusal,
} from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import type { LiveRoom, RoomMember } from './live-room.js';
import { type MemberContext, readMemberFrame, sendWelcome } from './member-frames.js';
import { startReauthorization } from './reauthorization.js';
import type { RoomRegistry } from './room-registry.js';

/** The part of a server-side WebSocket the room server uses. */
export interface RoomServerSocket {
  send(frame: Uint8Array<ArrayBuffer>): void;
  close(code: number, reason: string): void;
}

/** The upgrade request a connection arrived with. */
export interface RoomServerRequest {
  /** The request's path and query, such as `/rooms/a?token=t`. */
  url: string;
  headers: RoomAdmissionRequest['headers'];
}

/** What the socket's owner tells the room server about one connection. */
export interface RoomServerConnection {
  /** Passes a binary frame the client sent. */
  receive(frame: Uint8Array): void;
  /** Reports that the socket closed. */
  closed(): void;
}

/** A stateless message a member sent. */
export interface RoomStatelessMessage {
  room: string;
  actor: RoomActor;
  payload: string;
  /** Sends a stateless message back to the member alone. */
  reply(payload: string): void;
}

export interface ConnectionDependencies {
  host: ResolvedRoomHost;
  registry: RoomRegistry;
  onStateless: ((message: RoomStatelessMessage) => void) | undefined;
  /** Called each time a connection joins its room. */
  onJoin(): void;
  /** Shutdown callbacks for every connection, including those awaiting admission. */
  connections: Set<() => void>;
}

type RoomAdmitted = Extract<RoomAdmission, { ok: true }>;

const REFUSAL_CODES: Readonly<Record<RoomRefusal, number>> = {
  unauthenticated: CLOSE_CODES.unauthenticated,
  forbidden: CLOSE_CODES.forbidden,
  'not-found': CLOSE_CODES.notFound,
};

/** One connection's state, shared by the steps below. */
interface Connection {
  socket: RoomServerSocket;
  dependencies: ConnectionDependencies;
  /** Frames that arrived before the room was ready. */
  queue: Uint8Array[];
  context: MemberContext | null;
  closed: boolean;
  onClosed(): void;
  /** Stops refreshing the connection's decision. */
  stopReauthorization: (() => void) | null;
}

function leave(connection: Connection) {
  connection.queue.length = 0;
  connection.onClosed();
  connection.stopReauthorization?.();
  connection.stopReauthorization = null;
  if (!connection.context) return;
  const { room, member } = connection.context;
  connection.context = null;
  room.leave(member);
  connection.dependencies.registry.release(room);
}

function close(connection: Connection, code: number, reason: string) {
  if (connection.closed) return;
  connection.closed = true;
  try {
    connection.socket.close(code, reason);
  } finally {
    leave(connection);
  }
}

/** Tells the client why, so it stops reconnecting, and closes the socket. */
function refuse(connection: Connection, reason: string, code: number) {
  if (connection.closed) return;
  connection.socket.send(encodeAuthMessage({ type: 'denied', reason }));
  close(connection, code, reason);
}

/** Applies a refreshed decision: a refusal closes the connection, a new access is announced. */
function applyDecision(connection: Connection, decision: RoomAdmission) {
  const { context } = connection;
  if (!context) return;
  if (!decision.ok) return refuse(connection, decision.reason, REFUSAL_CODES[decision.reason]);
  context.capabilities = new Set(decision.capabilities);
  if (decision.access === context.access) return;
  context.access = decision.access;
  context.member.send(encodeAuthMessage({ type: 'granted', access: decision.access }));
}

function startRefreshing(connection: Connection, request: RoomRefreshRequest, expiresAt: number) {
  connection.stopReauthorization = startReauthorization({
    host: connection.dependencies.host,
    request,
    expiresAt,
    onDecision: (decision) => applyDecision(connection, decision),
    // Without the auth message the client reconnects, with a fresh token.
    onExpired: () => close(connection, CLOSE_CODES.unauthenticated, 'expired'),
  });
}

function read(connection: Connection, frame: Uint8Array, context: MemberContext) {
  try {
    readMemberFrame(frame, context);
  } catch (error) {
    connection.dependencies.host.logger.warn('A client sent a frame that cannot be read.', {
      room: context.room.name,
      error,
    });
    close(connection, CLOSE_CODES.badRequest, 'bad-request');
  }
}

/** Adds an admitted connection to its loaded room and replays what it sent meanwhile. */
function enter(connection: Connection, room: LiveRoom, admission: RoomAdmitted) {
  const { socket, dependencies } = connection;
  const { actor } = admission;
  const member: RoomMember = {
    send: (frame) => {
      if (!connection.closed) socket.send(frame);
    },
    close: (code, reason) => close(connection, code, reason),
  };
  const context: MemberContext = {
    room,
    member,
    actor,
    access: admission.access,
    capabilities: new Set(admission.capabilities),
    onStateless: (payload) =>
      dependencies.onStateless?.({
        room: room.name,
        actor,
        payload,
        reply: (answer) => member.send(encodeStatelessMessage(answer)),
      }),
    onRefusedWrite: (types) => {
      dependencies.host.logger.warn('A connection sent a change its access does not allow.', {
        room: room.name,
        actor: actor.id,
        types,
      });
      refuse(connection, 'unauthorized-write', CLOSE_CODES.forbidden);
    },
  };
  connection.context = context;
  room.members.add(member);
  dependencies.onJoin();
  sendWelcome(context);
  for (const frame of connection.queue.splice(0))
    if (!connection.closed) read(connection, frame, context);
}

async function join(connection: Connection, request: RoomServerRequest) {
  const { host, registry } = connection.dependencies;
  const parts = parseRoomUrl(request.url);
  if (!parts) return close(connection, CLOSE_CODES.badRequest, 'bad-request');
  const { room: requested, token, generation, params } = parts;
  const admission = await host.auth.admit({
    room: requested,
    token,
    params,
    headers: request.headers,
  });
  if (connection.closed) return;
  if (!admission.ok) return refuse(connection, admission.reason, REFUSAL_CODES[admission.reason]);
  const name = admission.room ?? requested;
  const load = await registry.acquire(name);
  if (!load.ok) {
    host.logger.warn('The room cannot open: storage is unavailable.', {
      room: name,
      error: load.error,
    });
    return close(connection, CLOSE_CODES.unavailable, 'unavailable');
  }
  if (connection.closed) return registry.release(load.room);
  // A document from another generation would bring back what the room discarded when it started
  // over; a client without a generation has never synced and may join any.
  if (generation !== null && generation !== readRoomGeneration(load.room.doc)) {
    registry.release(load.room);
    return refuse(connection, 'generation-mismatch', CLOSE_CODES.gone);
  }
  if (admission.expiresAt !== undefined && host.clock.now() >= admission.expiresAt) {
    registry.release(load.room);
    return close(connection, CLOSE_CODES.unauthenticated, 'expired');
  }
  enter(connection, load.room, admission);
  if (!connection.closed && admission.expiresAt !== undefined) {
    const refresh = { room: name, token, params, headers: request.headers, actor: admission.actor };
    startRefreshing(connection, refresh, admission.expiresAt);
  }
}

/**
 * Admits a connection, joins it to its room and reads its frames. Frames that arrive before the
 * room is ready wait in order.
 */
export function connectMember(
  socket: RoomServerSocket,
  request: RoomServerRequest,
  dependencies: ConnectionDependencies,
): RoomServerConnection {
  const shutdown = () => close(connection, CLOSE_CODES.shutdown, 'shutdown');
  const connection: Connection = {
    socket,
    dependencies,
    queue: [],
    context: null,
    closed: false,
    stopReauthorization: null,
    onClosed: () => dependencies.connections.delete(shutdown),
  };
  dependencies.connections.add(shutdown);
  join(connection, request).catch((error: unknown) => {
    dependencies.host.logger.error('Admitting a connection failed.', { error });
    close(connection, CLOSE_CODES.unavailable, 'unavailable');
  });
  return {
    receive: (frame) => {
      if (connection.closed) return;
      if (connection.context) read(connection, frame, connection.context);
      else connection.queue.push(frame);
    },
    closed: () => {
      connection.closed = true;
      leave(connection);
    },
  };
}
