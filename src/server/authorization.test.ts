import { Doc, encodeStateAsUpdate, encodeStateVector } from '@y/y';
import * as decoding from 'lib0/decoding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, type ManualClock } from '../../test/manual-clock.js';
import { connectToServer, settle } from '../../test/server-sockets.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import { encodeSyncUpdate } from '../protocol/frames.js';
import { CLOSE_CODES, MESSAGE_TYPES } from '../protocol/messages.js';
import type { RoomAdmission, RoomAuth, RoomWriteRules } from './host/adapters.js';
import { createMemoryPersistence } from './host/memory-persistence.js';
import { createRoomServer, type RoomServer } from './room-server.js';

const providers: RoomProvider[] = [];
const servers: RoomServer[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ADMISSIONS: Record<string, RoomAdmission> = {
  editor: { ok: true, actor: { id: 'e' }, access: 'read-write', capabilities: ['edit', 'comment'] },
  commenter: { ok: true, actor: { id: 'c' }, access: 'read-write', capabilities: ['comment'] },
};

function serve(rules: RoomWriteRules | null, auth?: Partial<RoomAuth>, clock?: ManualClock) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const server = createRoomServer({
    host: {
      auth: {
        admit: ({ token }) =>
          Promise.resolve(ADMISSIONS[token ?? ''] ?? { ok: false, reason: 'unauthenticated' }),
        ...auth,
      },
      persistence: createMemoryPersistence(),
      permissions: { rulesFor: () => rules },
      logger,
      clock: clock ?? createManualClock(),
    },
  });
  servers.push(server);
  const sockets = connectToServer(server);
  const open = (token: string, clientClock = createManualClock()) => {
    const provider = createRoomProvider({
      endpoint: 'wss://rooms.example.test/live',
      room: 'notes',
      doc: new Doc(),
      getToken: () => token,
      createSocket: sockets.createSocket,
      clock: clientClock,
    });
    providers.push(provider);
    return provider;
  };
  return { server, sockets, open, logger };
}

const RULES: RoomWriteRules = {
  required: { comments: 'comment' },
  serverOnly: ['meta'],
  otherwise: 'edit',
};

describe('room write rules', () => {
  it('COLLAB-SERVER-7.2 refuses a change to a type the connection lacks the capability for', async () => {
    const { server, sockets, open, logger } = serve(RULES);
    const commenter = open('commenter');
    await settle();

    commenter.doc.get('comments').setAttr('t1', 'a comment');
    await settle();
    const afterComment = commenter.getState();
    commenter.doc.get('body').insert(0, 'not allowed');
    await settle();
    const handle = await server.openRoom('notes');

    expect(afterComment).toMatchObject({ status: 'connected', hasUnconfirmedChanges: false });
    expect(commenter.getState()).toMatchObject({
      status: 'disconnected',
      refusal: 'unauthorized-write',
    });
    expect(sockets.sockets[0]?.serverClose?.code).toBe(CLOSE_CODES.forbidden);
    expect(handle.doc.get('comments').getAttr('t1')).toBe('a comment');
    expect(handle.doc.get('body').toString()).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(
      'A connection sent a change its access does not allow.',
      { room: 'notes', actor: 'c', types: ['body'] },
    );
    handle.release();
  });

  it('COLLAB-SERVER-7.2 keeps server-only types for the host’s handles', async () => {
    const { server, open } = serve(RULES);
    const editor = open('editor');
    await settle();
    const handle = await server.openRoom('notes');

    handle.doc.transact(() => handle.doc.get('meta').setAttr('generation', 'g1'), 'host');
    await settle();
    editor.doc.get('meta').setAttr('generation', 'forged');
    await settle();

    expect(handle.doc.get('meta').getAttr('generation')).toBe('g1');
    expect(editor.getState().refusal).toBe('unauthorized-write');
    handle.release();
  });

  it('COLLAB-SERVER-7.2 runs the finer check, which may simulate the change, and refuses when it throws', async () => {
    const seen: unknown[] = [];
    const rules: RoomWriteRules = {
      check: (change) => {
        seen.push(Object.fromEntries([...change.changes].map(([type, keys]) => [type, [...keys]])));
        const after = change.simulate((copy, apply) => {
          apply();
          return copy.get('comments').getAttr('t1');
        });
        if (after === 'boom') throw new Error('broken check');
        return after !== 'forbidden';
      },
    };
    const { open } = serve(rules);
    const allowed = open('editor');
    await settle();
    allowed.doc.get('comments').setAttr('t1', 'fine');
    await settle();
    const refused = open('editor');
    const broken = open('editor');
    await settle();

    refused.doc.get('comments').setAttr('t1', 'forbidden');
    broken.doc.get('comments').setAttr('t1', 'boom');
    await settle();

    expect(allowed.getState()).toMatchObject({ status: 'connected', hasUnconfirmedChanges: false });
    expect(refused.getState().refusal).toBe('unauthorized-write');
    expect(broken.getState().refusal).toBe('unauthorized-write');
    expect(seen[0]).toEqual({ comments: ['t1'] });
  });

  it('COLLAB-SERVER-7.3 drops an update that builds on missing content and asks for the rest', async () => {
    const { server } = serve({});
    const sent: Uint8Array[] = [];
    const connection = server.connect(
      { send: (frame) => sent.push(frame), close: () => undefined },
      { url: '/live/notes?token=editor', headers: {} },
    );
    await settle();
    const writer = new Doc();
    writer.get('body').insert(0, 'a');
    const vector = encodeStateVector(writer);
    writer.get('body').insert(1, 'b');
    const welcome = sent.length;

    connection.receive(encodeSyncUpdate(encodeStateAsUpdate(writer, vector)));
    await settle();
    const handle = await server.openRoom('notes');
    const reply = decoding.createDecoder(sent[welcome] ?? new Uint8Array());

    expect(handle.doc.get('body').toString()).toBe('');
    expect([decoding.readVarUint(reply), decoding.readVarUint(reply)]).toEqual([
      MESSAGE_TYPES.sync,
      0,
    ]);
    handle.release();
  });
});

