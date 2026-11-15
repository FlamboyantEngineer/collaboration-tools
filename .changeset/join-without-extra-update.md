---
'@flamboyantengineer/collaboration-tools': patch
---

A member that joins a room with a document holding deletions no longer costs the server a full encode of the room and an extra update frame: the server acknowledges content it holds already only for update messages, not for a sync step 2. The client's resend after the handshake still confirms an update whose echo was lost.
