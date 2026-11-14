import { applyUpdate, Doc, encodeStateAsUpdate } from '@y/y';
import { GENERATION_KEY, readRoomGeneration, ROOM_META_TYPE } from '../protocol/room-meta.js';
import type {
  RoomActor,
  RoomEvent,
  RoomGenerationReason,
  RoomLoadResult,
  RoomMetricEvent,
  RoomStoreResult,
} from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import type { StoreOutcome } from './store-scheduler.js';

/** A room's document as storage gave it, and the revision its next store builds on. */
export interface OpenedDoc {
  doc: Doc;
  baseRevision: string | null;
  /** Why the document started a new generation, or `null` when it kept its own. */
  newGeneration: RoomGenerationReason | null;
}

export type DocLoad = { ok: true; opened: OpenedDoc } | { ok: false; error: Error };

/** What storing a room reads and changes. */
export interface RoomStoreContext {
  name: string;
  doc: Doc;
  host: ResolvedRoomHost;
  baseRevision: string | null;
  conflicted: boolean;
  /** The actors whose changes no stored state holds yet, by id, in the order they changed it. */
  editors: Map<string, RoomActor>;
  onConflict(): void;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Passes `event` to the host's metrics. */
export function recordMetric(host: ResolvedRoomHost, event: RoomMetricEvent): void {
  try {
    host.metrics.record(event);
  } catch {
    // Metrics never change what a room does.
  }
}

/** Passes `event` to the host's events; the room never waits for or fails on a listener. */
export function emitEvent(host: ResolvedRoomHost, event: RoomEvent): void {
  const failed = (error: unknown) =>
    host.logger.warn('A room event listener failed.', {
      room: event.room,
      type: event.type,
      error,
    });
  try {
    const result = host.events.emit(event);
    if (result instanceof Promise) result.catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** Gives `doc` a new generation, replacing the one it has. */
function startGeneration(doc: Doc) {
  doc.get(ROOM_META_TYPE).setAttr(GENERATION_KEY, globalThis.crypto.randomUUID());
}

type StoredRead =
  Exclude<RoomLoadResult, { status: 'found' }> | { status: 'found'; revision: string; doc: Doc };

/** Stored documents and seeds must stand alone, with nothing deferred until a later write. */
function applyCompleteUpdate(doc: Doc, update: Uint8Array) {
  applyUpdate(doc, update);
  if (doc.store.pendingStructs || doc.store.pendingDs)
    throw new Error('The room update has missing dependencies.');
}

/** Loads a room's state; a found state that cannot be applied reads as corrupt. */
async function readStored(name: string, host: ResolvedRoomHost): Promise<StoredRead> {
  let loaded: RoomLoadResult;
  try {
    loaded = await host.persistence.load(name);
  } catch (error) {
    return { status: 'unavailable', error: toError(error) };
  }
  if (loaded.status !== 'found') return loaded;
  const { update, revision, sequence } = loaded.state;
  const doc = new Doc();
  try {
    applyCompleteUpdate(doc, update);
    return { status: 'found', revision, doc };
  } catch (error) {
    doc.destroy();
    return { status: 'corrupt', reason: toError(error).message, version: { revision, sequence } };
  }
}

/** A document built from the host's seed for `name`, with a new generation. */
async function seedDoc(name: string, host: ResolvedRoomHost): Promise<Doc> {
  const seed = await host.seeds.seed(name);
  const doc = new Doc();
  try {
    if (seed) applyCompleteUpdate(doc, seed);
  } catch (error) {
    doc.destroy();
    throw error;
  }
  startGeneration(doc);
  return doc;
}

/**
 * Loads a room's document. A found state keeps its generation, or starts one when it has none. A
 * missing, corrupt or stale room starts from the host's seed with a new generation, and a
 * corrupt or stale one stores over the state it replaces. Unavailable storage, or a seed that
 * fails, fails the load.
 */
export async function openStoredDoc(name: string, host: ResolvedRoomHost): Promise<DocLoad> {
  const started = host.clock.now();
  const loaded = await readStored(name, host);
  const durationMs = host.clock.now() - started;
  recordMetric(host, { type: 'load', room: name, outcome: loaded.status, durationMs });
  if (loaded.status === 'unavailable') return { ok: false, error: loaded.error };
  if (loaded.status === 'found') {
    const { doc, revision } = loaded;
    const marked = readRoomGeneration(doc) !== null;
    if (!marked) startGeneration(doc);
    return {
      ok: true,
      opened: { doc, baseRevision: revision, newGeneration: marked ? null : 'unmarked' },
    };
  }
  if (loaded.status === 'corrupt') {
    host.logger.warn('The stored room cannot be read; it starts from its seed.', {
      room: name,
      reason: loaded.reason,
    });
  }
  try {
    const seeded = await seedDoc(name, host);
    const baseRevision = loaded.status === 'missing' ? null : loaded.version.revision;
    return { ok: true, opened: { doc: seeded, baseRevision, newGeneration: loaded.status } };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

/** Puts back the editors of a store that failed, ahead of those who changed the room since. */
function restoreEditors(context: RoomStoreContext, editors: readonly RoomActor[]) {
  const since = [...context.editors.values()];
  context.editors.clear();
  for (const actor of [...editors, ...since]) {
    if (!context.editors.has(actor.id)) context.editors.set(actor.id, actor);
  }
}

/** Stores the room's whole document on top of the revision it last stored or loaded. */
export async function storeRoom(context: RoomStoreContext): Promise<StoreOutcome> {
  const { host, name } = context;
  if (context.conflicted) return 'abandoned';
  const update = encodeStateAsUpdate(context.doc);
  // Changes made while the store runs belong to the next one.
  const editors = [...context.editors.values()];
  context.editors.clear();
  const started = host.clock.now();
  let result: RoomStoreResult;
  try {
    result = await host.persistence.store({
      room: name,
      update,
      baseRevision: context.baseRevision,
    });
  } catch (error) {
    result = { status: 'unavailable', error: toError(error) };
  }
  const durationMs = host.clock.now() - started;
  recordMetric(host, {
    type: 'store',
    room: name,
    outcome: result.status,
    durationMs,
    bytes: update.length,
  });
  if (result.status === 'stored') {
    context.baseRevision = result.revision;
    const { revision, sequence } = result;
    emitEvent(host, { type: 'stored', room: name, revision, sequence, editors });
    return 'stored';
  }
  restoreEditors(context, editors);
  if (result.status === 'conflict') {
    host.logger.error('Another writer stored the room first.', { room: name });
    context.conflicted = true;
    emitEvent(host, { type: 'conflicted', room: name });
    context.onConflict();
    return 'abandoned';
  }
  host.logger.warn('Storing the room failed; retrying.', { room: name, error: result.error });
  return 'retry';
}
