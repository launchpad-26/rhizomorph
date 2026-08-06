# The Rhizomorph Constitution — extracted, tested, completed

> Council chair: design philosophy. Grounded in a full read of `docs/vision.md`,
> `docs/architecture.md` (all 1,972 lines), `docs/prd0–prd16.md` (prd14 does not
> exist as a file — it is the laboratory-experiments prd, repeatedly cited as
> future), `README.md`'s Trust section, `docs/record-format.md`, and the law
> tests themselves: `drawer/readonly.test.ts`, `panels/ledger/no-panel-refolds.test.ts`,
> `theme/legibility.test.ts` (#136), `lab/namespace-law.test.ts`,
> `otel/fixture-hygiene-law.test.ts`, `sessionlog/lane-state.ts`,
> `events/judge.ts`, `tide/chapters.ts`, `core/reduce.ts`, `events/common.ts`.
>
> **Grading**: **[V]** = I read the enforcing code/test or the primary document
> in this pass; **[R]** = stated in the repo's docs, enforcement not personally
> traced; **[J]** = evidenced in the conductor's journal (agenticlaunchpad
> `JOURNAL.md`), outside the product repo.

The repo's signature move — the thing that makes this constitution worth
writing down — is that it does not treat principles as prose. It turns them
into **executable law**: grep-laws over its own source text
(`readonly.test.ts` greps the drawer for any verb but GET **[V]**), types that
make the forbidden state unrepresentable (the calm ladder's `collisions: 0`
literal **[V]**), schema refinements that refuse bare claims
(`judge.ts`: "evidence must carry at least one item matching its kind — never
a bare claim" **[V]**), and live filesystem walks that run the thing rather
than read it (`namespace-law.test.ts` half 4 **[V]**). A constitution here is
not a values page; it is a test suite with a preamble.

---

## Part 1 — The extraction: the implicit constitution

Twenty-two principles, five articles. Each: the law as a repo could state it,
its origin, and its enforcement status.

### Article I — Posture (who this instrument is)

**1. The observer never writes the watched world.**
*Law: no code path reachable from a collector, poll, or panel may mutate the
watched repo, send a keystroke, or issue anything but a GET.*
Origin: prd0 core promise 5 ("read-only, always"); prd3 ruling 17 ("the
read-only constitution stands: the Rhizomorph never sends keys"); README "What
it does not do."
Enforced: `drawer/readonly.test.ts` (source-text grep: no mutating verb, no
request init, no exec channel, no credential, ATTACH copies and never runs)
**[V]**; record-format law 1 (export writes outside the repo; replay executes
nothing) **[V]**.

**2. Amendment adds a named hand; it never weakens the standing law.**
*Law: new write authority arrives only as a new, explicitly-invoked actor with
its own namespace and its own law test, while every prior readonly grep stays
green untouched.*
Origin: prd12 ruling 1 (the laboratory — writes only `refs/rhizomorph/`, its
own worktrees, artifacts outside the repo; "no background process of the
observer may invoke it"); prd16 ruling 2 (the recorder's third hand — rotation
writes only the data directory, exposed as an explicit human act).
Enforced: `lab/namespace-law.test.ts` — import-reachability grep (only
`cli/index.ts` may import the lab), ref-namespace grep, a no-clock law
(`setInterval`/`setTimeout` banned under `lab/` so "never runs without a
human" holds structurally), and a live filesystem-walk pass **[V]**. The
rotation-namespace twin is mandated by prd16 ruling 2 **[R]** — verify it
landed before calling this article complete.
This is the constitution's most original clause: it has a *written amendment
protocol*, and the protocol itself has a shape a test can check.

**3. Nothing leaves the machine; artifacts move by a human's hand.**
Origin: prd0 non-goals; README Trust ("nothing, ever, off this machine…
grep for `fetch(`… there isn't one"); record-format law 2 ("a record moves the
way a screenshot does") **[V]**; prd9 ruling 9; prd11 ruling 7.
Enforced: partially — the README *invites* the grep but no test performs the
outbound-socket grep repo-wide. The drawer's readonly test covers one
directory. **Gap: the trust grep is a reader exercise, not CI law.**

**4. Privacy is allowlist-by-construction, never scrub-after-the-fact.**
*Law: an event's payload field list IS the privacy boundary; an identity
attribute has no field to land in.*
Origin: prd1 decision (2026-07-30: `user.email` structurally never copied);
prd9 ruling 5 (spans: "the parser's fixed attribute allowlist means they are
structurally never stored"); record-format law 3 ("if a fact isn't safe to
export, it was never safe to log").
Enforced: `parse-metrics.test.ts` ("never copies user.email") **[R]**;
`trace.test.ts` law 4 ("the allowlist is structural") **[R]**;
`fixture-hygiene-law.test.ts` — identity fields in checked-in fixtures must be
placeholder-shaped, walked generically so unknown envelope shapes are still
caught **[V]**; prd16 ruling 3 extends the discipline to captured transcripts
**[R]**.

**5. Zero config, degrade loudly, gaps speak.**
Origin: prd0 ("each source optional, degrading gracefully"); architecture
(missing binary → one `collector.disabled` event); prd2 D (doctor, loud
failures); issue #18 ("connected but idle" must be distinguishable from "not
connected") **[V]**.

### Article II — The record (what a fact is)

**6. Every fact is an event on one append-only log; anything mutable is a
sidecar.**
Origin: architecture's "one structural decision that matters"; #156 ("a
recording is evidence, and evidence that can be silently rewritten stops being
evidence" — labels live in `session-<id>.label.json` beside the log, never in
it) **[V]**; prd16 ruling 3 (captured transcripts live beside the log, same
sidecar posture) **[R]**.

**7. One reducer folds live and replay; replay is therefore free.**
Origin: architecture ("Live and replay are the same reducer… That one
property is why replay is free"); record-format ("a foreign actor's record…
folded by the very same reducer") **[V]**.

**8. Collectors emit raw facts only; meaning is derived downstream by pure
selectors.**
Origin: architecture ("Collectors stay dumb and testable"); collector shape
`poll(prev) → {next, events[]}` over captured command output **[V]**.
Corollary (prd13 chapters): *if a moment you need has no event, name it — do
not invent one* (`chapters.ts`: "attention-summons onset has no event… No mark
kind is emitted for it") **[V]**.

**9. Derivation runs once per state change, never per frame or per event; one
derived object serves every surface.**
Origin: `buildFleet`'s own doc comment ("four surfaces each re-deriving the
same fact would eventually disagree by one, in public, on the one screen whose
job is to be trusted at a glance") **[V]**; the fold trilogy (#160/#162/#166)
and the 2026-08-05 adversarial audit, whose P1 was the ledger re-folding 55k
events per incoming event — "O(N²) refolds… a quadratic meltdown" **[V]**;
scene geometry recomputed from state, "never animated on its own clock."
Enforced: `no-panel-refolds.test.ts` (#171) — no panel may name `reduceAll`;
"the shell owns the fold" **[V]**; `tide/purity.test.ts` forbids the wall
clock in selectors **[V, by reference in chapters.ts]**.

**10. Declared beats inferred; and an inference must be structurally unable to
read its own echo.**
Origin: #75's two clocks (`ageMs` vs `workAgeMs`: "a pane repaint must never
be allowed to refresh the very silence being measured") **[V]**; #133's
false-summons law, made structural in prd15 ruling 1 (`lane-state.ts` law 1:
"There is no path from a mid-turn shape to `waiting`, at any silence, for any
duration") **[V]**; prd4 ruling 5 (parked is an operator *declaration*);
prd15 ruling 2 ("Declared WAITING/activity beats any inference — #133's law,
made universal").
Enforced: `buildFleet.test.ts` ("never calls the same silence both frozen and
waiting") **[R]**; `lane-state.ts`'s branch structure **[V]**.

**11. Unknown is never death; unknown never breaks a replay.**
Origin: `lane-state.ts` law 3 ("Only an explicit `processAlive === false`
reaches `gone`… a `null` probe degrades to `frozen`, the weaker claim")
**[V]**; `reduce.ts` default case ("an unknown future type must never break a
replay") **[V]**; trace parser (`kind: other`, "never erroring") **[R]**;
folds are idempotent on identity keys (`(traceId, spanId)`) **[R]**.

**12. Identity is declared at the source, namespaced by instance — never
inferred from names, slugs, or positions.**
Origin: prd2 rulings ("nothing inferred from slugs, paths, or magic
strings"); conductor resolved **by role, never by name**
(`findConductorAttribution` — "a lane literally named `conductor` proves
nothing, `role: 'conductor'` proves everything") **[V]**; record-format dedup
key `(actor.instance, event.id)` **[V]**; #187's pid+heartbeat session lock
**[R]**.

### Article III — Honesty (the voice)

**13. Honest gaps: absence is reported, never dressed — WHAT is missing, WHY
it matters, THE command that fixes it.**
Origin: prd3 law 12 (the gap voice); `/api/lanes`' "never a silent empty
list" (`available: false, reason: …`) **[V]**; prd13 ruling 8 (no-data is a
hatch, "an uninstrumented lane must not look like an idle one"); prd15
ruling 5 (ATTACH degrades honestly); #156 ("no activity recorded" is a real,
tested value) **[V]**.

**14. Never invent a number; provenance rides every figure.**
Origin: prd1 (sessionlog is documented "No dollars" rather than estimating);
#47 ("design for the correctly-configured case; surface incomplete
configuration as a gap, never as a second-class metric" — the token-ratio
fallback *rejected* because it trains users to read a token ratio as a dollar
figure) **[V]**; `overhead()` returns `null`, never `0` **[V]**; prd9 ruling 7
("dollars are vendored, flagged, or absent — never invented");
`—` rather than a fabricated `$0.00` in `sessions` **[V]**; trace law 1
("no spend from spans"; a span may JOIN a spend record, never create one)
**[V]**.

**15. Evidence or silence: no bare claims, no bare reassurance.**
Origin: prd3 ruling 14 ("collisions: 0 — checked N branches / M files —
never bare reassurance — the absence-of-flag research"); graft g4 (attention
chips carry evidence strings, never bare labels); `judge.ts`'s schema
refinement (a finding without matching evidence does not parse) **[V]**;
graft g5's ladder floor — ALL CLEAR is *typed* as incapable of coexisting with
a nonzero collision count (`@ts-expect-error` pins it) **[V]**.
Note the delicious reflexivity: every grep-law test opens by asserting its own
non-vacuity — "an empty grep proves nothing" **[V]** in readonly,
no-panel-refolds, and fixture-hygiene alike. The constitution applies
"counts are never reassurance" to its own laws.

**16. A cut declares itself.**
Origin: transcript `dropped` counts ("a reader who can't see it was cut is
being told the tool said less than it did") **[V]**; `+N` overflow in
auto-titles; coalesced pulse counts; the hide-finished toggle carrying its
count even collapsed ("a filter that hides its own effect is a filter that
quietly makes the picture a lie") **[V]**; prd13 ruling 5 — a scoped window
visibly declares itself, ruled on witnessed Grafana evidence ("one drag
silently rewrote every panel" **[R, Ran in spike]**).

### Article IV — The glance (visual law)

**17. Attention leads; the first-second question is "anything need me?"**
Origin: prd3 rulings 1–2, 5, 8 (the alarm ladder CALM → NOTICE → NEEDS-YOU →
BROKEN); prd4 ruling 2 (the scene answers "what is the fleet doing" first).
Enforced as *numbers, not taste*: the contrast budget
(`RECEDE`/`CALM_CEILING`/`ALARM_FLOOR`/`CALM_FLOOR`) — "a brightness you can
only re-find by looking at the screen is a brightness that drifts dark again"
**[V]**; BROKEN's exemption is pinned as dominance-under-recession **[R]**.

**18. Hue is meaning and each hue means one thing; brightness and grammar own
attention; color is never the sole carrier.**
Origin: prd3 law 9 → prd4 ruling 3's 9a/9b split; one chokepoint
(`ACTIVITY_HUE`) so re-aiming the palette "is an edit to one record, not a
sweep through five files" **[V]**; OKLCH distance in `palette.test.ts` (HSL
"put done and notice 29° apart… on a pair no eye actually confuses") **[V]**;
prd10 rulings 5/11 amend it *by quarantine* (the violet accent "may appear
only in scene tissue draws… it is never text").
Enforced: `palette.test.ts`, `salience.ts` tests, and the #136 legibility
floor — a grep-law that text may wear nothing dimmer than `ice-400` (5.1:1),
with an explicit aria-hidden allowlist whose stale entries fail loudly
**[V]**.

**19. Motion is spent on events; states glow; every moving pixel lives inside
a budgeted class with caps.**
Origin: prd3 law 10 + ruling 32's three pulse laws (history never pulses;
traffic is coalesced, never invented; an arrival flare is the end of a real
journey — each with an enforcing test in `pulses.test.ts`) **[V]**; prd5
ruling 4's three classes with load-bearing numbers (≤3% ambient amplitude from
calm technology; event cap of 5 from Pylyshyn & Storm's tracking limit)
**[V]**; prd10 ruling 10 adds a fourth class (`dissolution`) *with its bounds
as tests* rather than loosening the existing three.

**20. Surfaces self-legend or the fleet table teaches; a legend never.**
Origin: graft g1 ("the table IS the legend"); prd3 ruling 21 (learnable in
<30s, no text legend); prd13 ruling 7 ("labels when they fit; colour when
they do not; a legend never" — Grafana's per-panel legend named as "the
crutch this project has already ruled against").

**21. The curated order is the product; one hero; positions are pointable.**
Origin: prd3 ruling 6 (no drag/resize/custom layouts); prd4 ruling 2 (the
scene is the centerpiece; `PanelGrid.tsx` is "the one file that knows the
curated order") **[V]**; prd13 ruling 1 (the TIDE is the replay bar's body,
"never a panel… the answer is no"); prd16 ruling 4 (a library, not a second
overview). Pointability: graft g7 (angle is identity, pinned by test), prd13
ruling 3 (rows stable; "rows that move under the cursor destroy the muscle
memory").

**22. Every failing mark gets an affordance or is CUT — and the cut names what
it gives up.**
Origin: prd13 ruling 13 (the band cut: "the density band got its affordances…
and it still read as noise to the only person using it. So it goes." — with a
section headed "What is deliberately given up, named so nobody re-adds it by
accident") **[V]**; the same protocol earlier: distance-as-recency replaced
(failed the layman bar), the knot replaced by the fold (#117 — the law itself
was the mould), `root-arrival` deleted outright, react-three-fiber removed
from the tree. Sister principle: **nothing balloons, nothing vanishes** —
absolute scales with floors and ceilings (`seedSize`, `SCAR_FLOOR`:
"invisible completion is indistinguishable from a render bug") **[V]**.

### Article V — Process epistemics (how rulings are earned)

**23. Measurement before optimization; [Ran] beats [Read]; a claim you only
read is a hypothesis.**
Origin: prd7's reframe (a live profile found 60fps and zero `shadowBlur` —
"'janky' was the form language, not the renderer" — so nothing was spent on a
renderer) **[V]**; marching squares chosen on 1.28 vs 42.8 ms/frame measured;
the spring's closed form chosen because Euler *measurably* diverges (−5.2e8 in
twenty long frames) **[V]**; every research note grades claims and the
adversarial audit's own header defines [Ran]/[Read]/[Hypothesis] **[V]**;
prd9 ("built on captures, not docs"); prd15 ruling 7 ("captures, not
confidence").
Corollary: **a timing assertion under load measures the machine, not the
code** — the wall-clock flake replaced by a ratio guard + deterministic vertex
cap (#113) **[V]**; gates measure a busy box (prd3 rulings 33–34: "a test that
cannot survive contention is a latent flake").

**24. The suite cannot see the browser — so eyes are a named instrument, not a
shame.**
Origin: architecture Testing ("The scene is verified by eyes, not units —
said honestly"); browser verification for every UI issue (prd1 process,
repeated per-prd); prd7 ruling 1 (WebGL rejected partly because jsdom returns
`null` — "a WebGL painter is one this suite could never execute") **[V]**;
bugs found only "by building a throwaway software rasterizer and actually
looking" (#113, #114) **[V]**; the display list stays plain queryable data
(structuredClone conformance test) precisely to keep the testable surface
maximal **[V]**.

**25. Fences define ownership; contracts are pinned by the real payload, not
an approximation.**
Origin: the panel-directory disjointness (architecture); the 2026-07-30
decision "fences must cover every file a change can orphan"; #91 (a
hand-rolled test double let both sides go green while the live wire failed —
the regression test now pins the exact server payload) **[V]**; issue #17
("test doubles must match the real protocol, not the convenient one");
prd15 ruling 4 (the adapter contract: conformance = version-pinned real
captures of BOTH outcomes).

**26. Supersession is recorded, never silent.**
Origin: everywhere — the roadmap's *"superseded by what actually shipped"*
entries; prd6 ruling 1 explicitly OVERRULES #102; prd10 ruling 13 "knowingly
rescinds" prd5's cord-cut; prd13 ruling 13 lists which rulings the cut does
and does not touch; prd15's distribution ruling names the 2026-08-03 ruling it
supersedes; architecture leaves the prd7 table "as the historical record…
with a pointer to what it became" **[V]**. The constitution keeps its own
case law.

---

## Part 2 — Tensions, and how rulings resolved them

**T1. Read-only absolutism vs. usefulness (fork, rotation).** Resolved by the
amendment protocol (Principle 2): the old law never weakens; a new *hand* is
chartered with its own namespace law test. Two amendments so far (lab,
recorder), both citing the same logic. The pattern is now stronger precedent
than either amendment.

**T2. Render everything, always (prd3 ruling 22) vs. legibility at scale.**
Resolved in three moves: (a) coalesce with a declared count, never hide
(pulse law 2, prd13 ruling 4); (b) record a falsifiable re-rule trigger with a
named cheap retreat (ruling 31: label collisions ~30–35 lanes →
labels-on-hover); (c) when affordances fail the only real user, CUT (ruling
13). Note the arc: the operator's own maximalist ruling (22) was honored,
instrumented for falsification, and then partially walked back *through the
recorded protocol* — the constitution eating its own cooking.

**T3. Beauty vs. honesty (prd10).** Resolved by quarantine and restatement:
ornament must read as language (ruling 23); the accent hue is tissue-only with
a law test; growth rings are "data-honest: every ring is a real landing";
motes spawn only from real severance; "laws restated stronger, never
weakened" (ruling 8). Beauty is allowed to *restate* facts, never to add or
soften them.

**T4. Structure-as-truth vs. persistence-as-memory.** prd5's cord-cut made
"finished" a structural fact (disconnection — chosen because every surveyed
tool restyles and colour is misreadable). prd10 ruling 13 rescinded the
deletion half on the metaphor's authority ("a mycelial network does not
delete the cords that carried its nutrients"). Resolution: completion is a
*transformation* (thin, still, luminous — "luminous, but not alive"), and
density is bought by hierarchy, never removal (rulings 14–16). **This is the
one place in sixteen prds where the metaphor overruled a measured design
argument**, and the audit later found its cost (persistent strands rebuild
ribbon geometry every frame, P2) — the tension is resolved in law but not yet
in the frame budget. **[V]**

**T5. Zero-config vs. declared-beats-inferred.** Declaration needs
cooperation; zero-config forbids requiring it. Resolved by the enrichment
ladder (prd15 ruling 5): L0 is the FULL core experience with zero
cooperation; declarations *upgrade* inference where offered; doctor and the
provenance strip say the rung per lane; two witnesses disagreeing is an
honest voice, never silently resolved (ruling 2).

**T6. The layman bar vs. the cyber-sigilist register.** Resolved by
self-legending (the table teaches, the scene speaks) and by the standing rule
that anything needing explanation fails (distance-as-recency died of it).

**T7. "Collectors emit raw facts only" vs. "the summons is a fact."** Not yet
resolved — see Gap 1. `chapters.ts` hit this wall honestly: the ladder's rank
is `buildFleet`'s judgement folded from multiple signals against a clock, so
summons-onset has no event and cannot be a chapter mark. The derivation
stance (never store what you can derive) collides with the record stance
(what the instrument told the operator is itself history). Today derivation
wins by default, not by ruling. **[V]**

---

## Part 3 — The gap analysis: principles the last month's failures imply

**Gap 1. Operator acts and instrument verdicts join the record.**
Evidence of absence: rulings, gates, widenings, and dispatch waves exist only
in markdown and issue bodies; `chapters.ts` proves the instrument's own
summons has no event **[V]**; the only operator act in the event union today
is `fork.checkpoint` with `capturedBy: 'operator'` **[V]**; prd16's rotation
is an operator act that will presumably surface only as a new
`session.started`. Meanwhile prd11 defines the causal chain as transcript →
tool → file → commit → "the branch/prd that ordered it" — and that last link
dead-ends outside the record. The forest (prd11's multiplayer future) makes
this acute: a stranger replaying your record sees what the fleet did, never
why, and never what the instrument claimed at the time.
*Proposed law:* **"An act that changes what the instrument shows, records, or
permits is itself an event."* Additive `operator.*` / `verdict.*` types
(ruling reference, gate held/passed, session rotated, label applied — the
label sidecar stays authoritative for *content*; the event records *that it
happened*).
*Test shape:* grep-law over `cli/` and the UI's mutation surfaces — every
handler that writes a sidecar, rotates a log, or dispatches a fork must call
the event emitter; plus a replay-parity test: a summons visible live at time T
is reconstructible at scrub-time T (this one already half-exists via the
shared reducer; the missing half is the onset instant as a fact).

**Gap 2. Recordings never rot.**
Evidence: the reducer skips unknown *types* (`reduce.ts` default) **[V]** and
the record format refuses unknown *schemaVersions* ("a reader that doesn't
understand a version should refuse, not guess") **[V]** — but event *payloads*
carry no version, `parseJsonl` reports a changed-shape line as a schema error
**[V]**, and nothing in CI folds a recording from an earlier era through
today's reducer. Sixteen prds of additive-only discipline have kept this safe
so far, but "additive-only" is a convention with no tripwire, and prd16 just
made recordings the product's headline artifact ("the session is a thing you
can hold").
*Proposed law:* **"Every schema era leaves a pinned recording in the corpus,
and today's reducer folds every era's recording to its recorded headline
facts."* One small real session file per era under `fixtures/recordings/`,
a test asserting lanes/landings/spend match the numbers frozen at capture
time, and a CI failure message that names the era broken.
*This is the event-sourcing orthodoxy the repo is otherwise fluent in —
upcasting/versioning — and the one orthodox practice it has skipped.*

**Gap 3. Every summons names its evidence AND its remedy.**
Half-codified: gap states carry the fixing command (law 12); chips carry
evidence strings (g4); but a NEEDS-YOU summons carries lane + why + how long
and stops there — the remedy lives in the operator's head (press `n`, press
`a`, open the drawer). Aviation solved this: an ECAM/EICAS warning is bound to
its checklist. The affordances exist (`n`/`a`/click); the binding is
convention.
*Proposed law:* **"An attention item is not constructible without an evidence
string and an action affordance."** Type-level: `LadderItem` requires
`evidence: string` and `action: LaneAction` — the g5 move (unrepresentable
states) applied to the summons itself.

**Gap 4. Counts are never reassurance.**
Codified once (ruling 14's "collisions: 0 — checked N branches / M files")
and practiced reflexively in the law tests' non-vacuity assertions **[V]**,
but never generalized — and the judge is about to make it urgent: when rung 2
surfaces findings, "0 findings" will read as safety while the organ might
have been disabled, rate-limited, or watching zero lanes.
*Proposed law:* **"A rendered zero states its denominator: what was checked,
how many, how recently."** Test shape: every `*Gap`/empty-state component
takes coverage props with no default — a compile error to render reassurance
without evidence.

**Gap 5. One witness is no witness.**
The same lesson bought twice at full price: the conductor's watcher needed
SEVEN false-positive shapes before its verdicts were trusted only with
pane/repo verification (journal, 2026-08-0x: "the witness question finally
settled after SEVEN false-positive shapes… NO watcher verdict acts without
pane/repo verification") **[J]**; the product needed #133's false summons
before WAITING required a completed turn *plus* a settle window, corroborated
against a 150-turn corpus **[V]**; prd15 ruling 2 then ruled beacons vs.
transcript "two witnesses; disagreement surfaces as an honest voice." Three
convergent instances, no named law.
*Proposed law:* **"An inference that can summon a human requires a
declaration or two independent signals; a single-witness inference may reach
NOTICE, never NEEDS-YOU."** Test shape: structural, like `lane-state.ts` —
enumerate the paths into the needs-you rank and assert each consumes either a
declared event or two sources.

**Gap 6. Delete code nothing calls.**
Practiced with distinction (the band cut removed its whole machinery;
`knotMark` "no longer exists in source"; `root-arrival` deleted; r3f gone from
the tree) but each deletion was an operator ruling, not a standing sweep.
*Proposed law:* **"An export nothing imports is a failing test."** Cheap:
ts-prune (or knip) in CI with a reviewed allowlist, in the same
loud-diff-a-reviewer-reads style as the grep-laws. Weakest of the six gaps —
adopt it as hygiene, not constitution.

**Gap 7 (unprompted, from the audit). The instrument must not perturb what it
measures.**
The motion budget protects the *viewer's* attention with hard numbers; no
equivalent budget protects the *watched machine*. The audit found the judge
spawning 435 `git merge-tree` processes per minute on a 30-lane fleet —
"competing with the very agents being watched" **[V]** — and the journal's
frozen-instrument episode (224s blocking vs 395ms fresh) **[J]** is the same
class. An observability tool that steals the fleet's CPU is quietly editing
the data it reports (a lane slowed by the observer looks FROZEN sooner).
*Proposed law:* **"The observer's own footprint is budgeted and measured like
motion: a ceiling on subprocess spawns and wall-clock per poll cycle, pinned
by a test against the 20-lane fixture."** This is Heisenberg dressed as SRE:
monitoring must not spend the system's own error budget.

---

## Part 4 — The comparative test

**Calm technology (Weiser & Brown, "The Coming Age of Calm Technology," 1996;
Case, *Calm Technology*, 2015).** Consciously aligned, and *cited in the
code's own justification*: the ≤3% ambient amplitude is argued directly from
"a display earns the periphery only if it can be ignored" **[V]**. The
attention strip/tab-title/favicon ladder is Weiser's periphery→center
movement, executed. One deliberate strengthening: calm tech is content with
peripheral reassurance; rhizomorph forbids *bare* reassurance (ALL CLEAR must
carry its denominator). Where calm tech says "technology should require the
smallest possible amount of attention," prd3 ruling 2 restates it as a
falsifiable one-second question — a better version of the same idea.

**Tufte (data-ink, chartjunk; *The Visual Display of Quantitative
Information*) and Few (*Information Dashboard Design*).** prd3 is
Tufte-fluent: "color demoted to semantics, contrast spent on data,"
"Bloomberg numbers in Linear bones," the shared formatter, monospace tabular
numerals. prd10 then *consciously diverges*: "replay should look like a
legitimate art piece" is a chartjunk indictment waiting to happen — and the
divergence IS argued: the market thesis ("ops tooling is aesthetically dead;
'beautiful instrument' is a gap," prd3) plus the quarantine rules (ornament
must read as language; the accent is never data ink; rings are real
landings). Few would still fail the mycelium scene outright; the repo's
answer — that the scene must beat the tables at answering real questions or
lose its screen (ruling 4) — is a better-argued position than Few's blanket
ban. Silent on: Tufte's small multiples (per-lane sparklines died with the
band; nothing replaced the at-a-glance history texture — named as given up).

**Nielsen's heuristics.** Strong alignment mostly *without citation*:
visibility of system status is the product; error prevention became
unrepresentable states (g5, `severity: z.literal('log')`); recognition over
recall became self-legending; help became the gap voice (help that names the
command is heuristic 10 done right). Conscious divergence: **user control and
freedom** — no layouts, no drag, no resize, one curated order (prd3 ruling 6).
The divergence is argued (curation is the product; the operator is the
curator) but only from the solo-operator premise; the cohort/forest future
will stress it. Flexibility for experts exists as keyboard registers, not
customization.

**Unix philosophy.** Aligned: do one thing (observe), text streams (JSONL is
the interface; the record format hashes lines as opaque text so foreign
emitters can reuse it **[V]**), composition (`export-record` | `replay`).
Consciously divergent on the *rule of silence*: Unix silence means success;
rhizomorph rules that silence is never evidence (Principle 15) — an argued
inversion, since its subject (agent fleets) fails silently by nature. Unargued
divergence: the web UI is a monolith (one tree, one store, no plugin seams) —
defensible, but never defended in writing.

**SRE (golden signals, error budgets, alerting philosophy).** Traffic
(tokens/burn) and errors (#159) are surfaced; **latency was consciously
declined** ("errors yes, latency no," recorded in `format.ts` per prd13
ruling 11) **[R]**; **saturation is silent** — notable because prd1's own
honesty note says that on subscription plans the ticker's real meaning is
"rate-limit budget," a signal the product names and never renders. Alerting
philosophy aligns precisely with the Google SRE book's "every page should be
actionable": the ladder, evidence strings, aging-within-rung. Error budgets:
absent as a concept, yet the repo *performed* one calculation (the 75s settle
window justified against 150 resumed turns — a false-summons budget) without
institutionalizing the practice. The #133 corpus is an SLO waiting to be
named: *the summons precision target*.

**Aviation's dark cockpit.** Aligned in mechanism: the calm world is dim by
law (CALM_CEILING), a lit thing means act, insistence ages within a rung the
way aviation inhibits cascading alerts. Divergent in one deliberate,
philosophically interesting way: dark-cockpit trusts darkness (no light = all
fine); rhizomorph refuses exactly that inference — ALL CLEAR is an *active,
evidence-bearing* annunciation, because this instrument's sensors (inference
over polling) are less trustworthy than an aircraft's wired discretes. The
divergence is correct and nowhere argued in these terms. Missing from the
borrowing: aviation binds every caution to a procedure (Gap 3).

**Event-sourcing orthodoxy (Young, Fowler).** The deepest alignment in the
repo: append-only log, single fold, projections-as-selectors, replay as a
first-class citizen, idempotent delivery, events as immutable past-tense
facts, the log as the wire format. Divergences: no CQRS write side — because
the whole product is the read side (novel and clean); snapshots arrived only
when measurement demanded (fold trilogy) rather than by doctrine — fine; and
the one orthodox practice skipped is **event versioning/upcasting** (Gap 2),
which orthodoxy considers non-optional for exactly the artifact prd16 just
promoted.

---

## Part 5 — The document question

**Yes — write `docs/constitution.md`, and make it load-bearing.** The
material exists but lives in three places with three failure modes:
`architecture.md` (1,972 lines of narrative — authoritative but unindexed;
principles are buried in prose about the code that embodies them), the prds
(rulings with supersession chains a newcomer cannot walk), and the law tests
(enforcement without a table of contents). The handover/cohort future (prd9's
"something a stranger inherits rather than something an author explains") is
the argument: a stranger can read 300 lines of constitution; nobody inherits
1,972 lines of decisions log as their first document.

**Structure:**

1. **Preamble** — what this instrument is (observer, three hands), and the
   amendment protocol as Article 0: *a law is amended only by adding a named
   hand or a stricter restatement, never by weakening; every amendment ships
   its own law test* (the prd12/prd16 pattern, promoted from precedent to
   rule).
2. **Articles I–V** as extracted above (Posture · The record · Derivation ·
   Honesty · The glance · Process epistemics).
3. **Per law, four fields:** statement (one sentence, testable) · origin
   (prd/ruling/issue) · enforcement (test file path, or `NONE YET`) ·
   supersession history (what it replaced, what replaced parts of it).
4. **The case-law appendix** — pointers into architecture.md's decisions log,
   not duplication. architecture.md remains the narrative record; the
   constitution is the normative index. (The repo already distinguishes these
   registers: prds are "blessed docs before they are backlogs.")
5. **`constitution.test.ts` — the constitution's own law test.** Parse the
   doc's enforcement column; assert every named test file exists; assert
   every `*-law.test.ts` / known grep-law in the tree appears in the doc.
   Now the document cannot silently rot in either direction — which is the
   repo's signature move, applied to itself. Without this test, do not write
   the document: an unenforced constitution is exactly the "second summary an
   author has to keep in sync" that #156 ruled against.

**Laws with tests today** (constitution ships citing them): read-only
(drawer grep), lab namespace, fixture hygiene, legibility floor (#136), fold
ownership (no-panel-refolds), ladder floor (type-level), two-clocks/waiting
exclusivity, pulse laws ×3, motion budget + spring stability, contrast budget
numbers, no-spend-from-spans + idempotent fold + structural allowlist, mould
clause (#117 clause 4), variation channel table, contour determinism,
purity/prefix-consistency (tide), non-vacuity idiom throughout.

**Laws needing tests** (constitution names them `NONE YET`, each an issue):
the repo-wide no-outbound-socket grep (Principle 3); rotation namespace law
(mandated by prd16, verify landed); Gap 1 (acts are events); Gap 2 (era
corpus); Gap 3 (summons carries remedy, type-level); Gap 4 (zeros carry
denominators); Gap 5 (two witnesses for a summons); Gap 7 (observer footprint
budget); the "declared beats inferred" universal form (prd15 ruling 2 states
it; the beacon collector that makes it testable is wave 3).

---

## Part 6 — What the operator is missing that's obvious

**The operator is the only agent in the system that rhizomorph cannot see —
and the product already proved why that class of hole is fatal, in prd1.**

The founding insight of the money layer was: "orchestrated setups
systematically undercount by omitting the orchestrator's own spend — the
conductor was plausibly the largest single consumer." So the conductor's
tokens became first-class, role became an attributed dimension, and the
overhead ratio became a headline metric. That was the right correction, one
level down.

One level up, the same undercount is running uncorrected. Sixteen prds,
~150 rulings, two constitutional amendments, gate holds, wave dispatches, a
band cut — the *governance* traffic that actually steered this fleet — and
not one of those acts is an event. The instrument that exists to make process
visible has made every process visible except the one that decides
everything: the operator's. `chapters.ts` states the consequence in its own
doc comment — the summons, the instrument's single most important output, "has
no event," so the timeline cannot even point at the moment the operator was
called **[V]**. prd11's causal chain (transcript → tool → file → commit →
"the branch/prd that ordered it") terminates at a markdown file that lives
outside the record it's supposed to complete. And the forest — the ruled
product direction — is precisely the setting where a stranger replays your
session and needs the why: two actors' records merge (record-format's merge
law exists **[V]**), but neither record contains a single decision.

The fix is small and the repo has already built every part of it once:
rulings/gates/rotations as additive events (the schema discipline exists),
`capturedBy: 'operator'` (the field exists, in `fork.checkpoint`),
sidecar-for-content/event-for-occurrence (the label pattern exists), chapters
as the surface (the mark lane exists and is starving for exactly these
moments — "gate held, operator command" are prd12's own named checkpoint
moments). prd16 even bent the trajectory this way by making the session
boundary an operator's explicit act. What's missing is only the ruling that
names it: **the operator is an agent of the fleet; acts of governance are
facts of the session.** Until then, replay-as-art (prd10) will render growth,
flourishing and return with perfect honesty — of a garden that apparently
tended itself.
