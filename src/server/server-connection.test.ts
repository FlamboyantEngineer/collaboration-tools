import { Doc, encodeStateAsUpdate } from '@y/y';
import * as decoding from 'lib0/decoding';
import { afterEach, expect, it, vi } from 'vitest';
import { createManualClock } from '../../test/manual-clock.js';
import { createDeferred } from '../../test/promise-fixtures.js';
import { readHandle, settle } from '../../test/server-sockets.js';
import { encodeAwarenessFrame, encodeSyncUpdate } from '../protocol/frames.js';
import { CLOSE_CODES, encodeStatelessMessage, MESSAGE_TYPES } from '../protocol/messages.js';
import { decodeAwarenessEntries, encodeAwarenessEntries } from './awareness-owners.js';
import type { RoomAdmission, RoomHost } from './host/adapters.js';
import { createMemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer, type RoomServerOptions } from './room-server.js';

const servers: RoomServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
const admitted: RoomAdmission = {
  ok: true,
  actor: { id: 'alice', name: 'Alice' },
  access: 'read-write',
  sessionId: 's1',
};

function serve(host: Partial<RoomHost> = {}, options: Partial<RoomServerOptions> = {}) {
  const clock = createManualClock();
  const server = createRoomServer({
    host: {
      auth: { admit: () => Promise.resolve(admitted) },
      persistence: createMemoryPersistence(),
      clock,
      ...host,
    },
    ...options,
  });
  servers.push(server);
  return { server, clock };
}

function connect(server: RoomServer, room = 'notes') {
  const frames: Uint8Array[] = [];
  const close = vi.fn();
  const connection = server.connect(
    { send: (frame) => frames.push(frame), close },
    { url: `/live/${room}`, headers: {} },
  );
  return { connection, frames, close };
}

it('COLLAB-SERVER-1.4 caps pending frame counts and bytes before admission and ignores late admissions', async () => {
  const admission = createDeferred<RoomAdmission>();
  const { server } = serve(
    { auth: { admit: () => admission.promise } },
    { connectionLimits: { maxPendingFrames: 2 }, maxPendingBytes: 132 },
  );
  const first = connect(server);
  first.connection.receive(new Uint8Array(2));
  first.connection.receive(new Uint8Array(2));
  first.connection.receive(new Uint8Array(0));
  const second = connect(server);
  second.connection.receive(new Uint8Array(69));
  expect(first.close).toHaveBeenCalledWith(1009, 'too-large');
  expect(second.close).toHaveBeenCalledWith(1009, 'too-large');
  admission.resolve(admitted);
  await settle();
  expect(server.roomCount()).toBe(0);
  expect(first.frames).toEqual([]);
});

it('COLLAB-SERVER-1.4 times out admission and room loading and releases a room that completes after close', async () => {
  const admission = createDeferred<RoomAdmission>();
  const first = serve(
    { auth: { admit: () => admission.promise } },
    { connectionLimits: { admissionTimeoutMs: 20 } },
  );
  const pending = connect(first.server);
  first.clock.advance(20);
  expect(pending.close).toHaveBeenCalledWith(CLOSE_CODES.unavailable, 'admission-timeout');
  admission.resolve(admitted);
  await settle();
  expect(first.server.roomCount()).toBe(0);
  const loaded = createDeferred<Awaited<ReturnType<RoomHost['persistence']['load']>>>();
  const persistence = createMemoryPersistence();
  const second = serve(
    { persistence: { ...persistence, load: () => loaded.promise } },
    { connectionLimits: { loadTimeoutMs: 20 } },
  );
  const loading = connect(second.server);
  await settle();
  second.clock.advance(20);
  expect(loading.close).toHaveBeenCalledWith(CLOSE_CODES.unavailable, 'admission-timeout');
  loaded.resolve({ status: 'missing' });
  await settle();
  expect(second.server.roomCount()).toBe(0);
  expect(loading.frames).toEqual([]);
});

it('COLLAB-SERVER-7.5 revokes only the matching canonical room, actor and session', async () => {
  const { server } = serve({
    auth: {
      admit: ({ room }) =>
        Promise.resolve({ ...admitted, room: room === 'alias' ? 'notes' : room }),
    },
  });
  const first = connect(server, 'alias');
  const second = connect(server, 'other');
  await settle();
  server.revoke({ room: 'notes', actorId: 'alice', sessionId: 'wrong' });
  expect(first.close).not.toHaveBeenCalled();
  server.revoke({ room: 'notes', actorId: 'alice', sessionId: 's1' });
  expect(first.close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'revoked');
  expect(second.close).not.toHaveBeenCalled();
});

