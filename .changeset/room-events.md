---
'@flamboyantengineer/collaboration-tools': minor
---

A host passes `events` to hear what happens in its rooms, such as to forward it to a webhook: a room loading and unloading, connections joining and leaving with their actor, each stored state with its revision and the actors whose changes it first holds, and a conflict with another writer. The server never waits for a listener, and logs one that throws or rejects. `NO_EVENTS` is the default.
