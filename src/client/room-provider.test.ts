import { Doc } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackServer, flush, type LoopbackServer } from '../../test/loopback-server.js';
import { createManualClock } from '../../test/manual-clock.js';
import type { RoomConnectionState } from './connection-state.js';
import {
  createRoomProvider,
  type RoomProvider,
  type RoomProviderOptions,
} from './room-provider.js';

const ENDPOINT = 'wss://rooms.example.test/live';
const providers: RoomProvider[] = [];

function open(server: LoopbackServer, options: Partial<RoomProviderOptions> = {}) {
  const provider = createRoomProvider({
    endpoint: ENDPOINT,
    room: 'notes/1',
    doc: new Doc(),
    createSocket: server.createSocket,
    clock: createManualClock(),
    ...options,
  });
  providers.push(provider);
  return provider;
}

function text(provider: RoomProvider) {
  return provider.doc.get('text').toString();
}

afterEach(() => {
  for (const provider of providers.splice(0)) provider.destroy();
});

describe('createRoomProvider', () => {
  it('COLLAB-CLIENT-1.1 opens the room URL with the token read for that attempt', async () => {
    const server = createLoopbackServer();
    const tokens = ['first', 'second'];
    const provider = open(server, {
      getToken: () => tokens.shift() ?? null,
      params: { mode: 'edit' },
    });
    await flush();

    provider.disconnect();
    provider.connect();
    await flush();

    expect(server.urls).toEqual([
      'wss://rooms.example.test/live/notes%2F1?mode=edit&token=first',
      'wss://rooms.example.test/live/notes%2F1?mode=edit&token=second',
    ]);
  });

  it('COLLAB-CLIENT-1.2 syncs a document between two providers and reports the granted access', async () => {
    const server = createLoopbackServer();
    const first = open(server);
    const second = open(server);
    await flush();

    first.doc.get('text').insert(0, 'hello');
    await flush();

    expect(text(second)).toBe('hello');
    expect(server.doc('notes/1').get('text').toString()).toBe('hello');
    expect(second.getState()).toMatchObject({
      status: 'connected',
      access: 'read-write',
      synced: true,
      syncCount: 1,
      refusal: null,
    });
  });

  it('COLLAB-CLIENT-1.2 starts disconnected with pending access when told not to connect', async () => {
    const server = createLoopbackServer();
    const provider = open(server, { connect: false });
    await flush();

    expect(server.urls).toEqual([]);
    expect(provider.getState()).toEqual({
      status: 'disconnected',
      access: 'pending',
      synced: false,
      syncCount: 0,
      hasUnconfirmedChanges: false,
      refusal: null,
      closeCode: null,
    });
  });

  it('COLLAB-CLIENT-1.3 reports read-only access and keeps receiving changes', async () => {
    const server = createLoopbackServer({
      admit: (token) => (token === 'reader' ? 'read-only' : 'read-write'),
    });
    const writer = open(server);
    const reader = open(server, { getToken: () => 'reader' });
    await flush();

    writer.doc.get('text').insert(0, 'shared');
    await flush();

    expect(reader.getState().access).toBe('read-only');
    expect(text(reader)).toBe('shared');
  });

  it('COLLAB-CLIENT-1.4 stops reconnecting after a refusal until connect is called', async () => {
    let refuse = true;
    const server = createLoopbackServer({
      admit: () => (refuse ? { refuse: 'forbidden' } : 'read-write'),
    });
    const clock = createManualClock();
    const provider = open(server, { clock });
    await flush();

    clock.advance(10_000);
    await flush();
    const afterRefusal = provider.getState();
    refuse = false;
    provider.connect();
    await flush();

    expect(afterRefusal).toMatchObject({ status: 'disconnected', refusal: 'forbidden' });
    expect(server.urls).toHaveLength(2);
    expect(provider.getState()).toMatchObject({ status: 'connected', refusal: null });
  });

  it('COLLAB-CLIENT-1.5 notifies subscribers of each change until they unsubscribe', async () => {
    const server = createLoopbackServer();
    const provider = open(server, { connect: false });
    const states: RoomConnectionState[] = [];
    const unsubscribe = provider.subscribe((state) => states.push(state));

    provider.connect();
    await flush();
    unsubscribe();
    const notified = states.length;
    provider.disconnect();

    expect(states.map((state) => state.status)).toEqual([
      'connecting',
      'connected',
      'connected',
      'connected',
    ]);
    expect(states.at(-1)).toMatchObject({ access: 'read-write', synced: true });
    expect(states).toHaveLength(notified);
    expect(provider.getState().status).toBe('disconnected');
  });

  it('COLLAB-CLIENT-2.1 reconnects at once after an open socket drops, then backs off', async () => {
    const server = createLoopbackServer({ manualOpen: true });
    const clock = createManualClock();
    open(server, { clock, maxBackoffMs: 500 });

    const first = lastSocket(server);
    first.accept();
    await flush();
    first.drop();
    await flush();
    const afterDrop = clock.pendingDelays().filter((delay) => delay < 4_000);
    clock.advance(0);
    lastSocket(server).drop();
    await flush();
    const afterFailure = clock.pendingDelays().filter((delay) => delay < 4_000);
    clock.advance(200);
    lastSocket(server).drop();
    await flush();
    clock.advance(400);
    lastSocket(server).drop();
    await flush();

    expect(afterDrop).toEqual([0]);
    expect(afterFailure).toEqual([200]);
    expect(clock.pendingDelays()).toEqual([500]);
    expect(server.sockets).toHaveLength(4);
  });

  it('COLLAB-CLIENT-2.2 closes a socket that stays silent past the timeout and reconnects', async () => {
    const server = createLoopbackServer();
    const clock = createManualClock();
    const provider = open(server, { clock, socketTimeoutMs: 10_000 });
    await flush();

    server.silent = true;
    clock.advance(12_000);
    await flush();

    expect(provider.getState().closeCode).toBeNull();
    expect(server.urls).toHaveLength(2);
  });

  it('COLLAB-CLIENT-2.3 closes while offline and reconnects when back online', async () => {
    const server = createLoopbackServer();
    const listeners = new Map<string, () => void>();
    const connectivity = {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const clock = createManualClock();
    const provider = open(server, { clock, connectivity });
    await flush();

    listeners.get('offline')?.();
    await flush();
    clock.advance(10_000);
    const offline = provider.getState().status;
    const attemptsWhileOffline = server.urls.length;
    listeners.get('online')?.();
    await flush();

    expect(offline).toBe('disconnected');
    expect(attemptsWhileOffline).toBe(1);
    expect(provider.getState().status).toBe('connected');
    provider.destroy();
    expect(listeners.size).toBe(0);
  });

  it('COLLAB-CLIENT-3.1 reports unconfirmed changes until the server echoes them', async () => {
    const server = createLoopbackServer();
    const provider = open(server);
    await flush();

    provider.doc.get('text').insert(0, 'draft');
    const pending = provider.getState().hasUnconfirmedChanges;
    await flush();

    expect(pending).toBe(true);
    expect(provider.getState().hasUnconfirmedChanges).toBe(false);
  });

  it('COLLAB-CLIENT-3.2 resends changes the server never echoed after reconnecting', async () => {
    const server = createLoopbackServer();
    const clock = createManualClock();
    const provider = open(server, { clock });
    await flush();

    server.dropEchoes = true;
    provider.doc.get('text').insert(0, 'kept');
    await flush();
    const pending = provider.getState().hasUnconfirmedChanges;
    server.dropEchoes = false;
    lastSocket(server).drop();
    await flush();
    clock.advance(0);
    await flush();

    expect(pending).toBe(true);
    expect(server.doc('notes/1').get('text').toString()).toBe('kept');
    expect(provider.getState()).toMatchObject({ syncCount: 2, hasUnconfirmedChanges: false });
  });

  it('COLLAB-CLIENT-4.1 shares awareness and forgets remote states when the socket closes', async () => {
    const server = createLoopbackServer();
    const first = open(server);
    const second = open(server);
    await flush();

    first.awareness.setLocalStateField('name', 'Ada');
    await flush();
    const seen = second.awareness.getStates().get(first.awareness.clientID);
    first.disconnect();
    await flush();
    const afterLeave = second.awareness.getStates().has(first.awareness.clientID);
    lastSocket(server).drop();
    await flush();

    expect(seen).toEqual({ name: 'Ada' });
    expect(afterLeave).toBe(false);
    expect([...first.awareness.getStates().keys()]).toEqual([first.awareness.clientID]);
  });

  it('COLLAB-CLIENT-4.1 sends back none of the room’s awareness and renews its own clock on open', async () => {
    const server = createLoopbackServer();
    const clock = createManualClock();
    const first = open(server, { clock });
    const second = open(server);
    await flush();
    const secondSocket = server.sockets[1];
    if (!secondSocket) throw new Error('no socket');
    const sentBySecond = vi.spyOn(secondSocket, 'send');

    first.awareness.setLocalStateField('name', 'Ada');
    await flush();
    const clockBefore = first.awareness.meta.get(first.awareness.clientID)?.clock ?? 0;
    server.sockets[0]?.drop();
    await flush();
    clock.advance(0);
    await flush();

    expect(second.awareness.getStates().get(first.awareness.clientID)).toEqual({ name: 'Ada' });
    expect(sentBySecond).not.toHaveBeenCalled();
    expect(first.awareness.meta.get(first.awareness.clientID)?.clock).toBe(clockBefore + 1);
  });

  it('COLLAB-CLIENT-4.2 sends and receives stateless messages', async () => {
    const server = createLoopbackServer();
    const provider = open(server, { connect: false });
    const received: string[] = [];
    provider.onStateless((payload) => received.push(payload));

    const sentOffline = provider.sendStateless('too early');
    provider.connect();
    await flush();
    const sent = provider.sendStateless('ping');
    server.broadcastStateless('notes/1', 'pong');
    await flush();

    expect(sentOffline).toBe(false);
    expect(sent).toBe(true);
    expect(server.statelessReceived).toEqual(['ping']);
    expect(received).toEqual(['pong']);
  });

  it('COLLAB-CLIENT-4.3 marks what the server sent with an origin it recognises', async () => {
    const server = createLoopbackServer();
    const first = open(server);
    const second = open(server);
    await flush();
    const origins: unknown[] = [];
    second.doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    first.doc.get('text').insert(0, 'x');
    await flush();

    expect(origins).toHaveLength(1);
    expect(second.isRemoteOrigin(origins[0])).toBe(true);
    expect(first.isRemoteOrigin(origins[0])).toBe(false);
  });

  it('COLLAB-CLIENT-4.4 stops syncing and owns nothing after destroy', async () => {
    const server = createLoopbackServer();
    const provider = open(server);
    await flush();

    provider.destroy();
    provider.doc.get('text').insert(0, 'local');
    provider.connect();
    await flush();

    expect(server.openSockets()).toEqual([]);
    expect(server.doc('notes/1').get('text').toString()).toBe('');
    expect(provider.awareness.getLocalState()).toBeNull();
  });
});

function lastSocket(server: LoopbackServer) {
  const socket = server.sockets.at(-1);
  if (!socket) throw new Error('no socket');
  return socket;
}
