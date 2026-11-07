# Adopted Coding Rules

Part of the coding and testing guidelines is adapted from two MIT-licensed rule sets. The binding text is in [../CODING-GUIDELINES.md](../CODING-GUIDELINES.md) (the TypeScript `TS`, Node scripts `R`, security `SEC` and design `D` rules) and [../TESTING-GUIDELINES.md](../TESTING-GUIDELINES.md) (`T21` to `T26`). This folder records where they came from and carries the one file vendored verbatim.

| Source                                                                    | Commit                                     | What the library uses                                                                                                                                                                                                                                                                 | License                                                |
| ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [fabwaseem/agent-rules](https://github.com/fabwaseem/agent-rules)         | `3ed159bd93e9fa942bceb5df3169ac8f3a592137` | `rules/core/typescript.mdc`, `rules/node/node-runtime.mdc`, `rules/core/security.mdc` and `rules/core/testing.mdc`, adapted into the `TS`, `R` and `SEC` rules and `T21` to `T26`                                                                                                     | [LICENSE.agent-rules](LICENSE.agent-rules)             |
| [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) | `a7d7649044505b9c377c8dca28d2d6a543bc7f8c` | `a-philosophy-of-software-design/a-philosophy-of-software-design.mini.md`, vendored unchanged (below a two-line header naming this source, its commit and its license) as [a-philosophy-of-software-design.mini.md](a-philosophy-of-software-design.mini.md) and applied through `D1` | [LICENSE.agent-rules-books](LICENSE.agent-rules-books) |

## What was left out

The agent-rules React, Tailwind, shadcn, Next.js, NestJS, Prisma, Drizzle, accessibility, performance and git files are not adopted: the library's own rules are the rest of the coding guidelines and its specs (`specs/`). The HTTP parts of the Node.js and security sets (cookies, sessions, CSRF, response headers) are left out: the host owns its HTTP server, and the library only receives upgraded connections. Rules that conflict with an existing library rule were rewritten to the library rule.

## Updating

To take a newer upstream version, compare the upstream file at its new commit with the adapted rules, carry over changes that still fit, and update the commit column above. Replace the vendored mini file only with an unchanged upstream copy, and keep its two-line header naming the source, the new commit and the license.
