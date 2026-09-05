# prd17 — the complete record: the instrument's judgements and the operator's decisions join the log

> **Outcome:** partially shipped — ruling 3 landed, all five laws: the fold-order law was
> ruled on #205 (append order is the truth) and replay honours it. Ruling 1's nine event
> families landed as CONTRACTS on #219, and ruling 2's doorway landed as a collector on
> prd-27 w1 (#217) — but **nothing emits either yet**, and ruling 4 has not started. See
> the 2026-09-05 amendment, which corrects the sentence this line carried until then.
> Reconciled 2026-08-22 at `03df141`; re-audited 2026-09-05 at `5fa85b0`.

**STATUS: BLESSED** — operator, 2026-08-06, on the council's unanimous master
finding (`docs/research/2026-08-06-council/synthesis.md`): *the causal record
is missing its two most important actors — the instrument's own judgements,
and the operator's decisions.* prd1's founding insight ("orchestrated setups
undercount by omitting the orchestrator") recursed one level up: the operator
is the only unobserved agent in the system. Sequenced after prd16's waves
(they share the recorder seam, prd16 ruling 6); the UI dividend (digest,
inspectable landings, pins, calibration display, jump box, drill) is prd18.

## Success

> *Proposed 2026-08-06 as part of adopting the PRD standard; **not** blessed with
> the four rulings below, which were ruled 2026-08-06 on their own terms.*

Replaying a finished session shows the instrument's own judgements and the
operator's decisions as first-class events on the timeline — not inferred from
side effects. An unrecognised event line from a newer emitter is **counted and
voiced**, never dropped, and a recording folded today matches its committed
snapshot byte for byte.

Partially met: the integrity laws landed, the fold-order law included — ruled
on #205, append order is the truth; the event families and the timeline
dividend have not.

## Ruling 1 — the new event families, all additive

- `summons.raised` / `summons.cleared` — the instrument's attention
  judgements become events (the attention chair: without them, summons
  precision, time-in-alarm, flood and chattering are uncomputable — exactly
  what ISA-18.2 audits an alarm system on; `tide/chapters.ts` already
  documents the gap in its own comment).
- `gate.verdict` — fence check result, load-batch tallies, hold-or-merge, the
  widened fence if any. `dispatch.brief` — lane, issue, fence, model at
  dispatch. `fence.declared` — the fence as data whenever the lane manifest
  changes (the systems chair's proof: today a recording contains NO fences,
  so a trespass can never be re-derived from the record).
- `operator.ack` / `operator.verdict` / `operator.note` — the human's acts,
  each **stamped with the log offset it was decided against**: who decided,
  when, seeing what. This is the answer to "a human clicked approve".
- `session.closed` — a session's end is an event, not an absence (also fixes
  a durability gap the systems chair named).

## Ruling 2 — ingestion is the beacon, the constitution is untouched

Gate.sh and dispatch.sh write one-line JSON beacons into the instrument's own
data directory; a beacon collector tails them (prd15 ruling 2's mechanism,
already blessed). Operator acts arrive via the UI (explicit human invocations,
the prd12/prd16 logic) or the CLI. Recording a decision is observation, not
conduction: the observer's read-only law over the watched repo is untouched.
The principles chair's split governs shape: **sidecar for content, event for
occurrence** — bulk content (a brief's full text) lives beside the log;
that-it-happened, with its digest, lives in it.

## Ruling 3 — recordings never rot (the integrity laws)

The systems chair's verified finding: the parser silently SKIPS unrecognized
events (the reducer's forward-compat arm is unreachable), and live folds
arrival order while replay folds ts-sorted through an order-sensitive
reducer. Therefore, as law:

1. **Lenient parse**: an unrecognized event line is COUNTED and VOICED
   (an honest gap: "N events from a newer era were preserved but not
   understood"), never silently dropped, and always preserved byte-for-byte
   in the log and the record.
2. **The golden era corpus**: one real recording per era, folded in CI by
   every future reducer — byte-identical state or the build fails. The one
   event-sourcing orthodoxy the repo had skipped.
3. **An identity `upcast()` chokepoint** reserved now between parse and
   reduce, so the day a migration is needed it has a home that every event
   already flows through.
4. **The fold-order law**: one fixture pins what order the reducer is owed
   and both paths (live arrival, replay ts-sort) are proven to satisfy it —
   or the divergence is ruled and documented. Cross-actor ordering for the
   forest anchors on the commit DAG (already captured via
   `commit.landed.parents`), never on wall clocks.
5. **Durability**: fsync on session close and rotation; the rotation crash
   ordering is stated and tested (close-then-open, never both-open).

## Ruling 4 — the timeline inherits the truth

Once the events exist: gate holds and merges become chapter marks; summonses
become marks with their clearances; the operator's verdicts appear where they
happened. No new surface — the existing mark lane and hover cards simply gain
the mark kinds they were always missing. (Everything richer is prd18.)

## Non-goals

No approval workflow, ever — recording decisions is not routing them. No
operator-surveillance framing: only acts the operator explicitly performs are
events; there is no idle tracking, no read-receipts on panels. No UI dividend
surfaces in this prd (digest, pins, diff view, calibration, jump box, drill —
all prd18). No second process.

## Amendment — the fold order is ruled, and the beacon door is one door (operator, 2026-08-24)

Two reconciliations, against the tree at `9a26030`.

**Ruling 3's fourth law is not open — it was ruled, and the ruling landed.** Issue #205 was
decided by the operator as option 1, "append order is the truth", and replay now honours it
unconditionally: `web/src/replay/replayFold.ts` folds the log's own order everywhere
(`buildSessionIndex`, `foldFrom`, `foldUpTo`), keeps the ts-sort for time navigation only,
and `replayFold.test.ts` proves the once-real divergence gone against the era-1 recording
that exposed it. `docs/record-format.md` states the per-actor append-order law. This
document's older "remains unruled" sentences are corrected above; ADR-0002's and
`docs/architecture.md`'s stale OPEN sections are corrected in this same change. The one stale witness the
original amendment named as follow-up — the prose and local `foldReplay` helper of
`core/src/reduce.test.ts`'s divergence fixture, which still modelled the pre-ruling world —
has since been corrected: that fixture now states the ruled law and keeps the ts-sorted
fold only as the counterexample proving the reducer is order-sensitive enough for the law
to bite.

**Ruling 2's door is prd-27 ruling 1's door — one doorway, ruled 2026-08-24.** Hooks and
scripts append one-line JSON beacons to a rhizomorph-owned watched directory; one beacon
collector tails it through the standard collector contract (ADR-0004); either door folds
through the one reducer (ADR-0002). This PRD's "already blessed" and prd-27's "ADR owed —
the leads own the choice" now agree: the door is the file drop, never a new POST route, and
the owed ADR on the directory and event contract lands with the beacon keystone wave. The
sidecar-for-content / event-for-occurrence split governs both PRDs' payloads. The event
families of ruling 1 remain this PRD's build; the collector and its lapse voice are
prd-27's.

## Amendment — a contract is not an emitter, and ruling 4 stays here (operator, 2026-09-05)

Audited against the tree at `5fa85b0`. **The Outcome line above was wrong for two weeks**,
and in the direction that costs most: it said rulings 1 and 2 "have not landed" when both
had landed in part, so a reader planning the next wave would have rebuilt what already
existed. It is corrected above; what follows is what is actually true, and the distinction
the old line could not draw.

**Ruling 1 — the contracts landed, the emitters did not.** #219 put all nine families into
the one union (`core/src/events/index.ts`): the summons pair, `gate.verdict`,
`dispatch.brief`, `fence.declared`, the three operator acts, and `session.closed`. Every
one has a reducer arm, and every arm is `return state` under the comment *"additive only
(prd17 ruling 1, #219)"*. Outside `fixtures.ts` and `reduce.ts`, **nothing in the tree
emits any of them except `session.closed`** — which the recorder has raised since prd-40.
So the systems chair's proof stands exactly as written: a recording still contains no
fences, and a trespass still cannot be re-derived from the record. The gap between "the
family exists" and "the family appears in a log" is the whole of what rulings 1 and 4 have
left, and it is where every remaining wave sits.

**Ruling 2 — the door is built and nobody walks through it.** prd-27 wave 1 (#217) landed a
beacon collector that tails the rhizomorph-owned directory and records each line as
`beacon.received`, through the standard collector contract, exactly as the 2026-08-24
amendment ruled. It is honest about its own emptiness — its manifest declares
`attention: absent` with the reason *"no emitter exists yet"* rather than promising a rung
it cannot serve. No script writes a beacon: `grep -rln beacon scripts/` returns nothing.
Waves 5 and 6 (#273, #274, #280) are that missing writer.

**Ruling 4 stays in this PRD, as its own wave.** It was open whether the mark kinds belong
here or in prd18, which already owns the UI dividend. They stay here: ruling 4's constraint
is *no new surface* — the existing mark lane gains the kinds it was always missing — and
that is a claim about the record's completeness, not about the dock's design. prd18 remains
everything richer. Wave 2's #277 is the build.

**Ruling 3 re-audited, and it holds.** All five laws execute and all five bite: the golden
era corpus folds byte-identically and refuses to be re-blessed from inside the suite, the
`upcast()` chokepoint is still identity and still proven to run before anything else in
`reduce()` reads the event, the lenient boundary counts and voices what it cannot parse,
the append-order law is pinned on both paths, and rotation fsyncs close-then-open. Green
across the four law files — re-derive the count rather than trusting this
sentence, which is what `claim-lint` asked for when it was first written:

```
npx vitest run packages/core/src/eras/eras.test.ts \
  packages/core/src/upcast-chokepoint-law.test.ts \
  packages/server/src/recorder/rotate.test.ts \
  packages/server/src/recorder/session-log-writer.test.ts
``` The chokepoint law is worth reading as a model: its
assertion (d) exists *because* someone verified that moving the call below `opensNewSession`
left 1025/1025 green, and wrote the assertion that the mutation could not survive.

## Amendment — an operator act's coordinate is a claim, not a checked reference (operator, 2026-09-05)

Ruled during wave 2's verification, on a split between two independent review
seats. `POST /api/operator/:act` accepts any well-formed `sessionId` and
`offset` and records them: a valid-token request naming a session that does not
exist, at a line index far past any real record, returns 200 and is persisted.
One seat called that an integrity defect; the other called it correct. **It is
correct, and this is the ruling that says so, so nobody re-opens it.**

The server cannot check the coordinate without breaking the act. `sessionId` may
name a **finished recording under review** — which is the most valuable of the
three acts, and precisely what ruling 1 exists to make reconstructible — so
constraining it to the live session would refuse the review verdict. Even for
the live session the file grows between the operator deciding and the request
landing, so a check at write time would reject honest acts and accept nothing a
dishonest caller could not also send. Ruling 1's "stamped with the log offset it
was decided against" describes what the operator was **seeing**, and only the
client that rendered that line knows it.

So the field is a **claim by a trusted client**, and the capability token
(ADR-0012, ADR-0024) is what makes it trusted — the same posture every other
gated mutation holds. The consequence is stated rather than hidden: **the record
can carry an operator act whose coordinate names a line that never existed.**
A reader reconciling acts against a record must treat an unresolvable
`(sessionId, offset)` as an unresolvable reference, not as corruption of the
log, and must not assume the pair resolves.

What would change this ruling: an emitter that is not the dashboard — a script
or a second process posting acts — because the argument above rests on the
poster being the surface that rendered the line. Waves 5 and 6 bring exactly
such a writer for the *gate's* verdicts, and if operator acts ever join it, this
ruling is the one to revisit first.
