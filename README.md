# collaboration-tools

Real-time Yjs collaboration for any kind of shared content: a room server, a client provider and the wire protocol between them.

- **Host adapters.** A host passes adapters for authentication, permissions, persistence, logging and time ([specs/HOST-ADAPTERS.md](specs/HOST-ADAPTERS.md)). The library reads no globals, so several hosts run in one process.
- **Any content.** A room holds one Yjs document. Content adapters seed it from a stored snapshot and project it back, so documents, spreadsheets and records share one engine.
- **Optional.** Editors depend only on a shared document, an awareness instance and a connection state, so a host can use this library or its own server.

The library is in early `0.x` development and has no release yet.

## Entry points

| Entry point                                        | Contents                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@flamboyantengineer/collaboration-tools/protocol` | The wire protocol, room URLs and the clock both sides share. Safe on a server and in a browser. |
| `@flamboyantengineer/collaboration-tools/client`   | The client provider and its connection state.                                                   |
| `@flamboyantengineer/collaboration-tools/server`   | The room server, its WebSocket attachment, the host adapter contracts and in-memory storage.    |

`@y/y` (Yjs 14) is a peer dependency, so the host and the library share one Yjs.

## Develop

Node 22 is required.

```sh
npm ci
npm run check   # every gate: lint, format, types, references, specs, build and tests
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the branch, versioning and source rules.
