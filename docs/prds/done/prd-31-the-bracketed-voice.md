# prd-31 — the bracketed voice: a conversation reads at a glance

> **Outcome:** shipped — one kind grammar, structural conversation bracketing, trace density,
> and one typed search across conversation, feed and trace are all present. The search declares
> its hidden count on every surface and is enforced by the prd-31 surface tests. Reconciled
> 2026-08-22 at `03df141`.
>
> Builds the design charter's §7 rulings (`docs/design/charter.md`,
> PR #451): the kind→lightness module, binding on the charter's merge, and the reserved
> bracketing vocabulary, whose law shape the charter pre-states and this PRD designs. It owns no
> charter §8 pending ruling. **Timing law: wave 1 must land before prd-28 wave 3 dispatches —
> #439 reads `trace/`'s furniture.** Milestone 17. **Kind: specifying**
> (`docs/prds/README.md`). The chrome's visual form is decided here and reviewed by the team.
> Citations verified at origin/main `e8fed56`. **Ruling 1 was rewritten 2026-08-15, before any
> of it was built and while this PRD is unmerged** — no code cites it yet, so this is an edit
> rather than an amendment; rulings 5–8 and the specification were added the same day from
> `docs/design/ui-2.0-decisions.md` (D1–D9, D17, D20, D25).

## Problem

The conversation is the surface a human actually reads — the record of what an agent said and
did — and its voice is whispered. Roles are told apart by lightness alone: a prompt is ice-100,
a response ice-200, a subagent ice-400 with a border, and a stranger scrolling a long session
cannot tell who is speaking without reading every line. The same sentence — a kind is not a
status: lightness only, never hue — is encoded three times in three files, so the next surface
that renders kinds will write a fourth. And a session of any length is a scroll, not a query:
there is no way to filter the conversation, the feed or the trace down to the turn where things
went wrong. The record is complete and the reading of it is expensive — which is the one cost
this instrument exists to remove.

## Evidence

- **Three copies of one sentence.** `trace/glyphs.tsx` `KIND_CLASS`, `drawer/Activity.tsx`
  `KIND_CLASS`, and `drawer/Conversation.tsx` inline — all encoding kind→lightness,
  uncoordinated.
- **Role chrome today is lightness alone** (`drawer/Conversation.tsx`): user = ice-100 plus the
  cyan `›` (`figures text-notice` — the drawer's only status-hue use, grandfathered by charter
  §7); assistant = ice-200; subagent = ice-400 + `border-l border-ice-850`; system = mono 10px
  ice-400. Kind dispatches before role, and the code comments it as deliberate — a session log
  records tool results on user lines.
- **The hook already exists and nothing consumes it.** `data-role={entry.role}` rides
  `<li data-testid="turn">` today.
- **The ground is current and free.** `drawer/**` is unchanged since `e62fd93` (the charter's
  verification point), and zero open PRs touch `packages/web`.
- **#170** is open, unmilestoned, and overlaps this ground.

## Success

1. "A kind is not a status" is written once. **Not met while** `KIND_CLASS` exists twice, or any
   file outside the one module declares a kind→class map.
2. A stranger tells prompt from response from tool traffic without reading a word — role chrome
   is structure, drawn in the ice register. **Not met while** role is carried by lightness
   alone, or any role chrome spends a status hue beyond the grandfathered cyan `›`.
3. The trace reads at its density: a row's kind, depth and duration land before its text does.
   **Not met while** trace rows render every field at one weight, or legibility work breaks
   #439's read — a rename or signature change on the furniture it consumes.
4. An operator finds the turn, the event or the span by typing. **Not met while** filtering
   ships as a panel, or a filtered view fails to say it is filtering — law 12 at list altitude:
   a hidden row is a gap, and gaps are declared.

## Non-goals

- **Not the trace's data layer.** #439 (prd-28) reads `trace/`'s furniture; this PRD restyles
  rows and never renames or re-signatures `TraceGantt`, `TraceRow`, `FocusPanel`, `glyphs` or
  `format` while it is in flight.
- **Never a panel.** prd-13 ruling 1's standing refusal, restated for filtering: the filter is
  chrome in the surfaces that exist, not a new dock row, and the answer to promoting it stays
  no.
- **Not summarisation, not an AI reading voice.** The record renders; nothing paraphrases it.
- **No new hue.** The cyan `›` is the one grandfathered accent and gains no siblings; brackets,
  gutters and rules are ice.
- **Not the kind taxonomy.** Kinds come from the fold; this PRD renders them and adds none.

