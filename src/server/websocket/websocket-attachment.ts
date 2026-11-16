import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import * as syncProtocol from '@y/protocols/sync';
import * as decoding from 'lib0/decoding';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { PLATFORM_CLOCK, type RoomClock, type RoomTimer } from '../../protocol/clock.js';
import { CLOSE_CODES, MESSAGE_TYPES } from '../../protocol/messages.js';
import type { RoomServer } from '../room-server.js';

export interface AttachRoomServerOptions {
  /** The HTTP server whose upgrades to accept. */
  server: Server;
  /** Upgrades to this path, followed by `/<room>`, are rooms; others are left to other handlers. */
  path: string;
  /** Larger frames close the socket. Defaults to 64 MiB. */
  maxPayloadBytes?: number | undefined;
  /** Closes slow consumers before queued outgoing data exceeds this many bytes; defaults to the larger of 4 MiB and maxPayloadBytes. */
  maxBufferedBytes?: number | undefined;
  /** Every socket is pinged this often and dropped when it missed the last pong. Defaults to 30000. */
  pingIntervalMs?: number | undefined;
  /** Defaults to the platform clock. */
  clock?: RoomClock | undefined;
  /**
   * Negotiates per-message compression with clients that offer it. Off by default: the upgrade is
   * accepted before in-band authentication, so an operator turns it on only once they accept that.
   */
  compression?: RoomSocketCompression | undefined;
  /** Told of each frame written to a socket, once per recipient, at its uncompressed size. */
  onFrameSent?: ((frame: SentFrame) => void) | undefined;
}

/** How sockets compress frames, when an operator turns compression on. */
export interface RoomSocketCompression {
  /** Frames smaller than this many bytes are sent as they are. Defaults to 4096. */
  thresholdBytes?: number | undefined;
  /** The zlib level, 0 to 9. Defaults to 3. */
  level?: number | undefined;
  /** How many frames compress or decompress at once. Defaults to 8. */
  concurrency?: number | undefined;
}

/** What a frame written to a socket carries. */
export type SentFrameType =
  | 'sync-step1'
  | 'sync-step2'
  | 'sync-update'
  | 'awareness'
  | 'auth'
  | 'query-awareness'
  | 'stateless'
  | 'storage'
  | 'unknown';

/** A frame written to a socket: what it carries and its uncompressed size in bytes. */
export interface SentFrame {
  type: SentFrameType;
  bytes: number;
}

/** Stops accepting room upgrades. */
export interface RoomServerAttachment {
  /** Stops accepting upgrades and drops every socket; the room server's `close` stores the rooms. */
  close(): void;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

const SYNC_TYPES: Readonly<Record<number, SentFrameType>> = {
  [syncProtocol.messageYjsSyncStep1]: 'sync-step1',
  [syncProtocol.messageYjsSyncStep2]: 'sync-step2',
  [syncProtocol.messageYjsUpdate]: 'sync-update',
};

const MESSAGE_KINDS: Readonly<Record<number, SentFrameType>> = {
  [MESSAGE_TYPES.awareness]: 'awareness',
  [MESSAGE_TYPES.auth]: 'auth',
  [MESSAGE_TYPES.queryAwareness]: 'query-awareness',
  [MESSAGE_TYPES.stateless]: 'stateless',
  [MESSAGE_TYPES.storage]: 'storage',
};

/** What an outgoing frame carries, read from its message type and, for sync, its step. */
function sentFrameType(frame: Uint8Array): SentFrameType {
  try {
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type !== MESSAGE_TYPES.sync) return MESSAGE_KINDS[type] ?? 'unknown';
    return SYNC_TYPES[decoding.readVarUint(decoder)] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function perMessageDeflate(compression: RoomSocketCompression | undefined) {
  if (!compression) return false;
  return {
    threshold: compression.thresholdBytes ?? 4096,
    zlibDeflateOptions: { level: compression.level ?? 3 },
    concurrencyLimit: compression.concurrency ?? 8,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  };
}

// A recorder that throws changes nothing about the socket.
function reportSent(onFrameSent: ((frame: SentFrame) => void) | undefined, frame: Uint8Array) {
  if (!onFrameSent) return;
  try {
    onFrameSent({ type: sentFrameType(frame), bytes: frame.byteLength });
  } catch {
    // Metrics never change what a socket does.
  }
}

function bindSocket(options: {
  socket: WebSocket;
  request: IncomingMessage;
  rooms: RoomServer;
  maxBufferedBytes: number;
  onFrameSent: ((frame: SentFrame) => void) | undefined;
}) {
  const { socket, request, rooms, maxBufferedBytes, onFrameSent } = options;
  let alive = true;
  socket.on('pong', () => (alive = true));
  const connection = rooms.connect(
    {
      send: (frame) => {
        if (socket.readyState !== socket.OPEN) return;
        if (frame.byteLength > maxBufferedBytes - socket.bufferedAmount) {
          socket.terminate();
          connection.closed();
          return;
        }
        socket.send(frame, (error) => {
          if (error) socket.terminate();
          else reportSent(onFrameSent, frame);
        });
      },
      close: (code, reason) => socket.close(code, reason),
    },
    { url: request.url ?? '/', headers: request.headers },
  );
  socket.on('message', (data, isBinary) => {
    if (isBinary) connection.receive(toBytes(data));
    else socket.close(CLOSE_CODES.badRequest, 'bad-request');
  });
  socket.on('close', () => connection.closed());
  // A socket error is followed by its close event.
  socket.on('error', () => undefined);
  return {
    ping: () => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    },
  };
}

/** Serves a room server's rooms over WebSocket upgrades of an HTTP server, through `ws`. */
export function attachRoomServer(
  rooms: RoomServer,
  options: AttachRoomServerOptions,
): RoomServerAttachment {
  const maxBufferedBytes =
    options.maxBufferedBytes ??
    Math.max(4 * 1024 * 1024, options.maxPayloadBytes ?? 64 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0)
    throw new Error('Invalid outgoing buffer limit.');
  const clock = options.clock ?? PLATFORM_CLOCK;
  const prefix = `${options.path.replace(/\/+$/, '')}/`;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 64 * 1024 * 1024,
    perMessageDeflate: perMessageDeflate(options.compression),
  });
  const pings = new Map<WebSocket, () => void>();
  let timer: RoomTimer | null = null;

  const pingAll = () => {
    for (const ping of pings.values()) ping();
    timer = pings.size > 0 ? clock.setTimeout(pingAll, pingIntervalMs) : null;
  };

  const onUpgrade = (request: IncomingMessage, stream: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://room.invalid').pathname;
    if (!path.startsWith(prefix)) return;
    wss.handleUpgrade(request, stream, head, (socket) => {
      socket.binaryType = 'nodebuffer';
      const { onFrameSent } = options;
      pings.set(socket, bindSocket({ socket, request, rooms, maxBufferedBytes, onFrameSent }).ping);
      socket.on('close', () => pings.delete(socket));
      timer ??= clock.setTimeout(pingAll, pingIntervalMs);
    });
  };
  options.server.on('upgrade', onUpgrade);

  return {
    close: () => {
      options.server.off('upgrade', onUpgrade);
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      for (const socket of pings.keys()) socket.terminate();
      wss.close();
    },
  };
}
