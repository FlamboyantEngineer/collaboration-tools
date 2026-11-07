import * as awarenessProtocol from '@y/protocols/awareness';
import * as syncProtocol from '@y/protocols/sync';
import {
  createContentIdsFromUpdate,
  Doc,
  encodeStateAsUpdate,
  intersectUpdateWithContentIds,
} from '@y/y';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { RoomSocket, RoomSocketFactory } from '../src/client/room-socket.js';
import {
  encodeAuthMessage,
  encodeStatelessMessage,
  MESSAGE_TYPES,
  type RoomAccess,
} from '../src/protocol/messages.js';
import { parseRoomUrl } from '../src/protocol/room-url.js';

/** A test stand-in for a room server, reached through fake sockets in the same process. */
export interface LoopbackServer {
  /** Pass as a provider's `createSocket`. */
  createSocket: RoomSocketFactory;
  /** The URLs every socket opened, in order. */
  readonly urls: string[];
  /** Every socket a client opened, in order. */
  readonly sockets: LoopbackSocket[];
  /** The server's copy of a room's document. */
  doc(room: string): Doc;
  /** Sockets the server still holds open. */
  openSockets(): LoopbackSocket[];
  /** Messages clients sent as stateless frames. */
  readonly statelessReceived: string[];
  broadcastStateless(room: string, payload: string): void;
  /** While set, the server stops echoing updates back to the client that sent them. */
  dropEchoes: boolean;
  /** While set, the server sends nothing at all. */
  silent: boolean;
}

export interface LoopbackServerOptions {
  /** Decides each connection's access from its token; a string refuses with that reason. */
  admit?: (token: string | null) => RoomAccess | { refuse: string };
  /** When set, a new socket opens only when the test calls its `accept`. */
  manualOpen?: boolean;
}

/** Waits until every queued socket message has been delivered. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class LoopbackSocket implements RoomSocket {
  binaryType = 'blob';
  onopen: RoomSocket['onopen'] = null;
  onmessage: RoomSocket['onmessage'] = null;
  onclose: RoomSocket['onclose'] = null;
  onerror: RoomSocket['onerror'] = null;
  closed = false;
  /** Set by the server for the socket's lifetime. */
  receive: (frame: Uint8Array) => void = () => undefined;
  onServerClose: () => void = () => undefined;

  constructor(readonly url: string) {}

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.closed) throw new Error('send on a closed socket');
    const copy = data.slice();
    // A platform socket delivers what was sent before it closed.
    queueMicrotask(() => this.receive(copy));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onServerClose();
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' }));
  }

  /** Delivers a frame from the server. */
  deliver(frame: Uint8Array): void {
    queueMicrotask(() => {
      if (!this.closed) this.onmessage?.({ data: frame.slice().buffer });
    });
  }

  /** Opens the socket, as the platform does once the server accepts it. */
  accept(): void {
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.({});
    });
  }

  /** Drops the connection as a network failure would, with `code`. */
  drop(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.onServerClose();
    queueMicrotask(() => this.onclose?.({ code, reason: '' }));
  }
}

interface RoomState {
  doc: Doc;
  awareness: awarenessProtocol.Awareness;
  sockets: Set<LoopbackSocket>;
}

