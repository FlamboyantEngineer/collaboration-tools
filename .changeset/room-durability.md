---
'@flamboyantengineer/collaboration-tools': minor
---

Rooms keep generations, save status and receipts. The server keeps its own metadata in the reserved `__room` type, which no member may change, including the room's generation: a room that starts over from its seed (missing, corrupt, or `stale`, a new load status) gets a new generation and stores it before anyone joins, and a client whose document holds another generation is refused with `generation-mismatch`. A host passes `seeds` to say what a room starts from and `metrics` to count and time loads, stores and new generations. Members see the room's `saveStatus`, and `provider.whenStored()` resolves once the room has stored every local change made before it. A failed store's retry now also covers changes made while it waits. The provider takes a `logger` for the errors it catches.
