import {
  type ContentIds,
  createContentIdsFromUpdate,
  type Doc,
  encodeStateAsUpdate,
  excludeContentIds,
  intersectUpdateWithContentIds,
  mergeContentIds,
} from '@y/y';

/** Local updates sent within this many milliseconds of each other are tracked as one. */
const MERGE_WINDOW_MS = 500;

interface Pending {
  ids: ContentIds;
  createdAt: number;
}

/** The local changes a client sent that the server has not echoed back yet. */
export interface UnconfirmedUpdates {
  /** Tracks a local update sent at `now`. */
  record(update: Uint8Array, now: number): void;
  /** Drops what an update received from the server contains. */
  confirm(update: Uint8Array): void;
  isEmpty(): boolean;
  /**
   * An update holding only the unconfirmed content of `doc`, or `null` when nothing is pending.
   * A reconnect handshake misses content the server already holds but never echoed; resending it
   * is idempotent. Encoding reads the whole document.
   */
  encodeMissing(doc: Doc): Uint8Array | null;
}

function isEmptyIds(ids: ContentIds): boolean {
  return ids.inserts.isEmpty() && ids.deletes.isEmpty();
}

/** Creates an empty {@link UnconfirmedUpdates}. */
export function createUnconfirmedUpdates(): UnconfirmedUpdates {
  let pending: Pending[] = [];

  const record = (update: Uint8Array, now: number) => {
    const ids = createContentIdsFromUpdate(update);
    const last = pending.at(-1);
    if (last && now - last.createdAt < MERGE_WINDOW_MS) {
      last.ids = mergeContentIds([last.ids, ids]);
    } else {
      pending.push({ ids, createdAt: now });
    }
  };

  const confirm = (update: Uint8Array) => {
    if (pending.length === 0) return;
    const received = createContentIdsFromUpdate(update);
    pending = pending.filter((entry) => {
      entry.ids = excludeContentIds(entry.ids, received);
      return !isEmptyIds(entry.ids);
    });
  };

  const encodeMissing = (doc: Doc) => {
    if (pending.length === 0) return null;
    const ids = mergeContentIds(pending.map((entry) => entry.ids));
    return intersectUpdateWithContentIds(encodeStateAsUpdate(doc), ids);
  };

  return { record, confirm, isEmpty: () => pending.length === 0, encodeMissing };
}
