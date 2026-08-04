You are a worker agent on rhizomorph. You own exactly one issue.
Read docs/research/2026-08-04-dashboard-ia-spike.md and the issue IN
FULL before changing anything. This is connective tissue between
existing surfaces — no new panels, no new hues, no new rows.

YOUR ISSUE — #159:

## Direction

Operator-ruled from the dashboard-IA spike
(`docs/research/2026-08-04-dashboard-ia-spike.md` — read it first): take
the three cheap wins that are worth roughly what the state-timeline is
worth combined, plus the golden-signals error gap. One lane, lands alone.
No new hues, no new panels, no new rows in the curated order — this is
CONNECTIVE TISSUE between surfaces that already exist.

1. **Row drill-down** (Grafana's data-link pattern): any lane-identifying
   row — fleet table, ledger branch row, collisions column header —
   navigates to that lane's page (`/lane/:handle`, landed in #135) via
   the existing router. Keyboard-reachable, `cursor-pointer`, visible
   focus ring; the row still supports today's drawer-select behaviour
   (click selects, an explicit affordance navigates — do NOT hijack the
   existing click).
2. **Sparklines in table cells** (Grafana's legend-as-table pattern): a
   tiny inline sparkline in the fleet table's OUTPUT cell and the
   ledger's TOKENS cell showing that lane's/branch's recent output-token
   history from the events already folded. Pure SVG, no dependency, ~60x14,
   `aria-hidden` with the real number beside it (the number stays the
   truth; the spark is texture). Honest gap: fewer than 3 points → no
   spark, never a flat line pretending to be data.
3. **The exemplar jump** (Grafana's exemplars, our data already joins):
   in the ledger and the burn strip's per-lane detail, a spend figure
   that has trace spans behind it gets an affordance that opens that
   lane's drawer at the TRACE section, scrolled to the heaviest
   `llm_request` span in that window. Uses the existing selectors and the
   existing drawer focus — no new API, no new state.
4. **Errors in the top dock** (golden signals, operator ruling: errors
   yes, latency no): the burn strip gains ONE error figure — count of
   lanes currently blocked/parked plus gate failures visible in the fold
   — labelled plainly, sitting in the existing four-number rhythm (so
   five), styled from the existing ladder tokens (no new hue). Zero is
   rendered as a calm zero, never as reassurance copy (the standing law:
   absence of a flag is not evidence of absence).

## Fence (may touch ONLY)

- `packages/web/src/panels/fleet/` (all files)
- `packages/web/src/panels/ledger/` (all files)
- `packages/web/src/panels/collisions/` (all files)
- `packages/web/src/panels/burn/` (all files)
- `packages/web/src/fleet/buildFleet.ts`, `buildFleet.test.ts`
- `packages/web/src/spark/` (new — the sparkline component + test)

## Blocked by

Nothing (scene, replay and docs lanes are elsewhere). **Model:** sonnet.
**Wave:** connective tissue.

## Definition of done

- Drill-down works from all three row kinds without breaking select;
  sparklines honest about thin data; exemplar jump lands on the right
  span; one error figure in the dock with a calm zero.
- Laws green: legibility floor, hue-is-meaning, one-object-four-surfaces
  (read `buildFleet`, never re-derive), readonly greps.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic and
HERMETIC under 4x concurrency; build for a stranger's machine; if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
