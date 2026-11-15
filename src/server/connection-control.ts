/** Selects active connections by the intersection of authenticated attributes. */
export interface RoomConnectionTarget {
  room?: string | undefined;
  actorId?: string | undefined;
  sessionId?: string | undefined;
}

/** A connection's private authorization controls. */
export interface RoomConnectionControl {
  revoke(target: RoomConnectionTarget): void;
  refresh(target: RoomConnectionTarget): Promise<void>;
}

/** Matches every specified attribute; an empty target deliberately matches all connections. */
export function matchesConnection(
  target: RoomConnectionTarget,
  identity: RoomConnectionTarget,
): boolean {
  return (
    (target.room === undefined || target.room === identity.room) &&
    (target.actorId === undefined || target.actorId === identity.actorId) &&
    (target.sessionId === undefined || target.sessionId === identity.sessionId)
  );
}
