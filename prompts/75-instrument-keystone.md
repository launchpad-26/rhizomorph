You are a worker agent building The Observatory (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #75 (75. Instrument keystone: ice-neon tokens, derived fleet object, glyph alphabet, shell reorder)

## Direction

The spine of prd3 — everything wave 2 reads. Four deliverables, one branch:

1. **Ice-neon token system** (ruling 29). Rewrite `theme/theme.css` as the
   single token source: four ladder hues (calm = neutral, notice = saturated
   cyan, needs-you = amber, broken = magenta-red — exclusive, used for
   nothing else, ruling 9), the ice register for the calm world (cold
   blue-white / near-black-blue luminance ramp — neon by luminance, never by
   saturation), two type families per ruling 11 (sans for labels, mono +
   `tabular-nums` for ALL data). Every token commented with its law.
2. **The one derived fleet object** (graft g4/C's structural insistence).
   New `packages/web/src/fleet/`: a `buildFleet(state)` that joins
   `@observatory/core` selectors into per-lane vitals + the five pathology
   detectors + the alarm ladder + the gap registry. All four wave-2 surfaces
   will read THIS and nothing else, so they cannot disagree. Requirements:
   - Detectors with **evidence strings** (`Read→Edit→Bash ×6, no commit`;
     `touching <lane> — 1 file`), never bare labels (g4).
   - Tuned constants named at the top of the file (expensive ≥3× fleet
     median w/ floor; frozen = minutes of total silence; looping = period
     2–6, ≥3 repeats, no commit in window).
   - `done` is a first-class non-pathological state — a finished fleet must
     not read as 17 frozen lanes (C's rule).
   - **Detection honesty:** WAITING certain when workmux declared it,
     otherwise inferred-and-marked (`~`); off-fence only ever from a real
     lane manifest (`/api/lanes`, #76) — never inferred from lane names; a
     missing manifest is a named gap, not a guess (ruling 18/19).
   - **The ladder floor (g5):** ALL CLEAR is structurally incapable of
     rendering beside a non-zero collision count — the count raises the
     rung IN THE MODEL, and the evidence line (`collisions: 0 — checked N
     branches / M files`) only exists at CALM (ruling 14).
3. **The glyph alphabet.** `fleet/sigils.tsx`: the five pathology marks +
   state glyphs (working / waiting / done / idle), cyber-sigilist register
   (sharp tapered strokes, thorn-curl terminals — ruling 23), rendered at
   BOTH scene scale and 15px row scale from the same code (g1's enabler —
   the fleet table's STATE column will be the scene's legend). Hue =
   severity, form = kind (g4): three ambers must be unconfusable by
   silhouette alone.
4. **Shell reorder + placeholder registry** (ruling 6, and the coupling
   rule). Rework `App.tsx` / `PanelGrid` / `Shell` to the curated order:
   attention strip + burn strip docked top → fleet table → scene → the rest
   (ledger, collisions, feed) → provenance bar bottom. Register placeholder
   components for `panels/attention`, `panels/burn`, `panels/fleet`,
   `panels/feed` (bare stubs — wave 2 issues own their contents; you own
   ONLY the stub files listed in the fence). Deregister the spend ticker
   (#78 deletes its directory). Stub a `ReplayBanner` slot in the shell
   (mode-switched against the attention strip; #83 fills it). Provide the
   lane-selection context (select/clear, Esc clears) that the strip, table,
   scene and drawer will share. Wire fixture switching keys 1/2/3
   (live / 20-lane / staged-pathology) through `StreamContext` folding the
   SAME reducer as live, and tag events **news-vs-history** by their own
   `ts` against connection time (C's rule 1: history builds state and
   lights nothing — the scene reads this tag).

Ship the two synthetic fixtures in `fleet/fixtures.ts` (20-lane with
subagent threads; staged-pathology with exactly one of each), built from
real schema events via core's `createEvent`, folded by core's real reducer.
Tests must assert the staged fixture's one-of-each claim and the 20-lane
fixture's ALL CLEAR (C's pattern).

Reference (improve, never copy wholesale): branch `spike-c-mycelium` →
`packages/web/src/spike/data/` (fleet, fences, fixtures) and `feed/live.ts`
(news tagging); branch `spike-a-constellation` → `packages/web/src/spike/`
(`fleet.ts` detectors, `sigils.tsx` two-scale glyphs, the ladder floor).

## Fence (may touch ONLY)

- `packages/web/src/theme/**`
- `packages/web/src/fleet/**` (new)
- `packages/web/src/App.tsx`, `packages/web/src/App.test.tsx`
- `packages/web/src/app/PanelGrid.tsx`, `packages/web/src/app/PanelGrid.test.tsx`
- `packages/web/src/app/Shell.tsx`
- `packages/web/src/app/SceneSlot.tsx`
- `packages/web/src/app/panelPrefs.ts`, `packages/web/src/app/panelPrefs.test.ts`
- `packages/web/src/app/StreamContext.tsx`, `packages/web/src/app/StreamContext.test.tsx`
- `packages/web/src/app/streamState.ts`
- `packages/web/src/hooks/useEventStream.ts`, `packages/web/src/hooks/useEventStream.test.ts`
- `packages/web/src/panels/attention/index.tsx`, `packages/web/src/panels/burn/index.tsx`, `packages/web/src/panels/fleet/index.tsx`, `packages/web/src/panels/feed/index.tsx` (placeholder stubs only)
- `packages/web/src/index.css`

## Blocked by

Nothing. **Model:** opus. **Wave:** 1.

## Definition of done

- Tokens documented; no component outside the ladder uses a status hue.
- `buildFleet` fully tested: detectors find the staged fixture's
  one-of-each; ladder floor test (non-zero collisions ⇒ no ALL CLEAR, at
  the type/model level); done-as-non-pathology test; evidence strings
  asserted; news-vs-history tagging tested against an out-of-order replay
  burst.
- Shell renders curated order with placeholders; keys 1/2/3 switch sources
  through the one reducer; Esc clears selection.
- Old behavior-encoding tests reconciled (App.test.tsx panel mocks, panel
  prefs ids) — minimal reconciliation, on the record in your summary.
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
