import { encodeStateAsUpdate } from '@y/y';
import { CLOSE_CODES } from '../protocol/messages.js';
import { readRoomGeneration } from '../protocol/room-meta.js';
import type { RoomRecoveryState } from './durable-barrier.js';
import type { StoredRoomVersion } from './host/adapters.js';
import type { LiveRoom, RoomLoad } from './live-room.js';

/** A consistent capture for a host's canonical commit. */
export interface RoomSnapshot {
  room: string;
  update: Uint8Array;
  generation: string | null;
  version: StoredRoomVersion | null;
}

/** A canonical commit's persistence identity and caller result. */
export interface RoomCommitResult<T> {
  value: T;
  version: StoredRoomVersion;
}

/** The registry operations a serialized canonical operation needs. */
interface RoomOperationRegistry {
  acquire(name: string): Promise<RoomLoad>;
  release(room: LiveRoom): void;
  forget(room: LiveRoom): void;
}

/** Serializes canonical commits and invalidations for each room. */
export function createRoomOperations(registry: RoomOperationRegistry) {
  const pending = new Map<string, Promise<unknown>>();
  const run = <T>(name: string, operation: (room: LiveRoom) => Promise<T>): Promise<T> => {
    const previous = pending.get(name) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const loaded = await registry.acquire(name);
        if (!loaded.ok) throw loaded.error;
        const { room } = loaded;
        try {
          return await operation(room);
        } finally {
          registry.release(room);
        }
      });
    pending.set(name, current);
    void current
      .finally(() => {
        if (pending.get(name) === current) pending.delete(name);
      })
      .catch(() => undefined);
    return current;
  };
  return {
    commit: <T>(name: string, commit: (snapshot: RoomSnapshot) => Promise<RoomCommitResult<T>>) =>
      run(name, async (room) => {
        try {
          await room.store.flush();
          if (room.store.isDirty()) throw new Error('The room has unsaved changes.');
          return await room.store.exclusive(async () => {
            const result = await commit({
              room: name,
              update: encodeStateAsUpdate(room.doc),
              generation: readRoomGeneration(room.doc),
              version: room.version(),
            });
            room.advance(result.version);
            return result.value;
          });
        } finally {
          if (!room.store.isEnded()) room.accepting = true;
        }
      }),
    idle: () =>
      Promise.all([...pending.values()].map((operation) => operation.catch(() => undefined))),
    invalidate: (name: string): Promise<RoomRecoveryState[]> =>
      run(name, (room) => {
        room.accepting = false;
        for (const member of [...room.members]) member.close(CLOSE_CODES.gone, 'invalidated');
        return room.store.exclusive(() => {
          const recovery = room.store.isDirty()
            ? [{ room: name, update: encodeStateAsUpdate(room.doc) }]
            : [];
          room.fence();
          registry.forget(room);
          return Promise.resolve(recovery);
        });
      }),
  };
}
