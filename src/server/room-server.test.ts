import { applyUpdate, Doc } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, type ManualClock } from '../../test/manual-clock.js';
import { connectToServer, settle } from '../../test/server-sockets.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import { CLOSE_CODES } from '../protocol/messages.js';
import type { RoomAdmission, RoomAuth, RoomPersistence } from './host/adapters.js';
import { createMemoryPersistence, type MemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer, type RoomServerOptions } from './room-server.js';

const ENDPOINT = 'wss://rooms.example.test/live';
const providers: RoomProvider[] = [];
const servers: RoomServer[] = [];

interface Setup {
  server: RoomServer;
  clock: ManualClock;
  persistence: MemoryPersistence;
  sockets: ReturnType<typeof connectToServer>;
}

function setup(
  options: Partial<RoomServerOptions> & {
    admit?: (token: string | null, room: string) => RoomAdmission;
    persistence?: RoomPersistence;
  } = {},
): Setup {
  const clock = createManualClock();
  const persistence = createMemoryPersistence();
  const auth: RoomAuth = {
    admit: ({ token, room }) =>
      Promise.resolve(
        options.admit?.(token, room) ?? { ok: true, actor: { id: 'user' }, access: 'read-write' },
      ),
  };
  const server = createRoomServer({
    host: { auth, persistence: options.persistence ?? persistence, clock },
    ...options,
  });
  servers.push(server);
  return { server, clock, persistence, sockets: connectToServer(server) };
}

function open(
  { sockets }: Setup,
  options: { room?: string; token?: string; clock?: ManualClock } = {},
) {
  const provider = createRoomProvider({
    endpoint: ENDPOINT,
    room: options.room ?? 'notes',
    doc: new Doc(),
    getToken: () => options.token ?? null,
    createSocket: sockets.createSocket,
    clock: options.clock ?? createManualClock(),
  });
  providers.push(provider);
  return provider;
}

function text(doc: Doc) {
  return doc.get('text').toString();
}

function storedText(persistence: MemoryPersistence, room = 'notes') {
  const state = persistence.peek(room);
  if (!state) return undefined;
  const doc = new Doc();
  applyUpdate(doc, state.update);
  return text(doc);
}

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('createRoomServer admission', () => {
  it('COLLAB-SERVER-1.1 grants the admitted access and refuses with a reason and close code', async () => {
    const context = setup({
      admit: (token) =>
        token === 'reader'
          ? { ok: true, actor: { id: 'r' }, access: 'read-only' }
          : token === 'stranger'
            ? { ok: false, reason: 'forbidden' }
            : { ok: false, reason: 'unauthenticated' },
    });
    const reader = open(context, { token: 'reader' });
    const stranger = open(context, { token: 'stranger' });
    const anonymous = open(context);
    await settle();

    expect(reader.getState()).toMatchObject({ access: 'read-only', synced: true });
    expect(stranger.getState()).toMatchObject({ status: 'disconnected', refusal: 'forbidden' });
    expect(anonymous.getState()).toMatchObject({ refusal: 'unauthenticated' });
    expect(context.sockets.sockets.map((socket) => socket.serverClose?.code)).toEqual([
      undefined,
      CLOSE_CODES.forbidden,
      CLOSE_CODES.unauthenticated,
    ]);
    expect(context.server.roomCount()).toBe(1);
  });

  it('COLLAB-SERVER-1.2 joins every alias of a room to one live document', async () => {
    const context = setup({
      admit: (_token, room) => ({
        ok: true,
        actor: { id: 'user' },
        access: 'read-write',
        room: room === 'alias' ? 'notes' : room,
      }),
    });
    const byName = open(context);
    const byAlias = open(context, { room: 'alias' });
    await settle();

    byAlias.doc.get('text').insert(0, 'one room');
    await settle();

    expect(text(byName.doc)).toBe('one room');
    expect(context.server.roomCount()).toBe(1);
  });

  it('COLLAB-SERVER-1.3 closes a URL without a room as a bad request', async () => {
    const context = setup();
    const closes: number[] = [];
    context.server.connect(
      { send: () => undefined, close: (code) => closes.push(code) },
      { url: '/live/', headers: {} },
    );
    await settle();

    expect(closes).toEqual([CLOSE_CODES.badRequest]);
  });

  it('COLLAB-SERVER-1.3 closes as unavailable when admission throws or storage fails, and the client retries', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const clock = createManualClock();
    let failing = true;
    const memory = createMemoryPersistence();
    const persistence: RoomPersistence = {
      load: (room) =>
        failing
          ? Promise.resolve({ status: 'unavailable', error: new Error('down') })
          : memory.load(room),
      store: (input) => memory.store(input),
    };
    const server = createRoomServer({
      host: {
        auth: { admit: () => Promise.reject(new Error('no session store')) },
        persistence,
        logger,
        clock,
      },
    });
    servers.push(server);
    const closes: number[] = [];
    server.connect(
      { send: () => undefined, close: (code) => closes.push(code) },
      { url: '/live/notes', headers: {} },
    );
    const context = setup({ persistence });
    const clientClock = createManualClock();
    const provider = open(context, { clock: clientClock });
    await settle();
    const whileFailing = provider.getState();
    failing = false;
    clientClock.advance(1_000);
    await settle();

    expect(closes).toEqual([CLOSE_CODES.unavailable]);
    expect(logger.error).toHaveBeenCalledWith('Admitting a connection failed.', expect.anything());
    expect(whileFailing).toMatchObject({ closeCode: CLOSE_CODES.unavailable, refusal: null });
    expect(provider.getState()).toMatchObject({ status: 'connected', synced: true });
  });
});

