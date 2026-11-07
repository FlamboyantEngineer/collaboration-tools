# Coding Guidelines

Every file in `src/` and `test/` follows these rules; tests also follow [TESTING-GUIDELINES.md](TESTING-GUIDELINES.md). They follow the document editor library's guidelines, adapted to a library that runs on a server as well as in a browser and renders nothing. Rules marked **(enforced)** fail `npm run check`; the others are checked in review. Lint applies the size limits (C1), the no-class rule (I1) and the naming convention (N2, N3) to library source, `src/` without its tests.

## Naming

**N1. Files and directories are kebab-case,** named for what the module holds (`memory-persistence.ts`, `room-registry.ts`). **(enforced: `check:specs` lists every module by path)**

**N2. Functions say what they do.** Factories are `create<Thing>` (`createMemoryPersistence`), pure functions start with a verb (`resolveRoomHost`, `encodeSyncStep`), predicates start with `is` or `has`. **(enforced: camelCase)**

**N3. Types are PascalCase nouns.** An adapter a host implements is named for its role (`RoomAuth`, `RoomPersistence`); the options of a factory are `<Thing>Options`; a result a caller branches on is `<Action>Result`. **(enforced: PascalCase)**

**N4. One vocabulary.** A room is named by its `room` string, a stored state carries `revision` and `sequence`, and a connection's access is `read-write` or `read-only`. Do not introduce synonyms.

## Structure

**S1. Three places for code.** `src/protocol/` holds the wire protocol and what both sides share (room access, the clock), with no Node or DOM APIs; `src/client/` holds the client provider, which runs in a browser; `src/server/` holds the room server, which runs on Node. Each is an entry point with its own `index.ts`. `test/` holds repository-wide tests and shared fixtures.

**S2. `index.ts` only re-exports** the public API with named `export … from` statements. No default exports anywhere (TS7). **(enforced)**

**S3. Dependencies point one way.** `client/` and `server/` may import `protocol/`; neither imports the other, and `protocol/` imports neither.

**S4. Module order:** imports, exported types, module constants, private helpers, exported functions.

## Inheritance and composition

**I1. Factory functions and plain objects.** No classes in library source, except a subclass of a third-party class the library must hand back as that class (a Yjs document). **(enforced)**

