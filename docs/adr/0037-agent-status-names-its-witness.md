# 0037. `agent.status` names its witness: a pinned envelope source widens to a second literal

- **Status:** accepted (prd-27 ruling 2, ruled by the operator 2026-08-24; recorded on the build, #281)
- **Date:** 2026-09-05

## Context and Problem Statement

`agent.status` is the instrument's attention word — working, waiting, done —
and its envelope pinned `source: 'workmux'` from v0. Since prd-15 ruling 1 a
second witness exists: the transcript organ (`packages/server/src/collectors/
sessionlog/lane-state.ts`) derives working / waiting / frozen / gone every
poll, and `agentStatusEmissionFor` was written, tested and left unwired,
BLOCKED on that literal. Its own comment named the cost: *"if both witnesses
sign their observations `workmux`, a disagreement between them cannot even be
seen"*. Worse, a second witness publishing through the pinned envelope would
put workmux's name on an inference — forged provenance on a hash-chained log
(ADR-0009). prd-27 ruling 2 made unblocking this the PRD's keystone, and
ruling 4 ruled what happens when the two disagree: a declaration may raise a
summons; an inference alone may only withdraw an inferred one.

Three constraints bound the answer. ADR-0002: one event log, one reducer, live
and replay alike. ADR-0009: the envelope's `source` is provenance and must be
true. ADR-0011: recordings never rot — an old log's `agent.status` lines must
fold to the same meaning they always had.

## Considered Options

- **A — Widen the envelope's source.** `envelopeWithSources(['workmux',
  'sessionlog'], 'agent.status', …)`; `EVENT_SOURCE_BY_TYPE` keeps `workmux`
  as primary; the reducer records `witness` from `source`.
- **B — A second event type** (`lane.inferred`, say) for the organ's reading,
  with its own reducer arm and fleet plumbing.
- **C — Keep the pin; name the witness in the payload** (a `witness` field, or
  the `transcript-tail:` prefix `detail` carried as a stopgap).
- **D — Publish the organ's reading as a `beacon.received`** through ADR-0036's
  door.

Within A, one sub-choice: where prd-27 ruling 4's asymmetry lives — in the
reducer's `agentStatus` fold (chosen), or downstream in a fleet selector that
would need the reducer to keep each witness's last word separately.

## Decision Outcome

Chosen: **A**, with ruling 4 applied in the fold and the overruled word kept
as `dissent`.

`agentStatusEventSchema` accepts `source: 'workmux' | 'sessionlog'` and
refuses every other literal (`beacon`, `otel` included). `AgentState` gains
`witness` — whose word `status` is — and `dissent`, the one later word the
fold refused. The refusal is ruling 4's single asymmetry: a `sessionlog` word
arriving while a `workmux` `waiting` stands does not displace it (the human
was asked by name), and neither does one arriving while a `workmux` `done`
stands (the roster said the lane finished; the organ reads every finished
lane's quiet, alive session as `waiting` 75 s later, and that must not turn
DONE back into a summons — caught in verify, #281). If the refused word
differs it is recorded as dissent so the disagreement renders, never resolves
in silence (prd-15 ruling 2). Only a declared `working` yields to an
inference — the one declared word the organ can legitimately improve on —
and every other arrival is last-wins. The fleet reads `status` as the effective word, carries
`witness` to `Lane.agentStatusWitness`, and `detectWaiting` renders a
`workmux` WAITING as certain — naming any dissent beside it — and a
`sessionlog` WAITING as inferred, with the transcript's own reading as
evidence. `llm.usage` set this exact pattern in prd-1: one type, two
collectors, the envelope's `source` the honest record of which one saw it.

**B lost** because it says the same fact twice. Every consumer of agents —
`findAgent`, `buildFleet`'s geography loop, the era corpus — would grow a
second arm to reconcile two types that mean one thing, and the reconciliation
is exactly the disagreement logic this record wants in one place.

**C lost** on ADR-0009. `source` *is* the envelope's provenance field; a
payload that says "actually, sessionlog" under an envelope that says `workmux`
makes the envelope lie on a hash-chained log. The `transcript-tail:` prefix
was that stopgap, its own comment said so, and it is retired here.

**D lost** because a beacon is a declaration *by the harness* and the organ's
reading is an inference *by the instrument* — different rungs (L2 versus L0,
prd-15 ruling 5), and ADR-0036 defines a beacon as a writer's own line, which
the organ does not have. Folding an inference in as a declaration would invert
ruling 4.

**The fold over a selector**, within A, because the asymmetry is one `if`
cited to one ruling, and the alternative was carrying each witness's last word
in state so a selector could re-derive that `if` — more state, same rule.

## Consequences

- Good: the organ's four states finally reach a surface, edge-triggered, with
  `frozen` and `gone` still withheld (their reasons stand in `lane-state.ts`).
- Good: a disagreement between the two witnesses is a recorded fact
  (`dissent`) with a rendered sentence, not a race won by whoever polled last.
- Good: one type, one fold, one `Lane.agentStatus` — no consumer relearns
  anything; only the ones that care about certainty read `agentStatusWitness`.
- Bad: **`AgentState` grows two required keys, and the golden era-1 snapshot
  is re-blessed for the first time since the corpus was cut.** Every era-1
  agent folds to `witness: workmux, dissent: null`; `packages/core/src/eras/
  CAPTURE.md` records the diff and why. A future reader of that snapshot's
  history sees a reducer change that moved a permanent record — which is what
  happened, and is the honest cost of a fact the old log carried implicitly.
- Bad: `createEvent('agent.status', …)` **still defaults `source` to
  `workmux`**. A collector that forgets to pass `source: 'sessionlog'` signs
  workmux's name silently and no schema catches it — forged provenance by
  omission. The sessionlog collector's test asserting `source: 'sessionlog'`
  on every `agent.status` it emits is the only guard; it must not be weakened.
- Bad: the organ's first poll after boot has no `previousState`, so every lane
  with a `working`/`waiting` reading publishes once — one `agent.status` per
  lane, refreshing `lastWorkTs` once. Bounded and one-shot, but a boot is now
  visible on the log where it was not.
- Neutral: `elapsedSeconds` now means two things by witness — workmux's
  elapsed, or the organ's quiet interval. Both are in seconds; a reader who
  needs to tell them apart reads `witness`.
- Neutral: `EVENT_SOURCE_BY_TYPE['agent.status']` reads as *the* source to
  anyone who has not met `llm.usage`'s convention; the comment beside it now
  says "primary".
