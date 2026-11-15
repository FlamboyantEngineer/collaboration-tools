import type { RoomSocket, RoomSocketFactory } from '../src/client/room-socket.js';

/** A client socket that has not opened yet, for tests of how a provider waits and retries. */
export interface UnopenedSocket extends RoomSocket {
  readonly url: string;
  /** Fails the socket before it opened, as a refused or lost connection does, with code 1006. */
  drop(): void;
}

/** Opens sockets that never reach a server; each stays unopened until a test drops it. */
export function createUnopenedSockets(): {
  createSocket: RoomSocketFactory;
  readonly sockets: readonly UnopenedSocket[];
} {
  const sockets: UnopenedSocket[] = [];
  const createSocket: RoomSocketFactory = (url) => {
    let closed = false;
    const socket: UnopenedSocket = {
      url,
      binaryType: 'blob',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => {
        throw new Error('send on a socket that did not open');
      },
      close: () => socket.drop(),
      drop: () => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => socket.onclose?.({ code: 1006, reason: '' }));
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { createSocket, sockets };
}
