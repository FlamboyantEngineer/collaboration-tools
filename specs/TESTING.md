# Testing

The `./testing` entry point holds what a host needs to run its own tests and labs against a real room server without a network. It imports no Node module (COLLAB-SERVER-9.1), so it also runs in a browser page.

## COLLAB-TESTING-1 - In-process sockets

### COLLAB-TESTING-1.1 - Paired sockets

`connectToServer(server, headers?)` shall return a `createSocket` factory for the client provider and the list of sockets it opened. Each socket shall be paired with `server.connect`, using the socket URL's path and query and `headers` as the request, and shall open in a microtask. Frames shall travel in each direction in queued microtasks, as over a WebSocket, so providers run their real handshake, echoes and awareness. Each socket shall record every frame it sent and received, the code and reason the server closed it with, and whether it is closed. `drop()` shall close it with code 1006 as a network failure would; a `deaf` socket shall discard the server's frames; frames the server sent before it closed the socket shall still arrive, while nothing arrives once the client closed or dropped it. Sending on a closed socket shall throw.

Implementation: `src/testing/in-process-sockets.ts`
Verification: `src/testing/in-process-sockets.test.ts`