describe('re-authorization', () => {
  it('COLLAB-SERVER-7.4 closes a connection whose decision expires, and the client rejoins', async () => {
    const clock = createManualClock(0);
    const clientClock = createManualClock();
    const { sockets, open } = serve(
      null,
      { admit: () => Promise.resolve({ ...ADMISSIONS.editor, expiresAt: 1_000 } as RoomAdmission) },
      clock,
    );
    const provider = open('editor', clientClock);
    await settle();

    clock.advance(1_000);
    await settle();
    const closed = sockets.sockets[0]?.serverClose;
    clientClock.advance(0);
    await settle();

    expect(closed).toEqual({ code: CLOSE_CODES.unauthenticated, reason: 'expired' });
    expect(provider.getState()).toMatchObject({ status: 'connected', refusal: null });
    expect(sockets.sockets).toHaveLength(2);
  });

  it('COLLAB-SERVER-7.4 refreshes before expiry, applying a new access or a refusal', async () => {
    const clock = createManualClock(0);
    const decisions: RoomAdmission[] = [
      { ok: true, actor: { id: 'e' }, access: 'read-only', expiresAt: 120_000 },
      { ok: false, reason: 'forbidden' },
    ];
    const refresh = vi.fn(() => Promise.resolve(decisions.shift() as RoomAdmission));
    const { open } = serve(
      null,
      {
        admit: () => Promise.resolve({ ...ADMISSIONS.editor, expiresAt: 60_000 } as RoomAdmission),
        refresh,
      },
      clock,
    );
    const provider = open('editor');
    await settle();

    clock.advance(30_000);
    await settle();
    const afterFirst = provider.getState().access;
    clock.advance(60_000);
    await settle();

    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ room: 'notes', token: 'editor', actor: { id: 'e' } }),
    );
    expect(afterFirst).toBe('read-only');
    expect(provider.getState()).toMatchObject({ status: 'disconnected', refusal: 'forbidden' });
  });

  it('COLLAB-SERVER-7.4 retries a refresh that throws until the decision expires', async () => {
    const clock = createManualClock(0);
    const refresh = vi.fn(() => Promise.reject(new Error('auth down')));
    const { sockets, open, logger } = serve(
      null,
      {
        admit: () => Promise.resolve({ ...ADMISSIONS.editor, expiresAt: 40_000 } as RoomAdmission),
        refresh,
      },
      clock,
    );
    open('editor');
    await settle();

    for (let step = 0; step < 8; step += 1) {
      clock.advance(5_000);
      await settle();
    }

    expect(refresh).toHaveBeenCalledTimes(6);
    expect(logger.warn).toHaveBeenCalledWith(
      'Refreshing a connection’s access failed; retrying.',
      expect.objectContaining({ room: 'notes' }),
    );
    expect(sockets.sockets[0]?.serverClose).toEqual({
      code: CLOSE_CODES.unauthenticated,
      reason: 'expired',
    });
  });
});