describe('createRoomServer sync', () => {
  it('COLLAB-SERVER-2.1 relays edits between members and syncs a member that joins later', async () => {
    const context = setup();
    const first = open(context);
    const second = open(context);
    await settle();

    first.doc.get('text').insert(0, 'hello');
    await settle();
    const late = open(context);
    await settle();

    expect(text(second.doc)).toBe('hello');
    expect(text(late.doc)).toBe('hello');
    expect(first.getState().hasUnconfirmedChanges).toBe(false);
  });

  it('COLLAB-SERVER-2.2 keeps a read-only member from changing the room', async () => {
    const context = setup({
      admit: (token) => ({
        ok: true,
        actor: { id: 'user' },
        access: token === 'reader' ? 'read-only' : 'read-write',
      }),
    });
    const writer = open(context);
    const reader = open(context, { token: 'reader' });
    await settle();

    reader.doc.get('text').insert(0, 'ignored');
    writer.doc.get('text').insert(0, 'kept ');
    await settle();
    const handle = await context.server.openRoom('notes');

    expect(text(handle.doc)).toBe('kept ');
    expect(text(writer.doc)).toBe('kept ');
    handle.release();
  });

  it('COLLAB-SERVER-2.3 acknowledges an update the room holds already to its sender', async () => {
    const context = setup();
    const clientClock = createManualClock();
    const writer = open(context, { clock: clientClock });
    await settle();
    const [socket] = context.sockets.sockets;
    if (!socket) throw new Error('no socket');

    // The echo of this edit is lost, as when a socket drops right after sending.
    socket.deaf = true;
    writer.doc.get('text').insert(0, 'kept');
    await settle();
    const beforeDrop = writer.getState().hasUnconfirmedChanges;
    socket.drop();
    await settle();
    clientClock.advance(0);
    await settle();

    expect(beforeDrop).toBe(true);
    expect(writer.getState()).toMatchObject({ status: 'connected', hasUnconfirmedChanges: false });
    expect(text(writer.doc)).toBe('kept');
  });

  it('COLLAB-SERVER-2.4 closes a member that sends a frame it cannot read', async () => {
    const context = setup();
    open(context);
    await settle();
    const [socket] = context.sockets.sockets;
    socket?.connection?.receive(new Uint8Array([0, 2, 9, 1, 2]));
    await settle();

    expect(socket?.serverClose).toEqual({ code: CLOSE_CODES.badRequest, reason: 'bad-request' });
  });
});

