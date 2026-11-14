import { Doc } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { connectToServer, settle } from '../../test/server-sockets.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import type { RoomEvent, RoomEvents, RoomPersistence } from './host/adapters.js';
import { createMemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer } from './room-server.js';

const providers: RoomProvider[] = [];
const servers: RoomServer[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface ServeOptions {
  events?: RoomEvents;
  persistence?: RoomPersistence;
}

// A server whose clients are admitted as the actor their token names.
function serve(options: ServeOptions = {}) {
  const clock = createManualClock();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const seen: RoomEvent[] = [];
  const server = createRoomServer({
    host: {
      auth: {
        admit: ({ token }) =>
          Promise.resolve({
            ok: true,
            actor: { id: token ?? 'anonymous' },
            access: token === 'reader' ? 'read-only' : 'read-write',
          }),
      },
      persistence: options.persistence ?? createMemoryPersistence(),
      events: options.events ?? { emit: (event) => void seen.push(event) },
      logger,
      clock,
    },
    storeDebounceMs: 100,
    storeMaxDebounceMs: 500,
    storeRetryMs: 50,
  });
  servers.push(server);
  const sockets = connectToServer(server);
  const open = (token: string) => {
    const provider = createRoomProvider({
      endpoint: 'wss://rooms.example.test/live',
      room: 'notes',
      doc: new Doc(),
      getToken: () => token,
      createSocket: sockets.createSocket,
      clock: createManualClock(),
    });
    providers.push(provider);
    return provider;
  };
  return { server, clock, logger, open, seen };
}

const write = (provider: RoomProvider, text: string) =>
  provider.doc.get('text').insert(provider.doc.get('text').length, text);

// The events of the types given, without their stored revisions.
function eventsOf(seen: readonly RoomEvent[], ...types: RoomEvent['type'][]) {
  return seen
    .filter((event) => types.includes(event.type))
    .map((event) =>
      event.type === 'stored' ? { type: event.type, editors: event.editors } : event,
    );
}

describe('room events', () => {
  it('COLLAB-SERVER-8.6 reports a room loading, members joining and leaving, and the room unloading', async () => {
    const { seen, open } = serve();
    const writer = open('ada');
    const reader = open('reader');
    await settle();
    writer.destroy();
    reader.destroy();
    await settle();

    expect(eventsOf(seen, 'loaded', 'joined', 'left', 'unloaded')).toEqual([
      { type: 'loaded', room: 'notes' },
      { type: 'joined', room: 'notes', actor: { id: 'ada' }, access: 'read-write' },
      { type: 'joined', room: 'notes', actor: { id: 'reader' }, access: 'read-only' },
      { type: 'left', room: 'notes', actor: { id: 'ada' } },
      { type: 'left', room: 'notes', actor: { id: 'reader' } },
      { type: 'unloaded', room: 'notes' },
    ]);
  });

  it('COLLAB-SERVER-8.6 names, on each stored state, the actors whose changes it first holds', async () => {
    const { seen, open, clock, server } = serve();
    const ada = open('ada');
    const bo = open('bo');
    await settle();
    write(ada, 'a');
    write(bo, 'b');
    write(ada, 'c');
    await settle();
    clock.advance(100);
    await settle();
    write(bo, 'd');
    await settle();
    clock.advance(100);
    await settle();
    const handle = await server.openRoom('notes');
    handle.doc.transact(() => handle.doc.get('text').insert(0, 'host'), 'host');
    await settle();
    clock.advance(100);
    await settle();
    handle.release();

    const stored = seen.filter((event) => event.type === 'stored');
    expect(stored.map((event) => event.editors)).toEqual([
      // The new generation, stored as the room loads.
      [],
      [{ id: 'ada' }, { id: 'bo' }],
      [{ id: 'bo' }],
      [],
    ]);
    expect(stored.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('COLLAB-SERVER-8.6 keeps the editors of a failed store for the store that follows', async () => {
    const memory = createMemoryPersistence();
    let failing = false;
    const persistence: RoomPersistence = {
      load: (room) => memory.load(room),
      store: (input) =>
        failing
          ? Promise.resolve({ status: 'unavailable', error: new Error('down') })
          : memory.store(input),
    };
    const { seen, open, clock } = serve({ persistence });
    const ada = open('ada');
    const bo = open('bo');
    await settle();
    failing = true;
    write(ada, 'a');
    await settle();
    clock.advance(100);
    await settle();
    failing = false;
    write(bo, 'b');
    await settle();
    clock.advance(100);
    await settle();

    expect(eventsOf(seen, 'stored').slice(1)).toEqual([
      { type: 'stored', editors: [{ id: 'ada' }, { id: 'bo' }] },
    ]);
  });

  it('COLLAB-SERVER-8.6 reports a conflict', async () => {
    const memory = createMemoryPersistence();
    const { seen, open, clock } = serve({ persistence: memory });
    const ada = open('ada');
    await settle();
    // Another writer stores the room over the revision this one holds.
    const current = await memory.load('notes');
    if (current.status !== 'found') throw new Error('not stored');
    await memory.store({
      room: 'notes',
      update: current.state.update,
      baseRevision: current.state.revision,
    });
    write(ada, 'a');
    await settle();
    clock.advance(100);
    await settle();

    expect(eventsOf(seen, 'conflicted')).toEqual([{ type: 'conflicted', room: 'notes' }]);
  });

  it('COLLAB-SERVER-8.6 logs a listener that throws or rejects, and changes nothing', async () => {
    let calls = 0;
    const events: RoomEvents = {
      emit: () => {
        calls += 1;
        if (calls % 2) throw new Error('listener down');
        return Promise.reject(new Error('webhook down'));
      },
    };
    const { open, logger } = serve({ events });
    const writer = open('ada');
    await settle();

    expect(writer.getState().synced).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(logger.warn).toHaveBeenCalledWith(
      'A room event listener failed.',
      expect.objectContaining({ room: 'notes' }),
    );
    const errors = logger.warn.mock.calls.map(([, details]) => (details as { error: Error }).error);
    expect(errors.map((error) => error.message)).toEqual(
      expect.arrayContaining(['listener down', 'webhook down']),
    );
  });
});
