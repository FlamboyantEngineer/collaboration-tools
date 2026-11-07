import { CLOSE_CODES, encodeAuthMessage, encodeStatelessMessage } from '../protocol/messages.js';
import { parseRoomUrl } from '../protocol/room-url.js';
import type {
  RoomActor,
  RoomAdmission,
  RoomAdmissionRequest,
  RoomRefusal,
} from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import type { LiveRoom, RoomMember } from './live-room.js';
import { type MemberContext, readMemberFrame, sendWelcome } from './member-frames.js';
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
}

function leave(connection: Connection) {
  if (!connection.context) return;
  const { room, member } = connection.context;
  connection.context = null;
  room.leave(member);
  connection.dependencies.registry.release(room);
}

function close(connection: Connection, code: number, reason: string) {
  if (connection.closed) return;
  connection.closed = true;
  connection.socket.close(code, reason);
  leave(connection);
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
  const member: RoomMember = {
    send: (frame) => {
      if (!connection.closed) socket.send(frame);
    },
    close: (code, reason) => close(connection, code, reason),
  };
  const context: MemberContext = {
    room,
    member,
    access: admission.access,
    onStateless: (payload) =>
      dependencies.onStateless?.({
        room: room.name,
        actor: admission.actor,
        payload,
        reply: (answer) => member.send(encodeStatelessMessage(answer)),
      }),
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
  const { room: requested, token, params } = parts;
  const admission = await host.auth.admit({
    room: requested,
    token,
    params,
    headers: request.headers,
  });
  if (connection.closed) return;
  if (!admission.ok) {
    connection.socket.send(encodeAuthMessage({ type: 'denied', reason: admission.reason }));
    return close(connection, REFUSAL_CODES[admission.reason], admission.reason);
  }
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
  enter(connection, load.room, admission);
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
  const connection: Connection = { socket, dependencies, queue: [], context: null, closed: false };
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
