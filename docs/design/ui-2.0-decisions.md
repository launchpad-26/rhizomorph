# UI 2.0 — the decision record

> **Status:** decided 2026-08-15, in one operator interview session (~20 rounds).
> **Authority:** this document records *what was decided and why*. It rules
> nothing on its own — each decision lands as a numbered ruling in the PRD that
> owns it, and the PRD is what binds. When a PRD and this record disagree, the
> PRD is right and this record is stale.
> **Read this first** if you are picking up the UI era cold: it is the shortest
> path to the intent behind eight PRDs.

---

## The reframe

Before this session, the scene was understood as *one organism per instrument* —
your swarm, your lanes, your machine.

**It is now: the repo is the landscape; an organism is a person.** A developer,
their conductor, and their agents are one colony. Several people working the
same repository are several colonies in one shared world.

That single sentence reorders the product. **Multi-person observability is what
this UI is for** — not a later stage bolted onto a solo tool. The purposes,
in the operator's own order:

1. **Coordination** — who is working what, right now.
2. **Collision avoidance** — whose agents are touching my files. The collisions
   machinery already exists; across people it becomes load-bearing rather than
   a curiosity.
3. **Shared cost** — what the team is spending, and on what.
4. **Help** — who is stuck, so anyone watching can act.
5. **Organisation-level observation** over development teams using agentic
   workflows — implying a hierarchy: org → team → person → agents.

We **design for it and ship solo-first**: one person's swarm renders as one
complete colony, and the team layer arrives underneath a UI that already assumed
it. No visual redesign when it lands.

---

## What this era is finishing toward

**A desktop application a stranger installs.** Not a localhost URL behind a
clone and an `npm install` — an installable thing with a tray icon, a first-run
path, notifications, and updates. That is the finish line for "production
ready".

---

## The source material, and what we took from it

A collaborator's design handoff (a product called *Baseline* — an
experimentation platform for agentic workflows: runs, retros, variant
leaderboards, an R&D analyst, a permanent holdout) was harvested for this era.

**Taken:** its information architecture, its step/run reading, the idea that a
unit of work should be legible start-to-finish, its disclosure patterns, and the
craft of its light-ground palette.

**Rejected, with citations, so nobody re-proposes them by accident:**

| Baseline concept | Why it cannot land here |
|---|---|
| Variant leaderboards / ranking | Rejected three times already — prd-12 ruling 4, prd-14 ruling 3, ADR-0010 option D. `lab/compare.ts` refuses even to *sort* rows: "a sorted table is a ranking whether or not it says so." |
| An R&D analyst bot | Would be the first LLM call inside the instrument. Collides with "nothing leaves the machine" (README trust section, prd-9 ruling 9) and "the optimizer never lives in the Rhizomorph" (roadmap). |
| Stratified assignment · permanent holdout | No prior art in the repo, and structurally hard: checkpoints store *coordinates*, not content, so a held-out arm cannot be reopened later or elsewhere. |
| Model-written step summaries | The instrument makes no model calls and speaks in no voice that is not derived from evidence. |

Experiment-shaped ideas route to **prd-28 (the lab)**, whose nine issues already
contain three of the gaps Baseline highlighted: an arm holding *r* runs, an
outcome carrying how it was measured, and compare reading real outcomes.

> **Restamped 2026-08-25.** prd-28's paper did not survive the repository's
> deletion on 2026-08-19 and re-upload on 2026-08-21, and its nine issues died
> with it — so that routing instruction, read literally, points at nothing.
> Experiment-shaped ideas route to the lab's 2026-08-24 re-founding on a design
> canvas, which is the lab's design authority now; the three gaps are still the
> three gaps.

---

## What the app actually was, before this era

Stated plainly, because several decisions only make sense against it:

- **Five routes**, and navigation exists on **one** of them.
- **Inter and JetBrains Mono are declared in the theme and never loaded.** Every
  design decision ever made about this app was made against system fallbacks.
- The dominant text size is **10px**, hardcoded; **zero rem** anywhere, so a
  person's OS text-size preference is overridden entirely.
- **No light mode. No theme switching. No settings surface of any kind.**
- No responsive story below tablet width.
- **No visual or screenshot testing** — the deliberate substitute is that the
  scene emits a queryable display list and laws assert arithmetic.
