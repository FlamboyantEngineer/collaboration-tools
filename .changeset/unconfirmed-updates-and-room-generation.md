---
'@flamboyantengineer/collaboration-tools': minor
---

Add `getUnconfirmedUpdate()` and the `unconfirmedUpdate` option to the client provider, so a host can keep local changes the room has not confirmed across a reload. A server that refuses a document from another generation now names the room's generation first (auth subtype `generation`), and the provider reports it as `roomGeneration`. Older clients ignore the new message.
