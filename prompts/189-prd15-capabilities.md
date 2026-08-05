You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

prd15 wave 2a. docs/prd15.md rulings 4 and 5 bind you; #188's landed sessionlog organ is the reference adapter whose capabilities become the first real manifest. Ship the DATA, not the pixels — wave 2b owns the web surfaces.

YOUR ISSUE — #189:

## Direction

Operator review of the landed #186 dock, 2026-08-05: *"still cramped with
the old green work bar stuff when expanded, and the tooltips pop up BEHIND
the scrub bar, so it's effectively unusable in its current state."*
Conductor-reproduced in the browser the same hour. Two regressions; the
second cancels #186's central win, so this lane is urgent.

**Defect 1 — the hover cards paint BEHIND the dock. FATAL.**
Root cause, measured in the live DOM: every ancestor of
`[data-testid="tide-dock"]` is `position: static` with `z-index: auto`. A card
rendered inside that chain **cannot** paint above siblings drawn after it —
the band, the scrubber row, the axis labels and the provenance strip all win.
Hovering a mark produces a card that is invisible under the bar. #186's whole
point (marks as the primary navigation surface, hover cards carrying
who/what/when with per-member seek buttons) is therefore unreachable.

Direction: **portal the card out of the dock's flow** — render into
`document.body` (or a dedicated overlay root) positioned from the mark's
`getBoundingClientRect()`, above the transport in paint order. The research
note said "a card in dock chrome"; z-order reality overrides the phrasing —
the card must escape the flow, and no ancestor may clip it (`overflow`
hidden/auto anywhere up the chain kills it too, check all of them).
Test-state it: a law that asserts the card's own stacking wins — e.g. the
card's computed `position` is not `static`, it is not a descendant of the
dock's clipped subtree, and `document.elementFromPoint` at the card's centre
returns the card (or its child), never the band or the scrubber. That last
assertion is the one that would have caught this; jsdom cannot hit-test, so
**this needs a real-browser check in your verification, not only a unit
test** — the passive-wheel lesson from #186, restated one lane later.

**Defect 2 — "expanded" shows ONE row and a `+51` chip.**
Measured: in replay-expanded on the 48-lane recording, `tide-row` count = 1,
row height 20px, whole dock height 79px, and the band carries a `+51`
coalescing chip sitting on top of the working fills ("the old green work bar
stuff"). So expansion coalesces essentially everything and reveals nothing —
the per-lane view ruling 12 promised is unreachable, and the one row is
cramped under its own chip.

Direction: expansion must produce a REAL per-lane stack.
- Show top-N lanes as their own rows where N fills the available expanded
  height (a dozen-ish at 1080p), coalescing only the genuine remainder into
  the `+N` row — the existing coalescing law applied with a useful N, not
  N≈1.
- **The replay dock must grow to hold them** (prd13 ruling 2's two modes +
  #186's mode-dependent height, finishing the thought): expanded replay gets
  real height; live stays the compact strip. Respect the fold — attention
  strip, burn strip and the scene's min-height survive at 1080p; screenshot
  to prove it.
- The `+N` chip must not overprint the band's fills — give it its own gutter
  or place it in the row's label column.
- Ordering stays stable-for-the-session (ruling 3); do not re-sort by
  attention.

Laws that must survive, test-stated: the hit-test law above; expanded row
count is a function of available height and lane count (assert it at two
heights and two lane counts); collapsed live is unchanged; mark seek stays
exact at every zoom level (#186's law, unweakened); #136 contrast floor and
the motion law green.

## Fence (may touch ONLY)

- `packages/web/src/tide/` (all files)
- `packages/web/src/replay/` (all files)
- `packages/web/src/app/ReplayBar.tsx`

If the portal needs an overlay root mounted outside the dock (e.g. in the
app shell), print `BLOCKED: <need>` with the exact file — the conductor
widens on the record; `packages/web/src/app/Shell.test.tsx` is a known
coupling point for shell-level mounts.

## Blocked by

Nothing (#186 landed). **Model:** sonnet. **Wave:** tide-usable.

## Definition of done

- Hover cards paint above everything and are hit-testable in a real browser;
  expansion shows a useful per-lane stack in a dock that grew to hold it;
  no chip overprint; laws test-stated.
- Browser-verified on the 48-lane recording: collapsed live, expanded
  replay, a hovered cluster card, and a click-through from a card row to its
  exact seek — before/after screenshots at 1080p.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
