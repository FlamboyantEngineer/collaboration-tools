---
'@flamboyantengineer/collaboration-tools': minor
---

A room's write guard checks itself: after every change the shadow's state vector is compared with the room's, and every `verifyEvery` changes and on idle (`verifyIdleMs`) the guard's optional `verify()` compares its kept reading with the shadow. A drifted shadow is rebuilt from the room and reported as a `guard-repaired` event and a warning. A refused update now rebuilds the shadow at once.
