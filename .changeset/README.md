# Changesets

Every pull request that changes the published package adds a changeset:

```sh
npx changeset
```

Until `1.0.0`, APIs are experimental: use minor changesets for API additions, removals and reorganizations, and patches for fixes that preserve the API. Describe current capabilities without migration notices or deprecation periods.

Starting at `1.0.0`, the wire protocol and stored room states are compatibility contracts (see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing)). `npx changeset version` turns pending changesets into the next version and changelog entry; [CONTRIBUTING.md](../CONTRIBUTING.md#releasing) has the release steps.
