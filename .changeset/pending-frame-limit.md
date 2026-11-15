---
'@flamboyantengineer/collaboration-tools': minor
---

`createRoomServer` takes `maxPendingBytes` (default 4 MiB): frames a connection sends before it is admitted and joined wait in memory, each counting its length plus 64 bytes, and a connection that passes the limit is logged and closed with 1009. `broadcastStateless` finds its room by name instead of scanning the loaded rooms.