**Rejected alternatives.** *A fourth map "just for the new chrome"* — the defect is the plural;
one more copy restates the problem. *Role told by hue* — law 9a: hue is meaning and each hue
means one thing; roles are structure. *Server-side search* — the fold is already in the browser
and the corpus is one session; a query route is a new read seam prd-29 would have to gate,
bought to move work the client does in microseconds. *A filter panel* — rejected by standing
ruling above.

## What already exists (do not rebuild)

The three kind maps are correct code wrongly multiplied — the unification keeps their agreement
and deletes their plurality. `data-role` is the bracketing hook, already on the DOM. The
`figures` utility carries the mono voice the chrome will lean on; the type registers themselves
are prd-32's to define, and this PRD consumes them. Charter §7 pre-states the law shape — role
chrome is structure in the ice register; kind dispatches before role; the cyan `›` is
grandfathered — so the design argument here is about form, not about whether those laws hold.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — one kind→lightness module, and it lands first, on a clock

The three copies unify into one module under `web/src/`, consumed by `trace/glyphs.tsx`,
`drawer/Activity.tsx` and `drawer/Conversation.tsx`, with a law test stating the sentence — **a
kind is not a status** — so a fourth copy fails review by diff.

**What a kind may carry:** lightness, **and a capped category tint from prd-32 ruling 8's
tissue-derived family**. Not a status hue, not glow, never above `CALM_CEILING`, and never so
strong that a reader could mistake a kind for a state. The original sentence read "lightness
only, never hue"; it is rewritten here rather than amended because nothing has been built against
it and this PRD is unmerged — the law test is written this way the first time, which is cheaper
than an amendment to a fresh law.

The reason for the tint at all: a conversation is a wall of undifferentiated text today, and
lightness alone separates perhaps three levels before a reader stops perceiving the difference.
A bounded tint separates kinds at a glance without spending anything the status vocabulary owns —
which is exactly the trade prd-32 ruling 8's five caps exist to police.

This is still the era's hardest timing constraint and the reason it is wave 1: **it must land
before prd-28 wave 3 dispatches**, because #439 reads `trace/`'s furniture, and re-laying a
reader's ground mid-flight is the collision the fence calendar exists to prevent.

## Ruling 2 — the bracketing grammar: role chrome is structure, drawn in the ice register

Prompts, responses, tool calls, tool results and events each get named chrome — brackets,
gutters, rules — under charter §7's pre-stated shape: role chrome is structure in the ice
register; kind dispatches before role (the existing deliberate order); `data-role` is the hook;
the cyan `›` remains the one grandfathered accent. The visual cut of the brackets is decided
here and reviewed by the team; what any design must satisfy is fixed in this ruling, so the
work cannot drift into a hue or a reorder.

## Ruling 3 — trace legibility is density and hierarchy, styles only

