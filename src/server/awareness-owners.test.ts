import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import {
  type AwarenessEntry,
  createAwarenessOwners,
  decodeAwarenessEntries,
  encodeAwarenessEntries,
} from './awareness-owners.js';

const entry = (clientId: number, clock: number, state: unknown): AwarenessEntry => ({
  clientId,
  clock,
  state: JSON.stringify(state),
});

describe('createAwarenessOwners', () => {
  it('COLLAB-SERVER-3.3 gives a client id to the first connection that publishes a newer state', () => {
    const owners = createAwarenessOwners<string>();
    const clocks = new Map([[7, 3]]);
    const clockOf = (id: number) => clocks.get(id) ?? 0;

    const stale = owners.claim('a', [entry(7, 3, { name: 'old echo' })], clockOf);
    const removal = owners.claim('a', [entry(8, 1, null)], clockOf);
    const notAnObject = owners.claim('a', [entry(9, 1, 'text')], clockOf);
    const claimed = owners.claim('a', [entry(7, 4, { name: 'Ada' })], clockOf);
    const taken = owners.claim('b', [entry(7, 9, { name: 'Mallory' }), entry(10, 1, {})], clockOf);

    expect(stale).toEqual([]);
    expect(removal).toEqual([]);
    expect(notAnObject).toEqual([]);
    expect(claimed.map((item) => item.clientId)).toEqual([7]);
    expect(taken.map((item) => item.clientId)).toEqual([10]);
  });

  it('COLLAB-SERVER-3.3 lets an owner remove its own state and releases its ids on leave', () => {
    const owners = createAwarenessOwners<string>();
    owners.claim('a', [entry(1, 1, {}), entry(2, 1, {})], () => 0);

    const removal = owners.claim('a', [entry(1, 2, null)], () => 1);
    const released = owners.release('a');
    const reclaimed = owners.claim('b', [entry(2, 2, {})], () => 1);

    expect(removal.map((item) => item.clientId)).toEqual([1]);
    expect(released).toEqual([1, 2]);
    expect(reclaimed.map((item) => item.clientId)).toEqual([2]);
  });

  it('COLLAB-SERVER-3.3 round-trips encoded awareness entries', () => {
    const entries = [entry(1, 2, { a: 1 }), entry(3, 4, null)];

    expect(decodeAwarenessEntries(encodeAwarenessEntries(entries))).toEqual(entries);
  });
});

it('COLLAB-SERVER-2.4 rejects an impossible awareness count before allocating its entries', () => {
  const update = encoding.encode((encoder) => encoding.writeVarUint(encoder, 2 ** 32));
  expect(() => decodeAwarenessEntries(update)).toThrow('awareness');
});

it('COLLAB-SERVER-3.5 rejects malformed, trailing and oversized awareness states', () => {
  for (const state of [
    '[]',
    '1',
    'true',
    '"text"',
    '{',
    JSON.stringify({ text: 'x'.repeat(17 * 1024) }),
  ]) {
    expect(() =>
      decodeAwarenessEntries(encodeAwarenessEntries([{ clientId: 1, clock: 1, state }])),
    ).toThrow();
  }
  const update = encodeAwarenessEntries([entry(1, 1, {})]);
  expect(() => decodeAwarenessEntries(new Uint8Array([...update, 0]))).toThrow('Trailing');
  expect(() => decodeAwarenessEntries(new Uint8Array(65 * 1024))).toThrow('limit');
});

it('COLLAB-SERVER-3.5 bounds owned client ids and releases the budget after disconnect', () => {
  const owners = createAwarenessOwners<string>();
  for (let clientId = 0; clientId < 16; clientId += 1)
    owners.claim('a', [entry(clientId, 1, {})], () => 0);
  expect(() => owners.claim('a', [entry(17, 1, {})], () => 0)).toThrow('budget');
  expect(owners.release('a')).toHaveLength(16);
  expect(owners.claim('a', [entry(17, 1, {})], () => 0)).toHaveLength(1);
});

it('COLLAB-SERVER-3.5 bounds the room-wide active awareness client budget', () => {
  const owners = createAwarenessOwners<number>();
  for (let owner = 0; owner < 64; owner += 1) {
    owners.claim(
      owner,
      Array.from({ length: 16 }, (_, index) => entry(owner * 16 + index, 1, {})),
      () => 0,
    );
  }
  expect(() => owners.claim(65, [entry(1024, 1, {})], () => 0)).toThrow('budget');
  owners.release(0);
  expect(owners.claim(65, [entry(1024, 1, {})], () => 0)).toHaveLength(1);
});
