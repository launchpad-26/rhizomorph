# prd17 — the complete record: the instrument's judgements and the operator's decisions join the log

> **Outcome:** partially shipped, and the two sides of it are worth telling apart —
> a family that is DEFINED is not a family that is EMITTED.
> **Ruling 3 landed, all five laws:** lenient parse, the golden era corpus, the identity
> `upcast()` chokepoint, durability (fsync on close and rotation, close-then-open), and
> the fold-order law — ruled on #205, append order is the truth. The chokepoint was built
> on #62 and not before: three documents, this header among them, had said it existed from
> the day the ruling reserved it, so #62 made the claim true rather than edit it.
> **Ruling 1's nine families all exist** as of #219, and the emitted/unemitted split has
> moved twice since this line was first written. Re-derived against `main` on 2026-09-08:
>
> | family | emitter | in a recording? |
> |---|---|---|
> | `operator.ack`/`verdict`/`note` | `POST /api/operator/:act` — wave 2 | yes, era-2 |
> | `summons.raised`/`cleared` | the poll loop's tick — wave 3 (#278) | yes, era-2 |
> | `gate.verdict` | `scripts/gate.sh` writes the beacon line — wave 5 (#274) | not yet |
> | `session.closed` | the recorder, since prd-40 | not yet |
> | `dispatch.brief`, `fence.declared` | **none** | no |
>
> **The reason differs by row and that is the part an earlier version of this block got
> wrong**, by attaching one clause to all of them. `dispatch.brief` and `fence.declared`
> are DEFINED AND UNEMITTED in the original sense: their `reduce.ts` arms return state
> unchanged and nothing raises one. `gate.verdict` is EMITTED but not yet a first-class
> timeline event — a landing reaches the log as `beacon.received`, and deriving the typed
> event from that sidecar is wave 6. `session.closed` has an emitter and a fold; era-2's
> window simply does not contain a clean shutdown. **SEVEN of the nine have an EMITTER;
> FIVE appear in a real committed recording** — the three operator acts and the summons
> pair. The two counts differ by TWO rows, not one: `gate.verdict`, which emits but has
> not been captured, and `session.closed`, which has emitted from the recorder since
> prd-40 and whose clean shutdown era-2's window does not contain. Both are named in the
> table above and both must be named here, because the emitter total is the count that
> has been wrong three times — each time in the sentence written to stop it being wrong,
> and each time by omitting `session.closed`, whose emitter predates every wave this PRD
> sequenced and so gets read as belonging to none of them. Six is the number of families
> waves 2, 3 and 5 gave an emitter TO; seven is the number that HAVE one. Those are
> different claims and the difference is `session.closed`.
> **Ruling 4's mark kinds landed** in the same wave: `chapters.ts` now carries eight,
> including a summons and its clearance, a gate verdict and an operator verdict. They are
> readers waiting on emitters.
> **Ruling 2's doorway landed** as a collector on prd-27 wave 1 (#217) and nothing writes
> to it yet — wave 5 is that writer.
> **Rulings 5 and 6 were blessed 2026-09-05** and are unbuilt: ruling 5 (the instrument
> raises its own summons on the poll loop's tick) is wave 3 and owes an ADR; ruling 6 (the
> gate's verdict rides as extra keys on a beacon line) is what wave 5 builds to.
> **Ship-out is at wave 4 (operator, 2026-09-05):** this PRD closes when waves 2–4 land,
> with wave 5 declared and blocked and wave 6 (#280) declared after ship-out.
> Reconciled 2026-09-06 at `29cde14`; previously 2026-09-05 at `612df45` and 2026-08-22 at
> `03df141`. The residual is sequenced below and groomed onto the `prd17` milestone —
> an earlier version of this line said the milestone held no open issue, which stopped
> being true when the waves were groomed.

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

Partially met, and **less partially than this paragraph used to say** — restated
2026-09-08 against `main` rather than edited from the old sentence.

The integrity laws landed, the fold-order law included — ruled on #205, append
order is the truth — and the event families exist as of #219. Since then waves
2, 3 and 5 gave emitters to the operator's three acts, the summons pair and
`gate.verdict`, and wave 4's era-2 recording contains **nine** of era-1's
gap-list families folding byte-identically to a committed snapshot. So the
criterion's second clause — *"a recording folded today matches its committed
snapshot byte for byte"* — now holds of these families rather than only of the
ones era-1 happened to carry.

**The first clause does not yet hold, and the gap is exactly one wave.** A
replay shows the operator's decisions and the instrument's summonses as
first-class events; it does not yet show a landing's verdict as one, because
`gate.verdict` reaches the log as a `beacon.received` sidecar and the typed
event's `reduce.ts` arm still returns state unchanged. **Wave 6 (#280) is that
derivation.**

**So "this PRD closes" and "the Success criterion is met" are different
statements**, and the ship-out line below deliberately chooses the first. The
operator ruled ship-out at wave 4 with wave 6 declared after it — a decision
taken with this gap visible, not in ignorance of it. A reader who conflates the
two will think the PRD shipped incomplete by accident.

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

## Ruling 5 — the instrument raises its own summons, on the poll loop's tick (operator, 2026-09-05)

**RULED in session**, answering the first open question below and discharging wave 0.

The instrument raises `summons.raised`/`summons.cleared` **itself, server-side**. The record
must be complete whether or not anyone is watching: a summons that exists only while a
browser is open is an observer-dependent record, and that is prd1's founding insight —
orchestrated setups undercount by omitting the orchestrator — recurring one level down. The
client declaring what it summoned was rejected for that reason. The beacon door was rejected
for a different one: a summons is the instrument's judgement about *itself*, not an external
declaration, so routing it through the door built for external emitters would have the server
writing a file for its own collector to read back.

**No judgement is duplicated, and this is the part the drafting got wrong before it was
ruled.** `buildFleet` is core's, and the server already calls it
(`packages/server/src/api/lab.ts`); the lane manifest is already read server-side
(`readLanesManifest`, `packages/server/src/api/lanes.ts`). What is new is a **clock and an
edge**: `packages/server/src/server/poll-loop.ts` already ticks on an interval with an
injectable `now`, holds the recorder, and persists per-collector state through a
`SnapshotStore` — so the rung the last tick saw has a durable home, and a raise survives a
restart without re-firing.

**An ADR is owed and lands with wave 3, because the seam is not a collector.** The collector
contract hands a collector `repoPath`, `now`, `exec`, `nextId` and `emit` — never the folded
state — so a state-reading judge cannot be a collector without widening ADR-0004. The
recorder exposes `foldSoFar()` and the poll loop holds the recorder, so the tick, not the
collector list, is where this belongs. The ADR records exactly that: what a summons raiser
is, why it is not a collector, and where the edge state lives. One shape trap for whoever
writes it: core's `LaneManifest` is a `Record<string, LaneFence>` keyed by handle while
`api/lanes.ts`'s `LanesManifest` is a versioned array, so `parseLaneManifest` in
`packages/core/src/fleet/fences.ts` is the reader the ladder wants, not a hand-off from the
route's shape.

The summons *vocabulary* — which rungs raise, under what `kind` — is deliberately not ruled
here. `kind` is an open string by ruling 1's design, and wave 3 chooses the first entries.

## Ruling 6 — the gate's verdict travels as extra keys on a beacon line (operator, 2026-09-05)

**RULED in session**, after ADR-0036 landed with #217 and made the second open question below
answerable.

The door emits one event and it is not `gate.verdict`. `beacon.received`'s payload is
`writer`, `kind`, `lane`, `detail` — a *string*, capped at 512 — plus `digest`, `file` and
`offset`, and `packages/server/src/collectors/beacon/collector.ts` has exactly one emit site.
Ruling 1's verdict wants `handle`, `held`, `reason`, a digest of the gate's own output, and
`loadBatches`. Those two shapes do not meet.

So: `scripts/gate.sh` writes a v1 line whose `kind` comes from **prd-17's decision
vocabulary** — the vocabulary ADR-0036 explicitly leaves to this PRD's next wave — with
`lane` the handle and **the verdict's own fields as extra keys**. ADR-0036 already provides
for this in terms: extra keys are ignored by the collector and covered by the digest, and the
file is the sidecar. `beacon.received` therefore records that a landing was judged, when, by
whom, about which lane, with a pointer to the bytes; `file` + `offset` + `digest` recover the
full verdict from the sidecar, provably unaltered. **Deriving `gate.verdict` from that
sidecar is wave 6.**

Rejected: packing the verdict into `detail` as an encoded string, which would put a
hand-rolled parser between a landing and its typed event — the shape ADR-0002 exists to
prevent. Also rejected: retiring `gate.verdict`, which would withdraw part of a blessed
ruling that #219 has already landed, and would need ruling 1 amended rather than quietly left
unemitted.

This ruling changes no other PRD's territory. The collector is prd-27's and is untouched: it
already ignores keys it does not know, which is the whole reason this works.

## Non-goals

No approval workflow, ever — recording decisions is not routing them. No
operator-surveillance framing: only acts the operator explicitly performs are
events; there is no idle tracking, no read-receipts on panels. No UI dividend
surfaces in this prd (digest, pins, diff view, calibration, jump box, drill —
all prd18). No second process.

## Sequencing (waves, each gated as ever)

> *Added by the 2026-09-05 amendment below. This PRD ran its first wave with no Sequencing
> section at all — the waves lived only in issue titles, so `scripts/dev/prd-reconcile.sh`
> reads this PRD as ungroomed and could not have caught a wave that moved.
> This section is the plan of record from here; wave 1 is declared retroactively and its
> titles stand.*

`packages/server/src/server/collector-loader.ts`, the beacon collector directory #217 will
create beneath `packages/server/src/collectors/`, and the ADR that lands with it are prd-27's
territory; no wave of this PRD enters them. The richer UI — digest, inspectable landings,
pins, calibration display, jump box, drill — is prd18's; ruling 4's "no new surface" holds,
so no wave here adds one. Every wave below consumes wave 1's event families.

**The overlap this section used to warn about is gone.** #217 held a widened fence over
`packages/core/src/events/`, `reduce.ts` and `eras/eras.test.ts`, and wave 4 claims the last
of those — so the two could never have been in flight together. It **merged on 2026-09-04 in
PR #267**, bringing the beacon collector, `beacon.received`, and ADR-0036. Nothing in this
PRD is fenced against a live lane today. What #217 leaves behind is not a conflict but a
contract: ruling 6 above, and wave 5 below, are written against ADR-0036 rather than against
a door that had not been built.

**Wave 0 — operator act, booked not skipped. DISCHARGED 2026-09-05.** *Who raises a summons,
and against whose clock* is **ruling 5**: the instrument raises it server-side on the poll
loop's tick, and an ADR is owed with wave 3. Kept as a wave rather than deleted, because it
is what unblocked wave 3 and a reader tracing why wave 3 has the fence it has ends up here.

**Wave 1 — the Keystone. LANDED 2026-09-04.** `prd17 w1: every event reaches the reducer
through the upcast chokepoint` (#62) · `prd17 w1: the instrument's judgements and the
operator's decisions are event families` (#219) · `prd17 w1: the fold-order fixture states
the ruled law, and the landing ledger tells the truth` (#268). Additive and zero-claimant, as
a keystone must be: every family folds through a `reduce.ts` arm that returns state
unchanged, so nothing downstream was broken by defining them. Declared here after the fact —
and the tracker held two answers while it was undeclared: #219's title says `w1` and #217's
blocked-by paragraph records it as `prd17 w2`. The title is right.

**Wave 2 — parallel, fenced apart** (groomed 2026-09-05)**:** **#276** `prd17 w2: an operator
act is recorded with the offset it was decided against` (`packages/server/src/api/operator.ts`
and its test, both new, plus one import, one `registerApiRoutes` call and one `ROUTE_CLASSES`
row in `packages/server/src/api/index.ts`) · **#277** `prd17 w2: a gate verdict, a summons and
an operator act are marks on the tide` (ruling 4 — `packages/web/src/tide/chapters.ts`,
`chapters.test.ts`, `ChapterMarks.tsx`, `ChapterMarks.test.tsx`,
`packages/web/src/tide/index.ts`).

Two notes the grooming must carry, because each is a fence fact discovered rather than
assumed:

- **The route's real footprint is repo-wide, and the registry already says so.**
  `POST /api/operator/<act>` classified `gated-mutation` is the posture `POST /api/rotate`
  already holds — a mutation of the instrument's own log, never of the watched repo, so
  ruling 2's read-only law is untouched and no new route class is owed. But `.swarm/coupling.txt`
  names both files this lands on from outside its own fence:
  `packages/server/src/api/route-class-law.test.ts` pins the route total **twice**, exactly,
  so any new route reddens it from a directory the lane never entered; and `README.md`
  mirrors those counts, with the standing rule that only **one issue per wave** may claim it.
  Both must be fenced up front, and the sweep in that same law file then carries every other
  count claim in any tracked `.md`, `.ts`, `.tsx`, `.mjs` or `.js` file. That is why this
  issue cannot be bundled with anything else claiming documents.
- **The wave is peers, not a stack — checked, not assumed.** `wave-coupling.sh` reports eight
  content hits between #276 and #277. Six are basename collisions (an `index.ts` and a
  `fixtures.ts` exist in both trees). The two real ones are `docs/architecture.md`'s mention of
  the mark lane, which #276 owns for its route counts — and it is **not** a forced edit: that
  enumeration sits inside the historical account of prd-13 ruling 12 and already names
  `attention-summons`, which the shipped code has never had, so it states what the ruling
  decided rather than what the code emits. Recorded on #277.
- **Ruling 4 is cheaper than it reads.** `chaptersFor` takes `readonly RhizomorphEvent[]`, not
  `SessionState`, so no reducer arm needs filling to mark these families; `tide/fixtures.ts`
  is enough to prove the marks before any emitter exists. The same commit corrects the two
  sentences in `chapters.ts`'s module note that ruling 1 made false — *"attention-summons
  onset has no event"* and *"there is no `session.ended` type"* (`session.closed` has existed
  since prd-40).

**Wave 3 — the summons pair, now that ruling 5 exists.** **#278** `prd17 w3: a summons the
instrument raised says so in the record`. Fence: `packages/server/src/server/poll-loop.ts` (the tick
hook), a new module beside it holding the pure edge-trigger — last tick's rungs plus this
tick's fleet in, `summons.raised`/`cleared` out — and its test, plus `docs/adr/` for the ADR
ruling 5 owes. It reads `foldSoFar()` from the recorder and `parseLaneManifest` from core,
neither of which it edits.

It is **parallel with wave 2** (`server/server/` and `docs/adr/` against wave 2's
`server/api/` and `web/tide/`). It once collided with #217 over `docs/adr/`; that issue merged
on 2026-09-04, so the collision is historical. The pure edge-trigger module is the thing to
fence carefully: put the diff in the tick and there is nothing to test without a running loop.

**Wave 4 — the capture, last.** **#279** `prd17 w4: an era recording contains the instrument's
judgements and the operator's decisions`. `packages/core/src/eras/eras.test.ts` already states
this wave's exit condition in its own gap list — all eight new families sit in it, with the
note *"each should leave it in the wave that starts emitting it"* — so era-2 is captured
through `packages/core/src/eras/CAPTURE.md`'s blessing procedure and the gap list shrinks by
whatever now emits. Last because a capture is only worth taking once the emitters it is meant
to witness exist, and because it is what makes the Success criterion's byte-for-byte clause
true of these families rather than merely of the ones era-1 happened to hold.

**Wave 5 — the gate's own verdict.** Of ruling 1's gate trio only `gate.verdict` has an
emitter that lives in this repo: `scripts/gate.sh` is the instrument's own judgement on a
lane, and the log has never heard of it. The other two are in the unfiled tail below.

**Amended 2026-09-05 — wave 5 holds two issues, in a forced order, and neither is blocked.**
The wave was first declared as one issue on the emitter boundary (gate tooling versus dispatch
tooling). Reading `scripts/gate.sh` against `gateVerdictPayloadSchema` moved the boundary
again — the script already holds every field the payload asks for, so only the write was
blocked — and then #217 merged the same day in PR #267, which removed even that. Ruling 6
fixes the shape both issues build to. So:

- **#273** `prd17 w5: the landing gate says what it decided` — derives the whole verdict and
  prints the v1 beacon line it will be written as: `kind` from the decision vocabulary, `lane`
  the handle, the verdict's fields as extra keys, per ruling 6. Fence: `scripts/gate.sh` and
  `packages/server/src/gate-honesty-law.test.ts`, the second not optional for the reasons
  below. Where the size lives: 42 `fail "` sites collapse into a declared category
  vocabulary, and the gate's own output has to become a hashable artefact.
- **#274** `prd17 w5: the gate's verdict reaches the beacon directory` — appends that line to
  `beaconDirFor()`'s directory (`packages/server/src/collectors/beacon/paths.ts`), as
  `gate.jsonl`. ADR-0036 is explicit that **the collector never creates the directory** — the
  writer that appends is the one that must — so creating it is this issue's job, not
  something to discover at the first landing after a fresh install.

**They are a stack, not a bundle** — both claim `scripts/gate.sh`, so `fence-lint` sees an
OVERLAP and they may never be in flight together whatever wave they carry. The order is
forced: the derivation lands, then the redirect. That is the same shape prd-43's wave 6
records for its own stacked pair, and it is why the split does not make this two waves.

Fence, for the first issue: `scripts/gate.sh` **and**
`packages/server/src/gate-honesty-law.test.ts`, and the second is not optional —
`.swarm/coupling.txt` carries both ends of that coupling, with the standing instruction to
cite anchor text and never a line number. Two specifics from it, each of which makes this more
than "add an echo":

- the law anchors its assertions on **exact line text** pulled from the tracked `gate.sh`, so
  rewording an anchored line throws at *collection* — "expected exactly one line … found 0" —
  taking the whole file's assertions out of service at once rather than reddening one test;
- it also **pins derived counts** over `gate.sh`'s `VAR=$(...)` command-substitution
  assignments: how many exist, how many are flagged structurally unchecked, and how the
  checked ones split between the same-line `|| fail` form and the next-line `_RC=$?` capture.
  Capturing the gate's output for a digest introduces exactly such an assignment, so those
  pins move and the doc comment beside them is corrected in the same edit — not just the
  numbers.

This is also the one wave that edits the operator's landing tool, so its verification is
exactly the split AGENTS.md already draws: the lane runs `npm run typecheck`, `npm run lint`
and the suite; the operator runs the gate, because running it *is* the landing.

**Wave 6 — `gate.verdict` is derived from the sidecar.** **#280** `prd17 w6: a landing's
verdict is a gate.verdict event, not only a beacon`. Declared by ruling 6, groomed
2026-09-05. Once wave 5
writes the line, `beacon.received` carries `file`, `offset` and the line's `digest`, which is
everything needed to read the verdict back out of the sidecar and prove it unaltered. This is
where ruling 1's `gate.verdict` finally emits, and where the reducer's arm for it stops
returning state unchanged. It is declared after ship-out deliberately: the record already
holds the landing at the end of wave 5 — as an occurrence with a recoverable payload — and
this wave upgrades how it is read, not whether it was kept.

Unfiled work implied, described not numbered: **the other two thirds of ruling 1's gate trio** —
`dispatch.brief` and `fence.declared` would be written by dispatch tooling, and no such file
exists in this repo (`packages/server/src/api/lanes.ts` describes `.swarm/lanes.json` as written
by the conductor's dispatch tooling, which lives outside this checkout), so ruling 2's "gate.sh
and dispatch.sh write one-line JSON beacons" is half aspirational: the gate half is wave 5, the
dispatch half lands when that tooling adopts the beacon contract and is not a wave here. Both
families therefore stay on `packages/core/src/eras/eras.test.ts`'s corpus gap list, and wave 4's
capture can only shrink that list by what actually emits. Also: whether the nine no-op arms in
`reduce.ts` ever fold into `SessionState` (the summons pairing over `(lane, kind)` is named in
the arm's own comment as later work, and "never" is a legitimate answer); where the sidecar half
of sidecar-for-content actually lands, since ruling 2 names the split but no directory holds a
brief's full text today; the CLI door for operator acts, which ruling 2 mentions beside the UI
and wave 2 does not build; prd18's whole dividend.

**Wave 7 — the review residual, sequenced 2026-09-08 (#346).** Five issues that came out of
reviewing waves 3 and 5, not out of this PRD's own plan. They were groomed onto this milestone
as they were found and **carried no wave until now**, which `scripts/dev/prd-reconcile.sh`
reports as drift for a concrete reason: `scripts/fence-lint.sh` reads a wave, so a wave-less
issue is invisible to the one check that catches a bad fence *before* anyone is dispatched onto
it. Five dispatchable issues were in that state.

**Three lanes, one PR — and the lanes are forced by the fences, not chosen.** Two of them
hold the code follow-ups and are tabled immediately below; the third is this issue itself
(`#346`, docs only), described under *Third lane in wave 7* further down. The count is
written as three here because an earlier version of this section said **two** above a
two-row table and then declared a third lane twenty-five lines later — the same
figure-contradicts-its-own-document shape this issue exists to close, reproduced inside
the section added to close it. Found by round 3's review, not by the reconciler, which
maps issues to waves from the issue title and never counts lanes:

| lane | fence | issues |
|---|---|---|
| gate | `scripts/gate.sh`, `packages/server/src/gate-honesty-law.test.ts` | **#292** `prd17 w7: the gate law's pins forbid the classes they are named for` · **#293** `prd17 w7: a mistyped load-batch argument cannot cost the landing its verdict` |
| poll-loop | `packages/server/src/server/poll-loop.ts`, `poll-loop.test.ts`, `summons.test.ts` | **#299** `prd17 w7: a rotation between two appends cannot leak stale summons clears` · **#301** `prd17 w7: a recovery is recorded only for an error the log contains` · **#302** `prd17 w7: one rule governs what counts as degraded and what is preserved` |

Within a lane the issues **share a fence**, so they are sequential commits in one lane and never
parallel: `fence-lint.sh 299 301 302` hard-fails with OVERLAP on `poll-loop.ts`, and that
failure is correct for the question it asks rather than a blocker on the wave. Between all
three lanes the fences are disjoint — `poll-loop.ts`+`poll-loop.test.ts`,
`scripts/gate.sh`+`gate-honesty-law.test.ts`, and this PRD file — which is what makes this
one wave and one PR rather than three of each.

**Three of the eight were consolidated away before sequencing**, and the consolidation is the
more useful record: #300 folded into #302 (they are the two halves of one rule — what counts as
degraded, and what is preserved when it is), and #291 and #306 folded into #292 (three issues of
one defect class in one file, where the class is *a pin that forbids the spelling a review
reported and claims the class in its own name*). The argument for folding them got stronger the
day it was made: the tsx-invocation pin in that same file went token → suffix → position →
logical line across three commits and two reviewers on 2026-09-07, a fourth instance of the
class, which is what turns three defects into one habit.

**This wave is post-ship-out and does not gate the PRD closing.** It is real work and none of it
changes what ships; it is sequenced so that it can be dispatched safely, not so that it must be
done first.

**Third lane in wave 7 — the plan of record says what is true. #346** `prd17 w7: the PRD says
which families emit, and the review residual is a wave`. This document had drifted in two ways
at once: the header called three now-emitted families unemitted, attaching one reason to all of
them, and the residual above had no wave. Fence: this file only, disjoint from both other lanes,
which is what puts it in the same wave rather than ahead of it.

**A first draft of this paragraph numbered it wave 0 and said it had to land BEFORE wave 7,
"because a wave that `fence-lint` cannot see is not sequenced merely by being written down
here." That premise is false and is corrected here rather than shipped.** `scripts/fence-lint.sh`
takes issue numbers and reads issue BODIES; it contains no reference to `docs/prds` at all, and
neither does `scripts/gate.sh`. The only tool in the repo that reads a PRD is
`scripts/dev/prd-reconcile.sh`, which REPORTS drift and gates nothing. So this amendment blocks
no dispatch, and inventing a dependency to justify a separate wave would have cost an extra PR
against the working agreement's own bundling rule — the toll it exists to avoid paying twice.

Its exit condition stays mechanical but is only checkable AFTER it lands:
`scripts/dev/prd-reconcile.sh 17` judges against `origin/main` by design — its own header
records a stale checkout once reporting wave 7 vacant — and cannot be pointed at a working
copy.

## Open questions

- **Who raises a summons, and against whose clock.** — **ANSWERED (operator, in session,
  2026-09-05): ruling 5** — the instrument raises it server-side on the poll loop's tick, and
  the ADR that seam owes lands with wave 3. The three readings as they were put: *a
  server-side ladder* — one writer, no client trust, but thought at drafting time to be a new
  fold site duplicating `buildFleet`; *the client declares what it summoned* — no duplicated
  judgement, but the record then depends on a browser being open, and a summons nobody was
  watching never happened; *the beacon door carries it* — cheapest once #217 exists, and
  wrong in kind. The first reading's stated cost was **wrong and is worth keeping visible**:
  the server already calls `buildFleet` (`packages/server/src/api/lab.ts`) and already reads
  the manifest (`packages/server/src/api/lanes.ts`), so nothing is duplicated and the real
  cost is a clock and an edge. The objection that nearly decided this question against the
  answer was an artefact of not checking.
- **Who turns a beacon line into ruling 1's families.** — **ANSWERED (operator, in session,
  2026-09-05): ruling 6** — nobody at the door. #217 merged on 2026-09-04 with ADR-0036 and
  `packages/core/src/events/beacon.ts`, and the collector emits `beacon.received` and nothing
  else. The gate's verdict rides as extra keys on the line, and `gate.verdict` is derived
  from the sidecar in wave 6. The question was put as "the collector could map the line
  straight onto ruling 1's families"; the built collector cannot, and that is the answer
  rather than a limitation to work around — a collector that mapped kinds would be a second
  place where an event's identity is decided.
- **Whether the nine additive arms in `reduce.ts` stay no-ops.** Ruling 4 does not need them
  filled — `chaptersFor` reads events. Nothing else has asked yet. **Open, not ruled.**

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

## Amendment — ruling 5, and the four waves that close this PRD (operator, 2026-09-05)

> **BLESSED** — operator, in session, 2026-09-05. Drafted the same day against the tree at
> `612df45`, from a ruling-by-ruling read of the working tree rather than of the commit
> subjects. Three decisions were taken in that session and are recorded here: **ruling 5**
> (wave 0, put to the operator and ruled while this was being drafted, so wave 0 is already
> discharged); **wave 5 is one issue rather than three**; and **ship-out is at wave 4**. No
> ruling is renumbered and none is withdrawn.

Written because this PRD reached the state a Status line exists to prevent: the `prd17`
milestone holds **no open issue** while two of four rulings are unbuilt, so the board reads
as finished and the document read as further behind than the tree. Both halves are corrected
here — the tree discharged more than the header credited, and the residual is smaller and
more blocked than "rulings 1, 2 and 4 have not landed" suggested.

**Ruling 3 is fully discharged, and one of its five laws was newer than the document knew.**
Lenient parse (`packages/core/src/events/lenient.test.ts`), the golden era corpus
(`packages/core/src/eras/fold.ts`), durability (`packages/server/src/recorder/session-log-writer.ts`
and `recorder/rotate.ts`) and the fold-order law (#205 ruled, `web/src/replay/replayFold.ts`
honouring it, the last stale witness corrected on #268) were all in place at the 2026-08-22
reconciliation. The identity `upcast()` chokepoint was **not**, despite three documents —
this PRD's own Outcome header among them — saying it was from the day the ruling reserved it.
#62 built `packages/core/src/events/upcast.ts` and hooked it at `reduce()` rather than at
parse, so a synthesised or fixture event cannot bypass it, and the three claims became true
instead of being edited. That is the shape worth remembering: **a ruling that reserves a seam
is not a seam**, and nothing in the suite noticed for the length of a PRD.

**Ruling 1 landed on #219, and "defined" is the whole of it.** All nine families exist —
`summons.raised`/`cleared`, `gate.verdict`, `dispatch.brief`, `fence.declared`,
`operator.ack`/`verdict`/`note`, joining `session.closed`, which this ruling also reserved
and which landed earlier with the recorder's rotation work
(`packages/core/src/events/system.ts` carries the attribution). When this was written every one folded through an arm in
`packages/core/src/reduce.ts` that returned state unchanged, nothing raised one, and no
recording contained one.

**SEVEN of the nine have since left that state** (restated 2026-09-08; the header's table
is the current split). Waves 2, 3 and 5 gave emitters to the operator's three acts, the
summons pair and `gate.verdict` — that is SIX, and it is a claim about what these waves
BUILT, not about what emits. `session.closed` is the seventh: it has emitted from the
recorder since prd-40, before this PRD sequenced anything, which is why every previous
count of this number dropped it. Wave 4's era-2 recording contains nine gap-list families,
of which **FIVE** are from this ruling — the two missing from the seven are `gate.verdict`,
which emits but era-2's window holds no landing, and `session.closed`, which needs a clean
shutdown it does not contain. Seven minus those two is five, and the arithmetic is written
out here because the previous version of this passage named both exclusions while stating
the total as six, which does not subtract to five and was the tell. What has NOT changed is the fold: `reduce.ts` still returns state
unchanged for all nine, so a family being emitted and recorded is not yet the same as its
folding into state. That is the distinction wave 6 closes for `gate.verdict`, and the reason
this PRD's Success criterion is only half met at ship-out.

`packages/core/src/eras/eras.test.ts` states the gap as an assertion rather than leaving it
to be discovered, and it also states the exit condition this PRD sequences against: *each
should leave it in the wave that starts emitting it.* Six have left it in a wave of THIS
PRD's; `session.closed` left it in prd-40's recorder work, so seven have left it in all.
The exit condition counts waves, the emitter table counts emitters, and this sentence is
the seam the two counts have leaked across before.

**Ruling 2 is prd-27's, and this PRD stops holding it.** The 2026-08-24 amendment above gave
the doorway away — one rhizomorph-owned watched directory, one collector, never a POST route
— and prd-27's #217 is the issue that builds it, with the owed ADR landing in the same wave.
This PRD's residual against ruling 2 is therefore not the door but what comes through it:
the gate trio's emitters, which are wave 5 and blocked. **prd-17 should not be held open by
#217, and #217 should not be re-milestoned here.**

**Ruling 4 has not landed and is one wave.** `packages/web/src/tide/chapters.ts` still exports
four chapter kinds — `lane-born`, `lane-landed`, `gate-held`, `session-boundary` — and its
module note still reasons about a world where the summons has no event and no session-end
type exists. Both sentences were true when written and are false now. `chaptersFor` reads
events rather than folded state, which is why this is a wave and not a programme.

**What closing this PRD now requires, in order:** wave 2's two issues and wave 3, all three
dispatchable the day this amendment lands — ruling 5 discharged wave 0, so wave 3 is no
longer blocked on a decision; wave 4's era-2 capture, which is what makes the Success
criterion's byte-for-byte
clause true of these families; and wave 5, whose first issue is dispatchable now and whose
second waits on #217.

**Ship-out is at wave 4 (operator, 2026-09-05).** This PRD closes when waves 2, 3 and 4 land;
**wave 5 stays declared and blocked and does not hold it open.** The rejected alternative was
sitting at *partially shipped* until wave 5 lands, which would have made this PRD's closure
depend on an issue in another programme — the same shape as prd-44's five commits reading as
done while `main` had never heard of them, and the reason a PRD's own status must be
answerable from its own waves. So a shipped prd-17 will carry one declared, unbuilt wave, and
that is deliberate rather than an oversight: the wave is where the gate's own verdict will be
recorded when the door it writes through exists.

Wave 5 is also one issue rather than three — `dispatch.brief` and `fence.declared` have no
emitter in this repo to build, and the Sequencing's unfiled tail says so rather than booking
a wave that cannot close.

**On how this lands:** an amendment rides in the next wave PR rather than taking the queue's
per-PR toll alone. This PRD has no wave PR open or imminent and wave 2 cannot dispatch until
the amendment is on the trunk, which is the second of the two standalone cases — so it wants
either its own small docs PR or a seat on the next docs PR that lands ahead of wave 2's
dispatch.
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

> **Superseded on the emitter half, 2026-09-08 (#346).** This block is dated and stays as
> ruled; the sentence above was true when written and is not now. Waves 2, 3 and 5 gave
> emitters to the operator's three acts, the summons pair and `gate.verdict` — six of the
> nine, and `session.closed` already had one from the recorder, making SEVEN that emit.
> The header's table is the current split. **What this block got right is the part
> that still holds:** every arm is still `return state`, so a contract is still not an
> emitter and an emitter is still not a fold. That was the amendment's actual subject, and
> the emitter count was incidental to it.
>
> Recorded here rather than edited above because this section is a dated ruling. It is also
> the FIFTH site of a claim #346's own commit said appeared in four — the grep that found
> the other four searched `nothing emits`, and this one says *"nothing in the tree emits"*.
> A four-word window missed it, which is the argument for enumerating a class by what it
> MEANS rather than by a phrase it happens to use.
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

> **That last claim went false on 2026-09-07 and is corrected here rather than edited above,
> because this block is a dated ruling (#346, round 3).** Wave 5 (#274) landed the writer, so
> `grep -rln beacon scripts/` now returns `scripts/gate.sh` — and the header table this
> amendment's own commit rewrote already says so (*"`gate.verdict` | `scripts/gate.sh` writes
> the beacon line — wave 5"*). It sits in the 2026-08-24 amendment and concerns ruling 2
> rather than a count over ruling 1's nine families, so it fell outside that commit's declared
> sweep — but it is an executable claim about emitters, eleven lines below a block the same
> commit *did* give a forward pointer, and the commit's own stated method is to enumerate a
> class *"by what it MEANS rather than by a phrase it happens to use."* A phrase-scoped sweep
> is exactly what missed it. **Ruling 2's door now has its writer; what it still lacks is a
> recording that contains one** — `beacon.received` remains absent from era-2.
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
