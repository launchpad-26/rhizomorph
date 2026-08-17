# 0014. Every route is declared into one of three classes, checked by walking the running app

- **Status:** accepted — amended by [ADR-0024](0024-a-gated-read-is-the-fourth-route-class.md) (the fourth class, `gated-read`, and the gate-presence law)
- **Date:** 2026-08-12

## Context and Problem Statement

`server/mutation-guard.ts`'s Origin/Host/Content-Type guard (ADR-0008) applies globally, once, at
app assembly — no route's author can forget it. `requireCapabilityToken` (`api/security.ts`) never
worked that way: its own comment called adoption "deliberately incremental", opted into per route
by whichever author remembered to add the `preHandler`. That produced the same defect twice. #234
gated `POST /api/label`, the first route the audit reached; `POST /api/rotate` mutates exactly the
same recording and is called from the same dashboard, but sat ungated for another cycle until a
second pass (#249's audit) caught it. Incremental adoption does not fail loudly when a route is
missed — it just leaves that route open, indistinguishable from a route that was never meant to be
gated at all (prd-23's own inbox, ruling 6).

prd-23 ruling 5 asks for a law: every route this app registers belongs to exactly one declared
class, and adding a mutating route with no class fails the build rather than shipping open.

## Considered Options

- **A — Keep incremental adoption; catch a missing `preHandler` in code review.** The status quo.
- **B — A declared classification table, walked against the real, running Fastify instance.** Every
  route this app registers gets one row (`gated-mutation` / `ungated-mutation` / `read`); a test
  builds the real app, reads every route Fastify actually registered (via an `onRoute` hook wired in
  at `buildApp` assembly, before any route registers — the only way to see routes an encapsulated
  plugin registers, like `api/otel.ts`'s three), and fails if any registered route has no row.
- **C — Infer the class automatically from each route's own options** (e.g., "has
  `requireCapabilityToken` in its `preHandler` chain" ⇒ gated; "is a `POST` with none" ⇒ assume a
  hole and fail). No declared table at all.

## Decision Outcome

Chosen: **B**.

**A is what already produced the defect this ruling exists to retire** — review is exactly the
mechanism that already failed twice (#234 landed the label lane's own gate but not rotate's, and the
audit that caught it was a second, separate pass, not the first review).

**C was seriously considered and rejected**, not a strawman: it would remove the hand-maintained
table entirely. It fails on the one distinction the whole law exists to make: a `POST` with no
`preHandler` is either an oversight (the bug) or the OTLP inbox, deliberately ungated by design
(ruling 6) — and "does this route have a capability-token preHandler" cannot tell those apart, because
the second case is defined by its *absence*. Inferring "ungated" from the same signal as "forgot to
gate it" is exactly the ambiguity a law is supposed to remove, not encode. A declared table makes
every route's status an explicit, checked-in fact instead of something derived from what isn't there.

So **B**: `api/index.ts`'s `ROUTE_CLASSES` is the one place all six mutating routes and ten reads
(plus the static SPA/asset catch-all) are declared, and `api/route-class-law.test.ts` walks the real
app `buildApp` produces. The walk cannot go vacuous the way two other laws in this repo already have
(`api/security.ts`'s own history, `mutation-guard.ts`'s two now-corrected "three routes" claims): the
route count is pinned as a literal in the test, independent of the table's own length, so a table
quietly emptied and a walk that quietly matched nothing cannot agree with each other and both pass.

## Consequences

- **Good.** A new mutating route registered with no row in `ROUTE_CLASSES` fails CI immediately —
  the same shape of defect that shipped twice under incremental adoption (#234, then #249's audit)
  cannot ship a third time silently.
- **Good.** The walk reads the real, running Fastify instance rather than a parallel inventory that
  could drift from what `registerApiRoutes` and `buildApp` actually wire up — including routes
  registered inside an encapsulated plugin (`api/otel.ts`), which only materialize once `app.ready()`
  resolves the plugin queue, proven by a mutation test that drops the classified count from 17 to 14
  when that `await` is removed.
- **Bad.** The table is still hand-authored prose — "remembering to add a `preHandler`" becomes
  "remembering to add a table row." That is a strictly cheaper mistake (a missing or wrong row fails
  the build immediately and loudly, where a missing `preHandler` shipped silently), not one eliminated
  structurally. Automatically deriving a route's class from its own registration (option C) was
  rejected for the reason above, not attempted as a partial measure.
- **Neutral.** Fastify's auto-generated `HEAD` mirror of every `GET` is excluded from the walk
  entirely rather than given a fourth class: it shares its `GET`'s exact handler, `preHandler`s, and
  security posture, so classifying it separately would double-count every read for no trust-boundary
  reason. Documented in the law's own test rather than left as a silent gap.
