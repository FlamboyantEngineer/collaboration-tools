import type { Awareness } from '@y/protocols/awareness';
import type { Doc } from '@y/y';
import type { RoomClock } from '../protocol/clock.js';
import type { AuthMessage } from '../protocol/messages.js';
import { reportListenerError } from './connection-state.js';
import { encodeAwarenessFrame, encodeSyncStep1, readServerFrame } from './frames.js';
import { frameBytes, type RoomSocket, type RoomSocketFactory } from './room-socket.js';
import { createStaleSocketCheck } from './stale-socket-check.js';

/** What every socket of one provider shares. */
export interface SocketConfig {
  readonly createSocket: RoomSocketFactory;
  readonly clock: RoomClock;
  readonly doc: Doc;
  readonly awareness: Awareness;
  /** The transaction origin of everything the server sends. */
  readonly origin: object;
  readonly socketTimeoutMs: number;
}

export interface SocketEvents {
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

/** How often the stale-socket check runs. */
const CHECK_CADENCE_MS = 4_000;

function sendOpeningFrames(socket: RoomSocket, { doc, awareness }: SocketConfig) {
  socket.send(encodeSyncStep1(doc));
  if (awareness.getLocalState() !== null) {
    socket.send(encodeAwarenessFrame(awareness, [awareness.clientID]));
  }
}

/** Opens a socket to `url` and drives it until it closes. */
export function openSocketSession(
  url: string,
  config: SocketConfig,
  events: SocketEvents,
): SocketSession {
  const { clock } = config;
  const socket = config.createSocket(url);
  socket.binaryType = 'arraybuffer';
  let open = false;
  let closed = false;
  let lastMessageAt = clock.now();
  const frameContext = { ...config, ...events };

  const finish = (code: number | null) => {
    if (closed) return;
    closed = true;
    open = false;
    staleCheck.stop();
    socket.onopen = socket.onmessage = socket.onclose = null;
    events.onClose(code);
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
    timeoutMs: config.socketTimeoutMs,
    cadenceMs: CHECK_CADENCE_MS,
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
    events.onOpen();
    sendOpeningFrames(socket, config);
  };
  socket.onmessage = (event) => {
    lastMessageAt = clock.now();
    const frame = frameBytes(event.data);
    if (!frame) return;
    try {
      const reply = readServerFrame(frame, frameContext);
      if (reply) send(reply);
    } catch (error) {
      reportListenerError(error);
    }
  };
  socket.onclose = (event) => finish(event.code);

  return { isOpen: () => open, send, close };
}
