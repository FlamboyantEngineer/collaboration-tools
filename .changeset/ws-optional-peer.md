---
'@flamboyantengineer/collaboration-tools': minor
---

`ws` is now an optional peer dependency instead of a dependency, since only `./server/websocket` imports it: a host that uses that entry installs `ws` itself, and a client-only install no longer pulls it. The client also rejects a sync message of a type it does not know, as the server does, instead of applying it as an update.
