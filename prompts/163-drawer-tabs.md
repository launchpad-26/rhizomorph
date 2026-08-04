You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

This is a LAYOUT round on a surface with a scar: #132, #134 and #149 each
landed green ALONE and were broken IN COMBINATION (#151 was the cleanup).
Verify the whole drawer in a browser, not section by section.

YOUR ISSUE — #163:

## Direction

Operator reviewed the live drawer 2026-08-04 and ruled: *"this entire drawer is
incredibly cramped and occluded, the windows are too small, and it's all quite
difficult to read."*

**The cause is structural, not cosmetic.** The drawer is four independently
scrolling boxes stacked inside a 544px column, each with a hard-capped height:

- `drawer/Conversation.tsx:111` — `min-h-0 flex-1 overflow-y-auto` (gets only the leftover)
- `drawer/Activity.tsx:37` — `max-h-52 overflow-auto` (208px)
- `why/WhySurface.tsx:68` — `max-h-72 overflow-auto` (288px)
- `drawer/Trace.tsx:22` — `max-h-64 overflow-auto` (256px)

Those three fixed boxes claim 752px before conversation gets anything, which on
a 1080p screen exceeds the viewport. So conversation collapses to ~6 lines,
every section grows its own scrollbar, `scrollbar-gutter: stable` eats width
from an already narrow column, and the "PAUSED — JUMP TO THE TAIL" bar overlays
cut-off text. **The drawer allocates fixed heights to unbounded content.**

**OPERATOR RULING: tabs.** One section visible at a time, taking the full
drawer height.

1. **Tabs**: `CONVERSATION | ACTIVITY | WHY | TRACE`. Exactly one body renders
   at a time and it gets all remaining drawer height.
2. **The vitals header never hides.** The status line (DONE / req / tool calls /
   last work), OUTPUT / $ / AGE, and BRANCH / FENCE / WORKTREE stay pinned above
   the tab bar. Identity and spend are never a click away.
3. **Delete every `max-h-*` and every inner `overflow-auto` in the drawer.** The
   drawer has exactly ONE scroll region: the active tab's body. Keep
   `[scrollbar-gutter:stable]` (a #136 law) on that one region only.
4. **Tab labels carry counts, so nothing feels hidden**: `ACTIVITY 49`,
   `WHY 11 files`, `TRACE —`. Use the existing honest-gap voice for absent data
   (an em dash, not a zero).
5. **Widen modestly**: `w-[min(48rem,92vw)]` in place of `w-[min(34rem,100vw)]`.
   The operator's complaint was *cramped* as well as *short*, and a single
   section at full height can use the width. This one is the conductor's
   judgement inside the ruling — if it makes the scene unreadable behind it,
   say so with a screenshot and keep 34rem.
6. **Causality must survive tabbing.** This was the named cost of tabs: you can
   no longer see a commit and its WHY side by side. Pay it back with
   navigation — a file chip in WHY jumps to ACTIVITY scoped to that file, and
   #159's exemplar jump still lands on its target tab. If a jump cannot be made
   to work, say so plainly rather than dropping it silently.
7. **The PAUSED bar must never overlay text.** In the tabbed layout it belongs
   in the conversation tab's own flow — a sticky footer of that tab is fine, an
   overlay across content is not.
8. **Keyboard**: the tab bar is reachable and operable by keyboard (arrow keys
   cycle), and ESC still closes the drawer.

Laws that must survive, test-stated:

- `drawer/readonly.test.ts` stays green **untouched** — the drawer never writes.
- The #136 contrast floor: no new hex values, roles re-assigned only; the
  grep-law test stays green.
- Every honest-gap voice still renders — `NO TRACE TELEMETRY`,
  `TOOL DETAIL UNAVAILABLE`, `NO WORKTREE` — do not lose them in the
  restructure. An absent thing must still say it is absent.

**Browser-verify IN COMBINATION, not section by section.** Open the drawer on a
live lane AND a folded one, visit every tab, and screenshot both.

## Fence (may touch ONLY)

- `packages/web/src/drawer/` (all files)
- `packages/web/src/why/WhySurface.tsx`, `packages/web/src/why/WhySurface.test.tsx`
- `packages/web/src/App.test.tsx` (a flagged coupling point — it mocks the
  drawer surface; fence what wires, not just what changes)

## Blocked by

Nothing. #162 owns `app/StreamContext.tsx` and `replay/` — do NOT touch those.
**Model:** sonnet. **Wave:** the defects.

## Definition of done

- One scroll region in the whole drawer; no section is height-capped; nothing
  overlays text.
- Every tab reachable by mouse and keyboard; counts on the labels; honest-gap
  voices intact.
- Before/after screenshots at 1080p, on a live lane and a folded lane.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.

## Deferred by the operator

Section ORDER (TRACE currently sits below ACTIVITY; the original blessing said
below CONVERSATION) is deliberately **not** settled here — the operator will
judge order once the drawer is no longer cramped. Keep today's order; do not
reorder on your own initiative.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
