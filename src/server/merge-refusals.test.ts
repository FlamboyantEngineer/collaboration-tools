import { Doc, Type } from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, type ManualClock } from '../../test/manual-clock.js';
import { connectToServer, readHandle, settle } from '../../test/server-sockets.js';
import type { RoomReload } from '../client/room-connection.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import type { RoomAdmission, RoomWriteRules } from './host/adapters.js';
import { createMemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer } from './room-server.js';

const providers: RoomProvider[] = [];
const servers: RoomServer[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ADMISSIONS: Record<string, RoomAdmission> = {
  first: { ok: true, actor: { id: 'first' }, access: 'read-write' },
  second: { ok: true, actor: { id: 'second' }, access: 'read-write' },
  limited: { ok: true, actor: { id: 'limited' }, access: 'read-write' },
};

/**
 * A guard over a list that must keep two items: fewer is a conflict, since a merge of honest
 * deletions can leave it so; `limited` may change nothing at all.
 */
const LIST_RULES: RoomWriteRules = {
  openGuard: (shadow) => ({
    check: ({ actor }) => {
      if (actor.id === 'limited') return false;
      return shadow.get('list').length >= 2 ? true : 'conflict';
    },
  }),
};

function serve(rules: RoomWriteRules = LIST_RULES) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const events = { emit: vi.fn() };
  const server = createRoomServer({
    host: {
      auth: {
        admit: ({ token }) =>
          Promise.resolve(ADMISSIONS[token ?? ''] ?? { ok: false, reason: 'unauthenticated' }),
      },
      persistence: createMemoryPersistence(),
      permissions: { rulesFor: () => rules },
      logger,
      events,
      clock: createManualClock(),
    },
  });
  servers.push(server);
  const sockets = connectToServer(server);
  const open = (token: string, clock: ManualClock = createManualClock()) => {
    const provider = createRoomProvider({
      endpoint: 'wss://rooms.example.test/live',
      room: 'notes',
      doc: new Doc(),
      getToken: () => token,
      createSocket: sockets.createSocket,
      clock,
    });
    providers.push(provider);
    return provider;
  };
  const roomList = async () => {
    const handle = await server.openRoom('notes');
    const items = readHandle(handle).get('list').toArray();
    handle.release();
    return items;
  };
  return { server, sockets, open, roomList, logger, events };
}

const list = (provider: RoomProvider) => provider.doc.get('list');

/** Two writers in a room whose list holds a, b and c. */
async function twoWriters(rules?: RoomWriteRules) {
  const served = serve(rules);
  const first = served.open('first');
  const clock = createManualClock();
  const second = served.open('second', clock);
  await settle();
  list(first).insert(0, ['a', 'b', 'c']);
  await settle();
  return { ...served, first, second, clock };
}

describe('changes refused for their merge', () => {
  it('COLLAB-SERVER-7.7 COLLAB-CLIENT-3.5 refuses the later of two honest deletions, keeps the writer connected and reloads the room', async () => {
    const { first, second, roomList, logger } = await twoWriters();
    const reloads: RoomReload[] = [];
    second.onReload((reload) => reloads.push(reload));
    const before = second.doc;
    second.disconnect();
    list(first).delete(0, 1);
    list(second).delete(1, 2);
    second.connect();
    await settle();

    expect(await roomList()).toEqual(['b', 'c']);
    expect(second.getState()).toMatchObject({
      status: 'connected',
      refusal: null,
      refusedChanges: 1,
      hasUnconfirmedChanges: false,
    });
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toMatchObject({ reason: 'conflict', previous: before });
    expect(second.doc).toBe(reloads[0]?.doc);
    expect(list(second).toArray()).toEqual(['b', 'c']);
    expect(logger.warn).toHaveBeenCalledWith(
      'A connection sent a change that does not merge with the room.',
      expect.objectContaining({ actor: 'second' }),
    );

    // The same connection keeps writing, on the reloaded document.
    list(second).insert(2, ['d']);
    await settle();
    expect(await roomList()).toEqual(['b', 'c', 'd']);
    expect(list(first).toArray()).toEqual(['b', 'c', 'd']);
  });

  it('COLLAB-SERVER-7.7 still cuts off a write refused for the writer’s rights', async () => {
    const { open, roomList } = await twoWriters();
    const limited = open('limited');
    await settle();
    const reloads: RoomReload[] = [];
    limited.onReload((reload) => reloads.push(reload));

    list(limited).insert(0, ['x']);
    await settle();

    expect(limited.getState()).toMatchObject({
      status: 'disconnected',
      refusal: 'unauthorized-write',
      refusedChanges: 0,
    });
    expect(reloads).toEqual([]);
    expect(await roomList()).toEqual(['a', 'b', 'c']);
  });

  it('COLLAB-SERVER-7.7 cuts off a writer whose updates keep failing to merge past the limit', async () => {
    const { first, second, roomList } = await twoWriters({
      ...LIST_RULES,
      conflictLimit: { count: 2, windowMs: 60_000 },
    });
    list(first).delete(0, 1);
    await settle();

    const refusedOnce = async () => {
      list(second).delete(0, list(second).length - 1);
      await settle();
      return second.getState();
    };
    const one = await refusedOnce();
    const two = await refusedOnce();
    const three = await refusedOnce();

    expect(one).toMatchObject({ status: 'connected', refusedChanges: 1 });
    expect(two).toMatchObject({ status: 'connected', refusedChanges: 2 });
    expect(three).toMatchObject({ status: 'disconnected', refusal: 'unauthorized-write' });
    expect(await roomList()).toEqual(['b', 'c']);
  });

  it('COLLAB-CLIENT-3.4 COLLAB-CLIENT-3.5 sends offline changes one by one: the room keeps those that merge', async () => {
    const { first, second, clock, roomList } = await twoWriters();
    second.disconnect();
    list(first).delete(0, 1);
    list(second).insert(3, ['x']);
    clock.advance(600);
    // b and c: with the first writer's deletion the list would keep only x.
    list(second).delete(1, 2);
    clock.advance(600);
    list(second).insert(2, ['y']);
    const offline = second.getUnconfirmedUpdates();
    second.connect();
    await settle();

    expect(offline).toHaveLength(3);
    expect(await roomList()).toEqual(['b', 'c', 'x', 'y']);
    expect(list(second).toArray()).toEqual(['b', 'c', 'x', 'y']);
    expect(list(first).toArray()).toEqual(['b', 'c', 'x', 'y']);
    expect(second.getState()).toMatchObject({ refusedChanges: 1, hasUnconfirmedChanges: false });
  });

  it('COLLAB-CLIENT-3.5 keeps the later changes beside a refused change and drops those inside it', async () => {
    const { first, second, clock, roomList } = await twoWriters();
    const shared = list(second);
    const inner = new Type();
    second.disconnect();
    list(first).delete(0, 1);
    // The refused change inserts a nested list and deletes b and c.
    second.doc.transact(() => {
      shared.insert(3, [inner]);
      shared.delete(1, 2);
    });
    clock.advance(600);
    // Later changes, whose places come after the refused one's: one inside what it inserted.
    inner.insert(0, ['inside']);
    clock.advance(600);
    shared.insert(0, ['beside']);
    second.connect();
    await settle();

    expect(await roomList()).toEqual(['beside', 'b', 'c']);
    expect(list(second).toArray()).toEqual(['beside', 'b', 'c']);
    expect(second.getState()).toMatchObject({ refusedChanges: 1, hasUnconfirmedChanges: false });
  });
});
