import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, type Transaction } from '@y/y';
import type { RoomClock, RoomTimer } from '../protocol/clock.js';
import type { RoomWriteChange, RoomWriteGuard } from './host/adapters.js';

/** A room's guard on its shadow document, which follows every change the room takes. */
export interface ShadowGuard {
  /**
   * Applies `update` to the shadow and asks the guard. A refusal, or a guard that throws, rebuilds
   * the shadow from the room before it returns.
   */
  check(change: RoomWriteChange, update: Uint8Array): boolean;
  /** Stops following the room and closes the guard. */
  destroy(): void;
}

/** Why a shadow was rebuilt: its counters or the guard's own reading had drifted from the room. */
export type ShadowDrift = 'counters' | 'reading';

/** How a guard checks itself against the room it follows (COLLAB-SERVER-7.6). */
export interface ShadowSelfCheck {
  clock: RoomClock;
  /** Verifies the guard's reading after this many room changes; `undefined` only on idle. */
  verifyEvery?: number | undefined;
  /** Verifies the guard's reading this long after the room's last change. */
  idleMs: number;
  /** Told after a drifted shadow was rebuilt from the room. */
  onRepair(reason: ShadowDrift): void;
}

function copyOf(doc: Doc): Doc {
  const copy = new Doc();
  applyUpdate(copy, encodeStateAsUpdate(doc));
  return copy;
}

function applyCapturing(doc: Doc, update: Uint8Array): Transaction {
  // Own the primary transaction: observers may queue additional cleanup transactions.
  return doc.transact(
    (transaction) => {
      applyUpdate(doc, update);
      return transaction;
    },
    null,
    false,
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Whether `guard` says its reading still matches its shadow; a throw counts as a mismatch. */
function verifies(guard: RoomWriteGuard): boolean {
  try {
    return guard.verify?.() ?? true;
  } catch {
    return false;
  }
}

/** Calls `verify` every `verifyEvery` changes and once the room has been idle for `idleMs`. */
function createVerifyCadence(selfCheck: ShadowSelfCheck, verify: () => void) {
  let changes = 0;
  let idle: RoomTimer | null = null;
  const cancel = () => {
    if (idle !== null) selfCheck.clock.clearTimeout(idle);
    idle = null;
  };
  return {
    changed() {
      if (selfCheck.verifyEvery !== undefined && ++changes >= selfCheck.verifyEvery) {
        changes = 0;
        verify();
      }
      cancel();
      idle = selfCheck.clock.setTimeout(() => {
        idle = null;
        verify();
      }, selfCheck.idleMs);
    },
    cancel,
  };
}

/**
 * Opens a room's guard on a shadow copy of `room` (COLLAB-SERVER-7.2). Each check costs the
 * update's own size; only a refusal or a repair costs a copy of the room. After every room change
 * the shadow's state vector is compared with the room's, and every `verifyEvery` changes and on
 * idle the guard verifies its own reading (COLLAB-SERVER-7.6); a mismatch rebuilds the shadow and
 * reports it. A guard that throws when opened throws here, when the room loads.
 */
export function openShadowGuard(
  room: Doc,
  open: (shadow: Doc) => RoomWriteGuard,
  selfCheck: ShadowSelfCheck,
): ShadowGuard {
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

  /** Rebuilds the shadow now; a guard that cannot reopen is retried at the next check. */
  function rebuild() {
    close();
    try {
      reopen();
    } catch {
      // `check` reopens, and refuses while reopening throws.
    }
  }

  function repair(reason: ShadowDrift) {
    rebuild();
    selfCheck.onRepair(reason);
  }

  function decide(change: RoomWriteChange, update: Uint8Array): boolean {
    const { shadow, guard } = opened ?? reopen();
    const transaction = applyCapturing(shadow, update);
    return guard.check({ ...change, transaction });
  }

  function verifyReading() {
    if (opened && !verifies(opened.guard)) repair('reading');
  }

  const follow = (update: Uint8Array) => {
    if (!opened) return;
    applyUpdate(opened.shadow, update);
    if (sameBytes(encodeStateVector(opened.shadow), encodeStateVector(room))) cadence.changed();
    else repair('counters');
  };
  const cadence = createVerifyCadence(selfCheck, verifyReading);
  reopen();
  room.on('update', follow);
  return {
    check(change, update) {
      try {
        if (decide(change, update)) return true;
      } catch {
        // A guard that throws refuses, as a `check` that throws does.
      }
      rebuild();
      return false;
    },
    destroy: () => {
      room.off('update', follow);
      cadence.cancel();
      close();
    },
  };
}