`trace/` rows adopt the instrument register (prd-32's) and a weight hierarchy so kind, depth
and duration read before text. Edits to `trace/` are legal — only #439 *reads* those files —
but the furniture it reads keeps its names and signatures until prd-28 wave 3 lands.

## Ruling 4 — filtering and search are chrome over the fold, and #170 is claimed here

Filtering and search run over the conversation, the events feed and the trace — client-side,
over the fold, no server surface. prd-13 ruling 1's refusal is restated: never a panel. A
filtered view declares itself and its hidden count — law 12 at list altitude. **#170,
unmilestoned and overlapping, is re-milestoned into this PRD or closed at its grooming; the
claim is recorded here so the work cannot ride two homes.**

## Ruling 5 — `/lane/:handle` becomes the run view, and it survives the lane

There is no new top-level concept: the lane page grows into the place a person answers *what did
this piece of work actually do?* It carries a derived phase/step spine, the outcome with its
evidence, and conversation beside trace — and **it is readable after the worktree is gone**.

That last clause is the expensive one and it is deliberate. `workmux merge` deletes a worktree the
moment work lands, which is precisely when a person most wants to read what happened. The event
log persists and transcripts are captured at session close (prd-16 ruling 3), but a lane that ran
across three sessions has its life scattered across three recordings with no index tying them
together. **A lane index is therefore part of this ruling, not an optimisation of it**: lane
handle (and issue number, where one exists) → the sessions it appears in → its events and captured
transcripts, so `/lane/519-migrate` opens a week later without the reader knowing which recording
to find first.

## Ruling 6 — the interaction card is time-shaped, and its words are quoted, never written

An interaction renders as a card whose **headline is the time shape**: wall-clock elapsed beside
summed work. Three minutes elapsed, forty-seven seconds of work. The gap between those two
numbers is the most interesting fact the instrument holds — it is thinking, rate-limiting, or
blocked-on-a-human — and no other surface exposes it.

Beneath it, **the agent's own first sentence, quoted verbatim and marked as a quotation.** The
instrument makes no model calls (prd-9 ruling 9; ADR-0009; "nothing leaves the machine"), so a
summary is not available to it and inventing one would be the confident lie every honesty law in
this repo exists to prevent. A quote can be a bad sentence — that is the agent's fault, and the
reader can see it is a quote.

Then the facts, **only the ones we can source**: model · duration · tokens · cost *with its
provenance* (`est.` when the dollars are estimated, an honest gap when there is no cost feed) ·
tool count · files touched. Fields Baseline's card carries that we cannot source — skills loaded,
context percentage, check state — **do not appear at all**: no placeholder, no dash, no promise
of a column later. An omitted field is honest; a blank one implies we looked.

## Ruling 7 — phase is derived, and says so; refusals are first-class; subagents nest

**Phase is inferred from evidence and labelled as inferred** — reads-only reads as exploring,
writes as implementing, test commands as verifying, commits as landing — with the evidence behind
it one disclosure away (prd-30's card). It is never presented as something the agent declared,
because rhizomorph watches whatever you run rather than imposing a pipeline. When prd-27's beacons
land, a *declared* phase arrives additively and outranks the inference, and the card says which it
is showing.

**Refusals are first-class marks.** Every tool span carries a decision — accepted, rejected,
unknown — and a rejected or blocked call is often the entire explanation for a lane that went
quiet. Nothing surfaces it today. It renders wherever the interaction renders.

**Subagents nest, collapsed by default:** a child agent is one line inside its parent's
interaction — its type, duration and spend — expanding into its own full reading. The tree is
real in the data (`parentAgentId`); the surface mirrors it rather than flattening it.

## Ruling 8 — recordings and the run view are one history surface, with two axes

Recordings (a library of sessions) and the run view (the life of one lane) answer the same
question — *show me the past* — and splitting them was an artifact of how the data arrived, not a
distinction a reader has. They become **one surface with two axes**: browse by **session** (what
happened that night) or by **lane** (what that piece of work did), the lane axis made possible by
ruling 5's index.

The replay machinery beneath is untouched: one reducer for live and replay (ADR-0002), records
read-only, nothing enriched (`docs/record-format.md`'s laws). This is a reading change, not a
data change.

## The specification

Six answers per surface, per `docs/prds/README.md`.

### S1 — the interaction card

**What and why.** The unit of reading in a conversation: one prompt→response cycle with its tool
tree, legible at a skim, complete on demand.

```
┌─ 19:04:12 · 3m12s wall · 47s work ─────────────┐
│ "I'll add the plan/run split first, then wire  │
│  the route."                                   │
│ sonnet · 9 tools · 2 files · 41.2k · $0.31 est │
│ ▸ full text   ▸ why the gap   ▸ 1 subagent     │
└────────────────────────────────────────────────┘
```

**States.** *complete* (all facts) · *in flight* (the interaction has not ended: wall ticks, work
is partial, and the card says so rather than showing a total that will change) · *no text* (a
pure tool turn: the quote line is absent, not empty, and the facts carry the reading) · *refused*
(a rejected or blocked tool call renders its own mark inside the card) · *degraded* (a fact whose
source is a dead collector shows law 12's gap voice in place of the number) · *replay* (identical;
elapsed is relative to the scrub position) · *demo* (frame chrome carries the distinction).

**Data source, per field.** wall = interaction span start→end · work = Σ leaf span durations
(never containers — a container encloses its children, so adding it double-counts) · quote = the
first assistant text block of that interaction, verbatim · model/tokens = `llm_request` span ·
cost = `llm.cost` events, authoritative, or the vendored price table, flagged `est.`, or an
honest gap · tools = tool spans · files = the touches selector · subagents = `parentAgentId`.

**Interactions and keyboard path.** The card is a disclosure region, not a dialog: `▸ full text`
expands in place, `▸ why the gap` opens prd-30's card explaining the wall/work difference,
subagents expand nested. All keyboard-reachable; the one focus token applies.

**What would make it wrong.** A summarised (rather than quoted) verdict line · a placeholder for
an unsourceable field · a total shown for an in-flight interaction · work exceeding wall (a
container summed by mistake) · an estimated dollar without its flag.

**Acceptance criteria.** A fixture of a real captured interaction renders every field from its
own evidence; a rigged container-summing turns the wall/work assertion red; an interaction with
no assistant text renders without a quote line and without a blank; an estimated cost renders
`est.`; a rejected tool call renders its refusal mark.

### S2 — the run view (`/lane/:handle`)

**What and why.** The whole life of one piece of work, during and after.

**Regions.** (1) **Identity and outcome** — handle, branch, issue, who it belongs to (prd-37),
and how it ended with the evidence for that claim (commits, gate results, PR). (2) **The phase
spine** — derived phases across the lane's life, each expanding into its interactions. (3)
**Conversation beside trace**, aligned in time. (4) **Spend and activity**.

**States.** *live* (the lane exists and is working) · *finished, worktree present* · **
*finished, worktree gone* (the durability case: everything reads from the log and captured
transcripts, and the page says the worktree is gone rather than reporting emptiness) · *partial*
(a lane spanning sessions where one recording is missing: the gap is named with which session is
absent) · *unknown handle* (404 with what was searched) · *replay* · *demo*.

**Data source.** The lane index (ruling 5) → sessions → events + captured transcripts. Nothing is
read from a live worktree that could not also be read after its deletion.

**Interactions.** Deep-linkable; openable from the fleet list, the scene, and the history surface;
`/lane/main` remains the conductor's canonical page.

**What would make it wrong.** Any field that only works while the worktree exists · a silent
partial reading when a session is missing · an outcome claimed without its evidence.

**Acceptance.** A test deletes a worktree and asserts the page still renders every region; a lane
spanning two sessions renders one continuous life; a missing session is named.

### S3 — search over the loaded session

**What and why.** Find the turn, event or span you remember, without a new server surface.

**States.** *idle* · *filtering* (results plus **what was hidden and how much**, always) · *no
matches* (says what was searched and where) · *replay* (searches the loaded slice).

**Data source.** The fold, client-side. No index, no server route (prd-29 would have to gate a new
read seam; prd-13 ruling 1 refuses a panel).

**Interactions.** One input, reachable by keyboard from anywhere; filters conversation, feed and
trace together; `Escape` clears.

**What would make it wrong.** A filtered view that does not declare itself · search shipped as a
panel · a query that silently searches only one surface.

**Acceptance.** Filtering states the hidden count on every surface it touches; a test asserts no
`/api/` string is added by this feature.

### S4 — the history surface

**What and why.** Ruling 8's one surface, two axes.

**States.** *by session* (the recordings library's columns: title, lanes, landed, duration, cost
with provenance, captured) · *by lane* (handle, issue, when, outcome, spend, the sessions it
spans) · *empty* (no recordings yet: says what would create one) · *unreadable record* (named,
counted, never silently skipped — ADR-0011's posture).

**Data source.** `GET /api/sessions` for the session axis; the lane index for the lane axis.

**Interactions.** Toggle between axes (the same idiom as organism⇄list, prd-36); open a session
into replay; open a lane into the run view; rename a session (the existing label sidecar).

**What would make it wrong.** A lane appearing in the lane axis that cannot be opened · cost
rendered without provenance · a skipped unreadable record.

**Acceptance.** Both axes render from the same underlying data; a rigged unreadable record is
counted and voiced.

## Sequencing (waves, each gated as ever)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it.

> **Note (2026-09-08, prd-53 wave 5):** prd-28's paper died in the 2026-08-19 deletion and its
> number is retired, never reused. The fence stands; the territory's owner is prd-53
> (`docs/prds/prd-53-the-lab.md`). The sentence above is kept as written — a number is an identity.

1. **Keystone, on the era's clock:** the kind→lightness module and its law test — landed before
   prd-28 wave 3 dispatches (**#439** reads `trace/`'s furniture).
2. Parallel, fenced apart: the bracketing grammar (`drawer/`) · trace legibility (`trace/`,
   styles only, furniture untouched).
3. Filtering and search across conversation, feed and trace.

Unfiled work implied, described not numbered: the module and its law test; the bracket chrome;
the trace density pass; the filter chrome per surface.

## Open questions

- ~~The bracket forms themselves~~ — **decided here and reviewed by the team.**
- **Search scope** — the loaded session only, or across sessions via the recordings surface.
  Proposed the loaded session; open, not ruled.
- **#170's fate** — re-milestone or close is decided at grooming; the claim above stands either
  way.
- **Where each surface's filter chrome sits** — the only fixed point is the refusal: never a
  panel.