it('COLLAB-SERVER-7.5 refreshes access and capabilities and rejects changed identity', async () => {
  let decision = admitted;
  const { server } = serve({
    auth: { admit: () => Promise.resolve(admitted), refresh: () => Promise.resolve(decision) },
  });
  const client = connect(server);
  await settle();
  decision = { ...admitted, access: 'read-only', capabilities: [] };
  await server.reauthorize({ actorId: 'alice' });
  const doc = new Doc();
  doc.get('body').insert(0, 'refused');
  client.connection.receive(encodeSyncUpdate(encodeStateAsUpdate(doc)));
  const handle = await server.openRoom('notes');
  expect(readHandle(handle).get('body').toString()).toBe('');
  handle.release();
  decision = { ...admitted, actor: { id: 'bob' } };
  await server.reauthorize({ sessionId: 's1' });
  expect(client.close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'identity-changed');
  doc.destroy();
});

it('COLLAB-SERVER-7.5 bounds stalled refreshes and ignores completion after revocation', async () => {
  const deferred = createDeferred<RoomAdmission>();
  const { server, clock } = serve({
    auth: { admit: () => Promise.resolve(admitted), refresh: () => deferred.promise },
  });
  const client = connect(server);
  await settle();
  const pending = server.reauthorize({ actorId: 'alice' });
  clock.advance(10_000);
  expect(client.close).toHaveBeenCalledWith(CLOSE_CODES.unauthenticated, 'refresh-timeout');
  const count = client.frames.length;
  deferred.resolve(admitted);
  await pending;
  expect(client.frames).toHaveLength(count);
});

it('COLLAB-SERVER-3.5 COLLAB-HOST-9.1 relays authenticated identity and refuses malformed presence', async () => {
  const { server } = serve();
  const sender = connect(server);
  const observer = connect(server);
  await settle();
  observer.frames.length = 0;
  sender.connection.receive(
    encodeAwarenessFrame(
      encodeAwarenessEntries([
        {
          clientId: 44,
          clock: 1,
          state: JSON.stringify({ user: { id: 'bob' }, actor: { id: 'bob' }, cursor: 3 }),
        },
      ]),
    ),
  );
  const awareness = observer.frames.find(
    (frame) => decoding.readVarUint(decoding.createDecoder(frame)) === MESSAGE_TYPES.awareness,
  );
  expect(awareness).toBeDefined();
  const decoder = decoding.createDecoder(awareness ?? new Uint8Array());
  decoding.readVarUint(decoder);
  const entry = decodeAwarenessEntries(decoding.readVarUint8Array(decoder))[0];
  expect(JSON.parse(entry?.state ?? 'null')).toEqual({
    user: { id: 'alice', name: 'Alice' },
    actor: { id: 'alice', name: 'Alice' },
    cursor: 3,
  });
  sender.connection.receive(
    encodeAwarenessFrame(encodeAwarenessEntries([{ clientId: 44, clock: 2, state: '[]' }])),
  );
  expect(sender.close).toHaveBeenCalledWith(CLOSE_CODES.badRequest, 'bad-request');
});

it('COLLAB-SERVER-1.4 copies queued frames and cancels deadlines after joining or cancellation', async () => {
  const admission = createDeferred<RoomAdmission>();
  const onStateless = vi.fn();
  const { server, clock } = serve(
    { auth: { admit: () => admission.promise } },
    { onStateless, maxPendingBytes: undefined },
  );
  const client = connect(server);
  const frame = encodeStatelessMessage('original');
  client.connection.receive(frame);
  frame.fill(255);
  admission.resolve(admitted);
  await settle();
  expect(onStateless).toHaveBeenCalledWith(expect.objectContaining({ payload: 'original' }));
  clock.advance(40_000);
  expect(client.close).not.toHaveBeenCalled();
  client.connection.closed();
  clock.advance(40_000);
  expect(client.close).not.toHaveBeenCalled();
});

