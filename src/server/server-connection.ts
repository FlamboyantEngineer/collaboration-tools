import { CLOSE_CODES, encodeAuthMessage, encodeStatelessMessage } from '../protocol/messages.js';
import { readRoomGeneration } from '../protocol/room-meta.js';
import { parseRoomUrl } from '../protocol/room-url.js';
import type { RoomConnectionControl } from './connection-control.js';
import {
  acceptPendingAuthorization,
  close,
  type Connection,
  leave,
  refreshConnection,
  refuse,
  requestRefresh,
  requestRevocation,
  startRefreshing,
} from './connection-lifecycle.js';
import { createPendingConnection } from './connection-pending.js';
import type {
  ConnectionDependencies,
  RoomServerConnection,
  RoomServerRequest,
  RoomServerSocket,
} from './connection-types.js';
import type { RoomAdmission, RoomRefusal } from './host/adapters.js';
import type { LiveRoom, RoomMember } from './live-room.js';
import { type MemberContext, readMemberFrame, sendWelcome } from './member-frames.js';
export type {
  ConnectionDependencies,
  RoomServerConnection,
  RoomServerRequest,
  RoomServerSocket,
  RoomStatelessMessage,
} from './connection-types.js';
import { emitEvent } from './stored-room.js';

type RoomAdmitted = Extract<RoomAdmission, { ok: true }>;

const REFUSAL_CODES: Readonly<Record<RoomRefusal, number>> = {
  unauthenticated: CLOSE_CODES.unauthenticated,
  forbidden: CLOSE_CODES.forbidden,
  'not-found': CLOSE_CODES.notFound,
};

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
    normalizeAwareness: (state) =>
      dependencies.host.awareness.normalize({ room: room.name, actor, state }),
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
  emitEvent(dependencies.host, {
    type: 'joined',
    room: room.name,
    actor,
    access: admission.access,
  });
  sendWelcome(context);
  for (const frame of connection.pending.drain())
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
  connection.expiresAt = admission.expiresAt;
  connection.identity = { room: name, actorId: admission.actor.id, sessionId: admission.sessionId };
  if (!acceptPendingAuthorization(connection)) return;
  connection.refreshRequest = {
    room: name,
    token,
    params,
    headers: request.headers,
    actor: admission.actor,
  };
  connection.pending.arm('load');
  const load = await registry.acquire(name);
  if (!load.ok) {
    host.logger.warn('The room cannot open: storage is unavailable.', {
      room: name,
      error: load.error,
    });
    return close(connection, CLOSE_CODES.unavailable, 'unavailable');
  }
  if (connection.closed) return registry.release(load.room);
  if (!load.room.accepting) {
    registry.release(load.room);
    return close(connection, CLOSE_CODES.unavailable, 'room-busy');
  }
  // A document from another generation would bring back what the room discarded when it started
  // over; a client without a generation has never synced and may join any.
  const roomGeneration = readRoomGeneration(load.room.doc);
  if (generation !== null && generation !== roomGeneration) {
    registry.release(load.room);
    // The client may read and so may learn which generation to recover into.
    if (roomGeneration !== null) {
      connection.socket.send(encodeAuthMessage({ type: 'generation', generation: roomGeneration }));
    }
    return refuse(connection, 'generation-mismatch', CLOSE_CODES.gone);
  }
  if (admission.expiresAt !== undefined && host.clock.now() >= admission.expiresAt) {
    registry.release(load.room);
    return close(connection, CLOSE_CODES.unauthenticated, 'expired');
  }
  enter(connection, load.room, admission);
  if (admission.expiresAt !== undefined) {
    const refresh = { room: name, token, params, headers: request.headers, actor: admission.actor };
    startRefreshing(connection, refresh, admission.expiresAt);
  }
}

function queueFrame(connection: Connection, request: RoomServerRequest, frame: Uint8Array) {
  if (connection.pending.push(frame)) return;
  connection.dependencies.host.logger.warn('A connection sent too much before it was admitted.', {
    room: parseRoomUrl(request.url)?.room ?? null,
    bytes: connection.pending.bytes() + frame.byteLength + 64,
  });
  close(connection, 1009, 'too-large');
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
  let refreshing: Promise<void> | null = null;
  const control: RoomConnectionControl = {
    revoke: (target) => requestRevocation(connection, target),
    refresh: (target) => {
      if (!requestRefresh(connection, target)) return Promise.resolve();
      return (refreshing ??= refreshConnection(connection).finally(() => {
        refreshing = null;
      }));
    },
  };
  const connection: Connection = {
    socket,
    dependencies,
    pending: createPendingConnection({
      clock: dependencies.host.clock,
      maxPendingBytes: dependencies.maxPendingBytes,
      limits: dependencies.limits,
      onTimeout: () => close(connection, CLOSE_CODES.unavailable, 'admission-timeout'),
    }),
    context: null,
    identity: {},
    revocations: [],
    refreshes: [],
    refreshRequest: null,
    refreshing: false,
    stopRefresh: null,
    expiresAt: undefined,
    closed: false,
    stopReauthorization: null,
    onClosed: () => {
      dependencies.connections.delete(shutdown);
      dependencies.controls.delete(control);
    },
  };
  dependencies.connections.add(shutdown);
  dependencies.controls.add(control);
  connection.pending.arm('admission');
  join(connection, request).catch((error: unknown) => {
    dependencies.host.logger.error('Admitting a connection failed.', { error });
    close(connection, CLOSE_CODES.unavailable, 'unavailable');
  });
  return {
    receive: (frame) => {
      if (connection.closed || connection.refreshing) return;
      if (connection.context) read(connection, frame, connection.context);
      else queueFrame(connection, request, frame);
    },
    closed: () => {
      connection.closed = true;
      leave(connection);
    },
  };
}
