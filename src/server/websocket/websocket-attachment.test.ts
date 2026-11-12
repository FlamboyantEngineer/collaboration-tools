import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Doc } from '@y/y';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createRoomProvider, type RoomProvider } from '../../client/room-provider.js';
import type { RoomSocketFactory } from '../../client/room-socket.js';
import { CLOSE_CODES } from '../../protocol/messages.js';
import { createMemoryPersistence } from '../host/memory-persistence.js';
import { createRoomServer, type RoomServer } from '../room-server.js';
import { attachRoomServer, type RoomServerAttachment } from './websocket-attachment.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(rooms: RoomServer, pingIntervalMs?: number) {
  const http: Server = createServer();
  const attachment: RoomServerAttachment = attachRoomServer(rooms, {
    server: http,
    path: '/live',
    pingIntervalMs,
    maxPayloadBytes: 1024,
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  cleanups.push(() => attachment.close());
  const { port } = http.address() as AddressInfo;
  return { http, attachment, endpoint: `ws://127.0.0.1:${port}/live` };
}

function serve() {
  const rooms = createRoomServer({
    host: {
      auth: {
        admit: () => Promise.resolve({ ok: true, actor: { id: 'u' }, access: 'read-write' }),
      },
      persistence: createMemoryPersistence(),
    },
  });
  cleanups.push(() => rooms.close());
  return rooms;
}

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('timed out'));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

const createSocket: RoomSocketFactory = (url) => new WebSocket(url);

function open(endpoint: string): RoomProvider {
  const provider = createRoomProvider({ endpoint, room: 'notes', doc: new Doc(), createSocket });
  cleanups.push(() => provider.destroy());
  return provider;
}

describe('attachRoomServer', () => {
  it('COLLAB-SERVER-6.1 serves rooms over WebSocket upgrades on its path', async () => {
    const { endpoint } = await listen(serve());
    const first = open(endpoint);
    const second = open(endpoint);
    await waitFor(() => first.getState().synced && second.getState().synced);

    first.doc.get('text').insert(0, 'over the wire');
    await waitFor(() => second.doc.get('text').toString() === 'over the wire');

    expect(second.getState()).toMatchObject({ status: 'connected', access: 'read-write' });
  });

  it('COLLAB-SERVER-6.1 leaves other upgrade paths to other handlers', async () => {
    const { http, endpoint } = await listen(serve());
    const others: string[] = [];
    http.on('upgrade', (request, socket) => {
      others.push(request.url ?? '');
      socket.destroy();
    });

    const socket = new WebSocket(endpoint.replace('/live', '/elsewhere/notes'));
    await new Promise((resolve) => socket.on('error', resolve));

    expect(others).toEqual(['/elsewhere/notes']);
  });

  it('COLLAB-SERVER-6.2 closes a socket that sends text or a frame over the size limit', async () => {
    const { endpoint } = await listen(serve());
    const closeCode = (send: (socket: WebSocket) => void) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(`${endpoint}/notes`);
        socket.on('open', () => send(socket));
        socket.on('close', (code) => resolve(code));
      });

    const text = await closeCode((socket) => socket.send('hello'));
    const large = await closeCode((socket) => socket.send(new Uint8Array(4_096)));

    expect(text).toBe(CLOSE_CODES.badRequest);
    expect(large).toBe(1009);
  });

  it('COLLAB-SERVER-6.2 keeps answering sockets alive across pings', async () => {
    const { endpoint } = await listen(serve(), 20);
    const provider = open(endpoint);
    await waitFor(() => provider.getState().synced);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(provider.getState()).toMatchObject({ status: 'connected', syncCount: 1 });
  });
});
