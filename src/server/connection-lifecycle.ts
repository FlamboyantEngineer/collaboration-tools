import { CLOSE_CODES, encodeAuthMessage } from '../protocol/messages.js';
import { matchesConnection, type RoomConnectionTarget } from './connection-control.js';
import type { PendingConnection } from './connection-pending.js';
import type { ConnectionDependencies, RoomServerSocket } from './connection-types.js';
import type { RoomAdmission, RoomRefreshRequest } from './host/adapters.js';
import type { MemberContext } from './member-frames.js';
import { startReauthorization } from './reauthorization.js';
import { emitEvent } from './stored-room.js';

const REFUSAL_CODES = {
  unauthenticated: CLOSE_CODES.unauthenticated,
  forbidden: CLOSE_CODES.forbidden,
  'not-found': CLOSE_CODES.notFound,
};

/** One connection's state, shared by the steps below. */
export interface Connection {
  socket: RoomServerSocket;
  dependencies: ConnectionDependencies;
  /** Frames that arrived before the room was ready. */
  pending: PendingConnection;
  context: MemberContext | null;
  identity: RoomConnectionTarget;
  revocations: RoomConnectionTarget[];
  refreshes: RoomConnectionTarget[];
  refreshRequest: RoomRefreshRequest | null;
  refreshing: boolean;
  stopRefresh: (() => void) | null;
  expiresAt: number | undefined;
  closed: boolean;
  onClosed(): void;
  /** Stops refreshing the connection's decision. */
  stopReauthorization: (() => void) | null;
}

export function leave(connection: Connection) {
  connection.pending.clear();
  connection.revocations.length = 0;
  connection.refreshes.length = 0;
  connection.stopRefresh?.();
  connection.stopRefresh = null;
  connection.onClosed();
  connection.stopReauthorization?.();
  connection.stopReauthorization = null;
  if (!connection.context) return;
  const { context } = connection;
  const { room, member } = context;
  connection.context = null;
  room.leave(member);
  emitEvent(connection.dependencies.host, { type: 'left', room: room.name, actor: context.actor });
  connection.dependencies.registry.release(room);
}

export function close(connection: Connection, code: number, reason: string) {
  if (connection.closed) return;
  connection.closed = true;
  try {
    connection.socket.close(code, reason);
  } finally {
    leave(connection);
  }
}

/** Tells the client why, so it stops reconnecting, and closes the socket. */
export function refuse(connection: Connection, reason: string, code: number) {
  if (connection.closed) return;
  try {
    connection.socket.send(encodeAuthMessage({ type: 'denied', reason }));
  } finally {
    close(connection, code, reason);
  }
}

/** Applies a refreshed decision: a refusal closes the connection, a new access is announced. */
function applyDecision(connection: Connection, decision: RoomAdmission) {
  const { context } = connection;
  if (!context) return;
  if (!decision.ok) return refuse(connection, decision.reason, REFUSAL_CODES[decision.reason]);
  if (
    decision.actor.id !== context.actor.id ||
    (decision.room !== undefined && decision.room !== context.room.name) ||
    decision.sessionId !== connection.identity.sessionId
  )
    return refuse(connection, 'identity-changed', CLOSE_CODES.forbidden);
  connection.expiresAt = decision.expiresAt;
  context.capabilities = new Set(decision.capabilities);
  if (decision.access === context.access) return;
  context.access = decision.access;
  context.member.send(encodeAuthMessage({ type: 'granted', access: decision.access }));
}

export function startRefreshing(
  connection: Connection,
  request: RoomRefreshRequest,
  expiresAt: number,
) {
  if (connection.closed) return;
  connection.stopReauthorization = startReauthorization({
    host: connection.dependencies.host,
    request,
    expiresAt,
    onDecision: (decision) => applyDecision(connection, decision),
    // Without the auth message the client reconnects, with a fresh token.
    onExpired: () => close(connection, CLOSE_CODES.unauthenticated, 'expired'),
  });
}

function isExpiredDecision(decision: RoomAdmission, now: number): boolean {
  return decision.ok && decision.expiresAt !== undefined && decision.expiresAt <= now;
}

export async function refreshConnection(connection: Connection): Promise<void> {
  if (connection.closed || connection.refreshing) return;
  const { host } = connection.dependencies;
  const request = connection.refreshRequest;
  if (!request || !host.auth.refresh)
    return refuse(connection, 'refresh-unavailable', CLOSE_CODES.forbidden);
  connection.refreshing = true;
  let timeout: ReturnType<typeof host.clock.setTimeout> | null = null;
  const cancelled = new Promise<null>((resolve) => {
    connection.stopRefresh = () => {
      if (timeout !== null) host.clock.clearTimeout(timeout);
      resolve(null);
    };
    timeout = host.clock.setTimeout(
      () => {
        close(connection, CLOSE_CODES.unauthenticated, 'refresh-timeout');
        resolve(null);
      },
      Math.max(0, Math.min(10_000, (connection.expiresAt ?? Infinity) - host.clock.now())),
    );
  });
  connection.stopReauthorization?.();
  connection.stopReauthorization = null;
  try {
    const decision = await Promise.race([host.auth.refresh(request), cancelled]);
    if (connection.closed || decision === null) return;
    if (isExpiredDecision(decision, host.clock.now()))
      return close(connection, CLOSE_CODES.unauthenticated, 'expired');
    applyDecision(connection, decision);
    if (!connection.closed && decision.ok && decision.expiresAt !== undefined)
      startRefreshing(connection, request, decision.expiresAt);
  } catch {
    close(connection, CLOSE_CODES.forbidden, 'refresh-failed');
  } finally {
    if (timeout !== null) host.clock.clearTimeout(timeout);
    connection.stopRefresh = null;
    connection.refreshing = false;
  }
}

/** Revocation attempts every target even when one custom transport fails. */
function revokeConnection(connection: Connection): void {
  try {
    refuse(connection, 'revoked', CLOSE_CODES.forbidden);
  } catch (error) {
    connection.dependencies.host.logger.warn('Closing a revoked connection failed.', { error });
  }
}

/** Remembers pending targets until authentication establishes the canonical identity. */
export function requestRevocation(connection: Connection, target: RoomConnectionTarget): void {
  if (connection.closed) return;
  if (connection.identity.actorId === undefined) connection.revocations.push({ ...target });
  if (matchesConnection(target, connection.identity)) revokeConnection(connection);
}

/** Pending refreshes force fresh admission rather than entering with a superseded decision. */
export function requestRefresh(connection: Connection, target: RoomConnectionTarget): boolean {
  if (connection.closed) return false;
  if (connection.identity.actorId === undefined) connection.refreshes.push({ ...target });
  if (!matchesConnection(target, connection.identity)) return false;
  if (connection.context) return true;
  close(connection, CLOSE_CODES.unavailable, 'reauthorization-required');
  return false;
}

/** Enforces controls issued before admission revealed the canonical identity. */
export function acceptPendingAuthorization(connection: Connection): boolean {
  if (connection.revocations.some((target) => matchesConnection(target, connection.identity))) {
    revokeConnection(connection);
    return false;
  }
  if (connection.refreshes.some((target) => matchesConnection(target, connection.identity))) {
    close(connection, CLOSE_CODES.unavailable, 'reauthorization-required');
    return false;
  }
  connection.revocations.length = 0;
  connection.refreshes.length = 0;
  return true;
}
