---
'@flamboyantengineer/collaboration-tools': minor
---

The `./server` entry point no longer imports Node modules, so a room server also runs in a browser. `attachRoomServer` moves to the new `./server/websocket` entry point. The new `./testing` entry point exports `connectToServer`, in-process sockets that connect client providers to a room server without a network.
