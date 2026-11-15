---
'@flamboyantengineer/collaboration-tools': patch
---

A change made by a connection or handle that joins and leaves a room while the room stores before unloading is now stored before the room unloads, instead of being dropped. A room also never runs two stores at once when a flush starts between two of its stores.
