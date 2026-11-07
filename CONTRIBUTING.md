# Contributing

## Branches and pull requests

- `dev` is the integration branch. Work happens on short-lived branches cut from `dev` and merged back into `dev` by pull request.
- `main` is always releasable. It is updated only from `dev`, through a reviewed release pull request once the full checks pass on `dev`.
- `npm run check` must pass before a pull request merges.

## Versioning

The library is in `0.x` development. APIs are experimental until `1.0.0`: use minor versions for API additions, removals and reorganizations, and patches for fixes that keep the API. Remove obsolete APIs and migrate usage without deprecation periods or compatibility shims.

The wire protocol and the stored room state are stricter than the API: a client and a server of the same minor version always understand each other, and a state stored by any released version opens unchanged in every later version.

Releases are `v<version>` git tags, installed by hosts as git dependencies.

## Source rules

Code follows [docs/CODING-GUIDELINES.md](docs/CODING-GUIDELINES.md). In addition:

- **Host adapters only.** Identity, permissions, storage, logging, configuration and time come from the host's adapters. No globals, no singletons, no environment variables and no browser storage in library source.
- **Neutral wording.** Code, comments, docs, specs, fixtures, tests and package metadata never name a host application or its domain vocabulary. `npm run check:references` scans every authored file and path against the encoded denylist in `scripts/reference-denylist.json`. To add a term, append the output of `node scripts/check-references.mjs --encode '<regex>'`.

## Specs and tests

- Specs in `specs/` follow [specs/README.md](specs/README.md): `COLLAB-` requirement IDs with `Implementation:` and `Verification:` lines. `npm run check:specs` validates them.
- Unit tests (Vitest, Node) sit next to the source as `*.test.ts` and name the requirement IDs they verify.
