# prd-30 — the open hand: every mark explains itself

> **Status:** proposed — builds the design charter's §6 rulings (`docs/design/charter.md`,
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

1. **Keystone:** the disclosure component in `web/src/disclosure/` and its keyboard/focus
   pattern — a new directory, zero collisions; nothing else in this PRD renders without it.
2. Parallel, fenced apart: the condition selector in `core/src/selectors/` and the fleet STATE
   surface (the absorbed #192 fence) — with coordination notes for **#223** and **#380** where
   `app/StatusBar.tsx` is shared · the teach affordance on the card.
3. The `title=` adoption sweep — per-directory fences, deliberately late: it touches 25 files
   and collides with everything otherwise. It follows prd-31's drawer and trace re-lay and
   precedes prd-32's era-closing sweeps.

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
