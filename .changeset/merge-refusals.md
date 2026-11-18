---
'@flamboyantengineer/collaboration-tools': minor
---

A room's guard can refuse an update for its merge with the room (`check` answers `'conflict'`) rather than for the writer's rights. The server then keeps the writer connected and sends it a new `refused` message (type 7) with the reason and the update's content ids; past `conflictLimit` (10 a minute by default) the connection is cut off as for a refused write. The provider never sends the refused change again, sends a fill so its later changes still reach the room, reloads its document from the room and hands it over through `onReload`; `refusedChanges` counts the refusals. Unconfirmed changes are now sent one update per change, so the room refuses only the one that does not merge: `getUnconfirmedUpdate()` and `unconfirmedUpdate` become `getUnconfirmedUpdates()` and `unconfirmedUpdates`. An older provider ignores the refused message and is cut off at the limit.
