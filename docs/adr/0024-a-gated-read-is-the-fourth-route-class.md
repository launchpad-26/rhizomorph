# 0024. A gated read is the fourth route class, and "gated" fails the build when it is fiction

- **Status:** accepted
- **Date:** 2026-08-17
- Amends [ADR-0014](0014-exhaustive-route-classification.md).

## Context and Problem Statement

ADR-0014 declared every route into one of three classes — `gated-mutation`,
`ungated-mutation`, `read` — and made the classification a law by walking the
real running app. It left two things the identity seam (prd-29) now needs.

First, `read` meant "no `preHandler` at all", conflating two different postures:
the `GET /*` shell that must stay tokenless so the browser's first paint and
`rhizomorph rotate`'s scrape can bootstrap the in-band token (ADR-0012), and the
`/api` reads that serve an agent's verbatim transcript, absolute paths and
usernames on exactly one check — a `Host` header any caller writes freely. prd-29
gates the SPA-only reads; the taxonomy has no word for "a read that requires the
token".

Second, ADR-0014's own Consequences admit the table is trusted prose: a row says
`gated-mutation`, but nothing verifies the route actually carries its
`preHandler`. prd-23 ruling 5 asked for that presence check and it was never
built — the exact defect (`#234` gated label, `#249`'s audit later found rotate
still open) can still recur, silently, for any gated row.

`#374` already records ADR-0014-numbered prose promising a per-route exception
mechanism that no law implements — prose outrunning the law, the very thing the
presence check retires.

## Considered Options

- **A — Keep three classes; gate the reads under `gated-mutation`.** Reuse the
  existing gated class for reads too.
- **B — A fourth class `gated-read`, plus a gate-presence check: the onRoute hook
  additionally records each route's `preHandler` chain, and the law fails any
  `gated-*` row whose route does not actually carry the capability gate.**
- **C — Infer "gated" from the presence of a `preHandler` and drop the declared
  class for reads.** No `gated-read` row; derive it.

## Decision Outcome

Chosen: **B**.

**A loses** because a read is not a mutation and the table is documentation as
much as enforcement: filing `GET /api/transcript/:lane` under `gated-mutation`
would make the one place a reviewer learns what each route *is* actively lie
about its verb. The classes name postures; a read that requires the token is a
distinct posture and earns a distinct word.

**C loses for the reason ADR-0014 already rejected its sibling** (that ADR's
option C): a route's own registration cannot distinguish "deliberately ungated"
(the OTLP inbox, `GET /*`) from "forgot the gate". Inferring class from the
`preHandler`'s presence encodes exactly the ambiguity the law exists to remove.
The class stays a declared, checked-in fact; what B *adds* is the reverse check —
the declaration must match the running route.

So **B**: `ROUTE_CLASSES` gains `gated-read` and the seven SPA reads take it;
`build-app.ts`'s `onRoute` hook records `hasCapabilityGate` per route (branded by
a symbol the capability `preHandler` carries, so the check proves *that* gate, not
merely *some* `preHandler`); and `route-class-law.test.ts` fails any `gated-*` row
whose registered route lacks the gate, while proving `GET /*` and every `read`
carries none. The count stays pinned independently so the walk cannot go vacuous.

## Consequences

- **Good.** Deleting a gated route's `preHandler` is now a red build, not a second
  audit's finding — prd-23 ruling 5's unbuilt half, closed for reads and mutations
  alike.
- **Good.** The taxonomy tells the truth about verbs: a gated read reads as a
  gated read, distinct from both a free read and a mutation.
- **Bad.** The gate is proven present, not *correct*: the law checks the route
  carries the capability `preHandler`, not that the `preHandler` compares the right
  token or fails closed — those stay `security.ts`'s own unit tests' job. Presence
  is the half that shipped silently broken; correctness never did.
- **Bad.** "Gated" now depends on the symbol brand surviving Fastify's `onRoute`
  route options. The positive law (every real gated route reads `hasCapabilityGate
  === true`) is what catches a Fastify change that strips it — it goes red rather
  than passing vacuously.
- **Neutral.** `GET /*` keeps class `read` forever, named in its row as the
  tokenless bootstrap. Gating it would break the browser's first paint and rotate's
  scrape — ADR-0012's in-band delivery is the whole reason it must stay open, and
  prd-29's own non-goals say read-gating cannot stop a local process and must not
  claim to.
