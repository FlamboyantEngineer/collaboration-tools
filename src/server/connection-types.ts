import type { RoomConnectionControl } from './connection-control.js';
import type { RoomConnectionLimits } from './connection-pending.js';
import type { RoomActor, RoomAdmissionRequest } from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';
import type { RoomRegistry } from './room-registry.js';

/** The part of a server-side WebSocket the room server uses. */
export interface RoomServerSocket {
  send(frame: Uint8Array<ArrayBuffer>): void;
  close(code: number, reason: string): void;
}

/** The upgrade request a connection arrived with. */
export interface RoomServerRequest {
  /** The request's path and query, such as `/rooms/a?token=t`. */
  url: string;
  headers: RoomAdmissionRequest['headers'];
}

/** What the socket's owner tells the room server about one connection. */
export interface RoomServerConnection {
  /** Passes a binary frame the client sent. */
  receive(frame: Uint8Array): void;
  /** Reports that the socket closed. */
  closed(): void;
}

/** A stateless message a member sent. */
export interface RoomStatelessMessage {
  room: string;
  actor: RoomActor;
  payload: string;
  /** Sends a stateless message back to the member alone. */
  reply(payload: string): void;
}

export interface ConnectionDependencies {
  host: ResolvedRoomHost;
  limits?: RoomConnectionLimits | undefined;
  maxPendingBytes: number;
  controls: Set<RoomConnectionControl>;
  registry: RoomRegistry;
  onStateless: ((message: RoomStatelessMessage) => void) | undefined;
  /** Called each time a connection joins its room. */
  onJoin(): void;
  /** Shutdown callbacks for every connection, including those awaiting admission. */
  connections: Set<() => void>;
}
