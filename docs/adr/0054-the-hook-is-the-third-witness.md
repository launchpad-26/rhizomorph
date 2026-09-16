# 0054. The hook is the third witness of `agent.status` — amends ADR-0037

- **Status:** proposed (prd-57 ruling 5)
- **Date:** 2026-09-15
- **Amends:** [ADR-0037](0037-agent-status-names-its-witness.md). The envelope's source union gains
  a third literal, `'hook'`. ADR-0037's refusal of `'beacon'` and `'otel'` **stands as decided**,
  and this record says precisely what it decided, because it is narrower than it reads.

## Context and Problem Statement

ADR-0037 gave `agent.status` two witnesses — a lane manager's roster declaration and the transcript
organ's inference — and ruled how they disagree: the envelope's `source` names the witness, an
inference may not withdraw a declared summons, and an overruled word is kept as `dissent`
(`packages/core/src/state.ts`, `packages/core/src/events/workmux.ts`).

A harness's own lifecycle hook is a third kind of speaker. It is the agent process declaring its own
state, at the moment of the transition, with the join keys attached. It is neither of the existing
two, and it must not sign as either — signing an agent's declaration as a lane manager's roster
entry is exactly the forged-provenance failure ADR-0037 was written to prevent.

**The reason this needs its own record, rather than an obvious extension, is that ADR-0037 already
refused a literal that looks like this one.** Its option D — publish through the beacon door — lost.
Reading that refusal as settling the question here would be a mistake, and the mistake is worth
recording rather than quietly stepping around.

## What ADR-0037's refusal of `'beacon'` actually decided

Its option D was *"publish **the organ's reading** as a `beacon.received`"*, and it lost because

> a beacon is a declaration *by the harness* and the organ's reading is an inference *by the
> instrument* — different rungs (L2 versus L0, prd-15 ruling 5), and ADR-0036 defines a beacon as a
> writer's own line, which the organ does not have. Folding an inference in as a declaration would
> invert ruling 4.

Every clause of that is about the **organ**. A harness's lifecycle hook is a declaration by the
harness, and a hook runner appending a line does have a writer's own line — so the two properties
that disqualified option D are both satisfied here, and none of that reasoning reaches a hook.

That does not make `'beacon'` the right literal; it makes ADR-0037 silent on this question rather
than decisive. This record therefore argues `'hook'` on its own merits and leaves ADR-0037's
decision exactly where it stands.

## Considered Options

- **A — A third literal, `'hook'`**, with precedence hook > roster declaration > transcript
  inference, and prd-27 ruling 4's asymmetry preserved.
- **B — Publish hook facts through the existing `'workmux'` literal.**
- **C — Publish them as `'beacon'`**, on the ground that they arrive through the beacon door.
- **D — A new event type** for declared lifecycle, with its own reducer arm and fleet plumbing.

## Decision Outcome

Chosen: **A**. `agent.status` accepts `source: 'workmux' | 'sessionlog' | 'hook'`.

**Precedence is hook > workmux > sessionlog**, with prd-27 ruling 4's asymmetry preserved: a
declared word stands until its declarer withdraws it, an inference alone may only withdraw an
inferred word, and every overruled word is kept as `dissent`. A hook outranks a roster because a
roster reports what it observes about a process it started, while a hook is the process itself
speaking about its own transition.

**The vocabulary widens additively.** The existing literals keep their meanings and the reducer's
existing arms are untouched, so an old recording folds to exactly what it always folded to
(ADR-0011). The new words are reached only from conditions a hook or the process witness supplies;
none is reachable from silence.

**B lost as forged provenance**, and it is the failure ADR-0037 exists to prevent. If a hook's
declaration signs as `workmux`, a disagreement between the harness and the lane manager cannot be
seen, let alone voiced — the second speaker becomes a silent winner by construction.

**C lost, but not for ADR-0037's stated reason.** The beacon door is the **transport**: a line in a
directory, defined by ADR-0036 and tailed by a collector. `'beacon'` names how the fact arrived, and
the envelope's `source` is meant to name **who said it**. A hook fact and a gate fact can travel the
same door and are not the same witness. Collapsing them would make the door the identity, which is
the same category error as B one layer down.

**D lost for the reason ADR-0037 rejected its own option B**: a second reducer arm and fresh fleet
plumbing for one more witness of the same word. The word is `agent.status`; what changed is who is
entitled to say it.

## Consequences

**Good.** "Needs you" becomes a declaration rather than an inference. The instrument's loudest
signal stops being a guess about silence.

**Good.** A crash becomes a fact. `crashed` is reachable only from the process witness's
`seen`-then-`gone` pair with no session end between, so the instrument stops being silent in exactly
the case it exists for — and stops being at risk of calling a death a completion, which is the
constraint `packages/server/src/collectors/sessionlog/lane-state.ts` records in its own comment as
the reason it withholds two words today.

**Bad.** A harness whose hooks misfire — or whose hook runner is killed by a timeout — can leave a
declared word standing after it stopped being true. The withdrawal rules bound how long, and the
process witness bounds it further, but a declared word is by design harder to retract than an
inferred one and that asymmetry now has a third speaker in it.

**Bad.** More vocabulary for the palette and the teach layer to carry. It is mitigated by the
rendering rule rather than by more colours: an inferred word renders with its witness and never
takes a declared word's affordance, so the layer does not need a distinct colour per literal.

**Neutral.** `sessionlog`'s words are unchanged and `workmux`'s are unchanged. This record grants no
new write, no new route and no new read: it widens who may sign a word that already exists.