function frame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export function createLoopbackServer(options: LoopbackServerOptions = {}): LoopbackServer {
  const rooms = new Map<string, RoomState>();
  const urls: string[] = [];
  const sockets: LoopbackSocket[] = [];
  const statelessReceived: string[] = [];

  const roomState = (room: string): RoomState => {
    let state = rooms.get(room);
    if (!state) {
      const doc = new Doc();
      const awareness = new awarenessProtocol.Awareness(doc);
      awareness.setLocalState(null);
      state = { doc, awareness, sockets: new Set() };
      const created = state;
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        const message = frame((encoder) => {
          encoding.writeVarUint(encoder, MESSAGE_TYPES.sync);
          syncProtocol.writeUpdate(encoder, update);
        });
        for (const socket of created.sockets) {
          if (server.dropEchoes && socket === origin) continue;
          send(socket, message);
        }
      });
      rooms.set(room, state);
    }
    return state;
  };

  const send = (socket: LoopbackSocket, message: Uint8Array) => {
    if (!server.silent) socket.deliver(message);
  };

  // A replayed update changes nothing, so no echo confirms it: acknowledge it to its sender.
  const acknowledge = (socket: LoopbackSocket, state: RoomState, syncMessage: Uint8Array) => {
    const decoder = decoding.createDecoder(syncMessage);
    decoding.readVarUint(decoder);
    const ids = createContentIdsFromUpdate(decoding.readVarUint8Array(decoder));
    const update = intersectUpdateWithContentIds(encodeStateAsUpdate(state.doc), ids);
    send(
      socket,
      frame((encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_TYPES.sync);
        syncProtocol.writeUpdate(encoder, update);
      }),
    );
  };

  const handle = (
    socket: LoopbackSocket,
    state: RoomState,
    access: RoomAccess,
    data: Uint8Array,
  ) => {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_TYPES.sync) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_TYPES.sync);
      const syncType = decoding.peekVarUint(decoder);
      if (syncType !== syncProtocol.messageYjsSyncStep1 && access === 'read-only') return;
      let changed = false;
      const watch = () => (changed = true);
      state.doc.on('update', watch);
      const received = data.slice(decoder.pos);
      syncProtocol.readSyncMessage(decoder, reply, state.doc, socket);
      state.doc.off('update', watch);
      if (encoding.length(reply) > 1) send(socket, encoding.toUint8Array(reply));
      if (syncType !== syncProtocol.messageYjsSyncStep1 && !changed)
        acknowledge(socket, state, received);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        send(
          socket,
          frame((encoder) => {
            encoding.writeVarUint(encoder, MESSAGE_TYPES.sync);
            syncProtocol.writeSyncStep1(encoder, state.doc);
          }),
        );
      }
    } else if (type === MESSAGE_TYPES.awareness) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(state.awareness, update, socket);
      const message = frame((encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_TYPES.awareness);
        encoding.writeVarUint8Array(encoder, update);
      });
      for (const other of state.sockets) send(other, message);
    } else if (type === MESSAGE_TYPES.stateless) {
      statelessReceived.push(decoding.readVarString(decoder));
    }
  };

  const createSocket: RoomSocketFactory = (url) => {
    urls.push(url);
    const socket = new LoopbackSocket(url);
    sockets.push(socket);
    const parts = parseRoomUrl(new URL(url).pathname + new URL(url).search);
    if (!parts) throw new Error(`no room in ${url}`);
    const decision = options.admit?.(parts.token) ?? 'read-write';
    const state = roomState(parts.room);
    const start = () => {
      if (typeof decision !== 'string') {
        send(socket, encodeAuthMessage({ type: 'denied', reason: decision.refuse }));
        return;
      }
      state.sockets.add(socket);
      socket.receive = (data) => handle(socket, state, decision, data);
      socket.onServerClose = () => state.sockets.delete(socket);
      send(socket, encodeAuthMessage({ type: 'granted', access: decision }));
    };
    const accept = socket.accept.bind(socket);
    socket.accept = () => {
      accept();
      queueMicrotask(start);
    };
    if (!options.manualOpen) socket.accept();
    return socket;
  };

  const server: LoopbackServer = {
    createSocket,
    urls,
    sockets,
    doc: (room) => roomState(room).doc,
    openSockets: () => [...rooms.values()].flatMap((state) => [...state.sockets]),
    statelessReceived,
    broadcastStateless: (room, payload) => {
      for (const socket of roomState(room).sockets) send(socket, encodeStatelessMessage(payload));
    },
    dropEchoes: false,
    silent: false,
  };
  return server;
}
