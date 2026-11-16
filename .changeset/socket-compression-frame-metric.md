---
'@flamboyantengineer/collaboration-tools': minor
---

`attachRoomServer` takes an opt-in `compression` (per-message deflate, 4 KiB threshold, level 3, no context takeover, concurrency 8 by default; the payload cap applies to the inflated size) and an `onFrameSent` recorder told each frame written, per recipient, by type and uncompressed size.
