---
'@flamboyantengineer/collaboration-tools': minor
---

Rooms can carry write rules. A host's `permissions.rulesFor(room)` names the capability each top-level shared type needs, the types only the host's handles may change, and an optional finer `check` that may simulate a change on a copy of the room. The server reads which types and keys an update changes without applying it, refuses an update the rules do not allow (closing the connection with `unauthorized-write`), and drops an update that builds on content the room lacks, asking the client for the rest. Admission may return `capabilities` and an `expiresAt`; the server refreshes the decision through `auth.refresh` before it expires, applies a new access at once, and closes an expired connection so the client rejoins with a fresh token.
