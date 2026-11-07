import { applyAwarenessUpdate, encodeAwarenessUpdate } from '@y/protocols/awareness';
import * as syncProtocol from '@y/protocols/sync';
import {
  applyUpdate,
  type ContentIds,
  createContentIdsFromUpdate,
  encodeStateAsUpdate,
  excludeContentIds,
  intersectUpdateWithContentIds,
} from '@y/y';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { encodeAwarenessFrame, encodeSyncStep1, encodeSyncUpdate } from '../protocol/frames.js';
import {
  encodeAuthMessage,
  encodeStorageMessage,
  MESSAGE_TYPES,
  readStatelessMessage,
  readStorageMessage,
  type RoomAccess,
} from '../protocol/messages.js';
import { decodeAwarenessEntries, encodeAwarenessEntries } from './awareness-owners.js';
import type { RoomActor } from './host/adapters.js';
import type { LiveRoom, RoomMember } from './live-room.js';
import { checkWrite } from './write-rules.js';

/** What reading a member's frames needs. */
export interface MemberContext {
  room: LiveRoom;
  member: RoomMember;
  actor: RoomActor;
  /** The access and capabilities a refreshed decision may change. */
  access: RoomAccess;
  capabilities: ReadonlySet<string>;
  onStateless(payload: string): void;
  /** Called when the room's rules refuse an update, which is then dropped. */
  onRefusedWrite(types: readonly string[]): void;
}

function isEmptyIds(ids: ContentIds): boolean {
  return ids.inserts.isEmpty() && ids.deletes.isEmpty();
}

/**
 * Applies a member's update once the room's rules allow it. The room echoes what it changes to every member; what it held
 * already, such as an update a client resends after losing the echo, is acknowledged to the
 * sender alone, so the sender learns the room holds it.
 */
function applyMemberUpdate(context: MemberContext, update: Uint8Array) {
  const { room, member } = context;
  const decision = checkWrite(room.rules, {
    room: room.name,
    doc: room.doc,
    actor: context.actor,
    capabilities: context.capabilities,
    update,
  });
  // An incomplete update is dropped, never held back unchecked: the sync step 1 asks the client
  // for everything the room lacks, its dependencies included.
  if (decision.verdict === 'incomplete') return member.send(encodeSyncStep1(room.doc));
  if (decision.verdict === 'refused') return context.onRefusedWrite(decision.types);
  let applied: Uint8Array | null = null;
  const watch = (change: Uint8Array) => (applied = change);
  room.doc.on('update', watch);
  try {
    applyUpdate(room.doc, update, member);
  } finally {
    room.doc.off('update', watch);
  }
  const sent = createContentIdsFromUpdate(update);
  const held = applied ? excludeContentIds(sent, createContentIdsFromUpdate(applied)) : sent;
  if (isEmptyIds(held)) return;
  member.send(encodeSyncUpdate(intersectUpdateWithContentIds(encodeStateAsUpdate(room.doc), held)));
}

function readSync(decoder: decoding.Decoder, context: MemberContext) {
  const syncType = decoding.readVarUint(decoder);
  if (syncType === syncProtocol.messageYjsSyncStep1) {
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_TYPES.sync);
    syncProtocol.readSyncStep1(decoder, reply, context.room.doc);
    context.member.send(encoding.toUint8Array(reply));
    return;
  }
  if (syncType !== syncProtocol.messageYjsSyncStep2 && syncType !== syncProtocol.messageYjsUpdate) {
    throw new Error(`unknown sync message ${syncType}`);
  }
  const update = decoding.readVarUint8Array(decoder);
  // A read-only connection's changes never reach the room.
  if (context.access === 'read-write') applyMemberUpdate(context, update);
}

/** Applies the awareness entries the member may write and relays them to the other members. */
function readAwareness(decoder: decoding.Decoder, { room, member }: MemberContext) {
  const update = decoding.readVarUint8Array(decoder);
  const entries = decodeAwarenessEntries(update);
  const clockOf = (id: number) => room.awareness.meta.get(id)?.clock ?? 0;
  const allowed = room.owners.claim(member, entries, clockOf);
  if (allowed.length === 0) return;
  const filtered = allowed.length === entries.length ? update : encodeAwarenessEntries(allowed);
  applyAwarenessUpdate(room.awareness, filtered, member);
  room.broadcast(encodeAwarenessFrame(filtered), member);
}

/**
 * Answers a receipt request once the room has stored every change made before it, which includes
 * everything the member sent before it. A room that never stores them closes its members instead.
 */
function readStorage(decoder: decoding.Decoder, { room, member }: MemberContext) {
  const message = readStorageMessage(decoder);
  if (message?.type !== 'receipt-request') return;
  const receipt = encodeStorageMessage({ type: 'receipt', id: message.id });
  void room.store.whenStored().then((stored) => stored && member.send(receipt));
}

function sendAllAwareness({ room, member }: MemberContext) {
  const clients = [...room.awareness.getStates().keys()];
  if (clients.length > 0) {
    member.send(encodeAwarenessFrame(encodeAwarenessUpdate(room.awareness, clients)));
  }
}

/**
 * Reads every message in a member's frame. Any other message type, auth included, ends the frame,
 * as a newer client may add types. A frame that cannot be decoded throws.
 */
export function readMemberFrame(frame: Uint8Array, context: MemberContext): void {
  const decoder = decoding.createDecoder(frame);
  while (context.room.members.has(context.member) && decoding.hasContent(decoder)) {
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_TYPES.sync) readSync(decoder, context);
    else if (type === MESSAGE_TYPES.awareness) readAwareness(decoder, context);
    else if (type === MESSAGE_TYPES.queryAwareness) sendAllAwareness(context);
    else if (type === MESSAGE_TYPES.stateless) context.onStateless(readStatelessMessage(decoder));
    else if (type === MESSAGE_TYPES.storage) readStorage(decoder, context);
    else break;
  }
}

/**
 * What a member gets once admitted: its access, the room's save status, its sync step 1 and every
 * presence.
 */
export function sendWelcome(context: MemberContext): void {
  const { member, room } = context;
  member.send(encodeAuthMessage({ type: 'granted', access: context.access }));
  member.send(encodeStorageMessage({ type: 'status', status: room.store.status() }));
  member.send(encodeSyncStep1(room.doc));
  sendAllAwareness(context);
}
