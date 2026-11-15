# Room Server

`createRoomServer({ host, ... })` runs rooms for the connections a host passes it, reaching identity, storage, logging and time only through the host's adapters (HOST-ADAPTERS.md). `attachRoomServer(server, options)`, from its own `./server/websocket` entry point, binds it to the WebSocket upgrades of a Node HTTP server through `ws`; a host with its own socket layer calls `connect(socket, request)` instead. A room is loaded while a connection or a host handle holds it.

## COLLAB-SERVER-1 - Admission

### COLLAB-SERVER-1.1 - Access and refusal

`connect(socket, { url, headers })` shall read the room, token and parameters from the URL (COLLAB-PROTOCOL-2.2) and pass them with the headers to `host.auth.admit`. An admitted connection shall receive an auth granted message with its access, the room's sync step 1 and every awareness state in the room. A refused connection shall receive an auth denied message with the reason and be closed with `CLOSE_CODES.unauthenticated` (4401), `forbidden` (4403) or `notFound` (4404); it loads no room. Frames that arrive before admission completes shall be read in order once the connection joins; a connection that closes before then shall discard its queued frames.

Implementation: `src/server/room-server.ts`, `src/server/server-connection.ts`, `src/server/member-frames.ts`, `src/protocol/messages.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-1.2 - Canonical rooms

When admission returns a `room`, the connection shall join that room instead of the one it named, so every alias of a room shares one live document, one awareness and one stored state.

Implementation: `src/server/server-connection.ts`, `src/server/host/adapters.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-1.3 - Failures

A URL that names no room shall close the socket with `CLOSE_CODES.badRequest` (4400). When admission throws, or the room cannot load because storage or its permissions adapter fails, the server shall log it and close the socket with `CLOSE_CODES.unavailable` (1011) without an auth message, so the client keeps reconnecting. A failed room load shall release its registry entry and document, so a later attempt can load again.

Implementation: `src/server/server-connection.ts`, `src/server/room-registry.ts`
Verification: `src/server/room-server.test.ts`, `src/server/authorization.test.ts`

### COLLAB-SERVER-1.4 - Pending admission limits

Before admission and loading finish, a connection shall retain at most 64 copied frames by default. The top-level `maxPendingBytes` (default 4 MiB) caps each frame's byte length plus 64 bytes of queue overhead. Exceeding either cap logs a warning and closes with 1009 and reason `too-large`. `connectionLimits` may set the positive safe integer frame count cap and separate admission/loading deadlines, defaulting to 10000/30000 milliseconds. The byte cap must also be a positive safe integer. A deadline closes the connection as unavailable with reason `admission-timeout`. Closure discards pending frames and cancels timers; late admission results cannot join, and late loaded rooms are released.

Implementation: `src/server/server-connection.ts`, `src/server/connection-pending.ts`, `src/server/connection-types.ts`
Verification: `src/server/server-connection.test.ts`

## COLLAB-SERVER-2 - Sync

### COLLAB-SERVER-2.1 - Relaying changes

The server shall answer a sync step 1 with a sync step 2 and apply sync step 2 and update messages from a read-write connection, with an authenticated transaction origin containing actor, capabilities and source. Every change to a room's document, from a member or from a host handle, shall be sent to every member, its sender included: that echo is how a client learns the room holds its change.

Implementation: `src/server/member-frames.ts`, `src/server/live-room.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-2.2 - Read-only connections

Updates from a read-only connection shall never reach the room. The connection still receives every change and may publish awareness.

Implementation: `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-2.3 - Acknowledging held content

When an update message a member sends holds content the room has already, such as an update a client resends after losing its echo, the server shall send that member alone the room's copy of that content, so the client can confirm it. A sync step 2 shall not be acknowledged this way: it repeats every deletion the member knows, and the client resends what is still unconfirmed as an update once the handshake completes (COLLAB-CLIENT-3.2), so a member joining a document with deletions gets no extra frame.

