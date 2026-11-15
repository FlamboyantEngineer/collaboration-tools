import { encodeStateAsUpdate } from '@y/y';
import type { RoomClock, RoomTimer } from '../protocol/clock.js';
import { readRoomGeneration } from '../protocol/room-meta.js';
import type { StoredRoomVersion } from './host/adapters.js';
import type { LiveRoom } from './live-room.js';

/** Bounds a durability wait without cancelling storage or losing pending changes. */
export interface RoomFlushOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** A durable version covering every change preceding this barrier. */
export interface RoomFlushReceipt {
  room: string;
  generation: string | null;
  version: StoredRoomVersion | null;
}

/** A failed barrier includes a recoverable snapshot for each unsaved room. */
export interface RoomRecoveryState {
  room: string;
  update: Uint8Array;
}

/** Resolves only after all changes preceding the call are stored. */
export async function flushRooms(
  rooms: readonly LiveRoom[],
  clock: RoomClock,
  options: RoomFlushOptions = {},
): Promise<RoomFlushReceipt[]> {
  const cancellation = new AbortController();
  let timer: RoomTimer | null = null;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('The durability wait was aborted.'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = clock.setTimeout(
        () => reject(new Error('The durability wait timed out.')),
        options.timeoutMs,
      );
    }
  });
  try {
    const stored = Promise.all(
      rooms.map(async (room) => {
        if (options.timeoutMs !== undefined || options.signal)
          return room.store.drain(cancellation.signal);
        await room.store.flush();
        return !room.store.isDirty();
      }),
    );
    if ((await Promise.race([stored, cancelled])).some((value) => !value)) {
      throw new Error('Some room changes could not be stored.');
    }
    return rooms.map((room) => ({
      room: room.name,
      generation: readRoomGeneration(room.doc),
      version: room.version(),
    }));
  } finally {
    cancellation.abort();
    if (timer !== null) clock.clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}

/** Captures dirty rooms without discarding their retry state. */
export function recoverRooms(rooms: readonly LiveRoom[]): RoomRecoveryState[] {
  return rooms
    .filter((room) => room.store.isDirty())
    .map((room) => ({
      room: room.name,
      update: encodeStateAsUpdate(room.doc),
    }));
}

/** Bounds shutdown without abandoning the underlying durable cleanup. */
export async function waitForOperation<T>(
  operation: Promise<T>,
  clock: RoomClock,
  options: RoomFlushOptions = {},
): Promise<T> {
  if (!options.signal && options.timeoutMs === undefined) return operation;
  let timer: RoomTimer | null = null;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('The durability wait was aborted.'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    if (options.timeoutMs !== undefined)
      timer = clock.setTimeout(
        () => reject(new Error('The durability wait timed out.')),
        options.timeoutMs,
      );
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (timer !== null) clock.clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}
