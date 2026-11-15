---
'@flamboyantengineer/collaboration-tools': minor
---

Room write rules can open a guard once per room, `openGuard(shadow)`, on a shadow copy of the room that the server keeps in step with every change the room takes. Each update the lists and `check` allow is applied to the shadow before the guard's `check` decides, so a guard can keep a live reading of the room and each check costs the update's size instead of a copy of the room. A refusal rebuilds the shadow at the next guarded update. `RoomWriteChange.simulate` is removed: use a guard instead.
