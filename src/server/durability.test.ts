import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { connectToServer, settle } from '../../test/server-sockets.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import { CLOSE_CODES, type RoomSaveStatus } from '../protocol/messages.js';
import { GENERATION_KEY, readRoomGeneration, ROOM_META_TYPE } from '../protocol/room-meta.js';
import type {
  RoomHost,
  RoomLoadResult,
  RoomMetricEvent,
  RoomPersistence,
} from './host/adapters.js';
import { createMemoryPersistence, type MemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer } from './room-server.js';

const providers: RoomProvider[] = [];
const servers: RoomServer[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function serve(host: Partial<RoomHost> = {}) {
  const clock = createManualClock();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const persistence = host.persistence ?? createMemoryPersistence();
  const server = createRoomServer({
    host: {
      auth: {
        admit: () => Promise.resolve({ ok: true, actor: { id: 'u' }, access: 'read-write' }),
      },
      logger,
      clock,
      ...host,
      persistence,
    },
    storeDebounceMs: 100,
    storeMaxDebounceMs: 500,
    storeRetryMs: 50,
  });
  servers.push(server);
  const sockets = connectToServer(server);
  const open = (doc = new Doc(), clientClock = createManualClock()) => {
    const provider = createRoomProvider({
      endpoint: 'wss://rooms.example.test/live',
      room: 'notes',
      doc,
      createSocket: sockets.createSocket,
      clock: clientClock,
    });
    providers.push(provider);
    return provider;
  };
  return { server, clock, logger, sockets, open, persistence };
}

function storedDoc(memory: MemoryPersistence) {
  const doc = new Doc();
  const stored = memory.peek('notes');
  if (stored) applyUpdate(doc, stored.update);
  return doc;
}

function stateOf(content: string, generation?: string) {
  const doc = new Doc();
  if (generation) doc.get(ROOM_META_TYPE).setAttr(GENERATION_KEY, generation);
  doc.get('text').insert(0, content);
  return encodeStateAsUpdate(doc);
}

describe('room generations', () => {
  it('COLLAB-SERVER-8.1 COLLAB-PROTOCOL-3.1 stores a new room’s generation before its first member syncs', async () => {
    const memory = createMemoryPersistence();
    const { open } = serve({ persistence: memory });
    const member = open();
    await settle();

    const generation = readRoomGeneration(member.doc);
    expect(generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(readRoomGeneration(storedDoc(memory))).toBe(generation);
  });

  it('COLLAB-SERVER-8.1 marks a stored state that has no generation, keeping its content', async () => {
    const memory = createMemoryPersistence({
      initial: { notes: { update: stateOf('kept'), revision: 'r1', sequence: 1 } },
    });
    const { open } = serve({ persistence: memory });
    const member = open();
    await settle();

    expect(member.doc.get('text').toString()).toBe('kept');
    expect(readRoomGeneration(storedDoc(memory))).toBe(readRoomGeneration(member.doc));
    expect(memory.peek('notes')?.sequence).toBe(2);
  });

  it('COLLAB-SERVER-8.1 refuses a member’s change to the room metadata, even without rules', async () => {
    const { server, open } = serve();
    const member = open();
    await settle();
    const handle = await server.openRoom('notes');
    const generation = readRoomGeneration(handle.doc);

    member.doc.get(ROOM_META_TYPE).setAttr(GENERATION_KEY, 'forged');
    await settle();

    expect(readRoomGeneration(handle.doc)).toBe(generation);
    expect(member.getState().refusal).toBe('unauthorized-write');
    handle.release();
  });

  it('COLLAB-SERVER-8.1 COLLAB-CLIENT-5.1 refuses a document from another generation and lets one from the same generation rejoin', async () => {
    const state = stateOf('stored', 'g1');
    const memory = createMemoryPersistence({
      initial: { notes: { update: state, revision: 'r1', sequence: 1 } },
    });
    const { sockets, open } = serve({ persistence: memory });
    // A document kept from an earlier session in the same generation.
    const current = new Doc();
    applyUpdate(current, state);
    const old = new Doc();
    applyUpdate(old, stateOf('old', 'g0'));

    const same = open(current);
    const other = open(old);
    await settle();

    expect(
      sockets.sockets.map((socket) => new URL(socket.url).searchParams.get('generation')),
    ).toEqual(['g1', 'g0']);
    expect(same.getState()).toMatchObject({ status: 'connected', synced: true });
    expect(same.doc.get('text').toString()).toBe('stored');
    expect(other.getState()).toMatchObject({
      status: 'disconnected',
      refusal: 'generation-mismatch',
    });
    expect(sockets.sockets[1]?.serverClose?.code).toBe(CLOSE_CODES.gone);
    expect(storedDoc(memory).get('text').toString()).toBe('stored');
  });
});

describe('room seeds', () => {
  it('COLLAB-SERVER-8.2 starts a missing room from its seed', async () => {
    const seed = vi.fn(() => Promise.resolve(stateOf('seeded')));
    const { open } = serve({ seeds: { seed } });
    const member = open();
    await settle();

    expect(seed).toHaveBeenCalledWith('notes');
    expect(member.doc.get('text').toString()).toBe('seeded');
  });

  it('COLLAB-SERVER-8.2 starts a stale room over from its seed, in a new generation stored over the stale state', async () => {
    const stored: { baseRevision: string | null }[] = [];
    const persistence: RoomPersistence = {
      load: () =>
        Promise.resolve<RoomLoadResult>({
          status: 'stale',
          reason: 'changed elsewhere',
          version: { revision: 'r7', sequence: 7 },
        }),
      store: (input) => {
        stored.push({ baseRevision: input.baseRevision });
        return Promise.resolve({ status: 'stored', revision: 'r8', sequence: 8 });
      },
    };
    const { open } = serve({
      persistence,
      seeds: { seed: () => Promise.resolve(stateOf('fresh copy', 'from-seed')) },
    });
    const member = open();
    await settle();

    expect(member.doc.get('text').toString()).toBe('fresh copy');
    expect(readRoomGeneration(member.doc)).not.toBe('from-seed');
    expect(stored).toEqual([{ baseRevision: 'r7' }]);
  });

  it('COLLAB-SERVER-8.2 fails the join when the seed fails or the new generation cannot be stored', async () => {
    const failing = serve({ seeds: { seed: () => Promise.reject(new Error('source down')) } });
    failing.open();
    const unstored = serve({
      persistence: {
        load: () => Promise.resolve({ status: 'missing' }),
        store: () => Promise.resolve({ status: 'unavailable', error: new Error('down') }),
      },
    });
    unstored.open();
    await settle();

    expect(failing.sockets.sockets[0]?.serverClose?.code).toBe(CLOSE_CODES.unavailable);
    expect(unstored.sockets.sockets[0]?.serverClose?.code).toBe(CLOSE_CODES.unavailable);
    expect(unstored.server.roomCount()).toBe(0);
  });
});

describe('save status and receipts', () => {
  it('COLLAB-SERVER-8.3 COLLAB-CLIENT-5.2 tells members whether the room is saved', async () => {
    const memory = createMemoryPersistence();
    let failNext = false;
    const persistence: RoomPersistence = {
      load: (room) => memory.load(room),
      store: (input) => {
        if (!failNext) return memory.store(input);
        failNext = false;
        return Promise.resolve({ status: 'unavailable', error: new Error('down') });
      },
    };
    const { clock, open } = serve({ persistence });
    const member = open();
    await settle();
    const statuses: (RoomSaveStatus | null)[] = [member.getState().saveStatus];
    member.subscribe((state) => {
      if (state.saveStatus !== statuses.at(-1)) statuses.push(state.saveStatus);
    });

    failNext = true;
    member.doc.get('text').insert(0, 'a');
    await settle();
    clock.advance(100);
    await settle();
    clock.advance(50);
    await settle();

    expect(statuses).toEqual(['saved', 'unsaved', 'saving', 'retrying', 'saving', 'saved']);
  });

  it('COLLAB-SERVER-8.4 COLLAB-CLIENT-5.3 resolves a receipt once the room stores the changes before it', async () => {
    const memory = createMemoryPersistence();
    const { clock, open } = serve({ persistence: memory });
    const member = open();
    await settle();
    const clean = await member.whenStored();

    member.doc.get('text').insert(0, 'durable');
    let stored: boolean | null = null;
    void member.whenStored().then((value) => (stored = value));
    await settle();
    const beforeStore = stored;
    clock.advance(100);
    await settle();

    expect(clean).toBe(true);
    expect(beforeStore).toBeNull();
    expect(stored).toBe(true);
    expect(storedDoc(memory).get('text').toString()).toBe('durable');
  });

  it('COLLAB-CLIENT-5.3 asks again after a reconnect, and answers false once destroyed', async () => {
    const memory = createMemoryPersistence();
    const { clock, sockets, open } = serve({ persistence: memory });
    const clientClock = createManualClock();
    const member = open(new Doc(), clientClock);
    await settle();

    sockets.sockets[0]?.drop();
    await settle();
    member.doc.get('text').insert(0, 'offline');
    const receipt = member.whenStored();
    await settle();
    clientClock.advance(0);
    await settle();
    clock.advance(100);
    await settle();
    member.doc.get('text').insert(0, 'more ');
    const lost = member.whenStored();
    member.destroy();

    await expect(receipt).resolves.toBe(true);
    await expect(lost).resolves.toBe(false);
    expect(storedDoc(memory).get('text').toString()).toBe('offline');
  });
});

describe('room metrics', () => {
  it('COLLAB-SERVER-8.5 records loads, stores and generations, and ignores a recorder that throws', async () => {
    const events: RoomMetricEvent[] = [];
    const { open } = serve({
      metrics: {
        record: (event) => {
          events.push(event);
          throw new Error('metrics down');
        },
      },
    });
    const member = open();
    await settle();

    expect(member.getState().synced).toBe(true);
    expect(events).toEqual([
      { type: 'load', room: 'notes', outcome: 'missing', durationMs: 0 },
      { type: 'generation', room: 'notes', reason: 'missing' },
      {
        type: 'store',
        room: 'notes',
        outcome: 'stored',
        durationMs: 0,
        bytes: expect.any(Number) as number,
      },
    ]);
  });
});

describe('incomplete stored updates', () => {
  function incompleteUpdate() {
    const writer = new Doc();
    writer.get('text').insert(0, 'a');
    const before = encodeStateVector(writer);
    writer.get('text').insert(1, 'b');
    const update = encodeStateAsUpdate(writer, before);
    writer.destroy();
    return update;
  }

  it('COLLAB-SERVER-4.1 treats a stored update with missing dependencies as corrupt', async () => {
    const memory = createMemoryPersistence({
      initial: {
        notes: {
          revision: 'r1',
          sequence: 1,
          update: incompleteUpdate(),
        },
      },
    });
    const { open, logger } = serve({
      persistence: memory,
      seeds: { seed: () => Promise.resolve(stateOf('seeded')) },
    });
    const member = open();
    await settle();

    expect(member.doc.get('text').toString()).toBe('seeded');
    expect(logger.warn).toHaveBeenCalledWith(
      'The stored room cannot be read; it starts from its seed.',
      expect.anything(),
    );
    expect(memory.peek('notes')?.sequence).toBe(2);
  });

  it('COLLAB-SERVER-8.2 refuses an incomplete seed instead of persisting deferred content', async () => {
    const { open, sockets, server } = serve({
      seeds: { seed: () => Promise.resolve(incompleteUpdate()) },
    });
    open();
    await settle();

    expect(sockets.sockets[0]?.serverClose?.code).toBe(CLOSE_CODES.unavailable);
    expect(server.roomCount()).toBe(0);
  });

  it('COLLAB-CLIENT-5.3 answers false for receipt requests made after refusal', async () => {
    const { open } = serve({
      auth: { admit: () => Promise.resolve({ ok: false, reason: 'forbidden' }) },
    });
    const member = open();
    await settle();
    let result: boolean | null = null;
    void member.whenStored().then((stored) => {
      result = stored;
    });
    await settle();
    expect(result).toBe(false);
  });
});
