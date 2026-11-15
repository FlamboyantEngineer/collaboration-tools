import { type Doc, encodeStateAsUpdate } from '@y/y';
import type { RoomClock } from '../protocol/clock.js';
import { flushRooms, type RoomFlushOptions, type RoomFlushReceipt } from './durable-barrier.js';
import type { LiveRoom } from './live-room.js';
import { mutateRoom, type RoomMutationActor } from './room-mutations.js';

/** A host's hold on a loaded room, with validated attributed writes. */
export interface RoomHandle {
  readonly room: string;
  /** A detached full-state update. Mutations must use transact. */
  snapshot(): Uint8Array;
  /** Waits for this room alone and returns its durable version. */
  flush(options?: RoomFlushOptions): Promise<RoomFlushReceipt>;
  /** Applies a validated candidate; false means refused. */
  transact(actor: RoomMutationActor, mutate: (doc: Doc) => void): boolean;
  /** Lets the room unload once nothing else holds it. Releasing twice does nothing. */
  release(): void;
}

/** Keeps a handle's lifecycle independent from its detached mutation candidates. */
export function createRoomHandle(options: {
  room: LiveRoom;
  release(): void;
  isClosed(): boolean;
  clock: RoomClock;
}): RoomHandle {
  const { room, release, isClosed, clock } = options;
  let released = false;
  return {
    room: room.name,
    snapshot: () => encodeStateAsUpdate(room.doc),
    flush: async (options) => {
      const [receipt] = await flushRooms([room], clock, options);
      if (!receipt) throw new Error('The room has no durability receipt.');
      return receipt;
    },
    transact: (actor, mutate) => {
      if (released || isClosed()) throw new Error('The room handle is closed.');
      return mutateRoom(room, actor, mutate);
    },
    release: () => {
      if (released) return;
      released = true;
      release();
    },
  };
}
