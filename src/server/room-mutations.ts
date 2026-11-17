import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from '@y/y';
import type { RoomActor } from './host/adapters.js';
import type { LiveRoom } from './live-room.js';
import { analyzeUpdate } from './update-changes.js';
import { checkWrite } from './write-rules.js';

/** Authenticated attribution for a server mutation and its transaction origin. */
export interface RoomMutationActor {
  actor: RoomActor;
  capabilities: readonly string[];
}

/** The authenticated origin of an accepted live room transaction. */
export interface RoomTransactionOrigin {
  actor: RoomActor;
  capabilities: ReadonlySet<string>;
  source: 'client' | 'server';
}

/** Applies an attributed server mutation only when its complete candidate passes room rules. */
export function mutateRoom(
  room: LiveRoom,
  attribution: RoomMutationActor,
  mutate: (doc: Doc) => void,
): boolean {
  if (!room.accepting) throw new Error('The room is fenced or busy.');
  const candidate = new Doc();
  try {
    applyUpdate(candidate, encodeStateAsUpdate(room.doc));
    const before = encodeStateVector(candidate);
    candidate.transact(() => mutate(candidate), attribution);
    const update = encodeStateAsUpdate(candidate, before);
    const analysis = analyzeUpdate(room.doc, update);
    if (analysis.complete && analysis.changes.size === 0) return true;
    const decision = checkWrite(
      { ...room.rules, serverOnly: [] },
      {
        room: room.name,
        doc: room.doc,
        update,
        guard: room.guard,
        actor: attribution.actor,
        capabilities: new Set(attribution.capabilities),
      },
    );
    if (decision.verdict !== 'allowed') return false;
    const origin: RoomTransactionOrigin = {
      actor: attribution.actor,
      capabilities: new Set(attribution.capabilities),
      source: 'server',
    };
    // The room takes the update the guard admitted before anything else runs, as a member's
    // update is taken, so the guard's shadow never holds a change the room lacks.
    applyUpdate(room.doc, update, origin);
    room.edited(attribution.actor);
    return true;
  } finally {
    candidate.destroy();
  }
}
