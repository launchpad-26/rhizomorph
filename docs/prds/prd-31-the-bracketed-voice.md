# prd-31 — the bracketed voice: a conversation reads at a glance

> **Status:** proposed — builds the design charter's §7 rulings (`docs/design/charter.md`,
> PR #451): the kind→lightness module, binding on the charter's merge, and the reserved
> bracketing vocabulary, whose law shape the charter pre-states and this PRD designs. It owns no
> charter §8 pending ruling. **Timing law: wave 1 must land before prd-28 wave 3 dispatches —
> #439 reads `trace/`'s furniture.** Milestone 17. The chrome's visual form iterates with
> hchristina on the charter companion at blessing. Citations verified at origin/main `e8fed56`.

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
`drawer/Activity.tsx` and `drawer/Conversation.tsx`, with a law test stating the sentence — a
kind is not a status: lightness only, never hue — so a fourth copy fails review by diff and a
hue fails by test. This is the era's hardest timing constraint and the reason it is wave 1:
**it must land before prd-28 wave 3 dispatches**, because #439 reads `trace/`'s furniture, and
re-laying a reader's ground mid-flight is the collision the fence calendar exists to prevent.

## Ruling 2 — the bracketing grammar: role chrome is structure, drawn in the ice register

Prompts, responses, tool calls, tool results and events each get named chrome — brackets,
gutters, rules — under charter §7's pre-stated shape: role chrome is structure in the ice
register; kind dispatches before role (the existing deliberate order); `data-role` is the hook;
the cyan `›` remains the one grandfathered accent. The visual cut of the brackets iterates with
hchristina on the companion; what any design must satisfy is fixed here, so the iteration
cannot drift into a hue or a reorder.

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

## Sequencing (waves, each gated as ever)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it.

1. **Keystone, on the era's clock:** the kind→lightness module and its law test — landed before
   prd-28 wave 3 dispatches (**#439** reads `trace/`'s furniture).
2. Parallel, fenced apart: the bracketing grammar (`drawer/`) · trace legibility (`trace/`,
   styles only, furniture untouched).
3. Filtering and search across conversation, feed and trace.

Unfiled work implied, described not numbered: the module and its law test; the bracket chrome;
the trace density pass; the filter chrome per surface.

## Open questions

- **The bracket forms themselves** — hchristina's, on the companion. Open, not ruled.
- **Search scope** — the loaded session only, or across sessions via the recordings surface.
  Proposed the loaded session; open, not ruled.
- **#170's fate** — re-milestone or close is decided at grooming; the claim above stands either
  way.
- **Where each surface's filter chrome sits** — the only fixed point is the refusal: never a
  panel.
