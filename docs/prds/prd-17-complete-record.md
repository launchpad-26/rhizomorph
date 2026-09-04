# prd17 — the complete record: the instrument's judgements and the operator's decisions join the log

> **Outcome:** partially shipped — rulings 1 and 3 landed; rulings 2 and 4 have not.
> **Ruling 3, all five laws:** lenient parse, the golden era corpus, the identity
> `upcast()` chokepoint, durability (fsync on close and rotation, close-then-open), and
> the fold-order law — ruled on #205, append order is the truth, with the last stale
> witness corrected on #268. The chokepoint was built on #62 and not before: three
> documents, this header among them, had said it existed from the day the ruling reserved
> it, so #62 made the claim true rather than edit it.
> **Ruling 1's nine event families all exist** as of #219: `summons.raised`/`cleared`,
> `gate.verdict`, `dispatch.brief`, `fence.declared` and `operator.ack`/`verdict`/`note`,
> joining the already-landed `session.closed`. They are **defined, not emitted** — every
> one folds through a `reduce.ts` arm that returns state unchanged, nothing raises one, and
> no recording contains one.
> **Ruling 5 was added and blessed 2026-09-05** — the instrument raises its own summons,
> server-side on the poll loop's tick — and is unbuilt: it is wave 3, and it owes an ADR.
> **Not landed:** the emitters for ruling 1's families; ruling 2's beacon ingestion, whose
> doorway the 2026-08-24 amendment shares with prd-27 and whose collector is prd-27's open
> #217; and ruling 4's timeline dividend — `packages/web/src/tide/chapters.ts` still
> carries four chapter kinds, none of them a summons, a gate verdict or an operator act,
> and its module note still reads as though no event existed for them. The `prd17`
> milestone holds no open issue, so none of that residual is groomed. **Ship-out is at wave 4
> (operator, 2026-09-05):** this PRD closes when waves 2–4 land, with wave 5 declared and
> blocked.
> Reconciled 2026-09-05 at `612df45`; previously 2026-08-22 at `03df141`. The
> residual is sequenced by the closing amendment at the foot of this document.

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
on #205, append order is the truth — and the event families exist as of #219.
The criterion itself does not yet hold: nothing emits those families, so a
replay still shows no judgement and no decision as a first-class event, and the
timeline dividend has not landed.

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

**One live overlap to respect, and it is not a wave boundary.** #217's fence was widened on
2026-09-04 to `packages/core/src/events/common.ts`, `events/index.ts`, `events/events.test.ts`,
`fixtures.ts`, `reduce.ts`, `reduce.test.ts` and `eras/eras.test.ts`. Wave 4 claims the last of
those. So wave 4 and #217 may never be in flight together — sequence them, never bundle.
Waves 2 and 3 are clear of it: #217's own Definition of done forbids it to touch
`packages/server/src/api/`, and it names nothing under `packages/web/`.

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

**Wave 2 — parallel, fenced apart:** `prd17 w2: an operator act is recorded with the offset
it was decided against` (`packages/server/src/api/operator.ts` and its test, both new, plus
one import, one `registerApiRoutes` call and one `ROUTE_CLASSES` row in
`packages/server/src/api/index.ts`) · `prd17 w2: a gate verdict, a summons and an operator
act are marks on the tide` (ruling 4 — `packages/web/src/tide/chapters.ts`,
`chapters.test.ts`, `ChapterMarks.tsx`, `ChapterMarks.test.tsx`, `packages/web/src/tide/index.ts`).

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
- **Ruling 4 is cheaper than it reads.** `chaptersFor` takes `readonly RhizomorphEvent[]`, not
  `SessionState`, so no reducer arm needs filling to mark these families; `tide/fixtures.ts`
  is enough to prove the marks before any emitter exists. The same commit corrects the two
  sentences in `chapters.ts`'s module note that ruling 1 made false — *"attention-summons
  onset has no event"* and *"there is no `session.ended` type"* (`session.closed` has existed
  since prd-40).

**Wave 3 — the summons pair, now that ruling 5 exists.** `prd17 w3: a summons the instrument
raised says so in the record`. Fence: `packages/server/src/server/poll-loop.ts` (the tick
hook), a new module beside it holding the pure edge-trigger — last tick's rungs plus this
tick's fleet in, `summons.raised`/`cleared` out — and its test, plus `docs/adr/` for the ADR
ruling 5 owes. It reads `foldSoFar()` from the recorder and `parseLaneManifest` from core,
neither of which it edits.

Two sequencing facts: it is **parallel with wave 2** (`server/server/` and `docs/adr/` against
wave 2's `server/api/` and `web/tide/`), but it **collides with #217 on `docs/adr/`**, which
that issue also claims for the beacon ADR — so wave 3 and #217 are a sequence, not a bundle,
for the same reason wave 4 is. The pure edge-trigger module is the thing to fence carefully:
put the diff in the tick and there is nothing to test without a running loop.

**Wave 4 — the capture, last.** `prd17 w4: an era recording contains the instrument's
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

**Amended 2026-09-05 — wave 5 holds two issues, in a forced order, and the first is not
blocked.** The wave was declared as one issue on the emitter boundary (gate tooling versus
dispatch tooling). Reading `scripts/gate.sh` against `gateVerdictPayloadSchema` moved the
boundary again: the payload asks for `handle`, `held`, `reason`, `digest` and optional
`loadBatches`, and the script already holds every one of them — `$1`, the `MERGED` flag, which
check failed, and `$3`. **Only the write is blocked.** So:

- `prd17 w5: the landing gate says what it decided` — derives the whole verdict and prints it
  as one line of JSON. Dispatchable now. Fence: `scripts/gate.sh` and
  `packages/server/src/gate-honesty-law.test.ts`, the second not optional for the reasons
  below. Where the size lives: 42 `fail "` sites collapse into a declared category
  vocabulary, and the gate's own output has to become a hashable artefact.
- `prd17 w5: the gate's verdict reaches the beacon directory` — the write. Blocked on #217
  and the ADR that lands with it, which fixes where beacons are written and what one line
  *is*; the second Open question below, who turns a line into ruling 1's families, cannot be
  answered before that ADR exists. Deliberately not started, because inventing a directory or
  an envelope here would fork the one door the 2026-08-24 amendment exists to keep single.

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
- **Who turns a beacon line into ruling 1's families.** #217 adds a `beacon.*` family of its
  own, in a file that does not exist yet, so a gate beacon could fold as a beacon event
  with `gate.verdict` derived later, or the collector could map the line straight onto ruling
  1's families. The ADR that lands with #217 fixes what one line is, and that answer
  constrains this one. **Open, not ruled.**
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
(`packages/core/src/events/system.ts` carries the attribution). Every one folds through an
arm in `packages/core/src/reduce.ts` that returns state unchanged,
nothing raises one, and no recording contains one. `packages/core/src/eras/eras.test.ts`
states that fact as the corpus's gap list rather than leaving it to be discovered, and it
also states the exit condition this PRD now sequences against: *each should leave it in the
wave that starts emitting it.*

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
