# 0003. `core` is browser-safe: zod only, no `node:*`

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. The constraint dates from the initial
> package scaffold, 2026-07-30 (`5f24fce`, `0959288`). **The decision itself is
> inferred from construction** — no commit states "core must be browser-safe" as
> a ruling. What is *cited*, repeatedly and in the code, is every alternative
> that was rejected to preserve it. That inversion is what makes it ADR material
> rather than an accident of layout.

`packages/core` holds the event schemas, the reducer and the selectors. Both the
server and the web app fold the same log through them, and a portable record
(ADR-0009) should be verifiable by whoever receives it — including in a browser,
with no toolchain.

That only holds if `core` assumes nothing about its host. Any Node built-in
anywhere in it makes the browser bundle a separate build with separate
behaviour, and the shared-meaning property of ADR-0002 quietly becomes a
shared-source-file property instead.

## Considered Options

- **A — Let `core` use Node built-ins**, and bundle/polyfill for the browser.
- **B — Forbid `node:*` in `core`**, hand-rolling the few primitives needed.
- **C — Split `core` into `core` and `core-node`**, with the host-dependent parts
  in the latter.

## Decision Outcome

Chosen: **B**. `packages/core` has exactly one dependency (`zod`) and no
`node:*` import anywhere outside tests. Where a platform primitive was needed,
it was written by hand rather than imported.

Each of those hand-rollings is a rejected alternative recorded at its call site:

- **`node:crypto`** — rejected as Node-only. `record/hash.ts` implements SHA-256
  (FIPS 180-4) instead.
- **Web Crypto `subtle.digest`** — rejected because it is *async*, and would
  "force `buildRecord`/`verifyRecord` to stop being plain pure functions"
  (`record/hash.ts:1-8`). A purity constraint, not a portability one.
- **`TextEncoder`** — rejected as "a DOM/Node global this package doesn't
  assume"; UTF-8 encoding is hand-rolled beside the hash.
- **`node:path`** — rejected; `state.ts` carries a five-line `basename` with the
  comment "this module runs in the browser too".
- **Reading corpus fixtures from disk** — rejected in favour of binding them at
  import time through Vite's `?raw`, explicitly "so core keeps having no `node:*`
  anywhere" (`eras/corpus.ts:11`).

**A** was rejected implicitly and consistently: a polyfilled build means the
browser runs different code from the server, which is precisely what ADR-0002
exists to prevent.

**C** was never taken, and the cost of not taking it is small — the host-dependent
surface turned out to be four primitives, all under a hundred lines together.

## Consequences

**Good.** A record is verifiable anywhere, including in a browser with no
install. Server and web genuinely execute the same reducer, not two builds of it.

**Good.** `core`'s dependency surface is one package, which is most of why
`npm audit` is clean and the published bundle is small.

**Bad.** The project maintains its own SHA-256 and UTF-8 encoder. Both are
well-specified and well-tested, but they are cryptographic-adjacent code written
in-house, and that is a real if modest liability.

**Bad.** The constraint is enforced by discipline and review, not by tooling. No
lint rule forbids `node:*` in `core` — a future import would pass CI. Given the
repo's preference for enforcing laws with tests, this one is conspicuously
unenforced.

**Neutral.** `core` cannot read files, so anything file-shaped (the era corpus)
must be injected by its host. That has been a clarifying constraint rather than
a burden.