it('COLLAB-SERVER-3.5 COLLAB-HOST-9.1 allows host normalization and rejects exceptions or null results', async () => {
  for (const normalize of [
    () => null,
    () => {
      throw new Error('refused');
    },
  ]) {
    const { server } = serve({ awareness: { normalize } });
    const client = connect(server);
    await settle();
    client.connection.receive(
      encodeAwarenessFrame(encodeAwarenessEntries([{ clientId: 1, clock: 1, state: '{}' }])),
    );
    expect(client.close).toHaveBeenCalledWith(CLOSE_CODES.badRequest, 'bad-request');
  }
  const normalize = vi.fn(({ actor }: { actor: { id: string } }) => ({
    user: { member: actor.id },
    actor: { id: 'forged' },
  }));
  const { server } = serve({ awareness: { normalize } });
  const sender = connect(server);
  const receiver = connect(server);
  await settle();
  receiver.frames.length = 0;
  sender.connection.receive(
    encodeAwarenessFrame(encodeAwarenessEntries([{ clientId: 7, clock: 1, state: '{}' }])),
  );
  const frame = receiver.frames[0];
  const decoder = decoding.createDecoder(frame ?? new Uint8Array());
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_TYPES.awareness);
  const [entry] = decodeAwarenessEntries(decoding.readVarUint8Array(decoder));
  expect(JSON.parse(entry?.state ?? 'null')).toEqual({
    user: { member: 'alice' },
    actor: { id: 'alice', name: 'Alice' },
  });
  expect(normalize).toHaveBeenCalledWith(
    expect.objectContaining({ room: 'notes', actor: { id: 'alice', name: 'Alice' } }),
  );
});

it('COLLAB-SERVER-7.5 applies refreshed capabilities even when access stays read-write', async () => {
  const initial: RoomAdmission = { ...admitted, capabilities: ['edit'] };
  const { server } = serve({
    auth: {
      admit: () => Promise.resolve(initial),
      refresh: () => Promise.resolve({ ...admitted, capabilities: [] }),
    },
    permissions: { rulesFor: () => ({ otherwise: 'edit' }) },
  });
  const client = connect(server);
  await settle();
  await server.reauthorize({ actorId: 'alice' });
  const doc = new Doc();
  doc.get('body').insert(0, 'forbidden');
  client.connection.receive(encodeSyncUpdate(encodeStateAsUpdate(doc)));
  expect(client.close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'unauthorized-write');
  const handle = await server.openRoom('notes');
  expect(readHandle(handle).get('body').toString()).toBe('');
  handle.release();
  doc.destroy();
});

it('COLLAB-SERVER-7.5 cancels and shares a pending refresh when the connection is revoked', async () => {
  const deferred = createDeferred<RoomAdmission>();
  const refresh = vi.fn(() => deferred.promise);
  const { server } = serve({ auth: { admit: () => Promise.resolve(admitted), refresh } });
  const client = connect(server);
  await settle();
  const first = server.reauthorize({ sessionId: 's1' });
  const second = server.reauthorize({ sessionId: 's1' });
  server.revoke({ actorId: 'alice' });
  await Promise.all([first, second]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'revoked');
  const count = client.frames.length;
  deferred.resolve(admitted);
  await settle();
  expect(client.frames).toHaveLength(count);
});

it('COLLAB-SERVER-1.4 cancels pending authentication when the transport closes', async () => {
  const admission = createDeferred<RoomAdmission>();
  const { server, clock } = serve({ auth: { admit: () => admission.promise } });
  const client = connect(server);
  client.connection.receive(encodeStatelessMessage('discarded'));
  client.connection.closed();
  expect(clock.pendingDelays()).toEqual([]);
  admission.resolve(admitted);
  await settle();
  expect(server.roomCount()).toBe(0);
  expect(client.frames).toEqual([]);
  expect(client.close).not.toHaveBeenCalled();
});

it('COLLAB-SERVER-3.5 does not exhaust awareness metadata after repeated reconnects', async () => {
  const { server } = serve();
  const observer = connect(server);
  await settle();
  for (let session = 0; session < 70; session += 1) {
    const sender = connect(server);
    await settle(1);
    const entries = Array.from({ length: 16 }, (_, index) => ({
      clientId: 10000 + session * 16 + index,
      clock: 1,
      state: '{}',
    }));
    sender.connection.receive(encodeAwarenessFrame(encodeAwarenessEntries(entries)));
    expect(sender.close).not.toHaveBeenCalled();
    sender.connection.closed();
  }
  expect(observer.close).not.toHaveBeenCalled();
  const decoder = decoding.createDecoder(observer.frames.at(-1) ?? new Uint8Array());
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_TYPES.awareness);
  const removals = decodeAwarenessEntries(decoding.readVarUint8Array(decoder));
  expect(removals).toHaveLength(16);
  expect(removals.every((entry) => entry.state === 'null')).toBe(true);
});

