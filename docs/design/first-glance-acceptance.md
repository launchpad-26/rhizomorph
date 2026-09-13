# The first-glance acceptance — prd-30's last act

> **Run on:** ______________  **Viewer:** ______________  **Operator:** ______________
>
> **Status: NOT YET RUN.** Every Viewer column below is empty by design. This file becomes
> the record when it is filled in — there is no second artefact to reconcile afterwards.

This is the one operator act standing between prd-30 and closeout. Its build is finished: all
five waves are on `main` (`docs/prds/prd-30-the-open-hand.md` names the shas). Nothing here is
dispatchable to a lane, and nothing here can be automated.

Wave 5 shipped after this sheet was first drafted and changed what Check 2 asks — staging this
sitting is what found it. The banner on that check says what to verify before you start.

## Why it is one act and not two

prd-33 ruling 14 (`docs/prds/done/prd-33-the-living-scene.md`) transferred the lay-viewer half
of its wave-0 glance here. Both 2026-08-22 documents had booked a first-glance act — one per
PRD, on the same screen, neither noticing the other. One unrun act, two PRDs' acceptance; it is
now one act owned by one PRD, and it carries prd-33's Check 3 encoding list and the two
observations that run surfaced.

**The instrument half is already done and must not be re-run.** `docs/design/glance-2026-09-02.md`
captured what the fixtures actually put on screen, read off the DOM on 2026-09-02, and labelled
it EXECUTED. This sheet takes those as given. What is missing — the only thing missing — is what
a person says.

## What this act can and cannot do

**A viewer FAIL does not cut a scene mark.** prd-33 ruling 5 once allowed that; ruling 14 gives
it up explicitly and says why. A mark that fails here gets **an explanation in prd-30's
vocabulary** — label, why, remedy, through `packages/web/src/disclosure/` — or **a scene defect
filed against a shipped PRD**. Not a cut.

So the question this act answers is not *"should this mark exist?"* It is *"does this mark
explain itself to someone who has never seen it?"*

## Who counts as a viewer

prd-04 ruling 1's layman bar, which is a standing ruling: a first-time viewer — layman, even
though the product targets developers — should understand what is going on, what things mean,
and what to do next.

Disqualifying, and the reason the act has waited this long:

- anyone who has seen the instrument before, including in a screenshot;
- anyone who built any part of it;
- **an agent's reading of a capture.** `glance-2026-09-02.md` says this in as many words — a
  screenshot reading by the person who staged the fixtures is not a glance result. That
  sentence is why its Viewer columns are empty and why this file exists.

One viewer is enough. A second is better and costs one more sitting.

## Setup

Exactly what the 2026-09-02 run used, so the two halves describe the same screen.

| | |
|---|---|
| Checks 1–3 | `npm run dev:web` (Vite, :5173). Fixtures are client-side; no server needed. |
| Check 4 | `npm start` (:4321), watching any repo, then a recorded session from the picker |
| **Viewport** | **1440 px wide.** Not optional — how many chips the strip can name is a function of this width, and the observation below is written to it. At the 1100 px floor the strip names none at all. |
| Theme | default; Check 3 has a light-theme sub-item |

**Harness artefacts, not defects — do not let a viewer's reaction to these count as a finding:**
`/api/stream` 404 (no SSE under Vite), "could not load sessions" (the SPA fallback returns HTML
for `/api/sessions`), and a `CONNECTION ERROR` badge on the `live` source.

**The one trap that actually bit the last run:** once you have clicked inside the scene, it keeps
keyboard focus, and **`Esc` does not release it** — `packages/web/src/app/PanelGrid.tsx` says
Escape "is not handled and must not be". Press `1` expecting a source switch and you re-fit the
camera instead. Click outside the scene, or Tab, to get the source keys back. The 2026-09-02 run
hit this after clicking `PAUSE MOTION`, which Check 3 below also asks you to click; #225 closed
it by correcting `docs/demo.md` rather than the shell, so the behaviour stands.

Source keys: `1` live · `2` fleet20 · `3` pathology. `v` switches the fleet surface between
organism and list. `docs/demo.md` carries the full key table and each check's pass and failure
conditions in prose.

## How to run it without spoiling it

1. **Do not narrate.** No tour, no "notice how…". The check questions below are the only
   words the viewer should hear from you.
2. **Record verbatim**, including "I don't know" and including a wrong answer stated
   confidently — that is the most useful result this act can produce.
3. **Time Check 1 honestly.** Three seconds is the bar; a viewer who gets there in eight has
   failed the check and told you something real.
4. **Do not answer questions during a check.** Note the question — a question a viewer asks
   *is* a finding, because the surface should have answered it. Answer afterwards.
