---
'@flamboyantengineer/collaboration-tools': patch
---

A room's presence now expires on the host's `clock`: a presence not renewed for 30 s is removed and every member is told, where before each room ran its own platform interval that a host's clock did not control and whose removals no member heard.
