# prd14 — the experiment console

> **Outcome: SHIPPED, 2026-09-11.** The browser console, branching view, free-form
> arms, spread reporting and estimate/confirm flow all ship. Ruling 5's persistence
> seam shipped across three waves — the server stores a comparison, the two parser
> copies agree on the same bytes, and the recordings library lists one and reopens
> it. Ruling 6 shipped the format itself: a `version: 2` artifact carrying the
> measure and the facts that judged each run, with a v1 artifact still readable and
> no migration. Every issue in the milestone is closed.
>
> Two questions closed without code. The **scrub's scope** was answered by
> construction and had been since wave 1 — see Open, not ruled. The **hard spend
> cap** is parked, not built, and wants its own PRD if it ever returns.
>
> Earlier Outcome line, kept because it was true when written: *ruled 2026-08-24 —
> ruling 5 settles the persistence seam … the remaining build is one bounded
> save/reopen slice at moderate priority.* That slice turned out to be three waves
> and a format version, which is worth knowing about "one bounded slice" as an
> estimate. Reconciled 2026-08-22 at `03df141`; see `docs/roadmap.md`.

> **Shelf exemption:** stays on the live shelf rather than moving to `docs/prds/done/` —
> `docs/prds/prd-55-the-lab-stage-two.md` is live, with a wave in flight, and reasons from
> this PRD's rulings in the present tense: its Non-goals bind the R&D surface to naming no
> winner by citing "prd-14 ruling 3", and its ruling 4 says the estimate and its one
> confirmation "apply unchanged (prd-14 ruling 4)". Archiving this PRD would demote
> rulings prd-55 is building on.
>
> Recorded on #428, per prd56 ruling 2; read by
> `packages/server/src/prd-location-law.test.ts` for the `**Shelf exemption:**` marker.

**Status:** BLESSED 2026-08-06 (four rulings below).
**Predecessor:** prd12 (the laboratory — engine, constitution, checkpoints).

## Direction

The laboratory engine exists, is gated green, and is **invisible**.
`packages/server/src/lab/` can checkpoint a moment, fork a lane from it, run the
arms, restore, and compare; `packages/core/src/events/lab.ts` carries its
events. There is no `packages/web/src/lab/` and no lab route. #148 and #153
built an engine nothing can reach.

prd14 builds the part a human uses. In one sentence, the thing the console must
make possible:

> *"Take this lane, back it up to twenty minutes ago, and try three different
> approaches from that point. Show me how they went — honestly."*

**Structure, ruled 2026-08-04:** the lab is a **separate tab** from the
observatory, on the existing hand-rolled router
(`packages/web/src/app/router.ts`, mounted in `App.tsx` — verified; it is *not*
in `lane-page/`). A tab per constitutional hand makes the read-only/write
boundary visible in the UI instead of leaving it a documentation claim.

The dashboard-IA spike's "sprawl starts with the second overview" warning does
not bite here: it forbids a second view of *the same data*. The lab is a
different **mode** — a different hand. What *would* make it sprawl is the lab
tab re-rendering live fleet state. It must show forked realities and nothing
else, and that is a law below.

---

## Success

> *Proposed 2026-08-06 as part of adopting the PRD standard; **not** blessed with
> the four rulings below, which were ruled 2026-08-06 on their own terms.*

The operator can, from the browser and without touching the CLI, take a running
lane, restore it to a checkpoint twenty minutes old, dispatch three arms from
that point, and read back a comparison that reports **spread across runs, never a
single point** — with the estimate shown and confirmed before any money is spent.

Not met while the engine is reachable only from `rhizomorph lab`.

## Ruling 1 — the branching picture: new layout, shared primitives

The observatory's scene is a growth metaphor: strands off a root mass, aging,
decay, return. That is a story about **one** timeline. An experiment is one
moment splitting into several parallel realities, and the garden vocabulary
cannot say that honestly — "withering" means something else on an abandoned arm
than it does on a finished lane.