5. **Stop and record if the viewer is lost.** A rescued viewer produces no data.

---

## Check 1 — GLANCE (fixture `2`, 20 lanes)

Look away, then look back for three seconds at the top of the dashboard. Then ask:

| Question | Instrument shows (2026-09-02) | Viewer answered | Within 3 s? |
|---|---|---|---|
| Anything need me? | Pill `● ALL CLEAR`, evidence `20 lanes · 20 branches · 20 files checked · collisions 0` | | ☐ |
| How many lanes working? | `20 lanes` on the strip; fleet header `20 lanes · all live` | | ☐ |
| Rough cost? | Burn `482.6K OUT`, `$277.57`, rate `$429.47/hr` | | ☐ |

**Fails if:** the viewer hesitates past the glance, reads `ALL CLEAR` as an alarm (or the
reverse), or has to press `v` and read rows to get a lane count.

---

## Check 2 — PATHOLOGY (fixture `3`, 9 lanes)

Strip reads `● 5 NEED ATTENTION`. Ask the viewer to point at anything that looks wrong, then
press `v` and ask again.

> **Updated for prd-30 wave 5. Do not run this sitting until wave 5 is on `main`** — until then
> the strip behaves as the older rows described and the observation below asks a question the
> instrument no longer poses.
>
> **Check it on the screen rather than in the tracker**, which is quicker and cannot go stale:
> load fixture `3` at 1440 px and look at the attention strip. **One chip and `+4`** means wave 5
> has landed and this sheet is current. **Four chips** means it has not, and you should stop —
> the numbers in the rows below will not match what the viewer sees.
>
> No issue or PR number is cited here on purpose: this corpus's citation ceiling is the highest
> **merged** PR, so a number for work that has not merged yet cannot enter a tracked file.

The strip now names as many chips as actually fit and counts the rest. Measured in Chromium at
1440×900 on this fixture: **one chip named, `+4` beside it.** The named one is the worst rung —
FROZEN — because the ladder orders by severity, so the single chip a viewer gets is the most
urgent of the five.

| Pathology | Lane | On the strip at 1440 px? | Viewer pointed at it | Seconds |
|---|---|---|---|---|
| FROZEN | `42-otel-receiver` | **named** — `no events for <span>` | ☐ | |
| LOOPING | `41-retry-parser` | behind `+4` — `Bash→Read→Edit ×N, no commit` after `v` | ☐ | |
| WAITING | `43-drawer-attach` | behind `+4` — `workmux reports waiting <span>` after `v` | ☐ | |
| EXPENSIVE | `44-scene-pulses` | behind `+4` — scene shows a white-hot thread, `126K out` | ☐ | |
| OFF-FENCE | `45-ledger-subrows` | behind `+4` — `outside fence → 46-spend-selectors` after `v` | ☐ | |

Elapsed values are written as `<span>` rather than literals: the fixture's clock runs from when
you loaded it, so `11m03s` was true of one sitting and will not be true of yours.

**One extra, not booked by ruling 14 — ask it anyway, it is free.** The glance record raises
`ERRORS 2 ERR` on this fixture and calls whether a viewer reads it as a sixth pathology a Viewer
question, but it was never filed and ruling 14 books only the two below. Since this sitting is
the only one, a question with no line here is a question nobody asks.

> Did the viewer count `ERRORS 2 ERR` as another thing needing them? ☐ yes ☐ no ☐ did not see it

### The two booked observations — this is what ruling 14 sent here

Both are already known to be true of the instrument. What is *not* known is whether either one
costs a real viewer anything. Record the reaction, not your own judgement.

**1. Four of the five are counted rather than named, at 1440 px.** The strip names FROZEN and
shows `+4`. The protocol says "five chips"; the viewer sees one and a number.

**What ruling 14 sent here has changed shape, and it is worth knowing how.** When this
observation was booked the strip rendered four chips and a `+1` — and the `+1` was itself off
the right-hand edge of the screen, so three pathologies were hidden with nothing at all saying
so. That was a defect, found while staging this sitting and fixed in wave 5. The question
ruling 14 wanted answered — *does a viewer notice what the strip is not showing them?* — is
still live, but it is now a fair question rather than a trick one: the count is visible and it
is honest.

> Did the `+4` make the viewer look further, or did they stop at the one named lane?
> ☐ looked further unprompted ☐ stopped at FROZEN ☐ found the rest only after `v`
>
> Did they read `+4` as "four more problems", or as something else?
> ______________________________________________
>
> What they said: ______________________________________________

