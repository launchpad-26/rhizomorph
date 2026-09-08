# 0040. A mark that is already a control still discloses, without a second button

- **Status:** accepted (prd-30 ruling 1 and charter §6; recorded on the build, #220)
- **Date:** 2026-09-07

## Context and Problem Statement

prd-30 ruling 1 puts one disclosure affordance behind every mark, and charter §6
binds it: whatever hover discloses, focus discloses. `Disclosure`
(`packages/web/src/disclosure/Disclosure.tsx`) delivers that by owning a
`<button>` trigger, which is the right element when the mark is inert — a word,
a glyph, a figure in a cell.

The adoption sweep (#220) is where that assumption breaks. Eight of the fifty
native `title=` marks it retires sit on things that are *already* controls or
that contain one: the attention strip's chips filter the fleet, the ledger's
exemplar row navigates to a trace, the collision matrix's column headers hold a
branch link, a why-surface file button selects a path, a trace row expands, and a
transcript turn may contain anything `Block` renders. Wrapping those in
`Disclosure` as it stood nests a `<button>` inside a `<button>` — invalid HTML,
an accessible name assembled from two sources, and two click handlers racing for
the same tap, since the trigger's own `onClick` toggles the card's pin.

Leaving those eight on `title=` was not available: a native tooltip is
pointer-only disclosure, which charter §6 forbids outright, and retiring exactly
those is the issue's subject.

## Considered Options

- **A `trigger` mode on `Disclosure`** — `'button'` (the default, unchanged) or
  `'inline'`, the latter rendering a focusable `<span role="note">`.
- **Let the call sites render `DisclosureCard` themselves**, each driving its own
  hover, focus, Escape and pin state around the shared card.
- **Leave already-interactive marks on `title=`** and narrow the sweep to the
  forty-two inert ones.

## Decision Outcome

**The `trigger` mode.** The mode chooses an element and nothing else: one `open`
boolean, one `<DisclosureCard>` in the tree, one focus token, one Escape path,
one set of trigger props assembled once and spread into whichever element the
mode names. That is the property `Disclosure.tsx`'s own module note calls the
guarantee — "a keyboard user cannot be shown less than a mouse user because there
is no second render to be shown *from*" — and it survives the mode intact.

*Call sites rendering their own card* lost because it recreates the
three-idiom problem prd-30 exists to end, one call site at a time. The state
machine is the hard part of this component, not the markup, and eight copies of
it would drift within a wave. `one-card-law.test.ts` would still pass throughout
— it polices a marker string — while the duplication it was written against came
back wearing a different shape, which is the worst available outcome: a law that
reports success.

*Leaving them on `title=`* lost on charter §6, which is binding rather than
advisory, and because those eight are among the most information-dense marks in
the instrument — a chip that says a lane waited six minutes on a tool call is
exactly the mark a stranger needs explained.

## Consequences

- **Good:** seven already-interactive marks disclose with no markup violation,
  and the next one inherits the mode rather than inventing a fourth idiom. (The
  other of the eight — the recordings page's export and rename buttons, and two
  navigation controls in `why/` — turned out not to need a card at all: their
  `title=` was a sentence naming what the control *does*, which is an accessible
  name, so it became `aria-label`. A card is for a condition; a name is not one.)
- **Good:** the keyboard path is uniform — the trigger wears `focus-ring` in both
  modes, so prd-32 ruling 9's one focus token still covers every disclosure.
- **Bad:** `role="note"` on a focusable span is a weaker semantic than a button.
  A screen-reader user meets the card as an annotation rather than as something
  to activate; tap-to-pin still works, but the affordance is less discoverable
  than the default mode's. This is a real cost paid to avoid a worse one, not a
  neutral trade.
- **Bad:** `Disclosure` now has a mode, and a mode is a place for two paths to
  drift. The mitigation is structural (shared `triggerProps`, one card) and
  asserted (`Disclosure.test.tsx` runs its hover/focus parity case under both
  modes); neither alone would be enough.
- **Bad:** it widened #220's fence into `packages/web/src/disclosure/`, which
  prd-30 wave 2 (#221) owns. #221 was Backlog and unstarted when this landed; had
  it been in flight, this would have been a rebase conflict.

## Note, 2026-09-08 — a sibling case the decision did not consider

The problem statement answers *a mark that already **is** a control*. Review of
PR #335 found the sibling it does not cover: *a mark **inside** a control*. The
trace row's token headline sat inside the interaction toggle `<button>` wearing
the inline trigger, which relocated both harms rather than removing them — one
tap on the headline pinned the card **and** expanded the interaction (two click
handlers for one tap), and a focusable `role="note"` span inside a `<button>` is
the content-model violation the mode was introduced to avoid. The inline mode is
the right answer only when the control is the mark's *child*, never its
ancestor.

The trace row now renders the mark **beside** the toggle, where it is inert text
again and takes the default trigger (`trace/TraceTree.tsx`, asserted by
`TraceTree.test.tsx`'s "beside the toggle, never inside it" case). The
Consequences above therefore over-count by one: **six** already-interactive
marks wear the inline trigger, not seven. The decision itself stands; this note
records the boundary it turned out to have.