**The lab gets its own layout grammar, built on the observatory's existing
rendering primitives.** A trunk running to a fork point, then arms diverging:

```
        ┌──── arm A ──────▶
        │
──trunk─┼──── arm B ──────▶
   ▲    │
   │    └──── arm C ──▶ (dead)
fork point
```

- **Reuse, do not fork:** canvas 2D rendering, the palette, the retire/aging
  machinery, the frame-budget discipline and its measurement tests.
- **New:** the layout grammar only. No second renderer, no new hue, no new
  motion class, no `@grafana/ui` (React 18 peer against our 19).
- An arm that was abandoned reads as **dead**, distinctly from a lane that
  finished. Death and completion are different facts.

Deliberately given up: a single unified picture of live work and forked work.
They are different modes and get different pictures.

## Ruling 2 — free-form arms; the *reporting* carries the rigour

**Amended 2026-08-06, same session.** This ruling was first blessed as "one knob
per experiment" and the operator immediately challenged it. The challenge was
right and the original was wrong; the reasoning is kept here because it is the
substance of the ruling.

**The error:** the console was designed as a *comparison* tool. But the thing an
operator reaches for most is *"try three approaches from this checkpoint and see
how they go"* — that is **exploration**, not comparison. Forcing one knob made
the common case awkward in order to serve the rigorous case.

**The ruling:** each arm is configured **independently** — its own model, its own
brief, freely.

```
arm A  opus    brief X
arm B  sonnet  brief Y
arm C  opus    brief Y
```

The constraint moves out of the launcher and into the results surface, which
**tells the truth about what it can conclude**:

- Arms differing in **exactly one** dimension → compared properly, spread shown,
  the full ruling 3 treatment. (Above: A vs C differ in model only.)
- Arms differing in **more than one** → shown side by side, with an explicit
  voice naming why: *"these arms differ in model and brief, so a difference
  cannot be attributed to either."* (Above: A vs B.)

**Why this is better than either extreme:** a confounded comparison is not
prevented by refusing to run it — it is prevented by refusing to *draw a
conclusion from it*. Putting the guardrail in the launcher blocked legitimate
exploration; putting it in the reporting blocks only the false inference. This is
the same discipline the rest of the instrument already follows: report
uncertainty precisely rather than imply knowledge.

The dimensions that differ are **computed from the arms**, not declared by the
operator — a declared intent can be wrong, the configuration cannot.

Considered and declined: free-form with no guardrail at all (never comparing).
It is simpler, but it throws away a valid conclusion in the cleanly-controlled
case, which is the case worth being rigorous about.

## Ruling 3 — runs and spread, never a point; saved as an artifact

Inherits prd12 ruling 4 and makes it concrete.

```
arm A (opus)   n=4
  ●  ●   ●    ●     spread ├──┤
arm B (sonnet) n=4
   ● ●●  ●          spread ├─┤
arm C (haiku)  n=2
  ● ●   — too few runs to summarise
```

- Every **individual run** is shown. Always.
- **Spread** across runs is shown — never a single collapsed number standing in
  for an arm.
- **Below n≥3 an arm shows its runs and no summary at all**, and says why in
  words. Not a greyed-out number; an explicit voice.
- **No winner, no leading marker, no ranking.** Considered and declined: a
  "leading" flag reads as a verdict the moment it is screenshotted, and a
  verdict is exactly what this data cannot support.
- A finished comparison **saves as a reopenable artifact** and inherits prd16's
  recording machinery — it can be reopened later and put in front of someone.

## Ruling 4 — estimate and confirm before spending

Forking n arms multiplies real spend by roughly n.

```
Launch 3 arms × 2 runs from 14:22?

  est. spend  ~$4.80
  (based on this lane's recent rate)

     [ cancel ]   [ launch ]
```

- The estimate is derived from **the forked lane's own recent rate**, and says
  so. An estimate presented without its basis is a guess wearing a suit.
