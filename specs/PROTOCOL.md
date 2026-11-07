# Wire Protocol

The frames a client and a server exchange over one WebSocket per room. The protocol is the y-websocket protocol: the room travels in the URL, not in the frames, and every frame starts with a varUint message type. Two extensions are defined here: an auth message that grants access, and stateless messages.

## COLLAB-PROTOCOL-1 - Messages

### COLLAB-PROTOCOL-1.1 - Message types

`MESSAGE_TYPES` shall number the messages `sync` 0 (the y-protocols sync messages), `awareness` 1 (a y-protocols awareness update), `auth` 2, `queryAwareness` 3 (a request for every awareness state) and `stateless` 5. A reader that meets a message type it does not know shall stop reading that frame, so a newer peer can add types.

Implementation: `src/protocol/messages.ts`, `src/client/frames.ts`
Verification: `src/protocol/messages.test.ts`, `src/client/frames.test.ts`

### COLLAB-PROTOCOL-1.2 - Auth messages

An auth message shall be the subtype, a varUint, then a varString. Subtype 0 (`AUTH_SUBTYPES.denied`) is y-protocols' permission-denied message, and its string is the refusal reason. Subtype 1 (`AUTH_SUBTYPES.granted`) grants the connection access, and its string is `read-write` or `read-only`. `encodeAuthMessage(message)` shall write a whole auth frame, and `readAuthMessage(decoder)` shall read one after its message type, returning `null` for a subtype or access it does not know. `isRoomAccess(value)` shall tell whether a value is one of the two accesses.

Implementation: `src/protocol/messages.ts`
Verification: `src/protocol/messages.test.ts`

### COLLAB-PROTOCOL-1.3 - Stateless messages

A stateless message shall carry one varString payload that the library passes through unread. `encodeStatelessMessage(payload)` shall write a whole stateless frame and `readStatelessMessage(decoder)` shall read its payload.

Implementation: `src/protocol/messages.ts`
Verification: `src/protocol/messages.test.ts`

## COLLAB-PROTOCOL-2 - Room URLs

### COLLAB-PROTOCOL-2.1 - Building a room URL

`buildRoomUrl({ endpoint, room, token, params })` shall append the room to the endpoint's path as one `encodeURIComponent` segment, dropping trailing slashes from the path, keep the endpoint's own query, add each of `params` except `token`, and add the token as the `token` parameter when there is one.

Implementation: `src/protocol/room-url.ts`
Verification: `src/protocol/room-url.test.ts`

### COLLAB-PROTOCOL-2.2 - Reading a room URL

`parseRoomUrl(path)` shall return the room decoded from the last path segment, the `token` parameter or `null`, and every other parameter. It shall return `null` when the segment is empty or cannot be decoded.

Implementation: `src/protocol/room-url.ts`
Verification: `src/protocol/room-url.test.ts`