it('COLLAB-SERVER-7.5 revokes every target when one transport throws on denial', async () => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const { server } = serve({ logger });
  let fail = false;
  const close = vi.fn();
  server.connect(
    {
      send: () => {
        if (fail) throw new Error('transport failed');
      },
      close,
    },
    { url: '/live/notes', headers: {} },
  );
  const second = connect(server);
  await settle();
  fail = true;
  expect(() => server.revoke({ actorId: 'alice' })).not.toThrow();
  expect(close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'revoked');
  expect(second.close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'revoked');
  expect(logger.warn).toHaveBeenCalledWith(
    'Closing a revoked connection failed.',
    expect.any(Object),
  );
});

it.each([
  { actorId: 'alice' },
  { sessionId: 's1' },
  { room: 'notes' },
  { room: 'notes', actorId: 'alice', sessionId: 's1' },
])(
  'COLLAB-SERVER-7.5 enforces pending revocation after canonical identity resolves: %j',
  async (target) => {
    const admission = createDeferred<RoomAdmission>();
    const onStateless = vi.fn();
    const { server } = serve(
      {
        auth: {
          admit: ({ room }) =>
            room === 'alias'
              ? admission.promise
              : Promise.resolve({ ok: true, actor: { id: 'bob' }, access: 'read-write' }),
        },
      },
      { onStateless },
    );
    const pending = connect(server, 'alias');
    pending.connection.receive(encodeStatelessMessage('must not replay'));
    const unrelated = connect(server, 'other');
    await settle();
    server.revoke(target);
    expect(pending.close).not.toHaveBeenCalled();
    admission.resolve({ ...admitted, room: 'notes' });
    await settle();
    expect(pending.close).toHaveBeenCalledWith(CLOSE_CODES.forbidden, 'revoked');
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(onStateless).not.toHaveBeenCalled();
    const fresh = connect(server, 'alias');
    await settle();
    expect(fresh.close).not.toHaveBeenCalled();
    expect(server.roomCount()).toBe(2);
  },
);

it('COLLAB-SERVER-7.5 preserves target intersection and canonical room semantics for pending admission', async () => {
  const admission = createDeferred<RoomAdmission>();
  const { server } = serve({ auth: { admit: () => admission.promise } });
  const pending = connect(server, 'alias');
  const target = { actorId: 'alice', sessionId: 'wrong' };
  server.revoke(target);
  target.sessionId = 's1';
  server.revoke({ room: 'alias' });
  admission.resolve({ ...admitted, room: 'notes' });
  await settle();
  expect(pending.close).not.toHaveBeenCalled();
  expect(server.roomCount()).toBe(1);
});

it('COLLAB-SERVER-7.5 requires fresh admission when a pending identity later matches reauthorization', async () => {
  const admission = createDeferred<RoomAdmission>();
  const onStateless = vi.fn();
  const { server } = serve({ auth: { admit: () => admission.promise } }, { onStateless });
  const pending = connect(server, 'alias');
  pending.connection.receive(encodeStatelessMessage('must not replay'));
  await server.reauthorize({ room: 'notes', actorId: 'alice', sessionId: 's1' });
  admission.resolve({ ...admitted, room: 'notes' });
  await settle();
  expect(pending.close).toHaveBeenCalledWith(CLOSE_CODES.unavailable, 'reauthorization-required');
  expect(server.roomCount()).toBe(0);
  expect(onStateless).not.toHaveBeenCalled();
  const fresh = connect(server, 'alias');
  await settle();
  expect(fresh.close).not.toHaveBeenCalled();
});

it('COLLAB-SERVER-7.5 closes matching loading connections instead of entering with stale admission', async () => {
  const loaded = createDeferred<Awaited<ReturnType<RoomHost['persistence']['load']>>>();
  const refresh = vi.fn(() => Promise.resolve(admitted));
  const persistence = createMemoryPersistence();
  const { server } = serve({
    auth: { admit: () => Promise.resolve(admitted), refresh },
    persistence: { ...persistence, load: () => loaded.promise },
  });
  const pending = connect(server);
  await settle();
  await server.reauthorize({ actorId: 'other' });
  expect(pending.close).not.toHaveBeenCalled();
  await server.reauthorize({ actorId: 'alice' });
  expect(pending.close).toHaveBeenCalledWith(CLOSE_CODES.unavailable, 'reauthorization-required');
  expect(refresh).not.toHaveBeenCalled();
  loaded.resolve({ status: 'missing' });
  await settle();
  expect(server.roomCount()).toBe(0);
  expect(pending.frames).toEqual([]);
});
