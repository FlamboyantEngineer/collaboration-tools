import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { PLATFORM_CLOCK, type RoomClock, type RoomTimer } from '../protocol/clock.js';
import { CLOSE_CODES } from '../protocol/messages.js';
import type { RoomServer } from './room-server.js';

export interface AttachRoomServerOptions {
  /** The HTTP server whose upgrades to accept. */
  server: Server;
  /** Upgrades to this path, followed by `/<room>`, are rooms; others are left to other handlers. */
  path: string;
  /** Larger frames close the socket. Defaults to 64 MiB. */
  maxPayloadBytes?: number | undefined;
  /** Every socket is pinged this often and dropped when it missed the last pong. Defaults to 30000. */
  pingIntervalMs?: number | undefined;
  /** Defaults to the platform clock. */
  clock?: RoomClock | undefined;
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

function bindSocket(socket: WebSocket, request: IncomingMessage, rooms: RoomServer) {
  let alive = true;
  socket.on('pong', () => (alive = true));
  const connection = rooms.connect(
    {
      send: (frame) => socket.send(frame),
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
  const clock = options.clock ?? PLATFORM_CLOCK;
  const prefix = `${options.path.replace(/\/+$/, '')}/`;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 64 * 1024 * 1024,
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
      pings.set(socket, bindSocket(socket, request, rooms).ping);
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
