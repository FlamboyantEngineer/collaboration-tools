# Client Provider

`createRoomProvider(options)` keeps a Yjs document and its awareness in sync with one room over a WebSocket. It reaches the network, time and connectivity only through its options: `createSocket` (default the platform `WebSocket`), `clock` (default the platform clock) and `connectivity` (default none). An editor reads the provider's document, its awareness and its connection state, and needs nothing else from it.

## COLLAB-CLIENT-1 - Connecting

### COLLAB-CLIENT-1.1 - Room URL and token

Each connection attempt shall open `buildRoomUrl({ endpoint, room, token, params })` (COLLAB-PROTOCOL-2.1), with the token `getToken()` returns for that attempt, so a host can refresh an expiring token between attempts.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`, `src/client/room-socket.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-1.2 - Sync handshake and connection state

The provider shall connect at once unless `connect` is `false`. On open it shall send a sync step 1 and, when it has one, its local awareness state; it shall answer the server's sync step 1 and apply the server's sync step 2 and updates with an origin of its own. `getState()` shall return the connection state: `status` (`connecting`, `connected` or `disconnected`), `access` (`pending` until the server grants access on the current socket, then `read-write` or `read-only`), `synced` (whether the current socket has received the server's sync step 2), `syncCount` (completed handshakes since creation), `hasUnconfirmedChanges`, `refusal` and `closeCode` (the close code of the last socket that closed, `null` when the provider closed it). A provider that has not connected shall report `disconnected`, `pending`, not synced and zero handshakes.

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

`subscribe(listener)` shall call the listener with the new state each time a field changes, and return a function that stops it. A listener that throws shall not stop the provider; its error is rethrown in a microtask.

Implementation: `src/client/connection-state.ts`, `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`, `src/client/connection-state.test.ts`

## COLLAB-CLIENT-2 - Keeping the connection

### COLLAB-CLIENT-2.1 - Reconnecting

While it should be connected, the provider shall open a new socket when one closes: at once after a socket that had opened, and after `2^n × 100` ms, capped at `maxBackoffMs` (default 2500), after the `n`-th attempt in a row that never opened. `disconnect()` shall close the socket and stop reconnecting, after telling the room the local awareness state is gone; `connect()` shall start again.

Implementation: `src/client/room-connection.ts`, `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-2.2 - Stale sockets

A socket that receives nothing for longer than `socketTimeoutMs` (default 45000) shall be closed and replaced. The check shall run every 4 seconds on the provider's clock. A pass that runs more than two cadences after the previous one shall measure silence from itself, so messages queued behind a long task get a full timeout; a late pass that follows another late pass shall keep the earlier start, so steady throttling still closes a dead socket.

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

After each completed handshake, the provider shall send an update holding the content still unconfirmed, so a change whose echo was lost with a socket is confirmed. The server acknowledges such a replay to its sender even when it changes nothing.

Implementation: `src/client/unconfirmed-updates.ts`, `src/client/room-connection.ts`
Verification: `src/client/room-provider.test.ts`

## COLLAB-CLIENT-4 - Awareness, stateless messages and lifetime

### COLLAB-CLIENT-4.1 - Awareness

The provider shall send local awareness changes, apply the room's, answer a query for every awareness state, and drop every remote state when its socket closes. Without `options.awareness` it shall create one for the document.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`, `src/client/frames.ts`
Verification: `src/client/room-provider.test.ts`, `src/client/frames.test.ts`

### COLLAB-CLIENT-4.2 - Stateless messages

`sendStateless(payload)` shall send a stateless message and return `true`, or return `false` when no socket is open. `onStateless(listener)` shall call the listener with each stateless payload from the room and return a function that stops it.

Implementation: `src/client/room-provider.ts`, `src/client/room-connection.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-4.3 - Remote origin

`isRemoteOrigin(origin)` shall be `true` exactly for the transaction origin the provider applies the server's updates with.

Implementation: `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`

### COLLAB-CLIENT-4.4 - Destroying

`destroy()` shall disconnect, stop listening to the document and awareness, destroy the awareness it created, and make `connect()` do nothing.

Implementation: `src/client/room-provider.ts`
Verification: `src/client/room-provider.test.ts`
