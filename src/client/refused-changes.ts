import {
  applyUpdate,
  createContentIds,
  Doc,
  encodeStateAsUpdate,
  intersectUpdateWithContentIds,
  undoContentIds,
} from '@y/y';
import type { UnconfirmedChange } from './unconfirmed-updates.js';

/**
 * The fill of a change the room refused (COLLAB-CLIENT-3.5): the change's own insertions as
 * deleted content, without what it deleted, or `null` for a change that inserted nothing. A
 * writer's later updates take their places after the refused change's, so the room needs those
 * places to take them; the fill gives them with nothing to show, and nothing of what was refused.
 * Content built inside the refused insertions arrives deleted with them.
 */
export function encodeFill(change: UnconfirmedChange): Uint8Array | null {
  const { inserts } = change.ids;
  if (inserts.isEmpty()) return null;
  const undone = new Doc({ gc: false });
  const collected = new Doc();
  try {
    applyUpdate(undone, encodeStateAsUpdate(change.doc));
    undoContentIds(undone, createContentIds(inserts));
    // The undo keeps what it deletes; a fresh copy collects it, so the fill holds no refused text.
    applyUpdate(collected, encodeStateAsUpdate(undone));
    return intersectUpdateWithContentIds(
      encodeStateAsUpdate(collected),
      createContentIds(inserts, inserts),
    );
  } finally {
    undone.destroy();
    collected.destroy();
  }
}
