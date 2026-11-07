# Testing Guidelines

Every unit test in `src/` and `test/` follows these rules, on top of the [coding guidelines](CODING-GUIDELINES.md). Tests verify the specs: they drive the library through its public functions and the host adapters, and they name the requirement they check. Rules marked **(enforced)** fail `npm run check`; the others are checked in review.

## Files and names

**T1. TypeScript next to the source.** A unit test is `<module>.test.ts` beside the module it tests (`memory-persistence.ts` → `memory-persistence.test.ts`). `test/` holds repository-wide tests and shared fixtures (`test/*-fixtures.ts`). **(enforced: Vitest only collects `*.test.ts`)**

**T2. Test names start with the requirement IDs they verify**, then say what a caller observes: `it('COLLAB-HOST-3.2 refuses a store built on a revision that is no longer current', …)`. A test may name several IDs; an ID may be split over several tests. `check:specs` fails when no test listed under a requirement's `Verification:` names its ID. **(enforced)**

## Speed and isolation

**T3. Tests are parallel-safe and order-independent.** Each test builds its own host, rooms and fixtures, and the Vitest config restores mocks and stubbed globals. Restore anything else a test changes (`vi.useRealTimers()`, listeners, open sockets and servers), listen on port `0` rather than a fixed port, write temporary files under `mkdtemp`, and never depend on another test's state. The suite runs four workers by default and must pass with any `--maxWorkers`.

**T4. Control time through the host clock or Vitest's fake timers,** never with real waits. Debounces, retries and timeouts are driven by advancing the clock.

**T5. Keep each test under the 5 second default on a loaded machine.** Split a long test into focused ones that start from the state they need.

**T6. Tests run in Node.** Client tests that need a socket connect to a server the test starts in the same process.

## Assertions

Adapted from the agent-rules testing set ([coding-rules/README.md](coding-rules/README.md)).

**T21. Assert what a caller or a host can observe:** returned values, the documents clients converge on, frames on the wire and the calls a host adapter receives. Do not assert private function names, call counts or internal call order unless the spec requires them.

**T22. Mock at a module or network boundary,** never the module under test. Prefer the in-memory adapters to mocks.

**T23. A snapshot is never the only assertion.**

**T24. Build test data with a small factory or a shared fixture** (`test/*-fixtures.ts`) instead of copying a large fixture between files.

**T25. Cover the failure paths a change introduces or touches:** refused, read-only, conflicting, corrupt and unavailable states, where they exist.

**T26. Never weaken an assertion or skip a test to make it pass.** Fix the code, or change the spec requirement and its test together. **(enforced: lint rejects `.skip`, `.only` and `.todo`)**
