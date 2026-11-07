import { applyUpdate, Doc, encodeStateAsUpdate } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { connectToServer, settle } from '../../test/server-sockets.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import { CLOSE_CODES } from '../protocol/messages.js';
import type { RoomLoadResult, RoomPersistence, RoomStoreResult } from './host/adapters.js';
import { createMemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer } from './room-server.js';

const providers: RoomProvider[] = [];
const servers: RoomServer[] = [];

function update(content: string) {
  const doc = new Doc();
  doc.get('text').insert(0, content);
  return encodeStateAsUpdate(doc);
}

function text(doc: Doc) {
  return doc.get('text').toString();
}

function decoded(bytes: Uint8Array | undefined) {
  const doc = new Doc();
  if (bytes) applyUpdate(doc, bytes);
  return text(doc);
}

/** A persistence whose answers a test can change, recording every store. */
function scriptedPersistence(initial: RoomLoadResult) {
  const memory = createMemoryPersistence();
  const script = {
    load: initial,
    storeResults: [] as RoomStoreResult[],
    stored: [] as { update: Uint8Array; baseRevision: string | null }[],
  };
  const persistence: RoomPersistence = {
    load: () => Promise.resolve(script.load),
    store: async (input) => {
      script.stored.push({ update: input.update, baseRevision: input.baseRevision });
      const scripted = script.storeResults.shift();
      if (scripted) return scripted;
      return memory.store({ ...input, baseRevision: memory.peek(input.room)?.revision ?? null });
    },
  };
  return { persistence, script };
}

function serve(persistence: RoomPersistence) {
  const clock = createManualClock();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const server = createRoomServer({
    host: {
      auth: {
        admit: () => Promise.resolve({ ok: true, actor: { id: 'u' }, access: 'read-write' }),
      },
      persistence,
      logger,
      clock,
    },
    storeDebounceMs: 100,
    storeMaxDebounceMs: 500,
    storeRetryMs: 50,
  });
  servers.push(server);
  const sockets = connectToServer(server);
  const open = (clientClock = createManualClock()) => {
    const provider = createRoomProvider({
      endpoint: 'wss://rooms.example.test/live',
      room: 'notes',
      doc: new Doc(),
      createSocket: sockets.createSocket,
      clock: clientClock,
    });
    providers.push(provider);
    return provider;
  };
  return { server, clock, logger, sockets, open };
}

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('room storage', () => {
  it('COLLAB-SERVER-4.1 opens a stored room and stores on top of its revision', async () => {
    const { persistence, script } = scriptedPersistence({
      status: 'found',
      state: { update: update('stored'), revision: 'r1', sequence: 1 },
    });
    const { clock, open } = serve(persistence);
    const member = open();
    await settle();

    member.doc.get('text').insert(6, '!');
    await settle();
    clock.advance(100);
    await settle();

    expect(text(member.doc)).toBe('stored!');
    expect(script.stored.map((entry) => entry.baseRevision)).toEqual(['r1']);
    expect(decoded(script.stored[0]?.update)).toBe('stored!');
  });

  it('COLLAB-SERVER-4.1 starts a corrupt or undecodable room empty and stores over its revision', async () => {
    const { persistence, script } = scriptedPersistence({
      status: 'found',
      state: { update: new Uint8Array([200, 1, 7]), revision: 'bad', sequence: 4 },
    });
    const { clock, logger, open } = serve(persistence);
    const member = open();
    await settle();

    member.doc.get('text').insert(0, 'fresh');
    await settle();
    clock.advance(100);
    await settle();

    expect(logger.warn).toHaveBeenCalledWith(
      'The stored room cannot be read; it starts empty.',
      expect.objectContaining({ room: 'notes' }),
    );
    expect(script.stored.map((entry) => entry.baseRevision)).toEqual(['bad']);
  });

  it('COLLAB-SERVER-4.3 stores when the last member leaves, then unloads', async () => {
    const memory = createMemoryPersistence();
    const { server, open } = serve(memory);
    const member = open();
    await settle();

    member.doc.get('text').insert(0, 'saved on leave');
    await settle();
    member.destroy();
    await settle();

    expect(decoded(memory.peek('notes')?.update)).toBe('saved on leave');
    expect(server.roomCount()).toBe(0);
  });

  it('COLLAB-SERVER-4.3 keeps a room whose storage fails loaded, retrying, until it stores', async () => {
    const { persistence, script } = scriptedPersistence({ status: 'missing' });
    script.storeResults.push({ status: 'unavailable', error: new Error('down') });
    const { server, clock, open } = serve(persistence);
    const member = open();
    await settle();

    member.doc.get('text').insert(0, 'kept');
    await settle();
    member.destroy();
    await settle();
    const loadedWhileFailing = server.roomCount();
    clock.advance(50);
    await settle();

    expect(loadedWhileFailing).toBe(1);
    expect(script.stored).toHaveLength(2);
    expect(server.roomCount()).toBe(0);
  });

  it('COLLAB-SERVER-4.4 closes members on a store conflict, and a reconnect loads the other state', async () => {
    const { persistence, script } = scriptedPersistence({ status: 'missing' });
    script.storeResults.push({ status: 'conflict', current: { revision: 'other', sequence: 2 } });
    const { server, clock, logger, sockets, open } = serve(persistence);
    const clientClock = createManualClock();
    const member = open(clientClock);
    await settle();

    member.doc.get('text').insert(0, 'mine');
    await settle();
    clock.advance(100);
    await settle();
    const closedWith = sockets.sockets[0]?.serverClose;
    const roomsAfterConflict = server.roomCount();
    script.load = {
      status: 'found',
      state: { update: update('theirs'), revision: 'other', sequence: 2 },
    };
    clientClock.advance(0);
    await settle();

    expect(closedWith).toEqual({ code: CLOSE_CODES.conflict, reason: 'conflict' });
    expect(logger.error).toHaveBeenCalledWith(
      'Another writer stored the room first.',
      expect.anything(),
    );
    expect(roomsAfterConflict).toBe(0);
    expect(member.getState()).toMatchObject({ status: 'connected', synced: true });
    expect(text(member.doc)).toContain('theirs');
    expect(text(member.doc)).toContain('mine');
  });

  it('COLLAB-SERVER-4.5 stores every room on close, closes members and refuses later connections', async () => {
    const memory = createMemoryPersistence();
    const { server, sockets, open } = serve(memory);
    const member = open();
    await settle();

    member.doc.get('text').insert(0, 'before shutdown');
    await settle();
    await server.close();
    const closes: number[] = [];
    server.connect(
      { send: () => undefined, close: (code) => closes.push(code) },
      { url: '/live/notes', headers: {} },
    );

    expect(decoded(memory.peek('notes')?.update)).toBe('before shutdown');
    expect(sockets.sockets[0]?.serverClose?.code).toBe(CLOSE_CODES.shutdown);
    expect(closes).toEqual([CLOSE_CODES.shutdown]);
    expect(server.roomCount()).toBe(0);
    await expect(server.openRoom('notes')).rejects.toThrow('closed');
  });
});
