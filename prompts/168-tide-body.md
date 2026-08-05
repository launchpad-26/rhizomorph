You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Wave 2 of prd13. The #167 keystone is LANDED on main — packages/web/src/tide/ holds bandsFor/coalesce/rowPlan and their law tests. Read docs/prd13.md IN FULL, then the keystone code. You render what it computes; compute nothing yourself.

YOUR ISSUE — #168:

## Direction

prd13 wave 2 of 4 — **the body**. Read `docs/prd13.md` IN FULL, then #167's
landed selectors in `packages/web/src/tide/` — you render what they compute and
you compute NOTHING yourself. If a fact you need is not in the selectors,
`BLOCKED: <need>` — do not walk the event log from a component.

Build the `Tide` component: the swim-lane body the replay bar will grow in
wave 3. This wave builds it standalone (with fixtures/stories in tests); wave 3
docks it. Nothing in this wave changes the page layout.

1. **Rows**: 14px per lane, per #167's `rowPlan` — stable order, top-N, `+N`
   remainder row (prd13 rulings 3–4). Collapsed mode: ONE merged density band
   (live's default per ruling 4); expanded mode: per-lane rows.
2. **Fills**: the four ladder hues plus parked, drawn from the existing
   activity-state palette tokens (prd4 law 9a/9b). **No new hex values** — the
   #136 contrast-floor grep-law must stay green untouched. Gaps render as the
   honest hatch (prd13 ruling 8), visually unmistakable for a state fill.
3. **Labels when they fit; colour when they do not; a legend never** (prd13
   ruling 7). A band wide enough carries its state as text. There is NO legend
   in any mode — the fleet table teaches the hues.
4. **The duration hover** (prd13 ruling 6, stolen shape):
   `start – end · lane · STATE · Duration 1h 20m`. Duration is first-class
   text, never inferred from pixel width. Sub-threshold bands are coalesced via
   #167's `coalesce` — never rendered unhoverable (the felt-evidence pass
   watched Grafana fail exactly this way).
5. **Time axis**: session-to-now compression in live (prd13 ruling 2) — the
   whole session maps to the width; the component takes `{start, end}` and a
   width and owns the time→x mapping. Export that mapping — wave 3's playhead
   alignment and wave 4's selection both consume it, and two copies of a time
   scale is the drift the product exists to catch.
6. **Motion**: none. No new motion class (prd13 ruling 1); bands update by
   re-render, not animation. Respect the existing motion-law pause plumbing if
   any surface-level hook is needed — likely none.

Laws, test-stated:

- Rendering N lanes over span S produces bands whose summed widths equal the
  mapped span per lane (no time invented at the pixel layer).
- The hatch and every state fill are distinguishable WITHOUT colour (pattern vs
  fill) — assert the gap band renders its pattern class.
- Label-fits logic: a band below the text threshold renders no text (never
  clipped text).
- The #136 grep-law and drawer readonly tests stay green untouched.

## Fence (may touch ONLY)

- `packages/web/src/tide/` (all files — you extend #167's directory; its
  selector files' LAWS may not be weakened, and if a selector needs a change,
  `BLOCKED: <need>` so the conductor can judge it on the record)

## Blocked by

#167 (must be landed on main first). **Model:** sonnet. **Wave:** TIDE wave 2.

## Definition of done

- `Tide` renders collapsed and expanded modes from #167 selectors alone;
  hover carries the duration shape; no legend anywhere; laws above test-stated.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
