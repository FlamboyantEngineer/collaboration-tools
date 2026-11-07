import type { Awareness } from '@y/protocols/awareness';
import type { Doc } from '@y/y';
import type { RoomClock } from '../protocol/clock.js';
import type { AuthMessage } from '../protocol/messages.js';
import { reportListenerError } from './connection-state.js';
import { encodeAwarenessFrame, encodeSyncStep1, readServerFrame } from './frames.js';
import { frameBytes, type RoomSocket, type RoomSocketFactory } from './room-socket.js';
import { createStaleSocketCheck } from './stale-socket-check.js';

export interface SocketSessionOptions {
  url: string;
  createSocket: RoomSocketFactory;
  clock: RoomClock;
  doc: Doc;
  awareness: Awareness;
  origin: unknown;
  socketTimeoutMs: number;
  checkCadenceMs: number;
  onOpen(): void;
  onRemoteUpdate(update: Uint8Array, isSyncStep2: boolean): void;
  onAuth(message: AuthMessage): void;
  onStateless(payload: string): void;
  /** Runs once, when the socket closes for any reason; `code` is `null` when the client closed it. */
  onClose(code: number | null): void;
}

/** One socket's life, from opening to its single close. */
export interface SocketSession {
  /** Whether the socket is open and has not closed. */
  isOpen(): boolean;
  /** Sends `frame` when the socket is open; returns whether it did. */
  send(frame: Uint8Array<ArrayBuffer>): boolean;
  /** Closes the socket now, without waiting for the platform's close event. */
  close(): void;
}

function sendOpeningFrames(socket: RoomSocket, options: SocketSessionOptions) {
  socket.send(encodeSyncStep1(options.doc));
  const { awareness } = options;
  if (awareness.getLocalState() !== null) {
    socket.send(encodeAwarenessFrame(awareness, [awareness.clientID]));
  }
}

/** Opens a socket and drives it until it closes. */
export function openSocketSession(options: SocketSessionOptions): SocketSession {
  const { clock } = options;
  const socket = options.createSocket(options.url);
  socket.binaryType = 'arraybuffer';
  let open = false;
  let closed = false;
  let lastMessageAt = clock.now();

  const finish = (code: number | null) => {
    if (closed) return;
    closed = true;
    open = false;
    staleCheck.stop();
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    options.onClose(code);
  };
  const close = () => {
    try {
      socket.close();
    } finally {
      finish(null);
    }
  };
  const staleCheck = createStaleSocketCheck({
    clock,
    timeoutMs: options.socketTimeoutMs,
    cadenceMs: options.checkCadenceMs,
    lastMessageAt: () => lastMessageAt,
    onStale: close,
  });
  const send = (frame: Uint8Array<ArrayBuffer>) => {
    if (!open) return false;
    socket.send(frame);
    return true;
  };

  socket.onopen = () => {
    open = true;
    lastMessageAt = clock.now();
    staleCheck.start();
    options.onOpen();
    sendOpeningFrames(socket, options);
  };
  socket.onmessage = (event) => {
    lastMessageAt = clock.now();
    const frame = frameBytes(event.data);
    if (!frame) return;
    try {
      const reply = readServerFrame(frame, options);
      if (reply) send(reply);
    } catch (error) {
      reportListenerError(error);
    }
  };
  socket.onclose = (event) => finish(event.code);
  socket.onerror = () => undefined;

  return { isOpen: () => open, send, close };
}