**2. The right-hand LANES roster shows the *activity* word, not STATE.** `42-otel-receiver`
reads `IDLE` while it is FROZEN; `41` and `44` and `45` read `WORKING` while they are LOOPING,
EXPENSIVE and OFF-FENCE. Only `43` reads `WAITING`. A viewer who reads the roster instead of
pressing `v` sees a frozen lane called idle.

> Did the viewer land on the roster first? ☐ yes ☐ no
>
> Did they read a pathology lane as healthy because of it? ☐ yes ☐ no
>
> What they said: ______________________________________________

---

## Check 3 — SCENE (fixture `3`, organism only, 30 s silent)

**This is the core of the act.** Ruling 14 sent this list here specifically. Show the organism,
say nothing for thirty seconds, then ask: *"what do you think you're looking at?"* and let them
talk. Tick only what the viewer **volunteers** — a prompted answer is not a volunteered one, so
record it in the notes column instead.

| Encoding the viewer must volunteer | Instrument renders it | Volunteered | Notes / their words |
|---|---|---|---|
| Threads from a central mass are lanes/agents | ✓ nine threads from `MAIN` | ☐ | |
| Thicker thread = produced more (not "working harder") | ✓ `44-scene-pulses` widest (126K) | ☐ | |
| Distance from mass = how far along | ✓ | ☐ | |
| Brightness / travelling pulses = activity | ✓ | ☐ | |
| Green working · amber waiting · hollow red dead | ✓ `42` red hollow; `41`/`43`/`45` amber | ☐ | |
| Cut thread narrowing to nothing = FROZEN | ✓ `42-otel-receiver` | ☐ | |
| Needle tip = EXPENSIVE | ✓ `44-scene-pulses` | ☐ | |
| Centre reads as one organic mass, not rings | ✓ soft contour, no facets | ☐ | |

**Watch for the "working harder" misread specifically.** Thickness encodes *produced more*. A
viewer who says "that one's working hardest" has read effort where the instrument means output,
and that is a vocabulary finding, not a wrong viewer.

Two sub-items, both already verified instrument-side — ask only whether the viewer notices:

- **Motion pause is self-describing.** `PAUSE MOTION` flips to `RESUME MOTION` with a
  `MOTION PAUSED` label in words (prd-33 ruling 12, WCAG 2.2.2). ☐ noticed ☐ not
- **Light theme** — the mass becomes an ink wash; frozen-red, waiting-amber and
  off-fence-dashed all survive the carrier switch. ☐ still legible to them ☐ not

---

## Check 4 — MODE (real server, recorded session, mid-scrub)

Load a recorded session and scrub into the middle of it. Ask nothing at first.

Unlike Checks 1–3, this one runs on **your** repo and **your** recording, so the values below
are **shape, not values** — the timestamp, the duration and the repo name are the 2026-09-02
run's own and yours will differ. What must match is the form of each row.

| Cue | Instrument showed (2026-09-02 — yours will differ) |
|---|---|
| Banner replaces the attention strip | `REPLAY · viewing a recorded past — not the live fleet` (strip absent, not tinted) |
| Timestamp + session identity | `2026-08-11 02:28:53 · 2:47 / 1425:38 · rhizomorph · <session>.jsonl` |
| Transport | `Play · 1x 4x 16x · Return to live`; `]` steps chapters |
| Elsewhere | LAB tab: `UNAVAILABLE DURING REPLAY — THE LAB FORKS LIVE CHECKPOINTS, AND THIS SESSION IS HISTORY` |

> **Viewer said, unprompted:** ______________________________________________
>
> ☐ "this is the past" (or equivalent) ☐ asked "is this live?" ☐ said nothing

---

## What to do with the result

**If every check passes**, record it above, then:

1. Amend `docs/prds/prd-30-the-open-hand.md`'s header — the outstanding act becomes a
   performed one, dated, pointing here.
2. Move the PRD to `docs/prds/done/` and update its `docs/roadmap.md` entry.
3. `docs/design/glance-2026-09-02.md`'s Viewer columns stay empty; this file is where they
   were answered, and that document should say so rather than being back-filled.

**If something fails**, it lands in one of exactly two places, per ruling 14:

- **an explanation in prd-30's vocabulary** — a label/why/remedy triple on the mark that
  failed, through `packages/web/src/disclosure/`. This is the default and the expected shape.
- **a scene defect** filed against prd-33, which has shipped. A shipped PRD is not edited in
  place; the defect gets its own issue.

Neither is a cut. If a failure seems to demand one, that is a ruling for the operator to make
and record, not something this sheet authorises.

**A partial pass is a pass with findings**, not a fail — file the findings and close the act.
The bar is prd-04 ruling 1's, and it asks whether a first-time viewer understands, not whether
they understand perfectly.
