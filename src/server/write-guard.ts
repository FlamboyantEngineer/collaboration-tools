import { applyUpdate, Doc, encodeStateAsUpdate, type Transaction } from '@y/y';
import type { RoomWriteChange, RoomWriteGuard } from './host/adapters.js';

/** A room's guard on its shadow document, which follows every change the room takes. */
export interface ShadowGuard {
  /**
   * Applies `update` to the shadow and asks the guard. A refusal, or a guard that throws, leaves
   * the shadow stale: the next check rebuilds it from the room.
   */
  check(change: RoomWriteChange, update: Uint8Array): boolean;
  /** Stops following the room and closes the guard. */
  destroy(): void;
}

function copyOf(doc: Doc): Doc {
  const copy = new Doc();
  applyUpdate(copy, encodeStateAsUpdate(doc));
  return copy;
}

function applyCapturing(doc: Doc, update: Uint8Array): Transaction | null {
  let transaction: Transaction | null = null;
  const capture = (applied: Transaction) => (transaction = applied);
  doc.on('afterTransaction', capture);
  try {
    applyUpdate(doc, update);
  } finally {
    doc.off('afterTransaction', capture);
  }
  return transaction;
}

/**
 * Opens a room's guard on a shadow copy of `room` (COLLAB-SERVER-7.2). Each check costs the
 * update's own size; only a refusal costs a copy of the room, made at the next check. A guard that
 * throws when opened throws here, when the room loads.
 */
export function openShadowGuard(room: Doc, open: (shadow: Doc) => RoomWriteGuard): ShadowGuard {
  let opened: { shadow: Doc; guard: RoomWriteGuard } | null = null;

  function reopen() {
    const shadow = copyOf(room);
    try {
      opened = { shadow, guard: open(shadow) };
    } catch (error) {
      shadow.destroy();
      throw error;
    }
    return opened;
  }

  function close() {
    const closing = opened;
    opened = null;
    try {
      closing?.guard.destroy?.();
    } finally {
      closing?.shadow.destroy();
    }
  }

  function decide(change: RoomWriteChange, update: Uint8Array): boolean {
    const { shadow, guard } = opened ?? reopen();
    const transaction = applyCapturing(shadow, update);
    return transaction !== null && guard.check({ ...change, transaction });
  }

  // Every change the room takes reaches the shadow; one the shadow holds already changes nothing.
  const follow = (update: Uint8Array) => {
    if (opened) applyUpdate(opened.shadow, update);
  };
  reopen();
  room.on('update', follow);
  return {
    check(change, update) {
      try {
        if (decide(change, update)) return true;
      } catch {
        // A guard that throws refuses, as a `check` that throws does.
      }
      close();
      return false;
    },
    destroy() {
      room.off('update', follow);
      close();
    },
  };
}
