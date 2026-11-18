import {
  type ContentIds,
  createContentIdsFromUpdate,
  type Doc,
  encodeStateAsUpdate,
  excludeContentIds,
  intersectContentIds,
  intersectUpdateWithContentIds,
  mergeContentIds,
} from '@y/y';
import type { RoomClock } from '../protocol/clock.js';

/** Local updates made within this many milliseconds of the first unsent one are one change. */
const MERGE_WINDOW_MS = 500;

/** One local change the room has not confirmed, with the document that holds it. */
export interface UnconfirmedChange {
  ids: ContentIds;
  doc: Doc;
}

interface Pending extends UnconfirmedChange {
  createdAt: number;
  /** The change's own update, for one no document holds as it is sent: a refused change's fill. */
  update?: Uint8Array | undefined;
  /** Whether the change is one of its own: sent as it was made, or restored; never merged. */
  alone: boolean;
}

/** The local changes a client made that the server has not echoed back yet (COLLAB-CLIENT-3.1). */
export interface UnconfirmedUpdates {
  /**
   * Tracks a local update of `doc` made now. An update `alone` is a change of its own; other
   * updates within {@link MERGE_WINDOW_MS} of the first are one change (COLLAB-CLIENT-3.4).
   */
  record(update: Uint8Array, doc: Doc, alone: boolean): void;
  /**
   * Tracks `update`, the fill of a refused change of `doc` (COLLAB-CLIENT-3.5), as a change sent
   * before every other change of `doc`.
   */
  recordFill(update: Uint8Array, doc: Doc): void;
  /** Drops what an update received from the server contains. */
  confirm(update: Uint8Array): void;
  /**
   * Stops tracking the content of `ids` and returns what of it was tracked, with the document
   * holding it, or `null` when none was. A fill is dropped and never returned.
   */
  take(ids: ContentIds): UnconfirmedChange | null;
  isEmpty(): boolean;
  /** The content of every change still unconfirmed, or `null` when none is. */
  ids(): ContentIds | null;
  /**
   * One update for each change still unconfirmed, of `doc` alone when given, oldest first, each
   * holding only that change's content. A reconnect handshake misses content the server already
   * holds but never echoed; resending it is idempotent. Encoding reads each document once.
   */
  encodeEach(doc?: Doc): Uint8Array[];
}

function isEmptyIds(ids: ContentIds): boolean {
  return ids.inserts.isEmpty() && ids.deletes.isEmpty();
}

/** Creates an empty {@link UnconfirmedUpdates} that dates its changes by `clock`. */
export function createUnconfirmedUpdates(clock: RoomClock): UnconfirmedUpdates {
  let pending: Pending[] = [];

  const record = (update: Uint8Array, doc: Doc, alone: boolean) => {
    const now = clock.now();
    const ids = createContentIdsFromUpdate(update);
    const last = pending.at(-1);
    const merges = last && !alone && !last.alone && last.doc === doc;
    if (merges && now - last.createdAt < MERGE_WINDOW_MS) {
      last.ids = mergeContentIds([last.ids, ids]);
    } else {
      pending.push({ ids, doc, createdAt: now, alone });
    }
  };

  const drop = (ids: ContentIds) => {
    pending = pending.filter((entry) => {
      entry.ids = excludeContentIds(entry.ids, ids);
      return !isEmptyIds(entry.ids);
    });
  };

  const confirm = (update: Uint8Array) => {
    if (pending.length > 0) drop(createContentIdsFromUpdate(update));
  };

  const recordFill = (update: Uint8Array, doc: Doc) => {
    const ids = createContentIdsFromUpdate(update);
    const fill = { ids, doc, createdAt: clock.now(), alone: true, update };
    const first = pending.findIndex((entry) => entry.doc === doc);
    pending.splice(first < 0 ? pending.length : first, 0, fill);
  };

  // An update comes from one document, so what it holds of the changes is in that document's.
  const take = (ids: ContentIds) => {
    for (const entry of pending) {
      const taken = intersectContentIds(entry.ids, ids);
      if (isEmptyIds(taken)) continue;
      const doc = entry.doc;
      if (entry.update) {
        drop(taken);
        return null;
      }
      const held = pending
        .filter((other) => other.doc === doc && !other.update)
        .map((other) => other.ids);
      const all = intersectContentIds(mergeContentIds(held), ids);
      drop(all);
      return { ids: all, doc };
    }
    return null;
  };

  const encodeEach = (only?: Doc) => {
    const states = new Map<Doc, Uint8Array>();
    const chosen = only ? pending.filter((entry) => entry.doc === only) : pending;
    return chosen.map(({ ids, doc, update }) => {
      if (update) return update;
      let state = states.get(doc);
      if (!state) {
        state = encodeStateAsUpdate(doc);
        states.set(doc, state);
      }
      return intersectUpdateWithContentIds(state, ids);
    });
  };

  const ids = () =>
    pending.length === 0 ? null : mergeContentIds(pending.map((entry) => entry.ids));

  return {
    record,
    recordFill,
    confirm,
    take,
    isEmpty: () => pending.length === 0,
    ids,
    encodeEach,
  };
}
