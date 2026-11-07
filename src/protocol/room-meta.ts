import type { Doc } from '@y/y';

/**
 * The top-level type the library keeps its own room metadata in. Only the server writes it: a
 * member's change to it is refused whatever the room's write rules say.
 */
export const ROOM_META_TYPE = '__room';

/** The key under {@link ROOM_META_TYPE} that holds the room's generation. */
export const GENERATION_KEY = 'generation';

/**
 * The generation of the room `doc` was synced from, or `null` for a document that has not synced
 * with a room. A room starts a new generation each time it starts over from a seed, which
 * discards its history; a document from an older generation can no longer join it.
 */
export function readRoomGeneration(doc: Doc): string | null {
  const value: unknown = doc.get(ROOM_META_TYPE).getAttr(GENERATION_KEY);
  return typeof value === 'string' && value !== '' ? value : null;
}
