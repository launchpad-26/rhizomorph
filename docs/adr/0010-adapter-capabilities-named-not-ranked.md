# 0010. Every collector declares what it cannot do, and the ladder is named, not ranked

- **Status:** accepted (extends ADR-0004; supersedes the ranked-tier framing)
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. Landed 2026-08-05 (`dab2b90`, then one
> commit per collector: `7a3072a`, `632e0d2`, `b5e85bb`, `f404cee`, `b9f4178`,
> `e633c6f`), surfaced 2026-08-05/06 (`2d1ef46`, `2e7d1db`). All rejected
> options are cited. This is deliberately **not** folded into ADR-0004: the
> collector contract is from 2026-07-30, and this arrived six days later as an
> additive optional field.

The instrument was built on tmux, workmux and Claude Code. Making it work
anywhere means collectors that can answer *some* questions and not others — a
codex adapter with no cost data, a tmuxless setup with no pane liveness.

The failure mode is a dashboard that silently guesses. An instrument whose job is
honest observation cannot show a confident number sourced from nothing, and the
operator cannot tell a real zero from an absent sensor.

## Considered Options

- **A — A silent default**: a collector that declares nothing is assumed capable.
- **B — Three plain optional fields** per signal (`provided` / `partial` /
  `absent`).
- **C — A discriminated union** where anything not `provided` is
  compiler-required to carry a `reason`.
- **D — A ranked tier list**, where a setup without tmux is a *degraded* tier.

## Decision Outcome

Chosen: **C**, with **D explicitly superseded**.

Every collector may declare, per signal, what it can speak to and at what
confidence. A collector that declares nothing gets `UNKNOWN_CAPABILITIES` —
all six signals `absent` — described in the code as *"never a flattering
guess."*

**A was rejected** for exactly that reason: the convenient default is the
dishonest one, and it fails silently in the direction that misleads.

**B was rejected** because an optional `reason` is a reason nobody writes. The
union makes it *"the law restated as a type rather than a convention a collector
author could skip"* — the same move as ADR-0007's calm-branch literal `0`.

**D was rejected and its earlier framing superseded.** prd15 ruling 5 is titled
*"the enrichment ladder is named, not ranked"*, and demotes tmux from a
prerequisite to L4 optional enrichment. Ranking encodes "our setup is the real
one and yours is degraded" into the type system, which is both untrue and
unhelpful to the user who has a working setup without tmux.

## Consequences

**Good.** The UI can say what it does not know, and why, instead of showing a
confident zero. That is the same honest-gap discipline the product sells.

**Good.** Adding a seventh collector — or a codex/pi adapter — has a defined
contract for partial capability, so it can land without pretending to be
complete.

**Bad — declaration is not verification.** A collector's manifest is what its
author claims, not what it does. Nothing checks that a collector declaring
`provided` for a signal actually emits it. The honesty layer is only as honest
as its authors.

**Bad — it does not compose.** Two collectors covering the same signal at
different confidences have no defined merge; the ladder names rungs but does not
say what a fleet's overall confidence is when sources disagree.

**Neutral.** The field is optional and additive, so it landed without touching
ADR-0004's contract — which is why it is a separate record rather than an
amendment to it.
