import { Doc } from '@y/y';
import { afterEach, describe, expect, it } from 'vitest';
import { settle } from '../../test/server-sockets.js';
import { createRoomProvider, type RoomProvider } from '../client/room-provider.js';
import { createMemoryPersistence } from '../server/host/memory-persistence.js';
import { createRoomServer, type RoomServer } from '../server/room-server.js';
import { connectToServer } from './in-process-sockets.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startServer(): RoomServer {
  const server = createRoomServer({
    host: {
      auth: {
        admit: ({ token }) =>
          Promise.resolve({ ok: true, actor: { id: token ?? 'guest' }, access: 'read-write' }),
      },
      persistence: createMemoryPersistence(),
    },
  });
  cleanups.push(() => server.close());
  return server;
}

function join(sockets: ReturnType<typeof connectToServer>, name: string): RoomProvider {
  const provider = createRoomProvider({
    endpoint: 'ws://in-process.test/live',
    room: 'notes',
    doc: new Doc(),
    getToken: () => name,
    createSocket: sockets.createSocket,
  });
  cleanups.push(() => provider.destroy());
  return provider;
}

describe('connectToServer', () => {
  it('COLLAB-TESTING-1.1 carries two providers through the room server in this process', async () => {
    const sockets = connectToServer(startServer());
    const ada = join(sockets, 'ada');
    const bo = join(sockets, 'bo');
    await settle();

    ada.doc.get('text').insert(0, 'hello');
    await settle();

    expect(bo.doc.get('text').toString()).toBe('hello');
    expect(ada.getState().synced).toBe(true);
    expect(sockets.sockets).toHaveLength(2);
    const [first] = sockets.sockets;
    expect(first?.sent.length).toBeGreaterThan(0);
    expect(first?.received.length).toBeGreaterThan(0);
  });

  it('COLLAB-TESTING-1.1 drops a socket as a network failure would, and the provider sees it', async () => {
    const sockets = connectToServer(startServer());
    const provider = join(sockets, 'ada');
    await settle();
    const [first] = sockets.sockets;
    const closes: number[] = [];
    const onclose = first?.onclose;
    if (first) {
      first.onclose = (event) => {
        closes.push(event.code);
        onclose?.(event);
      };
    }

    first?.drop();
    await settle();

    expect(first?.closed).toBe(true);
    expect(closes).toEqual([1006]);
    expect(() => first?.send(new Uint8Array([0]))).toThrow('send on a closed socket');
    expect(provider.getState().synced).toBe(false);
  });

  it('COLLAB-TESTING-1.1 records how the server closed a socket', async () => {
    const server = createRoomServer({
      host: {
        auth: { admit: () => Promise.resolve({ ok: false, reason: 'forbidden' }) },
        persistence: createMemoryPersistence(),
      },
    });
    cleanups.push(() => server.close());
    const sockets = connectToServer(server);
    join(sockets, 'ada');
    await settle();

    expect(sockets.sockets[0]?.serverClose?.code).toBe(4403);
  });
});
