/** The query parameter that carries the client's token. */
export const TOKEN_PARAM = 'token';

export interface RoomUrlParts {
  /** The room, as the client named it. */
  room: string;
  /** The token the client sent, or `null`. */
  token: string | null;
  /** Every other query parameter. */
  params: Readonly<Record<string, string>>;
}

export interface BuildRoomUrlOptions {
  /** The server's endpoint, such as `wss://example.test/rooms`. Its own query is kept. */
  endpoint: string;
  room: string;
  token?: string | null | undefined;
  params?: Readonly<Record<string, string>> | undefined;
}

/**
 * The URL a client opens for a room: the endpoint, then the room as one encoded path segment, then
 * the endpoint's query, the caller's parameters and the token.
 */
export function buildRoomUrl(options: BuildRoomUrlOptions): string {
  const url = new URL(options.endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(options.room)}`;
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (key !== TOKEN_PARAM) url.searchParams.set(key, value);
  }
  if (options.token) url.searchParams.set(TOKEN_PARAM, options.token);
  return url.toString();
}

/**
 * Reads the room, token and parameters from a request path such as `/rooms/a%2Fb?token=t`, where
 * the room is the last path segment. Returns `null` when the path names no room.
 */
export function parseRoomUrl(path: string): RoomUrlParts | null {
  const url = new URL(path, 'http://room.invalid');
  const segment = url.pathname.split('/').pop() ?? '';
  let room: string;
  try {
    room = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!room) return null;
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (key !== TOKEN_PARAM) params[key] = value;
  });
  return { room, token: url.searchParams.get(TOKEN_PARAM), params };
}
