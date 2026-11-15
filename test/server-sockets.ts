import { applyUpdate, Doc } from '@y/y';
import type { RoomHandle } from '../src/server/room-handle.js';
export { connectToServer, type PairedSocket, type ServerSockets } from '../src/testing/index.js';

/** Waits until queued socket messages and pending promises have settled. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Opens a detached snapshot for assertions. */
export function readHandle(handle: RoomHandle): Doc {
  const doc = new Doc();
  applyUpdate(doc, handle.snapshot());
  return doc;
}
