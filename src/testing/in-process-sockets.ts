import type { RoomSocket, RoomSocketFactory } from '../client/room-socket.js';
import type { RoomServer } from '../server/room-server.js';
import type { RoomServerConnection } from '../server/server-connection.js';

/**
 * A client socket wired to a room server in the same process, as a WebSocket would be: frames
 * travel in queued microtasks, so providers run their real handshake, echoes and awareness.
 */
export interface PairedSocket extends RoomSocket {
  readonly url: string;
  /** The server's side of the socket. */
  readonly connection: RoomServerConnection;
  /** Set once either side closed the socket or it dropped. */
  readonly closed: boolean;
  /** Set once the client closed the socket or it dropped; nothing is delivered after that. */
  readonly closedByClient: boolean;
  /** The code and reason the server closed the socket with. */
  readonly serverClose: { code: number; reason: string } | null;
  /** Every frame the client sent, in order. */
  readonly sent: readonly Uint8Array[];
  /** Every frame the server sent, in order. */
  readonly received: readonly Uint8Array[];
  /** When set, frames from the server are dropped instead of delivered. */
  deaf: boolean;
  /** Drops the connection as a network failure would, with close code 1006. */
  drop(): void;
}

export interface ServerSockets {
  /** Pass as a provider's `createSocket`. */
  createSocket: RoomSocketFactory;
  /** Every socket a client opened, in order. */
  readonly sockets: readonly PairedSocket[];
}

/**
 * Connects client sockets to `server` in this process, for tests and labs. Each socket opens in a
 * microtask, then the server admits it with `headers` as the request headers.
 */
export function connectToServer(
  server: RoomServer,
  headers: Readonly<Record<string, string>> = {},
): ServerSockets {
  const sockets: PairedSocket[] = [];
  const createSocket: RoomSocketFactory = (url) => {
    const { pathname, search } = new URL(url);
    const sent: Uint8Array[] = [];
    const received: Uint8Array[] = [];
    let connection: RoomServerConnection | null = null;
    const finish = (code: number, reason: string) => {
      if (socket.closed) return;
      socket.closed = true;
      queueMicrotask(() => {
        connection?.closed();
        socket.onclose?.({ code, reason });
      });
    };
    const socket: { -readonly [Key in keyof PairedSocket]: PairedSocket[Key] } = {
      url,
      binaryType: 'blob',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      closed: false,
      closedByClient: false,
      serverClose: null,
      sent,
      received,
      deaf: false,
      get connection(): RoomServerConnection {
        if (!connection) throw new Error('the socket is not connected yet');
        return connection;
      },
      send(data: Uint8Array<ArrayBuffer>) {
        if (socket.closed) throw new Error('send on a closed socket');
        const copy = data.slice();
        sent.push(copy);
        queueMicrotask(() => {
          if (!socket.closed) connection?.receive(copy);
        });
      },
      close() {
        if (!socket.closed) socket.closedByClient = true;
        finish(1000, '');
      },
      drop() {
        if (!socket.closed) socket.closedByClient = true;
        finish(1006, '');
      },
    };
    sockets.push(socket);
    connection = server.connect(
      {
        send: (frame) => {
          const copy = frame.slice();
          received.push(copy);
          queueMicrotask(() => {
            // What the server sent before it closed the socket still arrives, as over a WebSocket.
            if (!socket.closedByClient && !socket.deaf) socket.onmessage?.({ data: copy.buffer });
          });
        },
        close: (code, reason) => {
          socket.serverClose = { code, reason };
          finish(code, reason);
        },
      },
      { url: pathname + search, headers },
    );
    queueMicrotask(() => {
      if (!socket.closed) socket.onopen?.({});
    });
    return socket;
  };
  return { createSocket, sockets };
}
