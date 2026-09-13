# 5. No runtime dependencies

**Status:** accepted

## Context

The engine needs storage, compression, an HTTP server and a test runner. Mature
libraries exist for all four.

## Decision

Zero runtime dependencies. Node built-ins only: `node:sqlite`, `node:zlib`,
`node:http`, `node:test`. Enforced by CI.

## Why

This is a research artefact as much as a library, and its results are supposed
to be reproducible. A dependency tree is the single most likely reason that
"clone it and run it" fails in five years — a yanked package, a transitive
breaking change, a lockfile that no longer resolves.

Node's built-ins now cover the requirements adequately. `node:sqlite` in
particular removes the one dependency that would otherwise have needed native
compilation, which is also the one most likely to break on an unfamiliar
platform.

There is a secondary benefit: the same source runs in Node and in a browser
without a bundler, so the demo exercises the code the tests exercise rather than
a compiled copy of it.

## Consequences

- No TypeScript. Types are expressed as JSDoc, which gives editor support and
  `tsc --checkJs` if wanted, without a build step.
- No linter or formatter. `scripts/check.js` covers what matters — parsing,
  import resolution, orphaned modules — and style is left to review.
- `node:sqlite` is experimental and requires a flag, which is inherited by
  everything that touches storage.
- Anything genuinely needing a dependency does not get built. So far nothing
  has.
