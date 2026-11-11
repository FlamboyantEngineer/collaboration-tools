# Wire Protocol

The frames a client and a server exchange over one WebSocket per room. The protocol is the y-websocket protocol: the room travels in the URL, not in the frames, and every frame starts with a varUint message type. The extensions are defined here: an auth message that grants access, stateless messages, storage messages and the room metadata the server keeps in the document.

## COLLAB-PROTOCOL-1 - Messages

### COLLAB-PROTOCOL-1.1 - Message types

`MESSAGE_TYPES` shall number the messages `sync` 0 (the y-protocols sync messages), `awareness` 1 (a y-protocols awareness update), `auth` 2, `queryAwareness` 3 (a request for every awareness state), `stateless` 5 and `storage` 6. A reader that meets a message type it does not know shall stop reading that frame, so a newer peer can add types.

Implementation: `src/protocol/messages.ts`, `src/client/frames.ts`
Verification: `src/protocol/messages.test.ts`, `src/client/frames.test.ts`

### COLLAB-PROTOCOL-1.2 - Auth messages

An auth message shall be the subtype, a varUint, then a varString. Subtype 0 (`AUTH_SUBTYPES.denied`) is y-protocols' permission-denied message, and its string is the refusal reason. Subtype 1 (`AUTH_SUBTYPES.granted`) grants the connection access, and its string is `read-write` or `read-only`. Subtype 2 (`AUTH_SUBTYPES.generation`) names the room's generation (COLLAB-PROTOCOL-3.1) to a client about to be refused for holding another one, and its string is that generation; a reader that does not know it ignores it. `encodeAuthMessage(message)` shall write a whole auth frame, and `readAuthMessage(decoder)` shall read one after its message type, returning `null` for a subtype or access it does not know, or an empty generation. `isRoomAccess(value)` shall tell whether a value is one of the two accesses.

Implementation: `src/protocol/messages.ts`
Verification: `src/protocol/messages.test.ts`

### COLLAB-PROTOCOL-1.3 - Stateless messages

A stateless message shall carry one varString payload that the library passes through unread. `encodeStatelessMessage(payload)` shall write a whole stateless frame and `readStatelessMessage(decoder)` shall read its payload.

Implementation: `src/protocol/messages.ts`
Verification: `src/protocol/messages.test.ts`

### COLLAB-PROTOCOL-1.4 - Frame encoders

`encodeSyncStep1(doc)` shall write a sync step 1 frame with the document's state vector, `encodeSyncUpdate(update)` a sync update frame, and `encodeAwarenessFrame(update)` an awareness frame around an encoded awareness update. `CLOSE_CODES` shall name the close codes a server uses: `shutdown` 1001, `unavailable` 1011, `badRequest` 4400, `unauthenticated` 4401, `forbidden` 4403, `notFound` 4404, `conflict` 4409 and `gone` 4410.

Implementation: `src/protocol/frames.ts`, `src/protocol/messages.ts`
Verification: `src/protocol/frames.test.ts`

### COLLAB-PROTOCOL-1.5 - Storage messages

A storage message shall be the subtype, a varUint, then one varUint. Subtype 0 (`STORAGE_SUBTYPES.status`) is the server's save status, whose value numbers `saved` 0, `unsaved` 1, `saving` 2 and `retrying` 3. Subtype 1 (`receiptRequest`) is a client's request, and subtype 2 (`receipt`) the server's answer, each carrying the request's id. `encodeStorageMessage(message)` shall write a whole storage frame, and `readStorageMessage(decoder)` shall read one after its message type, returning `null` for a subtype or status it does not know.

Implementation: `src/protocol/messages.ts`
Verification: `src/protocol/messages.test.ts`

## COLLAB-PROTOCOL-2 - Room URLs

### COLLAB-PROTOCOL-2.1 - Building a room URL

`buildRoomUrl({ endpoint, room, token, params })` shall append the room to the endpoint's path as one `encodeURIComponent` segment, dropping trailing slashes from the path, keep the endpoint's own query except its reserved `token` and `generation` parameters, add each of `params` except `token` and `generation`, then the generation as the `generation` parameter (`GENERATION_PARAM`) and the token as the `token` parameter, each when there is one.

Implementation: `src/protocol/room-url.ts`
Verification: `src/protocol/room-url.test.ts`

### COLLAB-PROTOCOL-2.2 - Reading a room URL

`parseRoomUrl(path)` shall return the room decoded from the last path segment, the `token` parameter or `null`, the `generation` parameter or `null` when it is missing or empty, and every other parameter as an own data property, including prototype-named keys. It shall return `null` when the URL is invalid or the segment is empty or cannot be decoded.

Implementation: `src/protocol/room-url.ts`
Verification: `src/protocol/room-url.test.ts`

## COLLAB-PROTOCOL-3 - Room metadata

### COLLAB-PROTOCOL-3.1 - Generations

The server shall keep its own metadata in the top-level type `ROOM_META_TYPE` (`__room`), which hosts shall not use for content. Its `GENERATION_KEY` (`generation`) attribute is the room's generation: an id that changes each time the room starts over from a seed and discards its history. `readRoomGeneration(doc)` shall return the generation a document holds, or `null` for a document that has not synced with a room.

Implementation: `src/protocol/room-meta.ts`
Verification: `src/server/durability.test.ts`
