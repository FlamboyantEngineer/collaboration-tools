import { applyUpdate, Doc } from '@y/y';
import { afterEach, expect, it } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { connectToServer, readHandle, settle } from '../../test/server-sockets.js';
import { createRoomProvider } from '../client/room-provider.js';
import { readRoomGeneration } from '../protocol/room-meta.js';
import type { RoomStoreInput, RoomStoreResult } from './host/adapters.js';
import { createMemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer } from './room-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup() {
  const clock = createManualClock();
  const memory = createMemoryPersistence();
  const inputs: RoomStoreInput[] = [];
  let unavailable = false;
  let intercept: ((input: RoomStoreInput) => Promise<RoomStoreResult>) | undefined;
  const persistence = {
    load: (room: string) => memory.load(room),
    store: (input: RoomStoreInput) => {
      inputs.push(input);
      if (unavailable)
        return Promise.resolve<RoomStoreResult>({
          status: 'unavailable',
          error: new Error('down'),
        });
      return intercept ? intercept(input) : memory.store(input);
    },
  };
  const server = createRoomServer({
    host: {
      clock,
      persistence,
      auth: {
        admit: () => Promise.resolve({ ok: true, actor: { id: 'alice' }, access: 'read-write' }),
      },
    },
    storeRetryMs: 20,
  });
  cleanups.push(async () => {
    unavailable = false;
    intercept = undefined;
    await server.close();
  });
  return {
    server,
    clock,
    memory,
    inputs,
    fail: (value: boolean) => {
      unavailable = value;
    },
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
  };
}

function write(server: RoomServer, value: string) {
  return server.openRoom('room').then((handle) => {
    expect(
      handle.transact({ actor: { id: 'service' }, capabilities: [] }, (doc) =>
        doc.get('text').insert(0, value),
      ),
    ).toBe(true);
    return handle;
  });
}

it('COLLAB-SERVER-10.1 rejects unsuccessful flush and close, preserving recoverable state and retrying shutdown', async () => {
  const { server, fail } = setup();
  const handle = await write(server, 'kept');
  fail(true);
  await expect(server.flush()).rejects.toThrow('could not be stored');
  await expect(server.close()).rejects.toThrow('recoverable unsaved');
  const recovered = new Doc();
  applyUpdate(recovered, server.recover()[0]?.update ?? new Uint8Array());
  expect(recovered.get('text').toString()).toBe('kept');
  expect(() =>
    handle.transact({ actor: { id: 'service' }, capabilities: [] }, () => undefined),
  ).toThrow('closed');
  fail(false);
  await server.close();
  expect(server.roomCount()).toBe(0);
  recovered.destroy();
});

it('COLLAB-SERVER-10.1 aborts and times out a barrier without cancelling recoverable storage', async () => {
  const { server, fail, clock } = setup();
  const handle = await write(server, 'kept');
  fail(true);
  const controller = new AbortController();
  const aborted = expect(server.flush({ signal: controller.signal })).rejects.toThrow('aborted');
  controller.abort();
  await aborted;
  const timeout = expect(server.flush({ timeoutMs: 10 })).rejects.toThrow('timed out');
  await settle();
  clock.advance(10);
  await timeout;
  expect(server.recover()).toHaveLength(1);
  fail(false);
  await server.flush();
  expect(server.recover()).toEqual([]);
  handle.release();
});

it('COLLAB-SERVER-10.2 keeps collaborators joined during canonical commit and advances the revision for later edits', async () => {
  const { server, memory, inputs } = setup();
  const sockets = connectToServer(server);
  const provider = createRoomProvider({
    endpoint: 'wss://example.test/live',
    room: 'room',
    doc: new Doc(),
    createSocket: sockets.createSocket,
  });
  await settle();
  provider.doc.get('text').insert(0, 'before');
  await settle();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured = '';
  const commit = server.commitRoom('room', async (snapshot) => {
    const doc = new Doc();
    applyUpdate(doc, snapshot.update);
    captured = doc.get('text').toString();
    doc.destroy();
    await wait;
    const result = await memory.store({
      room: 'room',
      update: snapshot.update,
      baseRevision: snapshot.version?.revision ?? null,
    });
    if (result.status !== 'stored') throw new Error('canonical commit failed');
    return { value: 'committed', version: result };
  });
  await settle();
  const storesBefore = inputs.length;
  provider.doc.get('text').insert(0, 'after ');
  await settle();
  expect(captured).toBe('before');
  expect(provider.getState().status).toBe('connected');
  expect(inputs).toHaveLength(storesBefore);
  release?.();
  await expect(commit).resolves.toBe('committed');
  await server.flush();
  const stored = memory.peek('room');
  const doc = new Doc();
  if (stored) applyUpdate(doc, stored.update);
  expect(doc.get('text').toString()).toBe('after before');
  expect(inputs.at(-1)?.baseRevision).not.toBe(inputs.at(-2)?.baseRevision);
  expect(inputs.at(-1)?.context?.actors).toEqual([{ id: 'alice' }]);
  provider.destroy();
  doc.destroy();
});

it('COLLAB-SERVER-10.3 fences retained handles, returns unsaved edits and reseeds a new generation', async () => {
  const { server } = setup();
  const handle = await write(server, 'old');
  const generation = readRoomGeneration(readHandle(handle));
  const recovery = await server.invalidate('room');
  expect(recovery).toHaveLength(1);
  expect(() =>
    handle.transact({ actor: { id: 'service' }, capabilities: [] }, (doc) =>
      doc.get('text').insert(0, 'late'),
    ),
  ).toThrow('fenced');
  const next = await server.openRoom('room');
  expect(readRoomGeneration(readHandle(next))).not.toBe(generation);
  expect(readHandle(next).get('text').toString()).toBe('');
  handle.release();
  next.release();
});

