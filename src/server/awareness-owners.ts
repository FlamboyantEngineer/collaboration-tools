import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** One client's entry in an encoded awareness update. */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  /** The state as JSON; `null` removes the client. */
  state: string;
}

/** Reads every entry of an encoded awareness update. */
export function decodeAwarenessEntries(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  // Each entry needs at least one byte each for its id, clock and string length.
  if (count > Math.floor((update.length - decoder.pos) / 3))
    throw new Error('Invalid awareness entry count.');
  return Array.from({ length: count }, () => ({
    clientId: decoding.readVarUint(decoder),
    clock: decoding.readVarUint(decoder),
    state: decoding.readVarString(decoder),
  }));
}

/** Encodes entries as an awareness update. */
export function encodeAwarenessEntries(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.state);
  }
  return encoding.toUint8Array(encoder);
}

function isObjectState(state: string): boolean {
  try {
    const value: unknown = JSON.parse(state);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** Which connection owns each awareness client id in a room. */
export interface AwarenessOwners<Owner> {
  /**
   * The entries `owner` may write: its own clients, and new clients it claims with an object
   * state and a clock past the room's. Entries for another owner's clients are dropped.
   */
  claim(
    owner: Owner,
    entries: readonly AwarenessEntry[],
    clockOf: (id: number) => number,
  ): AwarenessEntry[];
  /** Forgets `owner` and returns the client ids it owned. */
  release(owner: Owner): number[];
}

export function createAwarenessOwners<Owner>(): AwarenessOwners<Owner> {
  const owners = new Map<number, Owner>();

  const mayWrite = (owner: Owner, entry: AwarenessEntry, clockOf: (id: number) => number) => {
    const current = owners.get(entry.clientId);
    if (current !== undefined) return current === owner;
    if (entry.clock <= clockOf(entry.clientId) || !isObjectState(entry.state)) return false;
    owners.set(entry.clientId, owner);
    return true;
  };

  const release = (owner: Owner) => {
    const released = [...owners].filter(([, current]) => current === owner).map(([id]) => id);
    for (const id of released) owners.delete(id);
    return released;
  };

  return {
    claim: (owner, entries, clockOf) => entries.filter((entry) => mayWrite(owner, entry, clockOf)),
    release,
  };
}
