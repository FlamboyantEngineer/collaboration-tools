import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Doc } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRoomProvider, type RoomProvider } from '../../client/room-provider.js';
import type { RoomSocketFactory } from '../../client/room-socket.js';
import { CLOSE_CODES } from '../../protocol/messages.js';
import { createMemoryPersistence } from '../host/memory-persistence.js';
import { createRoomServer, type RoomServer } from '../room-server.js';
import {
  attachRoomServer,
  type AttachRoomServerOptions,
  type RoomServerAttachment,
  type SentFrame,
} from './websocket-attachment.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(
  rooms: RoomServer,
  pingIntervalMs?: number,
  maxBufferedBytes?: number,
  maxPayloadBytes = 1024,
  extra: Partial<AttachRoomServerOptions> = {},
) {
  const http: Server = createServer();
  const attachment: RoomServerAttachment = attachRoomServer(rooms, {
    server: http,
    path: '/live',
    pingIntervalMs,
    maxPayloadBytes,
    maxBufferedBytes,
    ...extra,
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

it('COLLAB-SERVER-6.2 drops a slow consumer before queued outgoing bytes exceed the limit', async () => {
  const rooms = serve();
  const { endpoint } = await listen(rooms, undefined, 1024);
  const socket = new WebSocket(`${endpoint}/notes`);
  await new Promise<void>((resolve) => socket.on('message', () => resolve()));
  const closed = new Promise<number>((resolve) => socket.on('close', resolve));
  const buffered = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(1024);
  try {
    rooms.broadcastStateless('notes', 'next frame');
    expect(await closed).toBe(1006);
    await waitFor(() => rooms.roomCount() === 0);
  } finally {
    buffered.mockRestore();
    socket.terminate();
  }
});

it('COLLAB-SERVER-6.2 bounds a single oversized outgoing frame', async () => {
  const rooms = serve();
  const { endpoint } = await listen(rooms, undefined, 1024);
  const socket = new WebSocket(`${endpoint}/notes`);
  await new Promise<void>((resolve) => socket.on('message', () => resolve()));
  const closed = new Promise<number>((resolve) => socket.on('close', resolve));
  rooms.broadcastStateless('notes', 'x'.repeat(2048));
  expect(await closed).toBe(1006);
  await waitFor(() => rooms.roomCount() === 0);
});

it('COLLAB-SERVER-6.2 derives the default outgoing limit from the accepted incoming frame size', async () => {
  const rooms = serve();
  const { endpoint } = await listen(rooms, undefined, undefined, 8 * 1024 * 1024);
  const socket = new WebSocket(`${endpoint}/notes`);
  await new Promise<void>((resolve) => socket.once('message', () => resolve()));
  const largeFrame = new Promise<number>((resolve) =>
    socket.on('message', (frame) => {
      const length = frame.toString().length;
      if (length > 5 * 1024 * 1024) resolve(length);
    }),
  );
  rooms.broadcastStateless('notes', 'x'.repeat(5 * 1024 * 1024));
  expect(await largeFrame).toBeGreaterThan(5 * 1024 * 1024);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.terminate();
});

// The extensions the server agreed to with a raw client offering compression.
async function negotiated(endpoint: string): Promise<string> {
  const socket = new WebSocket(`${endpoint}/notes`, { perMessageDeflate: true });
  cleanups.push(() => socket.terminate());
  const agreed = new Promise<string>((resolve) =>
    socket.on('upgrade', (response) => {
      resolve(String(response.headers['sec-websocket-extensions'] ?? ''));
    }),
  );
  await new Promise((resolve) => socket.on('open', resolve));
  return agreed;
}

it('COLLAB-SERVER-6.3 negotiates no compression unless the operator turns it on', async () => {
  const plain = await listen(serve());
  expect(await negotiated(plain.endpoint)).toBe('');

  const compressed = await listen(serve(), undefined, undefined, 1024 * 1024, {
    compression: {},
  });
  const extensions = await negotiated(compressed.endpoint);
  expect(extensions).toContain('permessage-deflate');
  expect(extensions).toContain('server_no_context_takeover');
  expect(extensions).toContain('client_no_context_takeover');
  // Rooms still sync through compressed sockets.
  const first = open(compressed.endpoint);
  const second = open(compressed.endpoint);
  await waitFor(() => first.getState().synced && second.getState().synced);
  first.doc.get('text').insert(0, 'x'.repeat(10_000));
  await waitFor(() => second.doc.get('text').toString().length === 10_000);
});

it('COLLAB-SERVER-6.3 caps a compressed frame by its inflated size', async () => {
  const { endpoint } = await listen(serve(), undefined, undefined, 1024, { compression: {} });
  const socket = new WebSocket(`${endpoint}/notes`, { perMessageDeflate: { threshold: 0 } });
  const closed = new Promise<number>((resolve) => socket.on('close', resolve));
  await new Promise((resolve) => socket.on('open', resolve));
  // Zeros compress to far below the limit, but inflate to eight times it.
  socket.send(new Uint8Array(8_192));
  expect(await closed).toBe(1009);
});

it('COLLAB-SERVER-6.4 reports each frame written, by type and uncompressed size, per recipient', async () => {
  const sent: SentFrame[] = [];
  const { endpoint } = await listen(serve(), undefined, undefined, 1024 * 1024, {
    compression: { thresholdBytes: 64 },
    onFrameSent: (frame) => sent.push(frame),
  });
  const first = open(endpoint);
  const second = open(endpoint);
  await waitFor(() => first.getState().synced && second.getState().synced);
  const types = new Set(sent.map((frame) => frame.type));
  expect([...types]).toEqual(expect.arrayContaining(['sync-step1', 'sync-step2']));

  sent.splice(0);
  first.doc.get('text').insert(0, 'y'.repeat(5_000));
  await waitFor(() => sent.filter((frame) => frame.type === 'sync-update').length >= 2);
  // The echo to the writer and the update to the other reader, each at its uncompressed size.
  const updates = sent.filter((frame) => frame.type === 'sync-update');
  expect(updates.length).toBeGreaterThanOrEqual(2);
  for (const update of updates) expect(update.bytes).toBeGreaterThan(5_000);
});