Implementation: `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-2.4 - Unreadable frames

An awareness entry count shall be bounded by the bytes remaining before allocating its entries. A frame that cannot be decoded or applied shall be logged and close the socket with `CLOSE_CODES.badRequest`. A message type the server does not know shall end the frame (COLLAB-PROTOCOL-1.1).

Implementation: `src/server/server-connection.ts`, `src/server/member-frames.ts`, `src/server/awareness-owners.ts`
Verification: `src/server/room-server.test.ts`, `src/server/awareness-owners.test.ts`

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

### COLLAB-SERVER-3.4 - Expiry

A presence its client has not renewed for 30 s, measured on the host's `clock`, shall be removed and the removal sent to every member. The room shall check every 3 s, holding a timer only while it tracks some presence.

Implementation: `src/server/awareness-expiry.ts`, `src/server/live-room.ts`, `src/server/member-frames.ts`
Verification: `src/server/room-server.test.ts`

### COLLAB-SERVER-3.5 - Authenticated and bounded presence

Awareness states shall be JSON objects or null removals, with safe integer ids and clocks, no trailing bytes, at most 64 entries and 64 KiB per update, and at most 16 KiB of JSON per state. Each connection may own at most 16 client ids and each room retain metadata for at most 1024 client ids. Ownership budgets are released on disconnect, and metadata for removed released states is pruned after broadcasting removal, so reconnect churn cannot exhaust a room for its lifetime. The server shall replace the reserved `actor` field with the authenticated actor, and by default also replace `user` with that actor. Other fields remain untrusted client content. A host may normalize or reject custom fields through `host.awareness.normalize`; exceptions, null results and malformed or oversized states close the sender as bad-request. The wire encoding stays unchanged.

Implementation: `src/server/awareness-owners.ts`, `src/server/member-frames.ts`, `src/server/host/awareness-policy.ts`
Verification: `src/server/awareness-owners.test.ts`, `src/server/server-connection.test.ts`

## COLLAB-SERVER-4 - Storage

### COLLAB-SERVER-4.1 - Loading

A room shall load through `host.persistence.load`. A `found` state shall rebuild the document, and the next store shall build on its revision. A `missing` room shall start from its seed (COLLAB-SERVER-8.2) with no base revision. A `corrupt` state, or a found state whose update cannot be applied or leaves unresolved Yjs dependencies, shall be logged and start from its seed, storing over the unreadable state's revision. An `unavailable` load, or a load that throws, shall fail the join (COLLAB-SERVER-1.3).

Implementation: `src/server/live-room.ts`, `src/server/stored-room.ts`
Verification: `src/server/room-storage.test.ts`, `src/server/durability.test.ts`

### COLLAB-SERVER-4.2 - Store scheduling

A change shall be stored `storeDebounceMs` (default 2000) after the last change, but no later than `storeMaxDebounceMs` (default 10000) after the first unstored one, one store at a time, as a full-state update with `baseRevision` set to the last stored revision. A store that resolves `unavailable` or throws shall be retried after `storeRetryMs` (default 1000), doubling up to 30000 ms; a change made while a retry waits shall wait for it, not start a debounce of its own. Cancelling the scheduler during a store shall prevent its result from scheduling another retry.

Implementation: `src/server/store-scheduler.ts`, `src/server/live-room.ts`, `src/server/stored-room.ts`, `src/server/room-server.ts`
Verification: `src/server/store-scheduler.test.ts`

### COLLAB-SERVER-4.3 - Unloading

When the last connection or handle releases a room, the server shall store its pending changes and then unload it. A room whose storage keeps failing shall stay loaded, retrying, until its changes are stored. A hold taken while the room stores before unloading shall keep it loaded, and a change that such a hold made before it was released shall be stored before the room unloads.

Implementation: `src/server/room-registry.ts`, `src/server/store-scheduler.ts`
Verification: `src/server/room-storage.test.ts`

### COLLAB-SERVER-4.4 - Conflicts

When a store resolves `conflict`, the room shall be logged, store nothing more, close its members with `CLOSE_CODES.conflict` (4409) and unload, so reconnecting clients load what the other writer stored and merge their own changes into it.

Implementation: `src/server/live-room.ts`, `src/server/room-registry.ts`, `src/server/room-server.ts`
Verification: `src/server/room-storage.test.ts`

### COLLAB-SERVER-4.5 - Shutdown

`close()` shall close every connection, including those awaiting admission or loading, refuse later work, and store all pending changes. It resolves only after every room is durable and unloaded. A failed store rejects shutdown and retains the room and its retry state; `recover()` returns detached snapshots and `close()` may be retried. Concurrent calls wait for the same attempt. Handles cannot mutate after shutdown begins. `flush()` starts pending stores and rejects when an attempt fails; supplying a signal or timeout waits through retries, without discarding changes when the wait ends.

Implementation: `src/server/room-server.ts`, `src/server/room-registry.ts`
Verification: `src/server/room-storage.test.ts`

## COLLAB-SERVER-5 - Host access

### COLLAB-SERVER-5.1 - Room handles

`openRoom(room)` shall hold a loaded room until release. A handle exposes a detached full-state `snapshot()` and `transact({ actor, capabilities }, mutate)`. Mutations run on a detached candidate, pass the room capability rules and additional guard, and only then reach the live room with authenticated attribution. Server-only types may be edited by the host, subject to its remaining capability rules and guard; the library generation remains reserved. A retained candidate cannot mutate the live room. A released or fenced handle cannot write.

Implementation: `src/server/room-server.ts`, `src/server/room-registry.ts`, `src/server/room-handle.ts`
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

Implementation: `src/server/websocket/websocket-attachment.ts`
Verification: `src/server/websocket/websocket-attachment.test.ts`

### COLLAB-SERVER-6.2 - Socket limits

A text frame shall close the socket with `CLOSE_CODES.badRequest`, and a frame larger than `maxPayloadBytes` (default 64 MiB) shall close it with 1009. Every socket shall be pinged every `pingIntervalMs` (default 30000) and dropped when it did not answer the previous ping.

The attachment shall terminate a slow consumer before an outbound frame would bring `bufferedAmount` above `maxBufferedBytes` (default the larger of 4 MiB and `maxPayloadBytes`, normally 64 MiB), including a single oversized outbound frame. Closed sockets receive no further sends; termination releases room membership. The buffer limit must be a positive safe integer. It includes each full welcome snapshot, so hosts with larger snapshots must configure a correspondingly larger outbound limit; a smaller explicit limit intentionally rejects larger outbound frames.

Implementation: `src/server/websocket/websocket-attachment.ts`
Verification: `src/server/websocket/websocket-attachment.test.ts`

## COLLAB-SERVER-7 - Authorization

### COLLAB-SERVER-7.1 - Reading an update's changes

Before applying a read-write connection's update, the server shall read, without applying the update or copying the room, every top-level type the update changes and the keys directly under that type whose content it changes, a position in a list or text counting as `null`. A change deep inside a nested type counts under the top-level key that holds it. Content the room holds already and content Yjs would drop count as no change.

Implementation: `src/server/update-changes.ts`
Verification: `src/server/update-changes.test.ts`

### COLLAB-SERVER-7.2 - Write rules

`host.permissions.rulesFor(room)` shall give a room its `RoomWriteRules` when it loads. A changed top-level type in `serverOnly`, or the room metadata type (COLLAB-PROTOCOL-3.1) in every room, shall refuse the update; otherwise the type shall need the capability `required` names for it, or `otherwise` when it has no own entry in `required`, or nothing beyond read-write access. When the lists allow the change, the rules' `check(change)` shall decide, with the room, actor, capabilities and changes, and then the room's guard. When the rules give `openGuard`, the room shall call it once as it loads, with a shadow copy of the room's document that the server keeps in step with every change the room takes, the host's room handles included; an `openGuard` that throws shall fail the load. Each update the lists and `check` allow shall be applied to the shadow first, and the guard's `check(change)` shall decide with the shadow's transaction that applied it, so a guard may keep its own reading of the room from its seed. A refused update leaves the shadow stale: the server shall rebuild it from the room and reopen the guard at the room's next guarded update, and refuse that update when reopening throws. A `check` that throws, the rules' or the guard's, shall refuse. Deciding by the lists, by `check` or by a guard shall cost about the update's own size, not the room's: about as much in a room of a megabyte as in an empty one. Only a refusal by the guard copies the room. A refused update shall not be applied: the server shall log it, send an auth denied message with `unauthorized-write` and close the socket with `CLOSE_CODES.forbidden`, and stop processing the remainder of that frame. Attributed host transactions pass the same finer check and guard; only server-only roots are exempt from the client restriction.

Implementation: `src/server/write-rules.ts`, `src/server/write-guard.ts`, `src/server/member-frames.ts`, `src/server/server-connection.ts`, `src/server/live-room.ts`, `src/server/host/adapters.ts`, `src/server/host/host.ts`
Verification: `src/server/authorization.test.ts`, `src/server/write-rules.test.ts`, `src/server/write-guard.test.ts`, `src/server/host/host.test.ts`

### COLLAB-SERVER-7.3 - Incomplete updates

An update that builds on content the room lacks, including either its left or right neighbour, shall not be applied or held back, since it would later apply unchecked; the server shall answer it with a sync step 1, so the client sends everything the room lacks.

Implementation: `src/server/update-changes.ts`, `src/server/member-frames.ts`
Verification: `src/server/update-changes.test.ts`, `src/server/authorization.test.ts`

### COLLAB-SERVER-7.4 - Expiry and refresh

When admission gives an `expiresAt`, the server shall call `host.auth.refresh` with the admission request, the canonical room and the actor 30 seconds before then. A refused decision shall send an auth denied message and close the socket with the refusal's close code. An admitted one shall replace the connection's capabilities, send an auth granted message when the access changed, and, with a new `expiresAt`, schedule the next refresh. A refresh that throws shall be logged and retried every 5 seconds. Successive refreshes shall be at least 5 seconds apart even when a new decision expires within the 30-second refresh lead. An admission already expired when its room finishes loading shall close before joining or replaying queued frames. When the decision expires with no fresh one, including while a refresh remains unresolved, or the auth adapter has no `refresh`, the server shall close the socket with `CLOSE_CODES.unauthenticated` and reason `expired`, without an auth message, so the client reconnects with a fresh token. A refresh result arriving after expiry or closure shall be ignored; an already expired refresh decision shall close the connection.

Implementation: `src/server/reauthorization.ts`, `src/server/server-connection.ts`
Verification: `src/server/authorization.test.ts`

### COLLAB-SERVER-7.5 - Targeted authorization controls

`revoke(target)` shall immediately refuse matching active connections with forbidden and reason `revoked`. `reauthorize(target)` shall await fresh decisions from the auth adapter and apply access and capabilities before accepting further frames. Targets match the intersection of optional canonical room, actor id and authenticated session id; an empty target selects all. For connections already awaiting admission, revocation targets shall be retained until the authenticated actor, session and canonical room are known, and enforced before room loading or queued-frame replay. New connections created after the call consult authentication normally. Reauthorization also records targets for unresolved admissions; a selected connection not yet joined closes with unavailable and reason `reauthorization-required`, before loading or replay, so reconnect obtains a fresh admission. Missing refresh support, refresh errors and changed actor id, canonical room or session id shall close the selected connection. A manual refresh shall finish within 10 seconds or the current admission expiry, whichever is earlier, and closure shall cancel the wait. Results after closure are ignored. Existing scheduled refresh results are superseded by manual refresh.

Implementation: `src/server/connection-control.ts`, `src/server/connection-lifecycle.ts`, `src/server/server-connection.ts`, `src/server/room-server.ts`
Verification: `src/server/server-connection.test.ts`

## COLLAB-SERVER-8 - Durability

### COLLAB-SERVER-8.1 - Generations

A room that loads from its seed shall start a new generation (COLLAB-PROTOCOL-3.1), a random UUID, and a found state without a generation shall be given one, keeping its content. A room with a new generation shall store it before any member joins; when that store does not succeed, the load shall fail (COLLAB-SERVER-1.3). A connection whose URL names a generation other than the room's shall be sent an auth generation message with the room's generation, then refused with an auth denied message with `generation-mismatch` and closed with `CLOSE_CODES.gone`, since its document holds history the room discarded. A connection that names none has never synced and may join.

Implementation: `src/server/stored-room.ts`, `src/server/live-room.ts`, `src/server/server-connection.ts`, `src/server/write-rules.ts`
Verification: `src/server/durability.test.ts`

### COLLAB-SERVER-8.2 - Seeds and stale rooms

A room that is `missing`, `corrupt` or `stale` shall start from `host.seeds.seed(room)`, a Yjs update that builds its content, or empty when the seed is `null`, and a `corrupt` or `stale` one shall store over the revision of the state it replaces. A seed that throws, or cannot be applied completely without unresolved Yjs dependencies, shall fail the load.

Implementation: `src/server/stored-room.ts`, `src/server/host/adapters.ts`, `src/server/host/host.ts`
Verification: `src/server/durability.test.ts`

### COLLAB-SERVER-8.3 - Save status

The server shall send each member the room's save status (COLLAB-PROTOCOL-1.5) when it joins, after its auth message, and every member each change of it: `saved` when every change is stored, `unsaved` while changes wait for a store, `saving` while one runs and `retrying` while a failed one waits to be retried.

Implementation: `src/server/store-scheduler.ts`, `src/server/live-room.ts`, `src/server/member-frames.ts`
Verification: `src/server/durability.test.ts`, `src/server/store-scheduler.test.ts`

### COLLAB-SERVER-8.4 - Receipts

The server shall answer a member's receipt request with a receipt for the same id once the room has stored every change made before the request, at once when nothing is waiting. A room that cannot store them, because another writer stored it first or it unloads, closes its members instead of answering.

Implementation: `src/server/store-scheduler.ts`, `src/server/member-frames.ts`
Verification: `src/server/durability.test.ts`, `src/server/store-scheduler.test.ts`

### COLLAB-SERVER-8.5 - Metrics

The server shall pass `host.metrics.record` an event for each load, with its outcome and duration, each store, with its outcome, duration and size, and each new generation, with the load outcome that caused it (`unmarked` for a found state without one). A recorder that throws shall change nothing.

Implementation: `src/server/stored-room.ts`, `src/server/live-room.ts`, `src/server/host/adapters.ts`
Verification: `src/server/durability.test.ts`

### COLLAB-SERVER-8.6 - Room events

The server shall pass `host.events.emit` an event, naming the room by its canonical name, when a room loads (`loaded`, after it stores a new generation), a connection joins it (`joined`, with its actor and access), a joined connection leaves it (`left`, with its actor), a store succeeds (`stored`, with the stored revision and sequence and the actors whose changes that state is the first to hold, in the order they first changed the room since the last stored state), another writer stores it first (`conflicted`) and it unloads (`unloaded`). A failed store's actors shall carry over to the store that follows, and changes made through a room handle shall carry their supplied actor. The server shall not wait for a listener: one that throws or whose promise rejects shall change nothing and be logged as a warning.

Implementation: `src/server/stored-room.ts`, `src/server/live-room.ts`, `src/server/room-registry.ts`, `src/server/server-connection.ts`, `src/server/member-frames.ts`, `src/server/host/adapters.ts`
Verification: `src/server/room-events.test.ts`

## COLLAB-SERVER-9 - Runtimes

### COLLAB-SERVER-9.1 - Outside Node

The `./server` entry point shall import no Node built-in module and not `ws`, so a room server runs in a browser or another JavaScript runtime with a host's own socket layer; room generations come from `globalThis.crypto.randomUUID`. Only the `./server/websocket` entry point, which holds the WebSocket attachment (COLLAB-SERVER-6), shall need Node.

Implementation: `src/server/stored-room.ts`, `src/server/websocket/index.ts`, `scripts/check-structure.mjs`
Verification: `src/server/browser-entries.test.ts`

## COLLAB-SERVER-10 - Durable host operations

### COLLAB-SERVER-10.1 - Explicit durability failures and recovery

Public room and server flush return per-room receipts naming the durable generation and version. They and shutdown never report success for unstored changes. Flush and shutdown accept abort and deadline options. These end only the wait and detach its listeners and waiter; retries continue and dirty snapshots remain recoverable. A shutdown that failed can be retried after storage recovers. No host mutation is accepted once shutdown begins.

Implementation: `src/server/durable-barrier.ts`, `src/server/room-registry.ts`, `src/server/store-scheduler.ts`, `src/server/room-server.ts`
Verification: `src/server/host-contracts.test.ts`

### COLLAB-SERVER-10.2 - Serialized canonical commits

`commitRoom(room, commit)` serializes canonical commits and checkpoint storage per room. It finishes older stores, captures a detached snapshot with its generation and stored version, and holds later stores until the callback resolves. The callback returns `{ value, version }`; that version becomes the base of the next checkpoint before storage resumes. Collaborators stay connected and may edit during the callback; their later changes remain dirty and persist against the returned version. Failed callbacks leave the existing base unchanged. The callback must atomically commit its canonical state and returned version, and must not call another serialized operation on the same room.

Implementation: `src/server/room-operations.ts`, `src/server/store-scheduler.ts`, `src/server/live-room.ts`, `src/server/stored-room.ts`
Verification: `src/server/host-contracts.test.ts`

### COLLAB-SERVER-10.3 - Generation invalidation

`invalidate(room)` serializes behind earlier canonical operations, closes members, prevents old handles from writing, waits for in-flight stores, cancels later stores and returns any unsaved snapshot. The next load starts a new generation from the host seed, replacing the latest stored version. Admission already loading the invalidated instance cannot join it. Clients retain responsibility for recovering edits from a refused old generation.

Implementation: `src/server/room-operations.ts`, `src/server/room-registry.ts`, `src/server/stored-room.ts`, `src/server/live-room.ts`, `src/server/server-connection.ts`
Verification: `src/server/host-contracts.test.ts`

### COLLAB-SERVER-10.4 - Guard lifecycle and atomic attribution

`RoomWriteRules.openGuard(shadow)` opens a synchronous preapply guard on a persistent room shadow. Its `check` receives the authenticated actor, capabilities, changed roots and candidate transaction, and runs in addition to ordinary capability rules. False or exceptions reject without broadcast or persistence. Unload destroys the guard. Host candidates use the same guard and carry attribution into the transaction origin and the atomic persistence context, including actors, generation and reason. The context is captured with the snapshot, before asynchronous persistence begins.

Implementation: `src/server/host/adapters.ts`, `src/server/room-mutations.ts`, `src/server/write-rules.ts`, `src/server/live-room.ts`, `src/server/stored-room.ts`, `src/server/room-handle.ts`
Verification: `src/server/host-contracts.test.ts`
