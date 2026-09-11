# prd-30 — the open hand: every mark explains itself

> **Outcome:** all four waves shipped; **one operator act outstanding** — the first-glance acceptance.
> Reconciled 2026-09-10, corrected 2026-09-11 when wave 4 reached `main` (see the amendment at the
> foot of this document, which also declares the waves in the form `scripts/dev/prd-reconcile.sh`
> reads).
>
> What landed: the shared disclosure card and the `title=` adoption sweep (#220, `8ee1b498`);
> the re-seat that let `one-card-law.test.ts` widen to its full sentence with an **empty**
> allowlist, retiring `MarkHoverCard` and the loupe read-out as separate card chrome (#221,
> `ac152919`); focus parity proven **per file** rather than per directory, with ADR-0045
> for why the render's transitivity forces a hand-maintained map (#334, `24b836b0`); and the
> last twelve native tooltips retired with `NOT_YET_SWEPT` **deleted** rather than emptied
> (#389, `b33da639`).
>
> **What is left is one act, and it is the operator's.** The **first-glance acceptance** —
> not a lane, and it carries prd-33 ruling 14's Check 3 list (see the amendment further down).
> Success criteria 1 and 3, which this block held open until wave 4 landed, are met: the laws
> that encode them — `packages/web/src/disclosure/one-card-law.test.ts` and
> `packages/web/src/app/title-residue-law.test.ts` — run green with no allowlist and no
> carve-out left in either.
>
> **This block said the opposite until 2026-09-11, and how it went wrong is the part worth
> keeping.** It was written in `c243c28f`, a commit inside PR #419 sitting *directly on top of*
> `b33da639` — the wave-4 work that same PR landed. So it described `NOT_YET_SWEPT`'s four
> carve-outs and twelve surviving tooltips as live while the commit beneath it had already
> deleted them, and it contradicted its own Outcome line one paragraph above. A status line
> authored inside the PR that lands the thing it calls outstanding is stale at merge by
> construction, and nothing went red: no law holds a PRD's status prose to the tree it
> describes. The same commit left `docs/roadmap.md`'s prd30 entry naming three resolved items
> as outstanding, corrected in the same change as this one.
>
> **The "97 native tooltips" this line used to quote was a bare-grep overcount.** The
> residue law's own docstring records the correction: 26 of the 97 were props on local
> components — `<Vital title=…>`, `<Figure title=…>` — and two were `<PanelFrame title="Fleet">`,
> which renders a *visible heading* and never was a tooltip. #220 retired **50** real ones
> (`packages/web/src/disclosure/testing.ts`). Count with the law's `nativeTitleSites`, which
> resolves the element each attribute sits on; a grep miscounts in both directions. The
> pre-sweep figures in *Evidence* below are left exactly as written — that section is a record
> of the tree at `26c48c7`, not a live claim.
>
> Reconciled in depth 2026-08-22 at `03df141`; see `retained-prds-review-2026-08-22.md`.
>
> Builds the design charter's §6 rulings (`docs/design/charter.md`,
> PR #451): one hover-disclosure vocabulary on prd-27 ruling 5's label/why/remedy triple, and
> whatever hover discloses, focus discloses. It owns no charter §8 pending ruling — its authority
> is §6, binding on the charter's merge; the build rides here. **#192 is absorbed**: its fence
> (`core/src/selectors/` + `panels/fleet/`) moves to this PRD, prd-27 ruling 5 supersedes its
> text, and prd-27's server waves are untouched. Milestone 16. The card's visual form is decided here and reviewed by
> the team; the vocabulary and its laws are decided
> here, and reviewed by the team. **Kind: specifying** (`docs/prds/README.md`).
> Citations verified at origin/main `e8fed56`; ruling 4 and the specification added
> 2026-08-15 from `docs/design/ui-2.0-decisions.md` (D10, D11).

## Problem

The instrument fails the person it exists to convince, at the exact moment of contact. prd-04
ruling 1's layman bar — a first-time viewer should understand what is going on, what things mean,
and what to do next — is the standing authority, and today the answer to "what does this mark
mean?" is a native `title=` tooltip: OS-delayed, keyboard-invisible, absent on touch, and one word
long when it exists at all. Meanwhile the app has grown three disclosure components in three
idioms, so the same question gets a different-shaped answer depending on which pixel is under the
pointer — and the conditions the instrument knows most about still reach the screen with no why
and nothing to do, because the vocabulary prd-27 ruled has never been built. Every mark should be
an open hand: hover it, focus it, and it explains itself the same way everywhere.

## Evidence

- **Three disclosure components, three idioms, all shipped.** `MarkHoverCard`
  (`packages/web/src/tide/ChapterMarks.tsx:283` — the only hit for that name in the repo; it
  lives inside `tide/`, not a shared directory), the loupe (`packages/web/src/tide/Loupe.tsx`,
  176 lines, landed with #430 — the charter's census said one was still in flight; all three are
  shipped code now, and prd-21 landed with the same merge), and ~85 native `title=` sites in 25
  files (heaviest: `drawer/Vitals.tsx` 13, `panels/burn` 9, `panels/fleet` 9).
- **The vocabulary is ruled but unbuilt.** prd-27 ruling 5
  (`docs/prds/prd-27-the-declared-voice.md:112`): three strings per condition — label, why (with
  evidence and elapsed), remedy — assembled once so every surface says a condition identically;
  unknown fails the build (`_never`). "`remedy` has no hits across `packages/web/src`" (:36).
- **Nothing here waits on the server.** prd-27 stands at 8 open / 0 closed, **#326** (its
  keystone) unstarted, and `git grep laneCondition` returns zero hits — the condition selector
  does not exist, so the first mover defines it. Only beacon-derived conditions wait on prd-27.
- **#192**, operator ruling 2026-08-05: *"the waiting tag can be misleading, especially if we
  aren't explaining at a glance WHY it's waiting."*

## Success

1. One component discloses, everywhere. **Not met while** `MarkHoverCard`, the loupe and the
   panels each render their own card chrome, or a new disclosure surface lands outside
   `web/src/disclosure/`.
2. Every disclosed condition carries label, why and remedy, identically on every surface.
   **Not met while** two surfaces phrase one condition differently, or an unknown condition
   renders rather than failing typecheck.
3. Whatever hover discloses, focus discloses. **Not met while** any disclosure is pointer-only,
   or a keyboard user is refused an explanation a mouse user gets.
4. The fleet STATE column explains its word. **Not met while** WAITING renders without a why, or
   `ACTIVITY_TITLE.waiting` still reads `'stopped'` on any surface.
5. A first-time viewer learns from the surface itself. **Not met while** understanding a mark
   requires the README or AGENTS.md, or the teach affordance names a condition the selector does
   not know.

## Non-goals

- **No server work, none.** The first edition of the condition table is hand-authored over
  evidence the fold already carries, exhaustiveness enforced by the `_never` switch — no prd-27
  gate, nothing in `packages/server` moves. When #326 lands, beacon-derived conditions join the
  table additively; this PRD never waits for them.
- **Not AI-generated tooltip text**, and the constitutional price is named: generated prose
  cannot be pinned by a law test, and it can assert what the evidence does not hold. The house's
  one aesthetic law — an ugly surface that refuses to lie beats a gorgeous one that ranks — makes
  a guessing explainer a violation, not a feature. Every string is hand-authored and asserted.
- **Not prd-27's beacons, rungs or server waves.** The absorption moves only #192's render-side
  fence; ruling 2's keystone, the beacon collector and the lapse states stay exactly where prd-27
  sequenced them.
- **No new hue, no new motion class**, and no disclosure ever carries status by decoration.

**Rejected alternatives.** *A tooltip library* — imports someone else's focus and timing model,
which the laws would then police from outside; the card is small and the laws are ours. *Styling
`title=` harder* — the OS delay and the keyboard hole are the defect, not the paint. *Docs-first
onboarding* — relocates learning away from the glance, where the layman bar is scored. *Waiting
for prd-27* — the fold already knows enough conditions to stop answering in one word; beacons
upgrade the table, they do not unlock it.

## What already exists (do not rebuild)

prd-27 ruling 5 is the design — this PRD builds it and does not re-argue it; "visual form is the
implementer's" (prd-27:151) stands: the implementer decides the form, and the team reviews it.
`Gap` already carries `{what, why, command}` for feeds — the triple at feed altitude, proof the
shape renders. The `rungInfo` `_never` switch is the exhaustiveness pattern to copy.
`MarkHoverCard` and the loupe are working positioning and read-out code to re-seat on the one
card, not to throw away. The `:focus-visible` floor token is prd-32's to define; this PRD
consumes it and defines no focus paint of its own — its keyboard work is about what focus
reveals, not what it draws.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — one disclosure component, and whatever hover discloses, focus discloses

A new `web/src/disclosure/` directory holds the one card: label, why (with evidence and
elapsed), remedy — prd-27 ruling 5's triple, assembled once. The three shipped idioms re-seat on
it: `MarkHoverCard`'s card, the loupe's read-out, and the `title=` population progressively
(wave 3). Focus opens what hover opens, Escape closes, touch taps; no pointer-only meaning
anywhere in the instrument (charter §6, binding). The card never invents content: it renders
what the selector returns, or it renders the honest unknown.

## Ruling 2 — the condition selector lands in `core`, hand-authored table first; #192 is absorbed

Stated plainly: #192 closes as superseded. Its fence — `core/src/selectors/` plus
`panels/fleet/` — moves to this PRD; prd-27 ruling 5 supersedes its text; prd-27's server waves
are untouched. The selector is a pure total function over folded evidence, first edition built
against a hand-authored condition table with `_never` exhaustiveness — which is why it needs no
server work and no prd-27 gate. `unknown` stays and must name what is missing and which rung
would prove it, prd-27's clause unchanged. When #326 lands, beacon-derived conditions arrive
additively: new rows in the same table, rendered by the same card.

## Ruling 3 — the beginner layer is progressive disclosure on the same triples

The layman bar (prd-04 ruling 1) is the standing authority this layer answers to. Three depths,
one vocabulary: the glance word, the hover/focus card, and a teach affordance that expands the
same triple with its evidence — the first hover is the tutorial, so there is no separate
tutorial to rot. Nothing teaches what the selector does not know; a condition the table lacks is
the `unknown` card, which names what is missing rather than improvising warmth.

## Ruling 4 — teaching is just-in-time only; there is no tour and no manual to rot

Ruling 3 established that the beginner layer is progressive disclosure on the same triples. This
settles the shape: **the first hover is the tutorial, and there is no other one.** No first-run
walkthrough, no annotated overlay mode, no "learn the interface" document that drifts from the
interface.

The reason is not economy. A tour is a second description of the product, written once and
maintained never — it rots the moment a mark changes, and it teaches in the wrong place, hours
before the confusion it answers. Disclosure teaches at the moment of contact, and it cannot rot,
because it renders from the same selector that renders the mark. The bet this makes explicit:
**a stranger explores rather than gets stuck**, and every mark being explicable is what makes
that bet safe.

What follows from it: the teach affordance (wave 2) expands the same triple with its evidence
rather than introducing a second voice; the first-run path (prd-34) walks a person to a working
instrument and then gets out of the way, teaching nothing the surface cannot teach; and any
future request for a tour is answered by making the marks explain themselves better.

## The specification

Six answers per surface, per `docs/prds/README.md`.

### S1 — the disclosure card

**What and why.** One component, one vocabulary, everywhere a mark can be interrogated. It
replaces `MarkHoverCard`, the loupe read-out and every `title=` — so that the same condition
gets the same answer whichever pixel is under the pointer.

**Anatomy**, in fixed order, from prd-27 ruling 5's triple:

1. **Label** — the condition's name, in the instrument register. The same word the mark shows.
2. **Why** — one sentence, carrying **the evidence and the elapsed time**: not "waiting" but
   "no output for 6 minutes; last tool call was a file read".
3. **Remedy** — the exact next action, and a command where one exists, copyable by the existing
   `AttachButton` idiom (which always shows what it copied and never toasts).

**States.**
- *known* — all three strings, from the selector.
- *unknown* — the condition is not in the table: the card **names what is missing and which rung
  would prove it** (prd-27 ruling 5's clause, unchanged), and never improvises warmth.
- *loading* — none. The card renders from the fold, synchronously; a card that could be pending
  would be a card that could lie by omission.
- *error* — the selector throwing is a bug, not a state; the `_never` exhaustiveness switch means
  an unhandled condition fails typecheck before it renders.
- *degraded* — a condition whose evidence comes from a dead collector says so in the why line,
  in law 12's voice, rather than reporting a stale fact confidently.
- *replay* — identical; the card reads the folded state at the scrub position, and elapsed times
  are relative to that position rather than to now.
- *demo* — identical; the frame's simulated chrome carries the distinction (prd-34), not the card.

**Data source.** The condition selector in `@rhizomorph/core` (ruling 2), a pure total function
over folded evidence. **The card never fetches and never invents**: it renders what the selector
returns or it renders the honest unknown.

**Interactions and keyboard path.** Hover opens it; **focus opens exactly what hover opens**
(charter §6, binding); `Escape` closes it; touch taps open it. It is positioned within the
viewport by the loupe's existing positioning code rather than a new implementation. No disclosure
in the instrument is pointer-only.

**What would make it wrong.** Two surfaces phrasing one condition differently · a card whose why
has no evidence in it · a remedy that names no action · a `title=` surviving on a mark this card
covers · a pointer-only disclosure · a card that renders a guess when the selector said unknown.

**Acceptance criteria.**
- One component, in `web/src/disclosure/`; a law test asserts no other directory renders card
  chrome.
- Every condition in the table renders all three strings; a rigged missing string fails the suite.
- A keyboard-only pass reaches every disclosure the pointer can (test asserts focus parity for
  each adopting surface).
- `ACTIVITY_TITLE.waiting` no longer reads `'stopped'` anywhere.
- A condition removed from the table fails typecheck rather than rendering bare.

### S2 — the teach affordance

**What and why.** The beginner's depth on the same triple: the card, expanded, showing the
evidence behind the why rather than a second explanation.

**States.** *collapsed* (the ordinary card) · *expanded* (the same three strings plus the
evidence: the events, counts and timestamps the condition was derived from) · *unknown* (expands
to what is missing and which rung would prove it — the same honest gap, at more length).

**Data source.** The same selector; the evidence is the folded facts it used, not a new query.

**Interactions.** One affordance on the card, keyboard-reachable, its expanded state **not**
remembered per condition by default (see open questions).

**What would make it wrong.** A teach layer that says something the card does not · content
written for a beginner that contradicts the instrument register elsewhere · any generated prose.

**Acceptance.** Every condition's expanded view is derived from evidence present in the fold; a
test asserts no string in the teach layer exists outside the condition table.

## Sequencing (waves, each gated as ever)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it.

> **Note (2026-09-08, prd-53 wave 5):** prd-28's paper died in the 2026-08-19 deletion and its
> number is retired, never reused. The fence stands; the territory's owner is prd-53
> (`docs/prds/prd-53-the-lab.md`). The sentence above is kept as written — a number is an identity.

1. **Keystone:** the disclosure component in `web/src/disclosure/` and its keyboard/focus
   pattern — a new directory, zero collisions; nothing else in this PRD renders without it.
2. Parallel, fenced apart: the condition selector in `core/src/selectors/` and the fleet STATE
   surface (the absorbed #192 fence) — with coordination notes for **#223** and **#380** where
   `app/StatusBar.tsx` is shared · the teach affordance on the card.
3. The `title=` adoption sweep — per-directory fences, deliberately late: it touches 25 files
   and collides with everything otherwise. It follows prd-31's drawer and trace re-lay and
   precedes prd-32's era-closing sweeps.

**The three items above are the ORIGINAL plan and are not what was built.** They are kept
because a PRD is append-only and the plan of record's history is the point; the waves as
actually executed are declared in the 2026-09-10 amendment at the foot of this document.
Two divergences, both already ruled elsewhere: the sweep ran as the FIRST wave rather than
the last (the 2026-09-02 grooming note above says why per-directory fences could not hold),
and the condition selector in `core/src/selectors/` never became its own wave.

Note also that this list's **#223** and **#380** are **prior-tracker** numbers — this document
predates the 2026-08-21 rebuild. `#380` in particular now resolves to a live, unrelated pull
request in this repository, so a reader following it lands somewhere plausible and wrong.
AGENTS.md's citation note is the general form of this hazard; the numbers are left as written
because they are real provenance, and this paragraph is the disambiguation.

Unfiled work implied, described not numbered: the card and its focus pattern; the selector and
its table; the STATE surface re-seat; the per-directory `title=` sweeps.

## Open questions

- ~~The card's visual form~~ — **decided here** (S1's anatomy), reviewed by the team.
- **The first edition of the condition table** — which conditions ship in wave 2's hand-authored
  list is decided at grooming with the fold's evidence open, not here.
- **Whether the teach affordance remembers** — a seen-state per condition, quieter each time, or
  stateless. Open, not ruled.
- prd-27's inherited question — how disagreement between declared and inferred renders — lands
  on this card when prd-27 wave 3 ships; whoever rules it owns both surfaces.

## Grooming note — the sweep is one issue, not five (2026-09-02, #222)

Groomed against `main` at `26c48c7`. Two corrections to how this PRD's remainder reads.

**"MarkHoverCard remains" was the wrong word.** It reads as *absent*. It exists —
`packages/web/src/tide/ChapterMarks.tsx` — and so does the loupe read-out (`tide/Loupe.tsx`,
`tide/TideDock.tsx`). `disclosure/one-card-law.test.ts` says so itself, and says why the law is
currently narrow: those idioms are *shipped card chrome in other directories right now*, so a
law written to the full sentence would have failed on landing and wave 1 would have had to
disable it. What is owed is the re-seat that lets the law widen. That is #221.

**The sweep's per-directory fences are not safely achievable, and it is #220 as one
issue.** The sequencing above asks for one boundary per directory. Three of this package's law
tests are anchored across directory lines — the token law's `STATUS_RING_ALLOWLIST` into the
status bar, the legibility law's allowlist into the conversation drawer, and the kind law's
`HAND_SPELLED_TAGS` asserting both an exact count and an exact file set over the whole package.
Any lane rewording an anchored line lands in those same three files, so directory-sized lanes
overlap; lanes that exclude them hit the landing gate with work that was correct. One
deliberately large, coherent sweep is the honest shape, and AGENTS.md's own measurement is the
licence: PR size does not predict cycle time — unrelated code in one diff does, and this is one
change repeated.

`packages/web/src/scene/` is excluded from #220 while #39 holds `scene/palette.ts` and
`theme/theme.css`; its three tooltips move in a later pass.

**That later pass is #389, and #39 landed at `848f1323` on 2026-09-08** — so this exclusion
has expired. It is recorded here rather than struck out because the *shape* of the failure is
the reusable part: the exclusion was encoded in
`packages/web/src/app/title-residue-law.test.ts`'s `NOT_YET_SWEPT`, whose guard test asserts
that every entry NAMES an owner and never that the owner is still OPEN. All four entries'
owners closed between 2026-09-07 and 2026-09-08 and nothing went red, so a law that reads as
enforcing coverage was quietly exempting four directories. #389 deletes the mechanism instead
of adding a staleness check, on the grounds that a check on an empty list is decoration.

## Amendment — prd-33's glance rides this PRD's acceptance (operator, 2026-09-02)

prd-33 ruling 14 transfers the lay-viewer half of its wave-0 glance here. This PRD already owes a
first-glance acceptance by a genuine layman once #220 and #221 land, on the same screen prd-33's
scene occupies; two lay sessions on one screen was never sensible, and both 2026-08-22 documents
book the act separately without noticing the other — `docs/prds/reconciliation-2026-08-22.md`
asks this PRD to *"perform first-glance acceptance"* and prd-33 to *"Run the booked first-glance
operator act"*, and `docs/prds/retained-prds-review-2026-08-22.md` says the same of each in
prose. One unrun act, two PRDs' acceptance. That act is now one act, and it carries:

- prd-33's **Check 3 encoding list** — threads from a mass are lanes; thicker means *produced
  more*; distance is lifecycle; green working, amber waiting, hollow red dead; a cut thread is
  FROZEN, a needle tip EXPENSIVE; the centre is one organic mass — as recorded in
  `docs/design/glance-2026-09-02.md`.
- the two observations that run surfaced for a viewer's reaction: the fifth PATHOLOGY chip
  collapsing into `+1` at 1440 px, and the right-hand roster's activity word (`IDLE`, `WORKING`)
  sitting beside lanes whose STATE is a pathology.

A viewer FAIL on a scene encoding lands as an explanation in this PRD's vocabulary or as a scene
defect; the CUT remedy prd-33 ruling 5 held does not transfer, and ruling 14 says why.

## Amendment — the waves as executed, and wave 4 (2026-09-10)

Written because `scripts/dev/prd-reconcile.sh 30` reported three UNDECLARED WAVES against
this document: the tracker held #220 at w1, #221 at w2 and #389 at w4, and this PRD declared
none of them. The reason is mechanical and worth recording, since it will recur in any PRD
written the same way — the detector reads a wave declaration as the literal string `**Wave N`,
and this document's *Sequencing* list used `1.` / `2.` / `3.` instead, so it declared nothing.
The single exception was an accident: a sentence in the 2026-09-02 grooming note opened with
a bolded wave-three heading, which declared w3 from inside a note that was arguing the
opposite. That sentence has been reworded to name the sweep instead of the wave number, and
the four waves are declared here. This paragraph deliberately does NOT quote the offending
string: reproducing a declaration verbatim while explaining it declares the wave a second
time, which is the duplicate the detector reports — the same rule prd-42's convention already
puts on SUPERSEDED markers.

The document is the plan of record, so it is amended rather than the issue titles moved —
the direction `prd-reconcile.sh`'s own header warns about getting backwards.

**Wave 1** — the disclosure card, its keyboard/focus pattern, and the `title=` adoption
sweep. #220, landed `8ee1b498`.

**Wave 2** — the re-seat that lets `disclosure/one-card-law.test.ts` state its whole
sentence with an empty allowlist, retiring `MarkHoverCard` and the loupe read-out as separate
card chrome. #221, landed `ac152919`.

**Wave 3** — focus parity proven per file rather than per directory, with ADR-0045 recording
why the render's transitivity forces a hand-maintained map over a scanner. #334, landed
`24b836b0`.

**Wave 4** — the native-title law has no exemptions left: the last twelve tooltips retire
from `scene/`, `replay/` and `concierge/`, and `NOT_YET_SWEPT` is deleted rather than
emptied. #389, landed `b33da639`.

Nine of those twelve became disclosure cards. Three did not, and the exception is a ruling
rather than an omission: `scene/`'s camera buttons carried their own accessible name plus a
keyboard shortcut, and the replay banner labelled two fields. None states a condition, rests
on evidence or has a remedy, so the vocabulary could only have been satisfied by inventing
all three — S1's own *"a card whose why has no evidence in it"*. They became accessible
names and `sr-only` labels instead, which the residue law is satisfied by: it forbids a
native `title=`, it does not require a card. ADR-0047 carries the related ruling on the three
controls that explain their own unavailability.

Wave 4 is one issue and not three, for the reason the 2026-09-02 grooming note already gave
about wave 3 and which has only got stronger: `packages/web/src/app/title-residue-law.test.ts`
now holds both `NOT_YET_SWEPT` and #334's per-file `PARITY_TEST`, so every adopting surface
must edit that one file or the parity law reddens. Three directory-sized lanes would collide
there; giving one lane sole ownership of it makes the siblings depend on that lane, which is a
stack wearing a bundle's clothes. One coherent sweep of the same change repeated is the honest
shape, and it is the same conclusion #222 reached.

**Ruled at wave 4's grooming, because #220 never had to face it.** Three of the twelve
tooltips sit on `disabled` buttons and exist precisely to explain the disablement — two in
`replay/index.tsx`, one in `scene/SceneView.tsx`. A `disabled` button cannot take focus, so
charter §6 is unsatisfiable on those three as written, and `disclosure/Disclosure.tsx` has no
`disabled` handling. They take `aria-disabled` with a guarded handler so they stay focusable,
scoped to exactly those three controls and to no other `disabled` control in the package. The
strings port verbatim: no new label/why/remedy authoring in wave 4, and no generated prose
ever. The guard is the part with a sibling defect in it — an `aria-disabled` button is a real
button, so it fires on Enter and Space too, and guarding only the pointer path leaves a
keyboard user able to invoke what the surface says is unavailable, which is strictly worse
than the `disabled` it replaced.

**What remains after wave 4 is the first-glance acceptance, and it is still an operator act.**
It carries prd-33 ruling 14's Check 3 encoding list and the two 1440 px observations, per the
2026-09-02 amendment above. Nothing in this PRD dispatches it to a lane.
