# collaboration-tools

Real-time Yjs collaboration for any kind of shared content: a room server, a client provider and the wire protocol between them.

- **Host adapters.** A host passes adapters for authentication, permissions, persistence, logging and time ([specs/HOST-ADAPTERS.md](specs/HOST-ADAPTERS.md)). The library reads no globals, so several hosts run in one process.
- **Any content.** A room holds one Yjs document. Content adapters seed it from a stored snapshot and project it back, so documents, spreadsheets and records share one engine.
- **Optional.** Editors depend only on a shared document, an awareness instance and a connection state, so a host can use this library or its own server.

The library is in early `0.x` development and has no release yet.

## Entry points

| Entry point                                                | Contents                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@flamboyantengineer/collaboration-tools/protocol`         | The wire protocol, room URLs and the clock both sides share. Safe on a server and in a browser.                          |
| `@flamboyantengineer/collaboration-tools/client`           | The client provider and its connection state.                                                                            |
| `@flamboyantengineer/collaboration-tools/server`           | The room server, the host adapter contracts and in-memory storage. Imports no Node module, so it also runs in a browser. |
| `@flamboyantengineer/collaboration-tools/server/websocket` | The WebSocket attachment for a Node HTTP server, through `ws`.                                                           |
| `@flamboyantengineer/collaboration-tools/testing`          | In-process sockets that connect client providers to a room server without a network, for tests and labs.                 |

`@y/y` (Yjs 14) is a peer dependency, so the host and the library share one Yjs. `ws` is an optional peer dependency: install it only to use `./server/websocket`, so a client-only install does not pull it.

## Develop

Node 22 is required.

```sh
npm ci
npm run check   # every gate: lint, format, types, references, specs, build and tests
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the branch, versioning and source rules.

## Host mutations and durable commits

Room handles expose detached snapshots and validated, attributed transactions. The callback receives a candidate document; keeping it cannot change the live room later.

```ts
const handle = await server.openRoom('shared');
const accepted = handle.transact(
  { actor: { id: 'service' }, capabilities: ['edit'] },
  (candidate) => candidate.get('content').insert(0, 'Hello'),
);
if (accepted) await handle.flush({ timeoutMs: 5000 });
handle.release();
```

A flush returns the durable room version and rejects if it cannot guarantee persistence. A signal or timeout bounds the wait while storage retries continue. Failed shutdown retains pending state: read `server.recover()` and retry `server.close()` after storage recovers.

Use `server.commitRoom(room, async snapshot => ({ value, version }))` when a canonical commit also changes the persistence revision. Older checkpoints finish first; later edits continue syncing and wait for the returned revision before their next checkpoint. Commit the canonical state and returned version atomically. Do not nest a serialized operation on the same room inside that callback. `server.invalidate(room)` returns recoverable pending state, fences old handles and clients, and reseeds a new generation on the next load.

`rulesFor(room)` can supply `openGuard(shadow)`. Its synchronous guard sees each candidate transaction on a persistent shadow before acceptance, with the admitted actor and capabilities. Rejected changes never reach the live document. A guarded room holds two documents; accepted updates do not copy the full room.

Presence includes an authenticated `actor` envelope. The default `user` is also authenticated; other presence fields are client supplied. A host can normalize its `user` schema through `host.awareness`, while `actor` remains server controlled. `revoke` and `reauthorize` target the intersection of room, actor and optional admission session id.
