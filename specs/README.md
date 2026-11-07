# Specs

Each file in this directory specifies one area of the library or one shared contract. Specs are the source of truth for behaviour; tests verify them.

## Ownership

| Document                             | Owns                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| [HOST-ADAPTERS.md](HOST-ADAPTERS.md) | The adapters a host passes in, their defaults and stored room states. |
| [PROTOCOL.md](PROTOCOL.md)           | The frames on the wire and room URLs.                                 |
| [CLIENT.md](CLIENT.md)               | The client provider and its connection state.                         |
| `<AREA>.md`                          | One area's behaviour.                                                 |

## File format

- File names are `UPPER-KEBAB.md`, named after the area (`HOST-ADAPTERS.md`, `PROTOCOL.md`).
- The first line is a `# Title` heading.
- Requirements are grouped under `## COLLAB-<AREA>-<n> - <Group title>` headings. Each requirement is a `### COLLAB-<AREA>-<n>.<m> - <Title>` heading followed by its statement, then two lines:

  ```markdown
  Implementation: `src/server/host/memory-persistence.ts`
  Verification: `src/server/host/memory-persistence.test.ts`
  ```

  - `<AREA>` is a short upper-case name for the spec (`HOST`, `PROTOCOL`, `ROOM`).
  - `Implementation:` lists the files that implement the requirement, each in backticks.
  - `Verification:` lists the tests that verify it, each in backticks. At least one of those tests names the requirement ID in a test title or comment.
  - Within a group, requirements are numbered from 1 without gaps and appear in number order, and groups appear in ascending order (gaps between group numbers are allowed). A requirement sits under its own group's heading.
  - IDs are never reused. A withdrawn requirement keeps its heading with the statement `Withdrawn.` and its last verification.

- Optional test sequences use `### COLLAB-<AREA>-T<n>.<m> - <Title>` headings for multi-step checks.

`npm run check:specs` enforces this format, including the group headings and numbering, the existence of every listed path, that the listed tests name each ID, and that every source module in `src/` (tests and `index.ts` files aside) is the `Implementation:` of some requirement.

## Host requirement IDs

Specs never mention a host application or its requirement IDs. A host that maps its own IDs to `COLLAB-` IDs keeps that map in its own repository.
