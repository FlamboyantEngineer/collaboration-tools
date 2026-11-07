import type { RoomSocket, RoomSocketFactory } from '../src/client/room-socket.js';
import type { RoomServer, RoomServerConnection } from '../src/server/index.js';

/** A client socket wired to a room server in the same process, as a WebSocket would be. */
export class PairedSocket implements RoomSocket {
  binaryType = 'blob';
  onopen: RoomSocket['onopen'] = null;
  onmessage: RoomSocket['onmessage'] = null;
  onclose: RoomSocket['onclose'] = null;
  onerror: RoomSocket['onerror'] = null;
  closed = false;
  /** Set once the client closed the socket; the platform delivers nothing after that. */
  closedByClient = false;
  /** The code and reason the server closed the socket with. */
  serverClose: { code: number; reason: string } | null = null;
  /** Every frame the server sent, in order. */
  readonly received: Uint8Array[] = [];
  /** When set, frames from the server are dropped instead of delivered. */
  deaf = false;
  connection: RoomServerConnection | null = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.closed) throw new Error('send on a closed socket');
    const copy = data.slice();
    queueMicrotask(() => {
      if (!this.closed) this.connection?.receive(copy);
    });
  }

  close(): void {
    if (!this.closed) this.closedByClient = true;
    this.finish(1000, '');
  }

  /** Delivers a frame from the server. */
  deliver(frame: Uint8Array): void {
    const copy = frame.slice();
    this.received.push(copy);
    queueMicrotask(() => {
      // What the server sent before it closed the socket still arrives, as over a WebSocket.
      if (!this.closedByClient && !this.deaf) this.onmessage?.({ data: copy.buffer });
    });
  }

  /** Drops the connection as a network failure would. */
  drop(): void {
    if (!this.closed) this.closedByClient = true;
    this.finish(1006, '');
  }

  finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      this.connection?.closed();
      this.onclose?.({ code, reason });
    });
  }
}

export interface ServerSockets {
  /** Pass as a provider's `createSocket`. */
  createSocket: RoomSocketFactory;
  /** Every socket a client opened, in order. */
  readonly sockets: PairedSocket[];
}

/** Connects client sockets to `server`; each one opens, then the server admits it. */
export function connectToServer(
  server: RoomServer,
  headers: Readonly<Record<string, string>> = {},
): ServerSockets {
  const sockets: PairedSocket[] = [];
  const createSocket: RoomSocketFactory = (url) => {
    const socket = new PairedSocket(url);
    sockets.push(socket);
    const { pathname, search } = new URL(url);
    socket.connection = server.connect(
      {
        send: (frame) => socket.deliver(frame),
        close: (code, reason) => {
          socket.serverClose = { code, reason };
          socket.finish(code, reason);
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

/** Waits until queued socket messages and pending promises have settled. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