describe('createRoomServer awareness', () => {
  it('COLLAB-SERVER-3.1 relays presence and removes a member’s presence when it leaves', async () => {
    const context = setup();
    const first = open(context);
    const second = open(context);
    await settle();

    first.awareness.setLocalStateField('name', 'Ada');
    await settle();
    const seen = second.awareness.getStates().get(first.awareness.clientID);
    const late = open(context);
    await settle();
    const seenLate = late.awareness.getStates().has(first.awareness.clientID);
    first.destroy();
    await settle();

    expect(seen).toEqual({ name: 'Ada' });
    expect(seenLate).toBe(true);
    expect(second.awareness.getStates().has(first.awareness.clientID)).toBe(false);
  });

  it('COLLAB-SERVER-3.2 takes a reconnecting member’s presence again', async () => {
    const context = setup();
    const clientClock = createManualClock();
    const first = open(context, { clock: clientClock });
    const second = open(context);
    first.awareness.setLocalStateField('name', 'Ada');
    await settle();

    context.sockets.sockets[0]?.drop();
    await settle();
    const afterDrop = second.awareness.getStates().has(first.awareness.clientID);
    clientClock.advance(0);
    await settle();

    expect(afterDrop).toBe(false);
    expect(second.awareness.getStates().get(first.awareness.clientID)).toEqual({ name: 'Ada' });
  });
});

describe('createRoomServer host access', () => {
  it('COLLAB-SERVER-5.1 lets a host change a room through a handle that keeps it loaded', async () => {
    const context = setup();
    const member = open(context);
    await settle();

    const handle = await context.server.openRoom('notes');
    handle.doc.transact(() => handle.doc.get('text').insert(0, 'from host'), 'host');
    await settle();
    member.destroy();
    await settle();
    const loadedWhileHeld = context.server.roomCount();
    handle.release();
    handle.release();
    await settle();

    expect(text(member.doc)).toBe('from host');
    expect(loadedWhileHeld).toBe(1);
    expect(context.server.roomCount()).toBe(0);
    expect(storedText(context.persistence)).toBe('from host');
  });

  it('COLLAB-SERVER-5.2 passes stateless messages to the host, with replies and broadcasts', async () => {
    const received: string[] = [];
    const context = setup({
      onStateless: (message) => {
        received.push(`${message.room}:${message.actor.id}:${message.payload}`);
        message.reply(`ack ${message.payload}`);
      },
    });
    const first = open(context);
    const second = open(context);
    const firstHeard: string[] = [];
    const secondHeard: string[] = [];
    first.onStateless((payload) => firstHeard.push(payload));
    second.onStateless((payload) => secondHeard.push(payload));
    await settle();

    first.sendStateless('ping');
    await settle();
    context.server.broadcastStateless('notes', 'to all');
    await settle();

    expect(received).toEqual(['notes:user:ping']);
    expect(firstHeard).toEqual(['ack ping', 'to all']);
    expect(secondHeard).toEqual(['to all']);
  });

  it('COLLAB-SERVER-5.3 sends a keepalive frame while rooms are loaded, and no timer when idle', async () => {
    const context = setup({ keepaliveMs: 1_000 });
    open(context);
    await settle();
    const [socket] = context.sockets.sockets;
    const before = socket?.received.length ?? 0;

    context.clock.advance(1_000);
    const afterOne = socket?.received.length ?? 0;
    providers.splice(0).forEach((provider) => provider.destroy());
    await settle();
    context.clock.advance(5_000);
    await settle();

    expect(afterOne).toBe(before + 1);
    expect(context.server.roomCount()).toBe(0);
    expect(context.clock.pendingDelays()).toEqual([]);
  });
});
