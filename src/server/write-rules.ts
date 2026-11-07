import { applyUpdate, Doc, encodeStateAsUpdate } from '@y/y';
import { ROOM_META_TYPE } from '../protocol/room-meta.js';
import type { RoomActor, RoomWriteChange, RoomWriteRules } from './host/adapters.js';
import { analyzeUpdate } from './update-changes.js';

/** The connection and update a write check decides on. */
export interface WriteRequest {
  room: string;
  doc: Doc;
  actor: RoomActor;
  capabilities: ReadonlySet<string>;
  update: Uint8Array;
}

/**
 * Whether an update may be applied: `refused` lists the top-level types the connection may not
 * change, and `incomplete` means the update builds on content the room lacks.
 */
export type WriteDecision =
  { verdict: 'allowed' } | { verdict: 'refused'; types: string[] } | { verdict: 'incomplete' };

function mayChange(rules: RoomWriteRules, type: string, capabilities: ReadonlySet<string>) {
  // The library's own metadata is server-only in every room.
  if (type === ROOM_META_TYPE || rules.serverOnly?.includes(type)) return false;
  const required = rules.required;
  const needed = required && Object.hasOwn(required, type) ? required[type] : rules.otherwise;
  return needed === undefined || capabilities.has(needed);
}

function simulate<T>(doc: Doc, update: Uint8Array, inspect: (copy: Doc, apply: () => void) => T) {
  const copy = new Doc();
  try {
    applyUpdate(copy, encodeStateAsUpdate(doc));
    return inspect(copy, () => applyUpdate(copy, update));
  } finally {
    copy.destroy();
  }
}

function isAllowed(check: (change: RoomWriteChange) => boolean, change: RoomWriteChange) {
  try {
    return check(change);
  } catch {
    return false;
  }
}

/**
 * Checks an update against a room's rules before it is applied: first the capability each
 * changed top-level type needs, then the rules' finer `check`. A check that throws refuses.
 */
export function checkWrite(rules: RoomWriteRules, request: WriteRequest): WriteDecision {
  const { doc, update, capabilities } = request;
  const analysis = analyzeUpdate(doc, update);
  if (!analysis.complete) return { verdict: 'incomplete' };
  const types = [...analysis.changes.keys()];
  const refused = types.filter((type) => !mayChange(rules, type, capabilities));
  if (refused.length > 0) return { verdict: 'refused', types: refused };
  if (types.length === 0 || !rules.check) return { verdict: 'allowed' };
  const change: RoomWriteChange = {
    room: request.room,
    actor: request.actor,
    capabilities,
    changes: analysis.changes,
    simulate: (inspect) => simulate(doc, update, inspect),
  };
  return isAllowed(rules.check, change) ? { verdict: 'allowed' } : { verdict: 'refused', types };
}