- The grep laws (legibility floor, tissue accent, motion budget, mutating-calls,
  ruling-7, the fold law) are the real constraint surface: a redesign that
  renames a file, adds a fetch, or adds a colour fails them structurally.

---

## THE DECISIONS

Numbered for citation. Each is owned by exactly one PRD, named at the end.

### Reading a unit of work

**D1 — no new top-level "run" concept.** `/lane/:handle` becomes the run view.
*(prd-31)*

**D2 — the run view carries** a phase/step spine · outcome and evidence ·
conversation and trace side by side · and it is **readable after the lane is
gone**. *(prd-31)*

**D3 — durability is full, indexed by lane.** A lane's whole life is
reconstructible from the event log and captured transcripts, across however many
sessions it spanned, openable by handle or issue number. *(prd-31)*

**D4 — the interaction card is time-shaped.** Wall-versus-work leads: three
minutes elapsed, forty-seven seconds of actual work. The gap between those two
numbers is the most interesting fact we hold and nothing else surfaces it.
*(prd-31)*

**D5 — the verdict line is the agent's own words, quoted verbatim.** Never
summarised: the instrument makes no model calls. A bad sentence is the agent's
fault, not the instrument's. *(prd-31)*

**D6 — the facts strip shows only what we can honestly source** — model,
duration, tokens, cost with provenance, tool count, files touched. Fields with
no source (skills loaded, context %, check state) simply do not appear: no
placeholder, no dash, no promise. *(prd-31)*

**D7 — phase is derived and labelled as derived** — reads-only versus writes
versus runs-tests versus commits — never presented as something the agent
declared. *(prd-31)*

**D8 — subagents nest, collapsed by default**; **refusals (accepted / rejected /
blocked) are first-class marks** — uniquely ours, and often the explanation for
a stalled lane; **skim first, expand on demand**. *(prd-31)*

