/** The query parameter that carries the client's token. */
export const TOKEN_PARAM = 'token';

/** The query parameter that carries the generation of the client's document (COLLAB-PROTOCOL-3). */
export const GENERATION_PARAM = 'generation';

const RESERVED_PARAMS: ReadonlySet<string> = new Set([TOKEN_PARAM, GENERATION_PARAM]);

export interface RoomUrlParts {
  /** The room, as the client named it. */
  room: string;
  /** The token the client sent, or `null`. */
  token: string | null;
  /** The generation of the client's document, or `null` for a document that has none. */
  generation: string | null;
  /** Every other query parameter. */
  params: Readonly<Record<string, string>>;
}

export interface BuildRoomUrlOptions {
  /** The server's endpoint, such as `wss://example.test/rooms`. Its own query is kept. */
  endpoint: string;
  room: string;
  token?: string | null | undefined;
  generation?: string | null | undefined;
  params?: Readonly<Record<string, string>> | undefined;
}

/**
 * The URL a client opens for a room: the endpoint, then the room as one encoded path segment, then
 * the endpoint's query, the caller's parameters, the generation and the token.
 */
export function buildRoomUrl(options: BuildRoomUrlOptions): string {
  const url = new URL(options.endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(options.room)}`;
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (!RESERVED_PARAMS.has(key)) url.searchParams.set(key, value);
  }
  for (const key of RESERVED_PARAMS) url.searchParams.delete(key);
  if (options.generation) url.searchParams.set(GENERATION_PARAM, options.generation);
  if (options.token) url.searchParams.set(TOKEN_PARAM, options.token);
  return url.toString();
}

/**
 * Reads the room, token, generation and parameters from a request path such as `/rooms/a%2Fb?token=t`, where
 * the room is the last path segment. Returns `null` when the path names no room.
 */
export function parseRoomUrl(path: string): RoomUrlParts | null {
  let url: URL;
  let room: string;
  try {
    url = new URL(path, 'http://room.invalid');
    room = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  } catch {
    return null;
  }
  if (!room) return null;
  const params = Object.fromEntries(
    [...url.searchParams].filter(([key]) => !RESERVED_PARAMS.has(key)),
  );
  const { searchParams } = url;
  return {
    room,
    token: searchParams.get(TOKEN_PARAM),
    generation: searchParams.get(GENERATION_PARAM) || null,
    params,
  };
}
