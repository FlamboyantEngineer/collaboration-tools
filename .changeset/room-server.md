---
'@flamboyantengineer/collaboration-tools': minor
---

The server entry point runs rooms: `createRoomServer({ host })` admits connections through the host's auth adapter (which may name a room's canonical name for an alias), syncs documents and presence between members, keeps read-only members from changing a room, acknowledges content a client resends, stores each room through the host's persistence with a debounce, retries and conflict handling, and unloads a room once nothing holds it. `openRoom` gives a host a handle to change a room directly, and `attachRoomServer` serves the rooms over the WebSocket upgrades of a Node HTTP server. `CLOSE_CODES` names the close codes on the wire. The client renews its awareness clock on each open and no longer sends the room's awareness back to it.