**D9 — one search over the loaded session** (conversation + feed + trace),
client-side, always declaring what it hid and how much. Never a panel
(prd-13 ruling 1's standing refusal). *(prd-31)*

### Explaining itself

**D10 — disclosure is one card: label · why (with evidence and elapsed) ·
remedy.** Hover and focus disclose identically. An unknown condition names what
is missing and what would prove it, rather than improvising. *(prd-30)*

**D11 — teaching is just-in-time only. The first hover is the tutorial.** No
tour, no onboarding walkthrough, no docs to rot: the explanation lives
permanently on the thing it explains. *(prd-30)*

### Layout and surfaces

**D12 — scene hero, tabbed dock beneath** (spend · collisions · feed · trace).
*(prd-32)*

**D13 — the fleet roster merges into the scene**: one surface, two
representations (organism ⇄ list), one keystroke between them, shared selection.
**The list is the floor** — always complete, always usable at the lowest quality
level and in still mode. The art is the enhancement, never the requirement.
*(prd-36)*

**D14 — persistent navigation on every surface.** *(prd-32)*

**D15 — laptop-first**: ~1440×900 primary, a hard minimum window (~1100×700)
that says so rather than breaking, scaling up gracefully. *(prd-32)*

**D16 — connect verifies, settings configures, first-run is a guided path
through both.** No surface duplicates another's controls. *(prd-35, prd-34)*

**D17 — replay and recordings get a full redesign** alongside everything else.
*(prd-31, prd-34)*

### The cut list

**D18 — cut the focus trace panel.** The run view supersedes it.

**D19 — demote the drawer to a peek** — vitals, latest activity, one line of
why — whose single action is *open the run view*. Removes a duplicated four-tab
set.

**D20 — unify recordings with the run view into one history surface**, two axes:
by session (what happened that night) or by lane (what that work did).

**D21 — one trace surface, two representations** (tree ⇄ gantt), matching the
organism ⇄ list idiom.

**D22 — keep everything else.** Collisions especially.

### Colour, type, identity

**D23 — a bounded category/phase colour family, tissue-extended.** Built off the
organism's existing violet-magenta material hue: low chroma, "one organism, many
tissues", deliberately *not* a multi-colour pop, and clear of the cyan notice
hue. This is a real amendment to the most-repeated constraint in the record
("no new hue"), made deliberately and bounded. *(prd-32, charter)*

**D24 — category and status never share a channel.** On the scene: **status is
the living thread** (hue and brightness, untouched); **category is its material**
— sheath, nodes, segment banding. Two claims, two surfaces, no ambiguous mark.
*(prd-33)*

**D25 — prd-31 ruling 1 is rewritten before its law test exists**: a kind
carries lightness **plus a capped category tint**; a kind is still not a status.
Deciding this now costs a paragraph; deciding it after the law lands costs an
amendment. *(prd-31)*

**D26 — two themes, dark is the source of truth.** Light is **warm paper** —
off-white ground, deep plum-grey inks — and severity there is carried by weight,
enclosure and saturation, **never by pretending brightness still means what it
meant on the void**. *(prd-32)*

**D27 — reading register at 13–14px equivalent, expressed in rem**; instrument
register stays dense for tabular data. **Mono-forward; sans for prose only.**
*(prd-32)*

**D28 — accessibility floor**: rem throughout so OS text size works · contrast
computed per theme by test · keyboard reachability (charter §6 binds it).
Screen-reader support for non-scene surfaces is explicitly declined for now.
*(prd-32)*

### The scene

**D29 — composition: colonies.** Radial masses in shared space, designed from
the start for several colonies (people) in one frame; one alone still reads
complete. Uses the existing camera. *(prd-33)*

**D30 — material: living tissue** — translucent, lit from within, overlaps blend
rather than stack. *(prd-33)*

**D31 — growth: bud → reach → thicken**, continuous while a lane lives.
*(prd-33)*

**D32 — atmosphere, all four**: depth haze · ambient drift (motes, spores) ·
directional light · reactive ground — every one of them bound by **"ambient
never means"**: no ambient property may correlate with status, cost, attention
or any folded fact. *(prd-33)*

**D33 — motion caps are raised**, on the operator's empirical argument: lanes
run five minutes to two hours, so real concurrent-event density is low and the
cap is rarely binding. **Two conditions**: the new caps are *derived from the
measured distribution* in recorded sessions rather than guessed, and **alarms
are exempt** — when everything happens at once, deaths still win the eye. Growth
gets its own class and budget. *(prd-33)*

**D34 — the renderer is spiked, then decided with numbers.** ADR-0006 chose
canvas 2D over WebGL by measurement, against a flat-marks workload; the new
workload (depth, iridescence, atmosphere, many colonies) is exactly where that
trade changes. Only measurement overturns measurement. *(prd-33)*

**D35 — reduced motion is a first-class still composition**, designed and
glance-tested as its own artifact — not the app with the animation removed.
*(prd-33)*

**D36 — scene quality is a user choice** (named levels); the list floor (D13)
guarantees navigation never degrades with it. *(prd-33, prd-35)*

**D37 — four numbers never move**: `RECEDE 0.30`, `CALM_CEILING 0.78`,
`ALARM_FLOOR 0.84`, `CALM_FLOOR 0.15`. The six-hundredths gap is the salience
mechanism and is never spent.

### Shipping

**D38 — first launch opens the live demo fleet**, loudly labelled, with a
standing invitation to watch your own repo. A stranger sees the instrument doing
its job beautifully before being asked to configure anything. *(prd-34)*

**D39 — the simulated fleets become first-class** — permanently available,
unmistakably marked, reachable from the menu. They already exist for testing;
they are real data through the real renderer. *(prd-34)*

**D40 — idle shows the repo's own past, alive** — dormant structure, landed work
as mass, past lanes as scars. Idle reads as at rest, never as broken. *(prd-33)*

**D41 — tray daemon**: the window closes independently of the watcher · the tray
badge reflects fleet state · notifications for needs-a-human, died, landed and
spend-threshold · launch-on-login offered, never imposed. **All toggleable.**
*(prd-34, prd-35)*

**D42 — never configurable**: the alarm band and attention ladder · honest-gap
voices and estimate flags · zero-with-evidence · the simulated/real distinction.
Settings menus are where products start lying; this is the list that keeps this
one honest. *(prd-35)*

**D43 — failure degrades loudly and keeps working.** Whatever still works keeps
working; the broken part names what died, when, and how to restart it, in the
same honest-gap voice used for missing data. *(prd-35)*

**D44 — updates download quietly and apply on restart** — never mid-session,
never under a running fleet. *(prd-34)*

**D45 — code signing is deferred**: the packaging pipeline is built so signing
is a switch, builds ship unsigned with honest instructions, and the money
(~$120/yr Windows, ~$99/yr macOS) is spent at a real release. *(prd-34)*

### The shared world

**D46 — privacy is per-person opt-in.** Facts always; words (prompts, agent
text) only if that person shares them. The view is uneven by design. *(prd-37)*

**D47 — the shared server is one machine someone on the team runs.** Collectors
ship to it; no accounts, no cloud. "Nothing leaves the machine" becomes
"nothing leaves the team." *(prd-37)*

**D48 — identity is git identity, declared once** — display name and colour in
settings, on top of the author identity the log already carries. No accounts, no
auth, works offline. *(prd-37, prd-35)*

### Process

**D49 — PRDs become full specs.** The house rule ("length is a feature") is
amended rather than ignored, and the PRD-as-spec anti-pattern is rewritten to
say what still holds. Each PRD now carries, per surface: what it shows and why ·
every state (live, empty, loading, error, degraded, replay, demo) · data source
per field with its honest gap · interactions and keyboard path · what would make
it wrong · acceptance criteria.

**D50 — build model is hybrid**: fenced fleet waves for mechanical work (rem
migration, token plumbing, tests, packaging, wiring); operator and conductor
hand-build anything where taste decides the outcome (the scene, the conversation
card, the light theme).

**D51 — the lab joins the era.** prd-28's nine issues (#433–#441) are unassigned,
so nothing is trampled; the lab inherits the foundation and its surfaces are
designed with the rest rather than after them. *(Those nine unassigned issues
were the old repo's state on 2026-08-15; prd-28's paper and its issues both died
in the re-upload, and the lab's design home is its 2026-08-24 re-founding on a
design canvas. The decision itself — the lab is designed with the era, not after
it — stands.)*

**D52 — no fixed deadline.** Sequenced for quality.

---

## The order

```
1  foundation + settings              prd-32 · prd-35
2  reading surfaces                   prd-30 · prd-31 · prd-36 · lab surfaces
3  the doorstep                       prd-34
4  the organism ‖ the shared world    prd-33 ‖ prd-37   (independent)
5  sweeps                             prd-32 w4 — era-last, by ruling
```

Inherited timing constraints, as they stood on 2026-08-15:

- **prd-31 wave 1 lands before prd-28 wave 3 dispatches** — #439 reads
  `trace/`'s furniture, and re-laying a reader's ground mid-flight is the
  collision the fence calendar exists to prevent. **Discharged 2026-08-25:**
  prd-31 landed (`docs/prds/done/prd-31-the-bracketed-voice.md`), and prd-28's
  wave 3 and #439 died with the old repo — the constraint has no live referent on
  either side, and lab sequencing belongs to the 2026-08-24 re-founding.
- **prd-32 wave 4 (the sweeps) is the last wave of the era**, by ruling: a sweep
  that runs earlier re-lays ground the other PRDs are about to dig.
- **Ruling numbers are never renumbered** — code comments cite them 688 times.

---

## What was still open, as of 2026-08-15

- **#158's glance re-run** — an operator act with a real lay viewer. The gate is
  amended: prd-33 proceeds on a documented deferral, and the re-run is booked
  **before the era closes** rather than before its first dispatch.
- **The renderer** — canvas 2D versus WebGL, pending the spike (D34).
- **The measured motion caps** — pending the concurrency distribution (D33).
- **The team layer's ingest** — designed for here, built when the metamorphosis
  observatory lands.

> **Restamped 2026-08-25.** Two of those four have moved. **The measured motion
> caps landed:** prd-33 ruling 10 raised the event cap to 7 from the measured
> distribution rather than from appetite, with alarms exempt, and ruling 9 gave
> growth its own class and budget — both are in the code, at
> `packages/web/src/scene/motion.ts:79` (`EVENT.maxConcurrent`) and `:202`
> (`GROWTH`, with `GROWTH_CAUSES` at `:235`), and the charter's §5 table states
> them. **The glance re-run outlived its number:** #158 died with the old repo,
> and the obligation is carried by prd-33's own wave-0 gate text. The renderer
> spike and the team layer's ingest stand as written.
