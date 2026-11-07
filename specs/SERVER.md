# Room Server

`createRoomServer({ host, ... })` runs rooms for the connections a host passes it, reaching identity, storage, logging and time only through the host's adapters (HOST-ADAPTERS.md). `attachRoomServer(server, options)` binds it to the WebSocket upgrades of a Node HTTP server through `ws`; a host with its own socket layer calls `connect(socket, request)` instead. A room is loaded while a connection or a host handle holds it.

## COLLAB-SERVER-1 - Admission

### COLLAB-SERVER-1.1 - Access and refusal

`connect(socket, { url, headers })` shall read the room, token and parameters from the URL (COLLAB-PROTOCOL-2.2) and pass them with the headers to `host.auth.admit`. An admitted connection shall receive an auth granted message with its access, the room's sync step 1 and every awareness state in the room. A refused connection shall receive an auth denied message with the reason and be closed with `CLOSE_CODES.unauthenticated` (4401), `forbidden` (4403) or `notFound` (4404); it loads no room. Frames that arrive before admission completes shall be read in order once the connection joins.

Implementation: `src/server/room-server.ts`, `src/server/server-connection.ts`, `src/server/member-frames.ts`, `src/protocol/messages.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-1.2 - Canonical rooms

When admission returns a `room`, the connection shall join that room instead of the one it named, so every alias of a room shares one live document, one awareness and one stored state.

Implementation: `src/server/server-connection.ts`, `src/server/host/adapters.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-1.3 - Failures

A URL that names no room shall close the socket with `CLOSE_CODES.badRequest` (4400). When admission throws, or the room cannot load because storage is unavailable, the server shall log it and close the socket with `CLOSE_CODES.unavailable` (1011) without an auth message, so the client keeps reconnecting.

Implementation: `src/server/server-connection.ts`, `src/server/room-registry.ts`
Verification: `src/server/room-server.test.ts`

## COLLAB-SERVER-2 - Sync

### COLLAB-SERVER-2.1 - Relaying changes

The server shall answer a sync step 1 with a sync step 2 and apply sync step 2 and update messages from a read-write connection, with the connection as the transaction origin. Every change to a room's document, from a member or from a host handle, shall be sent to every member, its sender included: that echo is how a client learns the room holds its change.

Implementation: `src/server/member-frames.ts`, `src/server/live-room.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-2.2 - Read-only connections

Updates from a read-only connection shall never reach the room. The connection still receives every change and may publish awareness.

Implementation: `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-2.3 - Acknowledging held content

When an update a member sends holds content the room has already, such as an update a client resends after losing its echo, the server shall send that member alone the room's copy of that content, so the client can confirm it.

Implementation: `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-2.4 - Unreadable frames

A frame that cannot be decoded or applied shall be logged and close the socket with `CLOSE_CODES.badRequest`. A message type the server does not know shall end the frame (COLLAB-PROTOCOL-1.1).

Implementation: `src/server/server-connection.ts`, `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

## COLLAB-SERVER-3 - Awareness

### COLLAB-SERVER-3.1 - Relaying presence

The server shall apply a member's awareness updates, relay them to the other members, answer a query for every awareness state, and, when a member leaves, remove the states it owns and tell the remaining members.

Implementation: `src/server/member-frames.ts`, `src/server/live-room.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-3.2 - Reconnecting members

A member that reconnects shall be able to publish its state again with a newer clock (COLLAB-CLIENT-4.1), and the other members shall see it.

Implementation: `src/server/awareness-owners.ts`, `src/client/socket-session.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-3.3 - Ownership

Each awareness client id shall belong to the connection that first publishes an object state for it with a clock newer than the room's. Entries for a client id another connection owns shall be dropped, so no member overwrites or removes another member's presence, and stale echoes do not bring back a member that left. A connection's ids are released when it leaves.

Implementation: `src/server/awareness-owners.ts`
Verification: `src/server/awareness-owners.test.ts`

## COLLAB-SERVER-4 - Storage

### COLLAB-SERVER-4.1 - Loading

A room shall load through `host.persistence.load`. A `found` state shall rebuild the document, and the next store shall build on its revision. A `missing` room shall start empty with no base revision. A `corrupt` state, or a found state whose update cannot be applied, shall be logged and start empty, storing over the unreadable state's revision. An `unavailable` load, or a load that throws, shall fail the join (COLLAB-SERVER-1.3).

Implementation: `src/server/live-room.ts`
Verification: `src/server/room-storage.test.ts`

### COLLAB-SERVER-4.2 - Store scheduling

A change shall be stored `storeDebounceMs` (default 2000) after the last change, but no later than `storeMaxDebounceMs` (default 10000) after the first unstored one, one store at a time, as a full-state update with `baseRevision` set to the last stored revision. A store that resolves `unavailable` or throws shall be retried after `storeRetryMs` (default 1000), doubling up to 30000 ms.

Implementation: `src/server/store-scheduler.ts`, `src/server/live-room.ts`, `src/server/room-server.ts`
Verification: `src/server/store-scheduler.test.ts`

### COLLAB-SERVER-4.3 - Unloading

When the last connection or handle releases a room, the server shall store its pending changes and then unload it. A room whose storage keeps failing shall stay loaded, retrying, until its changes are stored. A hold taken while the room stores before unloading shall keep it loaded.

Implementation: `src/server/room-registry.ts`, `src/server/store-scheduler.ts`
Verification: `src/server/room-storage.test.ts`

### COLLAB-SERVER-4.4 - Conflicts

When a store resolves `conflict`, the room shall be logged, store nothing more, close its members with `CLOSE_CODES.conflict` (4409) and unload, so reconnecting clients load what the other writer stored and merge their own changes into it.

