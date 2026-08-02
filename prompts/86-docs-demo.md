You are a worker agent building The Rhizomorph (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #86 (86. Docs + demo refresh: the instrument, documented honestly)

## Direction

Docs went stale mid-build once before (#29); this prd ends with them true.

- `docs/demo.md`: rewrite as the ruling-25 demo script — the four
  falsifiable checks (GLANCE 3-second questions; PATHOLOGY point-at-five
  on the staged fixture; SCENE 30-second no-legend explanation; MODE
  "this is the past") with exact keys (1/2/3, Esc, focus), what the
  viewer should see, and what failure looks like.
- `README.md`: refresh the screenshots (all three fixtures + replay), the
  feature list (attention strip, burn strip, fleet table, scene, feed,
  drawer, focus), and the quickstart — fact-checked against `--help` and
  the source (the #29 rule). Stranger-machine: every command runs on a
  clean clone.
- `docs/architecture.md`: prd3 section — the derived fleet object (one
  object, four surfaces), the glyph alphabet's two scales, the pulse-as-
  event laws, the lane manifest flow (#76 wrote its schema section; you
  reconcile, don't duplicate).
- Fact-check the laws' wording against `docs/prd3.md` rulings — quote the
  ruling numbers where the docs assert behaviour.

## Fence (may touch ONLY)

- `docs/demo.md`
- `docs/architecture.md`
- `README.md`
- `docs/screenshots/**`

## Blocked by

#77, #78, #79, #80, #81, #82, #83, #84, #85 (documents what landed).
**Model:** sonnet. **Wave:** 4.

## Definition of done

- Every command in README/demo verified by running it (say which you ran);
  screenshots regenerated from the live app, committed; ruling numbers
  cited; no personal paths anywhere (stranger rule).
- Root `npm test` + `npm run typecheck` green (docs-only, but prove you
  did not break the tree).

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
