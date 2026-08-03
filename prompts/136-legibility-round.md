You are a worker agent on rhizomorph (prd9: the trace era).
You own exactly one issue — the operator-ruled legibility round.

FIRST read packages/web/src/theme/theme.css IN FULL (the laws in its
comments bind you), then packages/web/src/drawer/readonly.test.ts
(the grep-law pattern your new test mirrors), then skim the panels
you are giving air to. Your fence is wide because you land alone —
that is trust, not license: smallest possible diff per file.

YOUR ISSUE — #136:

## Direction

prd9 legibility round — operator-ruled 2026-08-03 after reviewing the live
UI: "blue text on dark blue is hard to read; things get crowded and
occluded by scroll bars." Measured basis (WCAG ratios vs the `ice-1000`
page floor): `ice-300` body 7.9:1 ✓, `ice-400` 5.1:1 ✓, **`ice-500`
3.3:1 ✗, `ice-600` 2.4:1 ✗** — the de-emphasis ladder dips below
legibility. This lane lands ALONE (wide fence, single writer).

1. **Contrast re-role + law test** (operator chose re-role over
   re-tinting):
   - Every hex in `theme/theme.css` stays EXACTLY as is. The RULE changes:
     **text may not wear anything dimmer than `ice-400`**. `ice-500`/
     `ice-600` become non-text-only (disabled/absent marks, decorative
     structure); update the token comments to say so.
   - Sweep `packages/web/src` for sub-floor ink on text (`text-ice-500`,
     `text-ice-600` and any dimmer, however expressed) and raise each to
     `text-ice-400` (or `-300` where it was already carrying data);
     de-emphasis that mattered is re-expressed via size/weight/opacity of
     SPACING — never sub-floor luminance.
   - New law test `packages/web/src/theme/legibility.test.ts` (mirror the
     `drawer/readonly.test.ts` grep-the-source pattern): no text-color
     class below the floor anywhere in `packages/web/src`, with an
     explicit in-test allowlist for genuinely decorative uses (each entry
     justified by a comment). Laws restated stronger, never weakened.
2. **Scrollbars + gutters**: thin (~8px) ice-toned scrollbars
   (`scrollbar-width: thin` + `::-webkit-scrollbar*` styled from tokens,
   in `index.css`), and `scrollbar-gutter: stable` on every panel/drawer
   scroll container so content is never occluded by an overlay bar.
3. **Spacing & density pass**: one token-driven sweep — panel padding, row
   min-heights, mono-list line-height (the collisions file list is the
   named offender), table cell gaps. Air, not layout redesign.
4. **Responsive panel wrap**: the three-up ledger/collisions/feed band
   wraps to two-up below ~1400px instead of squeezing (PanelGrid CSS).
5. **Feed collapsed by default**: the activity feed starts collapsed
   (header + latest line), expands on demand, remembers the choice via
   the existing `panelPrefs` mechanism.

## Hard boundaries

- `packages/web/src/scene/` canvas geometry/marks: UNTOUCHED (the scene
  reads tokens; it needs nothing from this round).
- No hue-law changes (9a/9b stand); no motion-budget changes; no new
  dependencies; no layout re-architecture — this is air and ink, not
  organs.

## Fence (may touch ONLY)

- `packages/web/src/**` EXCEPT `packages/web/src/scene/**` (wide by
  design — this lane lands alone; the conductor reviews the diff before
  the gate)

## Blocked by

Nothing (board empty). **Model:** sonnet. **Wave:** legibility (solo).

## Definition of done

- Legibility law test green with every allowlist entry justified; zero
  sub-floor text classes outside it (the test IS the proof).
- Scrollbar gutters stable on every scrolling panel; thin styled bars.
- Two-up wrap at narrow widths; feed collapse persisted.
- Scene untouched (`git diff --stat` shows nothing under `scene/`).
- Root `npm test` + `npm run typecheck` green.

RULES: stay inside the FENCE (everything under packages/web/src
EXCEPT scene/ — the gate audits it); small conventional commits per
concern (committing is REQUIRED); NEVER switch branches, push, merge,
or run git in a sibling worktree; no NUL bytes; tests deterministic;
hue is meaning — no status hue gains a new use; if you cannot proceed
print "BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