Implementation: `src/server/live-room.ts`, `src/server/room-registry.ts`, `src/server/room-server.ts`
Verification: `src/server/room-storage.test.ts`

### COLLAB-SERVER-4.5 - Shutdown

`close()` shall close every member with `CLOSE_CODES.shutdown` (1001), store every room once more, logging a room whose changes could not be stored, and unload them all. Later connections shall be closed with `CLOSE_CODES.shutdown`, and `openRoom` shall reject. `flush()` shall store every room's pending changes now.

Implementation: `src/server/room-server.ts`, `src/server/room-registry.ts`
Verification: `src/server/room-storage.test.ts`

## COLLAB-SERVER-5 - Host access

### COLLAB-SERVER-5.1 - Room handles

`openRoom(room)` shall load the room, or hold the loaded one, and resolve to a handle with its live document, rejecting when storage is unavailable. A change made on the handle's document shall reach every member and be stored like a member's. The room shall stay loaded until every handle is released; releasing a handle twice does nothing. A host warms a room up by opening it and releasing it later.

Implementation: `src/server/room-server.ts`, `src/server/room-registry.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-5.2 - Stateless messages

A member's stateless message shall reach `onStateless` with the room, the admitted actor, the payload and a `reply` that answers that member alone. `broadcastStateless(room, payload)` shall send a stateless message to every member of a loaded room.

Implementation: `src/server/room-server.ts`, `src/server/server-connection.ts`, `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-5.3 - Keepalive

While any room is loaded, every member shall receive an empty awareness frame every `keepaliveMs` (default 10000), so the client's stale-socket check (COLLAB-CLIENT-2.2) sees a live socket in a quiet room. An idle server shall hold no timer.

Implementation: `src/server/room-server.ts`
Verification: `src/server/room-server.test.ts`

## COLLAB-SERVER-6 - WebSocket attachment

### COLLAB-SERVER-6.1 - Upgrades

`attachRoomServer(rooms, { server, path })` shall accept the HTTP server's WebSocket upgrades whose path is `path` followed by `/<room>`, pass each socket to `rooms.connect`, and leave every other upgrade to other handlers. `close()` shall stop accepting upgrades and drop every socket; the room server's own `close` stores the rooms.

Implementation: `src/server/websocket-attachment.ts`
Verification: `src/server/websocket-attachment.test.ts`

### COLLAB-SERVER-6.2 - Socket limits

A text frame shall close the socket with `CLOSE_CODES.badRequest`, and a frame larger than `maxPayloadBytes` (default 64 MiB) shall close it with 1009. Every socket shall be pinged every `pingIntervalMs` (default 30000) and dropped when it did not answer the previous ping.

Implementation: `src/server/websocket-attachment.ts`
Verification: `src/server/websocket-attachment.test.ts`

## COLLAB-SERVER-7 - Authorization

### COLLAB-SERVER-7.1 - Reading an update's changes

Before applying a read-write connection's update to a room with write rules, the server shall read, without applying the update or copying the room, every top-level type the update changes and the keys directly under that type whose content it changes, a position in a list or text counting as `null`. A change deep inside a nested type counts under the top-level key that holds it. Content the room holds already and content Yjs would drop count as no change.

Implementation: `src/server/update-changes.ts`
Verification: `src/server/update-changes.test.ts`

### COLLAB-SERVER-7.2 - Write rules

`host.permissions.rulesFor(room)` shall give a room its `RoomWriteRules` when it loads. A changed top-level type in `serverOnly` shall refuse the update; otherwise the type shall need the capability `required` names for it, or `otherwise` when it is not named, or nothing beyond read-write access. When the lists allow the change, the rules' `check(change)` shall decide, with the room, actor, capabilities and changes; `change.simulate(inspect)` shall run `inspect` on a copy of the room with a function that applies the update to it. A `check` that throws shall refuse. A refused update shall not be applied: the server shall log it, send an auth denied message with `unauthorized-write` and close the socket with `CLOSE_CODES.forbidden`. The host's room handles are not checked.

Implementation: `src/server/write-rules.ts`, `src/server/member-frames.ts`, `src/server/server-connection.ts`, `src/server/live-room.ts`, `src/server/host/adapters.ts`, `src/server/host/host.ts`
Verification: `src/server/authorization.test.ts`, `src/server/host/host.test.ts`

### COLLAB-SERVER-7.3 - Incomplete updates

In a room with write rules, an update that builds on content the room lacks shall not be applied or held back, since it would later apply unchecked; the server shall answer it with a sync step 1, so the client sends everything the room lacks.

Implementation: `src/server/update-changes.ts`, `src/server/member-frames.ts`
Verification: `src/server/update-changes.test.ts`, `src/server/authorization.test.ts`

### COLLAB-SERVER-7.4 - Expiry and refresh

When admission gives an `expiresAt`, the server shall call `host.auth.refresh` with the admission request, the canonical room and the actor 30 seconds before then. A refused decision shall send an auth denied message and close the socket with the refusal's close code. An admitted one shall replace the connection's capabilities, send an auth granted message when the access changed, and, with a new `expiresAt`, schedule the next refresh. A refresh that throws shall be logged and retried every 5 seconds. When the decision expires with no fresh one, or the auth adapter has no `refresh`, the server shall close the socket with `CLOSE_CODES.unauthenticated` and reason `expired`, without an auth message, so the client reconnects with a fresh token.

Implementation: `src/server/reauthorization.ts`, `src/server/server-connection.ts`
Verification: `src/server/authorization.test.ts`