**I2. Host adapters are interfaces.** The library declares what it needs from a host as an interface in `src/server/host/adapters.ts` (or the client's equivalent) and receives an implementation; it never reaches for a global, a singleton or the environment. **(enforced: lint for `process` and browser storage)**

## Simplicity

**C1. Small units.** A function has at most 80 lines and a cyclomatic complexity of at most 15, nests at most three levels deep, and takes at most three parameters (pass an options object instead). A module has at most 300 lines; split helpers into sibling modules before that. **(enforced in library source)**

**C2. No speculative surface.** Every export and option is exercised by a unit test. Remove what nothing uses.

**C3. Comments explain why, not what.** Document public functions and types in one line of TSDoc; comment only non-obvious constraints and workarounds. No commented-out code, no narration, no decorative separators.

**C4. No dead code.** No unused exports, parameters, branches or files. **(enforced: lint for unused variables, parameters and imports; `check:specs` for files no requirement names)**

## TypeScript

Adapted from the agent-rules TypeScript set ([coding-rules/README.md](coding-rules/README.md)). They apply to every TypeScript file. The enforced ones run in `npm run lint` through the `collaboration-tools/typescript` configs in `eslint.config.js`, which load the TypeScript program; ESLint runs with a 6 GB heap for that reason.

**TS1. `strict` stays on.** Do not weaken `tsconfig.json` to make a file compile.

**TS2. No `any`.** Use `unknown` and narrow it; wrap a third-party `any` at the boundary that receives it. **(enforced: `@typescript-eslint/no-explicit-any`)**

**TS3. No non-null assertions (`value!`).** Narrow the value, restructure so the type proves it, or throw an `Error` where the invariant would break. **(enforced: `@typescript-eslint/no-non-null-assertion`)**

**TS4. No `@ts-ignore` or `@ts-nocheck`.** A `@ts-expect-error` carries a description of what removes it. **(enforced: `@typescript-eslint/ban-ts-comment`)**

**TS5. Import a type-only binding with `import type`** (S2). An import whose names are all types is a whole `import type` statement, so the compiled module drops it instead of keeping an empty side-effect import. **(enforced: `@typescript-eslint/consistent-type-imports`, `@typescript-eslint/no-import-type-side-effects`)**

**TS6. No `enum`.** Use a string-literal union, or an `as const` object with a derived type. **(enforced)**

**TS7. Named exports only.** A default export is allowed only where a loader requires it: the Vitest configuration file. **(enforced: `no-restricted-exports`)**

**TS8. A `switch` over a union handles every member,** or ends in a `default` that handles the rest on purpose. **(enforced: `@typescript-eslint/switch-exhaustiveness-check`)**

**TS9. No floating promises.** `await` a promise, return it, or mark a deliberately detached one with `void` and handle its rejection. Do not pass an async function where the callee expects a synchronous callback. **(enforced: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`)**

**TS10. Throw and reject with `Error` objects,** never strings or plain objects. Rethrowing a caught `unknown` value is allowed. **(enforced: `@typescript-eslint/only-throw-error`, `@typescript-eslint/prefer-promise-reject-errors`)**

**TS11. When a `catch` block throws a new error, attach the caught one as `{ cause }`.** **(enforced: `preserve-caught-error`)**

**TS12. Return a discriminated result for expected failures** a caller branches on (`{ ok: true, value } | { ok: false, error }`) instead of throwing.

**TS13. Prefer `type` for unions and derived shapes,** and `interface` for object shapes callers extend, such as adapters (N3, I2).

**TS14. Give an exported function an explicit return type** when the inferred one is a wide object or a promise the caller must branch on.

**TS15. Three compiler programs check the code** (`npm run typecheck`).

- `tsconfig.json` checks library source, tests and configs with Node's globals, which the tests need.
- `tsconfig.build.json` checks library source again without them (`types: []`), as the build compiles it.
- `tsconfig.scripts.json` checks the Node scripts and `eslint.config.js` as JavaScript (`checkJs`). An unannotated parameter there is `any`, and everything else is strict.
- Library source compiles in both global environments, so a timer handle is typed `ReturnType<typeof setTimeout>`, which holds in both.
- Beyond `strict`, the programs set `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch`.
- Three flags are deliberately off:
  - `exactOptionalPropertyTypes`: optional fields declare `| undefined` so callers may pass `undefined`; the flag would also reject spreading partial objects.
  - `noPropertyAccessFromIndexSignature`: records keyed by id are read with dot access.
  - `isolatedDeclarations`: public types are inferred where TS14 does not ask for them.
    **(enforced: `npm run typecheck`)**

## Node scripts

Adapted from the agent-rules Node.js set. They apply to `scripts/` and the configuration files; library source reads no `process.env`.

**R1. Target the Node version in `package.json` `engines`** (Node 22).

**R2. Read options from arguments,** and environment variables only at the script's entry point, with a default.

**R3. Fail loudly.** A check exits non-zero with a message naming the file and the rule it broke; an unexpected failure stays an `Error` with its original `cause`.

**R4. Scripts that write files can run twice with the same result,** and a script that deletes files deletes only build output.

## Security

Adapted from the agent-rules security set. They apply everywhere.

**SEC1. Every frame from a client is untrusted.** Decode it defensively, bound what it may allocate, and check what it changes against the connection's access before it reaches the room's document.

**SEC2. No `eval`, `new Function` or string timers.**

**SEC3. Authentication belongs to the host.** The library passes tokens to the host's auth adapter and never parses, stores or logs them.

**SEC4. Keep secrets and tokens out of the repository, out of logs and out of browser storage.**

**SEC5. Pass shell arguments as arrays** (`execFileSync(command, args)`), never as a concatenated command string.

**SEC6. Add dependencies through `npm`** so the lockfile records them.

## Design

**D1. Design for less complexity.** New and touched code follows [coding-rules/a-philosophy-of-software-design.mini.md](coding-rules/a-philosophy-of-software-design.mini.md), vendored unchanged from agent-rules-books. It is review guidance, not lint. In short: measure a design by the complexity a reader must carry, prefer deep modules with small interfaces over pass-through layers, keep each decision inside the module that owns it, define invalid states away rather than making callers defend against them, and use names and comments to state contracts, not mechanics. Where it overlaps a numbered rule, the numbered rule wins.
