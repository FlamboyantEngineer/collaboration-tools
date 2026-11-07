/**
 * A socket event handler, checked like a method so the platform's handlers, which take a fuller
 * event, satisfy it.
 */
export type SocketHandler<Event> = { handle(event: Event): void }['handle'];

/** The part of a WebSocket the provider uses; the platform `WebSocket` satisfies it. */
export interface RoomSocket {
  binaryType: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  onopen: SocketHandler<unknown> | null;
  onmessage: SocketHandler<{ data: unknown }> | null;
  onclose: SocketHandler<{ code: number; reason: string }> | null;
  onerror: SocketHandler<unknown> | null;
}

/** Opens a socket to `url`. */
export type RoomSocketFactory = (url: string) => RoomSocket;

/** Browser connectivity events, such as a window's `online` and `offline`. */
export interface ConnectivityEvents {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

/** Opens sockets with the platform `WebSocket`. */
export const PLATFORM_SOCKET_FACTORY: RoomSocketFactory = (url) => new WebSocket(url);

/** The bytes of a message event, or `null` for a text frame. */
export function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}
