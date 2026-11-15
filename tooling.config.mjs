// This repository's settings for the checks shared through ui-components' tooling (its
// specs/TOOLING.md), which `npm run check:references`, `check:specs` and `check:structure` run.

export default {
  // Every library module carries behaviour some requirement specifies.
  specs: { prefix: 'COLLAB', everyModuleImplemented: true },
  structure: {
    names: ['src', 'test', 'scripts'],
    typeImportCycles: true,
    // S1 and S3: only server/ runs in Node; client/ and server/ meet only in protocol/, and the
    // in-process testing helpers pair a client with a server.
    layers: {
      protocol: { imports: [], browser: true },
      client: { imports: ['protocol'], browser: true },
      server: { imports: ['protocol'] },
      testing: { imports: ['protocol', 'client', 'server'], browser: true },
    },
  },
};
