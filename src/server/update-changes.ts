import {
  type AbstractStruct,
  decodeUpdate,
  type Doc,
  findIndexSS,
  findRootTypeKey,
  ID,
  Item,
  Skip,
  type Type,
} from '@y/y';

/**
 * What an update changes: each top-level type it touches, with the keys directly under that type
 * whose content it touches. A position in a list or text has no key and is recorded as `null`.
 */
export type UpdateChanges = ReadonlyMap<string, ReadonlySet<string | null>>;

/**
 * What applying an update to a document would do, read without applying it. An update is
 * incomplete when it builds on content the document does not have yet: Yjs would hold it back
 * and apply it later, unchecked, when another update fills the gap.
 */
export type UpdateAnalysis = { complete: true; changes: UpdateChanges } | { complete: false };

interface Placement {
  root: string;
  key: string | null;
}

/** A placement for content Yjs drops, such as an item whose neighbour was collected. */
const DROPPED = null;

/** The next clock the document expects from `client`. */
function nextClock(doc: Doc, client: number): number {
  const structs = doc.store.clients.get(client);
  const last = structs?.at(-1);
  return last ? last.id.clock + last.length : 0;
}

/** The struct of `structs` that holds `clock`, or `undefined`. */
function structAt<Struct extends AbstractStruct>(
  structs: readonly Struct[] | undefined,
  clock: number,
) {
  const last = structs?.at(-1);
  if (!structs || !last || clock >= last.id.clock + last.length) return undefined;
  if (clock < (structs[0]?.id.clock ?? 0)) return undefined;
  return structs[findIndexSS(structs as Struct[], clock)];
}

/** Places items; `missing` is set once something they build on is in neither the document nor the update. */
function createReader(doc: Doc, incoming: ReadonlyMap<number, Item[]>) {
  const placements = new Map<Item, Placement | typeof DROPPED>();
  const reader = { missing: false, find, place };

  function find(id: ID): AbstractStruct | undefined {
    const struct =
      structAt(doc.store.clients.get(id.client), id.clock) ??
      structAt(incoming.get(id.client), id.clock);
    if (!struct) reader.missing = true;
    return struct;
  }

  /** The top-level type and key an item of the document sits under. */
  const placeLive = (item: Item): Placement | typeof DROPPED => {
    let current = item;
    for (;;) {
      const parent = current.parent as Type | null;
      if (!parent) return DROPPED;
      const holder = parent._item;
      if (holder === null) return { root: findRootTypeKey(parent), key: current.parentSub };
      current = holder;
    }
  };

  const placeStruct = (struct: AbstractStruct | undefined): Placement | typeof DROPPED =>
    struct instanceof Item ? place(struct) : DROPPED;

  /** Where an item lands: by its parent, or beside its neighbour when it names no parent. */
  function place(item: Item): Placement | typeof DROPPED {
    const known = placements.get(item);
    if (known !== undefined) return known;
    const { parent } = item;
    let placement: Placement | typeof DROPPED;
    if (typeof parent === 'string') placement = { root: parent, key: item.parentSub };
    else if (parent instanceof ID) placement = placeStruct(find(parent));
    else if (parent === null) {
      const neighbour = item.origin ?? item.rightOrigin;
      placement = neighbour ? placeStruct(find(neighbour)) : DROPPED;
    } else placement = placeLive(item);
    placements.set(item, placement);
    return placement;
  }

  return reader;
}

/**
 * Groups an update's items by client, with the clock each client reaches, or returns `null` when a
 * client's items do not follow on from what the document holds.
 */
function readIncoming(doc: Doc, structs: readonly AbstractStruct[]) {
  const incoming = new Map<number, Item[]>();
  const next = new Map<number, number>();
  for (const struct of structs) {
    const { client, clock } = struct.id;
    const expected = next.get(client) ?? nextClock(doc, client);
    if (clock > expected) return null;
    if (struct instanceof Skip) continue;
    next.set(client, Math.max(expected, clock + struct.length));
    if (!(struct instanceof Item)) continue;
    const items = incoming.get(client) ?? [];
    items.push(struct);
    incoming.set(client, items);
  }
  return { incoming, next };
}

/** Reads, without applying it, which top-level types and keys `update` would change in `doc`. */
export function analyzeUpdate(doc: Doc, update: Uint8Array): UpdateAnalysis {
  const { structs, ds } = decodeUpdate(update);
  const read = readIncoming(doc, structs);
  if (!read) return { complete: false };
  const reader = createReader(doc, read.incoming);
  const changes = new Map<string, Set<string | null>>();
  const record = (placement: Placement | typeof DROPPED) => {
    if (!placement) return;
    const keys = changes.get(placement.root) ?? new Set();
    keys.add(placement.key);
    changes.set(placement.root, keys);
  };
  for (const [client, items] of read.incoming) {
    const held = nextClock(doc, client);
    // Content the document holds already changes nothing.
    for (const item of items) if (item.id.clock + item.length > held) record(reader.place(item));
  }
  let complete = true;
  ds.clients.forEach((ranges, client) => {
    const end = read.next.get(client) ?? nextClock(doc, client);
    for (const { clock, len } of ranges.getIds()) {
      if (clock + len > end) complete = false;
      for (let at = clock; complete && at < Math.min(clock + len, end);) {
        const struct = reader.find(new ID(client, at));
        if (!struct) break;
        if (struct instanceof Item && !struct.deleted) record(reader.place(struct));
        at = struct.id.clock + struct.length;
      }
    }
  });
  return complete && !reader.missing ? { complete: true, changes } : { complete: false };
}
