import type {
  RoomLoadResult,
  RoomPersistence,
  RoomStoreInput,
  RoomStoreResult,
  StoredRoomState,
} from './adapters.js';

export interface MemoryPersistenceOptions {
  /** Makes the revision of each stored state. Defaults to a random UUID. */
  createRevision?: (() => string) | undefined;
  /** States the persistence starts with, by room. */
  initial?: Readonly<Record<string, StoredRoomState>> | undefined;
}

/** {@link RoomPersistence} held in memory, for tests, labs and single-process hosts. */
export interface MemoryPersistence extends RoomPersistence {
  /** The room's current stored state, or `undefined`. */
  peek(room: string): StoredRoomState | undefined;
}

function copyState(state: StoredRoomState): StoredRoomState {
  return { update: state.update.slice(), revision: state.revision, sequence: state.sequence };
}

/** Creates an in-memory {@link RoomPersistence} with compare-and-set stores. */
export function createMemoryPersistence(options: MemoryPersistenceOptions = {}): MemoryPersistence {
  const createRevision = options.createRevision ?? (() => globalThis.crypto.randomUUID());
  const states = new Map<string, StoredRoomState>(
    Object.entries(options.initial ?? {}).map(([room, state]) => [room, copyState(state)]),
  );

  const load = (room: string): Promise<RoomLoadResult> => {
    const state = states.get(room);
    return Promise.resolve(
      state ? { status: 'found', state: copyState(state) } : { status: 'missing' },
    );
  };

  const store = (input: RoomStoreInput): Promise<RoomStoreResult> => {
    const current = states.get(input.room);
    if ((current?.revision ?? null) !== input.baseRevision) {
      const version = current ? { revision: current.revision, sequence: current.sequence } : null;
      return Promise.resolve({ status: 'conflict', current: version });
    }
    const next: StoredRoomState = {
      update: input.update.slice(),
      revision: createRevision(),
      sequence: (current?.sequence ?? 0) + 1,
    };
    states.set(input.room, next);
    return Promise.resolve({ status: 'stored', revision: next.revision, sequence: next.sequence });
  };

  const peek = (room: string) => {
    const state = states.get(room);
    return state ? copyState(state) : undefined;
  };

  return { load, store, peek };
}
