# 0007. One derived `Fleet` object, four surfaces

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. Landed 2026-07-31 (`176cdd2`); the
> enforcing law followed 2026-08-05 (`abfac99`). The rationale is quoted from
> `buildFleet.ts`'s own header comment; all three rejected options are cited.

Four surfaces show the same fleet: the attention strip, the fleet table, the
burn strip and the scene. Each needs facts like "how many lanes are working",
"which lanes collide", "what is this lane costing".

Each could compute those itself from the folded state. `buildFleet.ts:107-112`
states why that fails, and it is the sharpest sentence in the codebase:

> four surfaces that each re-derive "how many lanes are working" will eventually
> disagree by one, in public, on the one screen whose job is to be trusted at a
> glance.

## Considered Options

- **A — Each surface derives its own facts** from `SessionState`.
- **B — Derive once into a `Fleet` object**; surfaces render it and derive
  nothing.
- **C — B, with the consistency rules enforced as view-layer conventions** (e.g.
  "the ladder floor means show calm").

## Decision Outcome

Chosen: **B**, with the consistency rules encoded in the *type* rather than in
convention.

Everything is derived by `core`'s selectors over the same `SessionState` every
other consumer folds. Nothing is summed locally that a selector already sums, no
new event type is invented, and nothing the log did not say is guessed — each
pathology names the recorded facts it read in an evidence string
(`Read→Edit→Bash ×6, no commit`) rather than a bare label.

**A was the status quo it replaced — and it came back.** The ledger panel later
re-derived by calling `reduceAll(state.events)` itself. `abfac99` banned
re-derivation with a source-grep law after the fact. A decision that has to be
re-enforced two weeks later is one worth having recorded.

**C was rejected** in favour of making the inconsistent state unrepresentable:
`Fleet` is a discriminated union whose calm branch types `collisions` to the
literal `0`, so a calm fleet with collisions has no value that type-checks. A
convention can be skipped; a type cannot.

A fourth, narrower option was rejected during the same work: **one clock for both
liveness and work**. Both prd3 spikes shared a bug where a pane's own repaint
kept a stale WAITING inference alive, so the clock was split into `ageMs` and
`workAgeMs`.

## Consequences

**Good.** The four surfaces cannot disagree, which is the entire point of an
instrument.

**Good.** Adding a fifth surface is cheap and safe — it renders `Fleet` and
inherits every consistency property.

**Bad — it lives in the wrong package.** `buildFleet` is in
`packages/web/src/fleet/`, so nothing outside the browser can reach it. The
server needs spend-by-lane and re-folds with `reduceAll` + `selectSpendRateByLane`
instead. Any future CLI, daemon or second client duplicates the judgment this ADR
exists to centralise. Tracked as issue #246 — the dependency *direction* is
clean; the layering is inverted.

**Neutral.** `buildFleet` is large and composes a dozen selectors. That is
inherent: it is where the product's judgment lives, and concentrating it is the
decision, not a side effect of it.