it('COLLAB-SERVER-10.4 attributes validated host candidates atomically and disposes guards', async () => {
  const memory = createMemoryPersistence();
  const changes: string[] = [];
  let destroyed = 0;
  const server = createRoomServer({
    host: {
      persistence: memory,
      auth: { admit: () => Promise.resolve({ ok: false, reason: 'forbidden' }) },
      permissions: {
        rulesFor: () => ({
          openGuard: () => ({
            check: (change) => {
              changes.push(change.actor.id);
              return change.capabilities.has('edit');
            },
            destroy: () => {
              destroyed += 1;
            },
          }),
        }),
      },
    },
  });
  const handle = await server.openRoom('room');
  expect(
    handle.transact({ actor: { id: 'denied' }, capabilities: [] }, (doc) =>
      doc.get('text').insert(0, 'bad'),
    ),
  ).toBe(false);
  let retained: Doc | undefined;
  expect(
    handle.transact({ actor: { id: 'accepted' }, capabilities: ['edit'] }, (doc) => {
      retained = doc;
      doc.get('text').insert(0, 'good');
    }),
  ).toBe(true);
  retained?.get('text').insert(0, 'escaped');
  expect(readHandle(handle).get('text').toString()).toBe('good');
  expect(changes).toEqual(['denied', 'accepted']);
  await server.flush();
  handle.release();
  await server.close();
  expect(destroyed).toBe(2);
});

it('COLLAB-SERVER-10.1 returns a per-room receipt covering the requested boundary while later edits remain dirty', async () => {
  const { server, memory, intercept } = setup();
  const handle = await write(server, 'before');
  let finish: (() => void) | undefined;
  intercept(
    (input) =>
      new Promise((resolve) => {
        finish = () => {
          void memory.store(input).then(resolve);
        };
      }),
  );
  const flush = handle.flush({ timeoutMs: 100 });
  await settle();
  handle.transact({ actor: { id: 'later' }, capabilities: [] }, (doc) =>
    doc.get('text').insert(0, 'after '),
  );
  finish?.();
  const receipt = await flush;
  expect(receipt.room).toBe('room');
  expect(receipt.version?.revision).toBe(memory.peek('room')?.revision);
  expect(server.recover()).toHaveLength(1);
  intercept(undefined);
  // The flush already in progress owns the second snapshot, so resolve it too.
  finish?.();
  await settle();
  await server.flush();
  handle.release();
});

it('COLLAB-SERVER-10.3 waits for in-flight storage before invalidation and prevents late old handles from writing', async () => {
  const { server, memory, intercept } = setup();
  const handle = await write(server, 'old');
  let finish: (() => void) | undefined;
  intercept(
    (input) =>
      new Promise((resolve) => {
        finish = () => {
          void memory.store(input).then(resolve);
        };
      }),
  );
  const flushing = server.flush();
  await settle();
  let invalidated = false;
  const invalidating = server.invalidate('room').then((recovery) => {
    invalidated = true;
    return recovery;
  });
  await settle();
  expect(invalidated).toBe(false);
  finish?.();
  await flushing;
  await expect(invalidating).resolves.toEqual([]);
  intercept(undefined);
  expect(() =>
    handle.transact({ actor: { id: 'late' }, capabilities: [] }, (doc) =>
      doc.get('text').insert(0, 'late'),
    ),
  ).toThrow('fenced');
  const next = await server.openRoom('room');
  expect(readHandle(next).get('text').toString()).toBe('');
  handle.release();
  next.release();
});

it('COLLAB-SERVER-10.3 retires a fenced dirty instance after handing recovery to the caller', async () => {
  const { server } = setup();
  const handle = await write(server, 'unsaved');
  const recovered = await server.invalidate('room');
  expect(recovered).toHaveLength(1);
  await server.close();
  expect(server.roomCount()).toBe(0);
  handle.release();
});

it('COLLAB-SERVER-10.3 refuses writes through an old handle after a persistence conflict', async () => {
  const { server, memory } = setup();
  const handle = await write(server, 'unsaved');
  const current = memory.peek('room');
  if (!current) throw new Error('missing stored state');
  await memory.store({ room: 'room', baseRevision: current.revision, update: current.update });
  await expect(server.flush()).rejects.toThrow('could not be stored');
  expect(() =>
    handle.transact({ actor: { id: 'late' }, capabilities: [] }, () => undefined),
  ).toThrow('fenced');
  handle.release();
});

it('COLLAB-SERVER-10.4 excludes no-op host candidates from atomic persistence attribution', async () => {
  const { server, inputs } = setup();
  const handle = await server.openRoom('room');
  handle.transact({ actor: { id: 'noop' }, capabilities: [] }, () => undefined);
  handle.transact({ actor: { id: 'actual' }, capabilities: [] }, (doc) =>
    doc.get('text').insert(0, 'change'),
  );
  await handle.flush();
  expect(inputs.at(-1)?.context?.actors).toEqual([{ id: 'actual' }]);
  handle.release();
});

it('COLLAB-SERVER-10.1 bounds shutdown while a store is unresolved and allows cleanup to finish later', async () => {
  const { server, memory, intercept, clock } = setup();
  const handle = await write(server, 'pending');
  let finish: (() => void) | undefined;
  intercept(
    (input) =>
      new Promise((resolve) => {
        finish = () => {
          void memory.store(input).then(resolve);
        };
      }),
  );
  const closing = expect(server.close({ timeoutMs: 10 })).rejects.toThrow('timed out');
  await settle();
  clock.advance(10);
  await closing;
  expect(server.recover()).toHaveLength(1);
  finish?.();
  await settle();
  await server.close();
  expect(server.roomCount()).toBe(0);
  handle.release();
});