- One confirmation. Launching an expensive experiment is always deliberate.
- **A fork's spend is real spend and says so** (prd12 ruling 3) — it appears in
  the ledger as spend, never hidden or discounted as "just an experiment".
- Considered and declined for now: a hard spend cap. A ceiling that stops arms
  mid-flight produces partial data, and partial data would need its own honesty
  voice in the comparison surface. Revisit once the console is real.

---

## Inherited constraints — already test-enforced, non-negotiable

- **prd12 ruling 1 — the observer stays absolutely read-only.** The lab writes
  only under `refs/rhizomorph/*`, its own worktrees, and artifacts outside the
  watched repo. `packages/server/src/lab/namespace-law.test.ts` polices this and
  stays green. A UI button is an explicit human invocation and is permitted;
  **no background process of the observer may invoke the lab.**
- **prd12 ruling 3 — forks render as visibly synthetic everywhere**, with
  lineage as a verifiable prefix commitment into the record's hash chain.
- **prd12 ruling 2 — checkpoints are captured live, never synthesized.**
- **The lab tab shows forked realities only.** A law test asserts that nothing
  in the lab tab **names** live-fleet machinery — the same shape as #206's
  `no-live-fleet-law.test.ts`. It does **not** assert that the lab tab cannot
  reach it. Those are different sentences, and only the first is enforced.

  **Narrowed 2026-09-10 (#350, #411).** The sentence above used to read *"a law
  test asserts the lab surface renders no live fleet state"* — the stronger of
  the two readings, and never what the law checked. It is corrected in place
  rather than caveated, because a caveat under an over-claim leaves the
  over-claim to be quoted: the first draft of this amendment appended the
  paragraph below and left the old sentence standing, and a review pass
  correctly reported the contradiction it had just created.

  That law is a text sweep over one directory. It reads every
  source file under `packages/web/src/lab/` and refuses two things by name: a
  forbidden identifier spelled literally, and an import whose path carries a
  forbidden prefix. What it therefore guarantees is that **nothing in the lab
  tab NAMES live-fleet machinery** — not that the lab tab cannot reach it.
  Those are different sentences and only the first one is enforced.

  Two ways past it are known, both latent, both verified with controls, both
  written into the law's own axis table rather than left here: an import
  spelled in a form the specifier extractor does not read (CommonJS
  `require()` with a concatenated argument, or `createRequire`), and a symbol
  **renamed outside the directory** and imported under the alias, so no
  forbidden token appears under `lab/` at all.

  This is recorded as an amendment rather than a fix because closing either
  properly means resolving the lab tab's import closure — a resolver crossing
  package boundaries — and that was judged out of proportion to a gap nothing
  in the tree exploits and nothing ever has. The decision is the operator's,
  taken 2026-09-10. Five review rounds went into the first of the two; the
  early ones changed what shipped and the later ones did not — each closed one
  spelling of the same grammar and revealed the next, which is what made the
  cost visible.

  **It is a real weakening of what prd12 ruling 1 is read as promising**, and
  saying so here is the whole reason this paragraph exists: the ruling's
  read-only guarantee over the watched repo is enforced elsewhere and is
  untouched, but a reader who took *this* law as proof the lab tab is
  incapable of reaching fleet state was reading more than it ever checked.
  Anyone reinstating the stronger claim owes the closure, not another regex —
  the five rounds are on #350 and are worth reading before trying.
- Frame budget 16.67 ms, measured under matched load, attributed honestly
  (scene vs swarm) — the #157 lesson.

## Wave plan

**Waves 1–4 shipped.** The console is reachable, arms launch behind an estimate, the
branching layout renders and the comparison surface reads. They are kept verbatim below
because a plan is also a record of what was planned; ruling 5's sequencing is the section
after them.

1. **The seam and the route** — lab tab on the existing router, server routes
   over `packages/server/src/lab/*` (routes, not new engine code), empty state
   that names what the lab is for. The no-live-fleet law lands here.
2. **Launch** — checkpoint selection, one-knob arm configuration, the
   estimate-and-confirm dialog, spend into the ledger as real spend.
3. **The branching layout** — ruling 1's grammar on the shared primitives, with
   its own frame-budget measurement test and dead-vs-finished distinction.
4. **Comparison** — ruling 3's surface and the saved artifact, reusing prd16's
   recording machinery.

Lab events extend `packages/core/src/events/lab.ts` **additively** — prd17's
lenient-parse and `upcast()` chokepoint apply, so an old recording containing
lab events from an earlier era still reads. That still binds on everything below.

Wave 4 shipped its surface and **not** its artifact: `lab/compare/artifact.ts` landed as a
pure serialise/parse pair with zero production callers, which is the gap ruling 5 exists to
close. So the plan above is complete as built, not as written.

### Ruling 5's sequencing — the remaining two waves (groomed 2026-09-02)

Ruling 5 called itself "one bounded slice". Grooming split it at the seam the code already
has — server storage against browser listing — because the browser half has nothing to list
until the server can serve one. That makes them a **stack, not a bundle**: two waves cannot
share a PR (AGENTS.md — *"never bundle across waves"*), and the toll is paid twice on
purpose rather than pretending a dependency is not one.

Milestone `prd14` numbers these **w1 and w2**. That is a fresh count, not a continuation of
the four above — the milestone carries no closed issues, so the shipped console is not
traceable through it. Read `w1` on a prd14 issue as ruling 5's first wave, never as the lab
tab that shipped in 2026-08.

**Amended 2026-09-10: the split is w1, w2 and w3, and the library row is w3.** The
paragraph above and the two below are left as written, because what was planned is worth
keeping beside what was built. What changed is that grooming found a third piece of work
between them, and the tracker was renumbered on 2026-09-09 while this section was not — so
for a day the plan of record said `w2` and the issue said `w3`. This paragraph is the
document catching up, and it is the authority: **w1 = #213, w2 = #376, w3 = #214.**

**w2 — the two comparison-artifact parsers accept and refuse the same bytes (#376).** Not
foreseen here, and not optional. ADR-0042 chose a hand-ported second parser over a shared
schema and booked the drift risk in its own Consequences; w1 (#213, server) and prd-53's
#339 (web) then each changed the run shape in their own copy seventeen minutes apart, and
the suite stayed green through both because each side's test only round-tripped its own
parse. The consequence was that a completed run with nothing booked 400'd on save, and a
run that did save came back refused by the other parser — an artifact written with a 200
that the surface could never reopen. w3 is unsatisfiable until that agrees, which is what
makes this a wave of its own rather than a fix folded into either neighbour.

**w1 — the storage and the routes it needs (#213).** A new
`packages/server/src/comparisons/` module, plus save and read routes on `api/lab.ts`
registered in `ROUTE_CLASSES` with the save token-gated as the existing
`POST /api/lab/launch` is. The module is new rather than an addition to
`packages/server/src/lab/` deliberately: `lab/namespace-law.test.ts` confines that module
to its one CLI wiring point (prd12 ruling 1 — the laboratory is explicitly invoked, never
reachable from an always-on route), and a stored comparison is recording-adjacent, not a
second hand on the repo. The version refusal is exercised here, by storing a wrong version
and re-reading it.

**w3 — the library row and the reopen (#214).** The recordings library lists a saved
comparison as its own kind, visibly distinct from a session recording, and selecting one
reopens into `ComparisonSurface` rather than the replay surface. An artifact from an older
format version puts the parser's refusal **on screen by name** — not an empty state, not a
console error. Saving is reachable from the comparison surface itself, so a human can
complete the round trip without a fixture.

**Every blocker below has since cleared. Recorded as of 2026-09-10:** w1 landed as #213
(PR #351); w2 landed as #376 in PR #393; #23 is closed and #220 closed on 2026-09-09, so
w3 is dispatchable and was dispatched the same day. The three bullets are kept unedited
rather than deleted — a blocker that named the wrong owner is what let a real one go
unnoticed here once, so the record of what was believed is worth more than a tidy section.
Read them as history:

**Neither wave was dispatchable when this was written**, and the blockers were not the ones
the issues originally named:

- **w1 waits on #23** (prd43 w4, open), which owns
  `packages/server/src/api/route-class-law.test.ts`. Its `ROUTE_CLASSES.length` assertion
  pins an exact count deliberately asserted independently of the array, so the walk cannot
  pass vacuously — and so any new route reddens it. Cited by the assertion and not by line,
  because #23's whole job is to move it. #23 makes counts derive from what they count,
  which turns this from a fight into a one-line reconciliation.
- ~~**w2 waits on w1, and on a live fence it did not know about.** #220 (prd30 w1, open)
  claims both `packages/web/src/recordings/` and `packages/web/src/lab/` for prd-30's
  `title=` adoption sweep. `scripts/fence-lint.sh 213 214 220` reports two overlaps against
  w2's fence — verified, executed 2026-09-02 — so w2 belongs after #220 lands, not beside
  it.~~

  **Cleared, and then some. Corrected 2026-09-11 (#447).** The paragraph above was
  true when written and was still being read as current blocking state nine days
  later, because nothing sweeps a PRD's claims — see the note at the end of this
  list. It is struck rather than edited so the provenance survives: the overlap was
  real, the run that found it was real, and the reason it stopped mattering is below.

  #220 closed on 2026-09-08 and all four prd-30 waves are on `main`. But the
  stronger fact is that **the question is no longer "is w2 unblocked" — w2
  shipped**, along with every other wave here: w1 (#213), w2 (#376), w3 (#214) and
  w4 (#347) are all closed, and the milestone carries no open build.

  Established rather than assumed, 2026-09-11: re-running `scripts/fence-lint.sh`
  over this wave would prove nothing, because its issues are closed and the lint
  only compares the issues it is given. What was checked instead is the question
  that still has an answer — whether any LIVE fence took #220's place on the paths
  it held. Across all seven then-in-progress issues (#408, #410, #413, #414, #427,
  #429, #430), none claims `packages/web/src/recordings/`,
  `packages/web/src/lab/` or `packages/web/src/lab/compare/`. Nothing replaced it.

  Why it survived nine days, because the mechanism is the interesting part and it
  is not fixed by this correction: `packages/server/src/doc-citation-law.test.ts`
  excludes `docs/prds/` as a citing source, so no law sweeps this file's paths at
  all — proven by mutation during the review of PR #431, where a fabricated path
  in a PRD left the law green while the same fabrication in `docs/roadmap.md`
  turned it red. And where the law does sweep, it checks that paths RESOLVE, not
  that a cited issue is still open. A guard for that class is a separate concern;
  this is the instance.
- **w2's own stated orderer was wrong.** The issue orders itself after "the prd43
  recordings-law issue" holding `recordings/no-live-fleet-law.test.ts`. That file was prd-45's
  (#44, #76), both closed, and no open issue fences it. That dependency has cleared; #220 is
  the one that actually bites.

**Out of scope for all three waves**, restating ruling 5's boundary so it does not get relitigated
mid-build: nothing reopens the shipped layout, arm-configuration, spread or estimate work; no
migration is written for an older artifact version (it refuses, and a migration would go
through prd17's own upcast chokepoint); and the two questions still open below — the hard
spend cap and the scrub's scope — are not answered by either wave.

## Open, not ruled

- ~~Whether the checkpoint timeline scrubs the *whole instrument* back to a
  moment or only the lab's own view. Deferred to wave 1's eyeball.~~
  **Answered by construction, recorded 2026-09-11.** It is the lab's own view,
  and it has been since wave 1 shipped in 2026-08 — nobody wrote it down, so
  the question sat open for a month against code that had already closed it.

  Measured on `1570f55f`, and stated as an enumeration rather than a count so
  it cannot rot: `useFleet` appears in `lab/LabPage.tsx` zero times, and the
  only files referencing a checkpoint selection are
  `lab/launch/LaunchPanel.tsx` and `lab/the-lab-guide-law.test.ts` — both
  inside `lab/`. A selection reaches the launch panel and nothing else; no
  consumer outside the directory reads it.

  **The wider option was never actually available.** "Scrub the whole
  instrument" requires the lab surface to hold and re-render live fleet state,
  which is precisely what this PRD's own inherited constraint forbids and what
  `lab/no-live-fleet-law.test.ts` enforces. So the deferral was not a choice
  waiting to be made; it was a question the constraint two sections above had
  already decided. Recording it here rather than deleting the line, because a
  question that was open for a month while the code was unambiguous is worth a
  reader knowing about.

  What is NOT settled by the above: whether the narrow behaviour is the one the
  console should keep. That is a product question and nothing here rules on it.
- ~~Free-form per-arm variation (ruling 2's deliberate deferral).~~ **Since
  shipped** — ruling 2's amendment landed it, and `lab/launch/LaunchPanel.tsx`
  configures model and brief per arm; this PRD's own Outcome header records it.
- ~~Hard spend cap (ruling 4's deliberate deferral).~~ **Parked 2026-09-11,
  and deliberately not part of this PRD.** Ruling 4 deferred it with a
  condition — *"revisit once the console is real"* — and the console is now
  real, so the condition is met and the question is live rather than dormant.
  It is parked anyway, by the operator, on the ground that nothing is blocked:
  the estimate-and-confirm flow ships, a fork's spend appears in the ledger as
  real spend, and no operator has been surprised by a bill. Ruling 4's own
  reasoning against a cap still stands unrefuted — a ceiling that stops arms
  mid-flight produces partial data, and partial data would need its own
  honesty voice in the comparison surface, which is a design question nobody
  has needed answered yet.

  If console spend ever does become a real problem, this wants a PRD of its
  own rather than an amendment here: the cap is the easy half, and the
  partial-data voice is the half that would need ruling. Recorded so a later
  reader finds a decision rather than an unexplained silence.
- **#205 fold-order — since ruled: append order is the truth** (prd17's 2026-08-24
  amendment); the lab assumes exactly that resolution and no other.

## Amendment — the persistence seam is ruled (operator, 2026-08-24)

Ruled on the retained-PRDs review's recommendation, against the tree at `9a26030`. The
review's audit stands: `lab/compare/artifact.ts` serialises and parses a versioned
comparison artifact, and nothing in production calls either function — ruling 3's "saves as
a reopenable artifact" is the one promise still unkept here.

### Ruling 5 — a comparison is a recording: saved through prd-16's machinery, listed with its kin

A finished comparison persists through the recording machinery ruling 3 already names — the
server stores it beside the recordings it derives from, and the recordings library lists it
as its own kind, reopening into the comparison surface rather than the replay surface. An
artifact from an older format version **refuses by name** — the defensively-versioned
parser already knows how to say why — and never migrates silently; a migration, when one is
ever worth writing, goes through its own upcast the way prd17's chokepoint prescribes. One
bounded slice, moderate priority: storage + library row + reopen + the refusal, and nothing
that reopens the shipped layout, arm, spread or estimate work.

## Amendment — the saved artifact carries facts, not a DTO (operator, 2026-09-11)

Ruled on #347, which asked what a `version: 2` comparison artifact should carry.
The issue's own headline claim had gone stale before it was answered — it said
the pass/fail verdict was discarded, and #376 landed `verdict`, `note` and
`detail` into both parsers after it was written. What is actually missing from a
saved artifact is `durationMs`, `commits`, `provenance`, and — new since #214
and the only one a reader can see — **the measure**, which is why a reopened
comparison currently says *"measure not recorded"* and shows no summary at all.

### Ruling 6 — v2 stores facts in the surface's own vocabulary, and a v1 file is still read

**Per run, v2 stores `{ verdict, detail?, cost, duration, commits }`** — the
compare surface's own words, not `LabRunOutcomeDTO`. **Per artifact, it stores
the measure and the gate's provenance** (`verifyCommand`, `source`,
`measuredAt`), at the artifact level rather than repeated on every run.

The reopened surface then re-derives its view through `runForMeasure`
(`lab/compare/fromExperiment.ts`) — **the same function the live surface uses**.
That is the substance of the ruling and not an implementation note: it restores
the measure switch on a saved comparison, which v1 cannot offer at all, and it
keeps a server DTO out of a browser artifact format. A projection in the
surface's vocabulary is a contract this repo already owns; the DTO is one it
would have to keep in step across a boundary.

**A v1 file is read, not migrated and not refused.** The parser accepts 1 and 2
as a discriminated union, rewrites nothing on disk, and refuses 3 and above by
name — the fixture row pinned to `unsupported comparison artifact version: 2`
moves to `3`. An upcast is ruled out rather than deferred, and the reason is that
**v1 → v2 is not total**: the measure is unrecoverable from a v1 artifact, so any
upcast would have to invent one or leave the field absent, and prd-17's
chokepoint exists for translations that are complete. The existing
`measure === null` rendering path is **kept and retargeted at v1 artifacts**,
where its wording — no summary, every run shown by its verdict — is exactly
right rather than a stopgap.

**`packages/core` does not become the shape's home**, and ADR-0042 is superseded
anyway. Its deferral named a trigger — *"the day a third consumer appears or a
`version: 2` is written"* — and this ruling meets the trigger while re-deciding
the criterion behind it: the drift risk that trigger stood proxy for is already
closed by the shared fixture set and the two agreement laws, no third consumer
has appeared, and ADR-0041 keeps a comparison out of the fold and off the
record. The superseding record is
[ADR-0049](../adr/0049-the-comparison-shape-stays-in-two-copies-at-version-2.md),
and it says so in its own Consequences, with the
falsifier written down: **the two-copy decision holds only while the agreement
laws keep both kinds of coverage ADR-0049 names — throw sites derived from
source, and every accepted value of every union v2 admits.** If either lapses,
the argument for two copies has gone and the shape should move. (The ADR's
first draft named only the first kind; two review seats defeated it, and the
record was corrected before it shipped — see its Consequences.)

### Sequencing

**Ruling 6 is one wave — `prd14 w4`, and #347 is its only issue.** The count
continues the milestone's own sequence (w1 #213, w2 #376, w3 #214) rather than
restarting per ruling: `prd14` numbers waves, not amendments, and a second
sequence under one milestone is a collision waiting to happen.

It is deliberately NOT split into a storage half and a surface half. They are a
stack rather than a bundle — the reopened surface cannot re-derive through
`runForMeasure` until v2 exists to re-derive from — so splitting them would pay
the queue toll twice to buy an ordering the single lane already has. The cost of
that choice is a large PR, and it is accepted: the fence audit at landing is what
catches a miss in a change this wide, and it audits the whole wave either way.

**Held until #401 landed**, which it now has (PR #420, 2026-09-11, closing #401
and #402). That issue fenced `packages/web/src/lab/compare/` in its entirety and
every seam this ruling touches was inside it. Recorded rather than deleted
because the ordering is the reason this ruling was written before the build
instead of during it.

When #347 is groomed, its fence is drawn from the real footprint and not from
the two `artifact.ts` files the issue names — both parsers, both agreement laws,
the shared fixture, `fromExperiment.ts`, `ComparisonSurface.tsx`, `save.ts`,
`SaveComparisonControl.tsx`, `api/lab.ts`, `store.ts`,
`recordings/comparisons.ts`, `RecordingsPage.tsx`, and the three contract tests.
A version bump lands in both copies by construction; a fence naming one is a
fence that schedules the drift this PRD has already paid for once.
