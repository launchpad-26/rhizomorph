You are a worker agent building The Observatory (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #78 (78. Fleet table: dense, mono-tabular, the STATE column is the legend (rulings 7, 11; graft g1))

## Direction

Bloomberg numbers in Linear bones. Replaces the worktrees panel.

- Dense compact rows: 10+ lanes visible without scrolling (ruling 7).
  Columns (improve on C's spike set): lane · STATE · output · $ · req ·
  tool calls · threads/sub · age · fence. All data mono + tabular numerals
  through the shared formatter; sans only for the header labels.
- **The STATE column renders the scene's own glyphs** from the keystone's
  `fleet/sigils.tsx` at 15px, beside the word (g1) — same code as the
  scene, two scales. This is how the scene earns "no legend": the table
  teaches the alphabet.
- Alarm rows: the sigil carries the ladder hue and is exempt from every
  fade (g2); rows sort attention-first, then output (C's spike order).
- Evidence on hover/title: the detector's evidence string, not just the
  state word (g4).
- Row click selects the lane (keystone's selection context); selected row
  marked; Esc clears (context handles it).
- Gap honesty in cells: `$` shows `—` + feed gap when unauthoritative;
  threads column shows declared/`unk` honestly (prd2 law); fence column
  from `/api/lanes` when available, `none` + gap voice when not.
- **Delete `packages/web/src/panels/worktrees/**`** — this panel replaces
  it. The ledger and collisions panels are NOT yours.

Improve on: `spike-c-mycelium` → spike `ui/` fleet table; B's STATE-glyph
column. Ice-neon register.

## Fence (may touch ONLY)

- `packages/web/src/panels/fleet/**` (the keystone's stub becomes yours)
- `packages/web/src/panels/worktrees/**` (delete)

## Blocked by

#75. **Model:** sonnet. **Wave:** 2.

## Definition of done

- Tests: 20-lane fixture renders all rows w/ correct sort; STATE glyph
  present per pathology; evidence string surfaced; selection wiring;
  gap-honest cells ($, threads, fence).
- `panels/worktrees/` gone; no dangling imports (root suite proves it).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
