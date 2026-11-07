# Host Adapters

A host runs rooms by passing a `RoomHost`: the adapters through which the library reaches identity, permissions, storage, logging and time. The library reads no globals, environment or browser storage, so several hosts can run in one process.

## COLLAB-HOST-1 - Host contract

### COLLAB-HOST-1.1 - Required and optional adapters

A `RoomHost` shall require an `auth` adapter (`RoomAuth`) and a `persistence` adapter (`RoomPersistence`), and shall accept optional `permissions` (`RoomPermissions`, COLLAB-SERVER-7.2), `seeds` (`RoomSeeds`, COLLAB-SERVER-8.2), `metrics` (`RoomMetrics`, COLLAB-SERVER-8.5), `logger` (`RoomLogger`) and `clock` (`RoomClock`). `RoomAuth.admit(request)` shall receive the room the client asked for, the token it sent (or `null`), the URL's other query parameters and the upgrade request's headers, and shall resolve to either `{ ok: true, actor, access, room?, capabilities?, expiresAt? }`, where `access` is `read-write` or `read-only`, `room` is the canonical name of a room the client named by an alias, `capabilities` are what the room's write rules check, and `expiresAt` is when the decision expires (COLLAB-SERVER-7.4), or `{ ok: false, reason }`, where `reason` is `unauthenticated`, `forbidden` or `not-found`. Library source shall not read `process`, `localStorage`, `sessionStorage` or `indexedDB`.

Implementation: `src/server/host/adapters.ts`, `eslint.config.js`
Verification: `src/server/host/host.test.ts`

## COLLAB-HOST-2 - Defaults

### COLLAB-HOST-2.1 - Resolving a host

`resolveRoomHost(host)` shall return the host's adapters with `NO_PERMISSIONS`, which gives no room any rules, in place of missing permissions, `EMPTY_SEEDS`, which starts every room empty, in place of missing seeds, `NO_METRICS`, which records nothing, in place of missing metrics, `SILENT_LOGGER`, which drops every message, in place of a missing logger and `PLATFORM_CLOCK` in place of a missing clock. Adapters the host passes shall be kept as they are.

Implementation: `src/server/host/host.ts`
Verification: `src/server/host/host.test.ts`

### COLLAB-HOST-2.2 - Platform clock

`PLATFORM_CLOCK` (from the protocol entry point, shared with the client) shall read the time from `Date.now` and schedule and cancel callbacks with the global timers.

Implementation: `src/protocol/clock.ts`
Verification: `src/server/host/host.test.ts`

## COLLAB-HOST-3 - Stored states

### COLLAB-HOST-3.1 - Loading and storing

A stored state shall carry a Yjs update that rebuilds the room's document from empty, the host's opaque `revision`, which the library only compares for equality, and an integer `sequence`, which orders the room's stored states. `load(room)` shall resolve to `found` with the state, `missing` for a room never stored, `corrupt` with a reason and the unreadable state's revision and sequence, `stale` with a reason and the revision and sequence of a readable state that is out of date with the host's own record of the content, or `unavailable` with an error when storage fails. `createMemoryPersistence(options)` shall keep states in memory, report a room it never stored as `missing`, and give each stored state a new revision (from `options.createRevision`, by default a random UUID) and the sequence after the room's current one, starting from 1 or from the sequence of a state passed in `options.initial`.

Implementation: `src/server/host/adapters.ts`, `src/server/host/memory-persistence.ts`
Verification: `src/server/host/memory-persistence.test.ts`

### COLLAB-HOST-3.2 - Compare-and-set stores

`store(input)` shall store `input.update` only when `input.baseRevision` is the room's current revision, or `null` for a room with no stored state. Otherwise it shall store nothing and resolve to `conflict` with the room's current revision and sequence, or `null` when it has none.

Implementation: `src/server/host/adapters.ts`, `src/server/host/memory-persistence.ts`
Verification: `src/server/host/memory-persistence.test.ts`

### COLLAB-HOST-3.3 - Own copies

The in-memory persistence shall copy every update it receives and every state it returns, so a caller that changes those bytes changes nothing stored. `peek(room)` shall return a copy of the room's current state, or `undefined`.

Implementation: `src/server/host/memory-persistence.ts`
Verification: `src/server/host/memory-persistence.test.ts`
