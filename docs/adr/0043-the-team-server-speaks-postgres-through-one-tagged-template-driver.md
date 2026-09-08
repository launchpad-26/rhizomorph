# 0043. The team server speaks Postgres through one tagged-template driver

- **Status:** accepted (prd-51 ruling 5, recorded on the prd-51 wave-2 build)
- **Date:** 2026-09-08

## Context and Problem Statement

prd-51 ruling 5 puts the team server's storage on Postgres and keeps one discipline from the
SQLite-first design it deviates from: **storage behind an interface, no SQL in route handlers**, so
the engine stays a re-deployment rather than a rewrite. ADR-0035 makes the server a container, with
migrations applied on boot from SQL files tracked in `_migrations`.

Neither record names a driver, and `packages/team` is the first package in this repository to need
one. The repository is deliberately dependency-thin — `fastify` is the only production dependency
at the root and `zod` the only one in `packages/core` — and its `pack-smoke` job installs the packed
tarball on a 3×2 matrix of operating systems and node versions, so every transitive package is a
leg that can fail for reasons unrelated to this repository. TypeScript here is 7.0.2 with
`moduleResolution: Bundler`, which is new enough that a library's type definitions are worth
checking rather than assuming.

What the driver has to support is small and fixed by rulings 4, 5 and 13: parameterised inserts,
an explicit transaction, multi-statement DDL from a tracked file, and reading one server setting.
No ORM feature, no schema DSL, no query builder appears anywhere in those rulings.

## Considered Options

- **A — `pg` (node-postgres) 8.23.0**, the de-facto standard client.
- **B — `postgres` (postgres.js) 3.4.9**, a tagged-template client with no dependencies.
- **C — a query builder or ORM** (Drizzle, Kysely, Slonik) on top of one of them.
- **D — no driver in this wave**: define the interface, add the dependency with the ingest route.

## Decision Outcome

Chosen: **B, `postgres` 3.4.9**, pinned exact, as the only dependency `packages/team` adds.

Measured, in two throwaway project directories, on node v22.23.2:

| | A: `pg` | B: `postgres` |
|---|---|---|
| package.json entries required | **2** — `pg` plus `@types/pg`, since `pg` ships no types | **1** — types are first-party |
| packages installed | **17** | **1**, zero transitive dependencies |
| ESM named import under `"type": "module"` | works | works |
| typechecks under TypeScript 7.0.2 | yes | yes |

Three reasons B wins, in order of weight:

1. **The unsafe path is the one named `unsafe`.** Ruling 5's discipline is enforceable here as a
   grep law with a small, precise surface: a query needs either a tagged template or
   `sql.unsafe(...)`, and both are greppable. With A, a query is `client.query(<any string>)`, and
   the law has to reason about strings rather than about a capability.
2. **One entry, and one package.** The issue that adds this dependency is the wave's only
   dependency change, and A needs two manifest entries because its types live in DefinitelyTyped —
   a second publisher, on its own release cadence. Sixteen fewer installed packages is sixteen
   fewer `pack-smoke` legs that can 404 on a fresh transitive publish, which has happened here.
3. **Nothing in rulings 4, 5 or 13 needs A's ecosystem.** The plugins that make `pg` worth its
   dependency tree — `pg-copy-streams`, `pg-query-stream` — answer questions this design does not
   ask; postgres.js covers `COPY` and cursors in the box.

**A lost** on manifest arithmetic and transitive surface, not on quality: it is the more widely
deployed client, and if the surface `packages/team` needs ever grows past what postgres.js does
well, A is the migration this ADR would be superseded by. The argument this record deliberately
does **not** make is ESM friction — that was measured and both clients import cleanly under node
22, and recording the falsification is cheaper than re-testing it later.

**C lost** because it competes with rulings that already exist. Ruling 13 requires migrations as
tracked SQL files applied on boot; every builder in the class brings its own migration story and
its own schema DSL, so adopting one means either running two migration systems or abandoning
ruling 13's. It also adds manifest entries on top of a driver rather than instead of one, and the
partition, BRIN, `BYPASSRLS` and row-level-security DDL this schema needs is not what a builder's
abstraction is for.

**D lost** because it makes the wave-3 ingest lane do two jobs — add the dependency *and* write the
route — which is the stack that prd-51's wave structure exists to avoid, and because an interface
typed against nothing is an interface nobody has checked can be implemented.

## Consequences

**Good.** One dependency, zero transitive packages, first-party types. The team package's
`node_modules` footprint is one directory.

**Good.** Parameterisation is the default and un-parameterised SQL has to say `unsafe` out loud,
which is a stronger version of ruling 5's discipline than a naming convention.

**Bad.** postgres.js has a far smaller maintainer base than node-postgres. If it stops being
maintained, every call site changes — which is precisely the risk ruling 5's interface exists to
bound, and the bound is only as good as the law that keeps SQL inside
`packages/team/src/storage/postgres.ts`.

**Bad.** A tagged-template client makes a SQL fragment a first-class *value*, so SQL can in
principle leave the storage module as an object even when no string literal does. The law tests
both the literals and the capability (the driver import and the `unsafe` call), because the literal
sweep alone would not see it.

**Bad.** `sql.unsafe()` exists, and one call site legitimately needs it: multi-statement DDL from a
tracked migration file cannot go through a tagged template. That call site is the one the law
allows, and any second one is a decision, not a convenience.

**Neutral.** Operator muscle memory is `pg`-shaped — the connection lifecycle, the pool options and
most of the answers on the internet assume it. The migration path away, if it is ever taken, is
`packages/team/src/storage/postgres.ts` and `packages/team/src/storage/driver.ts`, and nothing
else: that is the interface in `packages/team/src/storage/contract.ts` doing its job.
