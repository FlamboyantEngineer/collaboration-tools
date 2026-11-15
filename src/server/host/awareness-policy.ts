/** Authenticated context for normalizing a client's untrusted presence fields. */
export interface RoomAwarenessChange {
  room: string;
  actor: { id: string; name?: string | undefined };
  state: Readonly<Record<string, unknown>>;
}

/** Selects the presence fields a host permits; exceptions and null refuse the update. */
export interface RoomAwareness {
  normalize(change: RoomAwarenessChange): Record<string, unknown> | null;
}
