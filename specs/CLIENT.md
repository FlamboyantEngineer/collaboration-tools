# Client Provider

`createRoomProvider(options)` keeps a Yjs document and its awareness in sync with one room over a WebSocket. It reaches the network, time and connectivity only through its options: `createSocket` (default the platform `WebSocket`), `clock` (default the platform clock) and `connectivity` (default none). An editor reads the provider's document, its awareness and its connection state, and needs nothing else from it.

## COLLAB-CLIENT-1 - Connecting

### COLLAB-CLIENT-1.1 - Room URL and token

Each connection attempt shall open `buildRoomUrl({ endpoint, room, token, params })` (COLLAB-PROTOCOL-2.1), with the token `getToken()` returns for that attempt, so a host can refresh an expiring token between attempts.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`, `src/client/room-socket.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-1.2 - Sync handshake and connection state

The provider shall connect at once unless `connect` is `false`. On open it shall send a sync step 1 and, when it has one, its local awareness state; it shall answer the server's sync step 1, leaving out the content of its unconfirmed changes (COLLAB-CLIENT-3.4), and apply the server's sync step 2 and updates with an origin of its own. `getState()` shall return the connection state: `status` (`connecting`, `connected` or `disconnected`), `access` (`pending` until the server grants access on the current socket, then `read-write` or `read-only`), `synced` (whether the current socket has received the server's sync step 2), `syncCount` (completed handshakes since creation), `hasUnconfirmedChanges`, `refusedChanges` (how many local changes the room refused while keeping the provider connected, COLLAB-CLIENT-3.5), `refusal`, `roomGeneration` (COLLAB-CLIENT-5.1), `closeCode` (the close code of the last socket that closed, `null` when the provider closed it) and `saveStatus` (COLLAB-CLIENT-5.2). A provider that has not connected shall report `disconnected`, `pending`, not synced and zero handshakes.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`, `src/client/socket-session.ts`, `src/client/frames.ts`, `src/client/connection-state.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-1.3 - Read-only access

When the server grants `read-only`, the state shall report it, and the provider shall keep applying what the server sends.

Implementation: `src/client/room-connection.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-1.4 - Refusals

When the server refuses the connection, the provider shall report the reason as `refusal`, close the socket and stop reconnecting. `connect()` shall try again and clear the refusal once a socket opens.

Implementation: `src/client/room-connection.ts`, `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-1.5 - Subscribing

`subscribe(listener)` shall call the listener with the new state each time a field changes, and return a function that stops it. A listener that throws shall not stop the provider; its error goes to the provider's logger (COLLAB-CLIENT-5.4).

Implementation: `src/client/connection-state.ts`, `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`, `src/client/connection-state.test.ts`

## COLLAB-CLIENT-2 - Keeping the connection

### COLLAB-CLIENT-2.1 - Reconnecting

While it should be connected, the provider shall open a new socket when one closes: at once after a socket that had opened, and after `2^n × 100` ms, capped at `maxBackoffMs` (default 2500), after the `n`-th attempt in a row that never opened. `disconnect()` shall close the socket and stop reconnecting, after telling the room the local awareness state is gone; `connect()` shall start again. If the token getter or socket factory throws during an attempt, the provider shall report the error and retry with the same backoff.

Implementation: `src/client/room-connection.ts`, `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-2.2 - Stale sockets

A socket that never opens, or receives nothing for longer than `socketTimeoutMs` (default 45000) shall be closed and replaced. The check shall run every 4 seconds on the provider's clock. A pass that runs more than two cadences after the previous one shall measure silence from itself, so messages queued behind a long task get a full timeout; a late pass that follows another late pass shall keep the earlier start, so steady throttling still closes a dead socket.

Implementation: `src/client/stale-socket-check.ts`, `src/client/socket-session.ts`
Verification: `src/client/stale-socket-check.test.ts`, `src/client/room-provider.test.ts`

### COLLAB-CLIENT-2.3 - Connectivity

With `connectivity`, an `offline` event shall close the socket and hold reconnects until an `online` event, which shall connect at once. `destroy()` shall remove both listeners.

Implementation: `src/client/room-provider.ts`, `src/client/room-socket.ts`
Verification: `src/client/room-provider.test.ts`

## COLLAB-CLIENT-3 - Local changes

### COLLAB-CLIENT-3.1 - Unconfirmed changes

Every local document update shall be sent when a socket is open and tracked until updates from the server contain its content; `hasUnconfirmedChanges` shall be `true` while any is tracked.

Implementation: `src/client/unconfirmed-updates.ts`, `src/client/room-connection.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-3.2 - Resending lost echoes

After each completed handshake, the provider shall send the changes still unconfirmed, one update for each (COLLAB-CLIENT-3.4), so a change whose echo was lost with a socket is confirmed. The server acknowledges such a replay to its sender even when it changes nothing.

Implementation: `src/client/unconfirmed-updates.ts`, `src/client/room-connection.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-3.3 - Keeping unconfirmed changes across reloads

`getUnconfirmedUpdates()` shall return one update for each change still unconfirmed (COLLAB-CLIENT-3.4), oldest first, each holding that change's content alone, or an empty list when none is. A provider created with `unconfirmedUpdates` shall, before it reports any state or connects, apply those updates to the document in order with the origin it applies the server's updates with and track each as a change of its own, so the resend after the handshake sends them one by one and `whenStored()` covers them.

Implementation: `src/client/room-provider.ts`, `src/client/unconfirmed-updates.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-3.4 - Changes one by one

The provider shall track its unconfirmed content as changes. A local update sent on an open socket as it is made shall be a change of its own; local updates made while no socket is open shall be one change from the first of them until 500 ms after it, so a change is a burst of typing, not a whole time offline. The resend after a handshake shall send each change as an update of its own, in the order they were made, and the provider's answer to the server's sync step 1 shall leave their content out, so the room's write rules decide on each change apart: the room takes those it allows, and refuses only one it does not, without taking the others down with it.

Implementation: `src/client/unconfirmed-updates.ts`, `src/client/room-connection.ts`, `src/client/frames.ts`
Verification: `src/server/merge-refusals.test.ts`, `src/client/room-provider.test.ts`

### COLLAB-CLIENT-3.5 - Refused changes

When the server sends a refused message (COLLAB-PROTOCOL-1.6), the provider shall stop tracking the refused update's content, which it shall never send again, count it in `refusedChanges`, and stay connected. Yjs cannot take content back out of a document, so the writer's document comes back to the room's content by being replaced:

- **Fill.** The writer's later changes take their places after the refused change's, and the room needs those places to take them. When the refused change inserted anything, the provider shall send a fill first: the change's insertions as deleted content, holding none of their text, and none of its deletions. It shall then send again, one by one, the later changes of the same document, which the room dropped as incomplete while it lacked those places (COLLAB-SERVER-7.3). The fill is tracked like a change, so a reconnect sends it again until the room confirms it.
- **Later changes.** A later change the room allows reaches it, the keys typed between the refused change and the reload included. Content of a later change that lies inside what the refused change inserted, such as text typed inside an item it added, arrives deleted with the fill: it is dropped with the refused change. A later change that the room refuses in turn is handled the same way.
- **Reload.** When the refused change belongs to the document the room syncs with, the provider shall start a new document of the same garbage collection setting, sync it with the room from scratch on the same socket, and keep sending the previous document's local changes until then. Once the room's sync step 2 reaches the new document, `doc` shall be the new document, the provider shall stop sending the previous one's changes, and `onReload(listener)` listeners shall receive `{ reason, doc, previous }`. A change refused from a document a reload already replaced reloads nothing. The provider reads a previous document while it still holds unconfirmed changes; a host keeps it until then.

A provider of an older version reads no refused message (COLLAB-PROTOCOL-1.1): it keeps the refused change unconfirmed and sends it again after each handshake, so its connection is cut off once the room's conflict limit is reached (COLLAB-SERVER-7.7).

Implementation: `src/client/room-connection.ts`, `src/client/refused-changes.ts`, `src/client/unconfirmed-updates.ts`, `src/client/room-provider.ts`, `src/client/frames.ts`
Verification: `src/server/merge-refusals.test.ts`

## COLLAB-CLIENT-4 - Awareness, stateless messages and lifetime

### COLLAB-CLIENT-4.1 - Awareness

The provider shall send local awareness changes, apply the room's without sending them back, answer a query for every awareness state, and drop every remote state when its socket closes. On each open it shall set its local state again, which gives it a newer clock than the room kept when the last socket closed, and send that. Without `options.awareness` it shall create one for the document.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`, `src/client/frames.ts`, `src/client/socket-session.ts`
Verification: `src/client/room-provider.test.ts`, `src/client/frames.test.ts`

### COLLAB-CLIENT-4.2 - Stateless messages

`sendStateless(payload)` shall send a stateless message and return `true`, or return `false` when no socket is open. `onStateless(listener)` shall call the listener with each stateless payload from the room and return a function that stops it.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-4.3 - Remote origin

`isRemoteOrigin(origin)` shall be `true` exactly for the transaction origin the provider applies the server's updates and a restored unconfirmed update (COLLAB-CLIENT-3.3) with.

Implementation: `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-4.4 - Destroying

`destroy()` shall disconnect, stop listening to the document and awareness, destroy the awareness it created, and make `connect()` do nothing.

Implementation: `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`

## COLLAB-CLIENT-5 - Durability

### COLLAB-CLIENT-5.1 - Generations

Each connection attempt shall name the generation the document holds (`readRoomGeneration`, COLLAB-PROTOCOL-3.1) in the room URL, or none for a document that has not synced. When the server refuses it with `generation-mismatch`, the provider stops as for any refusal, and `roomGeneration` shall be the room's generation the server named before refusing (COLLAB-PROTOCOL-1.2), until a socket opens again; the host then opens the room again with a new document, which may merge in what the old one held.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`, `src/client/connection-state.ts`, `src/server/server-connection.ts`
Verification: `src/server/durability.test.ts`

### COLLAB-CLIENT-5.2 - Save status

`saveStatus` shall be the room's save status as the server last sent it on the current socket, and `null` before it has and after the socket closes.

Implementation: `src/client/room-connection.ts`, `src/client/frames.ts`, `src/client/connection-state.ts`
Verification: `src/server/durability.test.ts`

### COLLAB-CLIENT-5.3 - Waiting until stored

`whenStored()` shall resolve `true` once the room has stored every local change made before the call. It shall send its receipt request once the current socket has synced and sent what an earlier socket lost, sending it again on the next socket when one closes first, and resolve `false` when the provider is refused or destroyed first, including calls made after a refusal and before the next `connect()`. A read-only connection's changes never reach the room, so its receipt covers only the room's own changes.

Implementation: `src/client/store-receipts.ts`, `src/client/room-connection.ts`, `src/client/room-provider.ts`
Verification: `src/server/durability.test.ts`

### COLLAB-CLIENT-5.4 - Logger

With `options.logger`, the errors the provider catches, from a listener that throws or a frame it cannot handle, shall go to `logger.error` with the error in its details. Without one, each shall be rethrown in a microtask, as the platform reports an event listener's error.

Implementation: `src/client/connection-state.ts`, `src/client/socket-session.ts`, `src/client/room-connection.ts`, `src/client/room-provider.ts`
Verification: `src/client/connection-state.test.ts`
