You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

prd13 ruling 12 is the blessing; docs/prd13.md IN FULL first, then the landed tide/ keystone+body+dock — chaptersFor sits beside bandsFor and obeys the same laws.

YOUR ISSUE — #185:

## Direction

prd13 **ruling 12** (operator amendment, 2026-08-05 — read the prd section IN
FULL first). The operator opened a 50-lane recording and the expanded
per-lane default was noise. The bar's glance layer becomes **chapters**:

1. **Replay defaults to the collapsed density band** (same as live);
   per-lane rows are opt-in via the existing expand affordance in both
   modes. This amends what #169 shipped — flip the default, keep the
   machinery.
2. **`chaptersFor(events)` — a new pure selector beside `bandsFor`** in
   `packages/web/src/tide/`, same laws (single pass, deterministic,
   prefix-consistent, property-tested): emits chapter marks for lane born,
   lane landed (gate merge), gate held, attention-summons onset, and
   session boundary. Derive from existing event types only; if a moment you
   need has no event, name it in your summary — do not invent one.
3. **The mark lane renders above the band** in the TideDock: sparse, still
   (no new motion), no new hue (existing roles). Click a mark → seek there.
   Hover carries who/what/when in the ruling-6 voice
   (`163 landed · 14:32:07`).
4. **Marks coalesce under density** — the existing coalescing law applied to
   marks: below the hover threshold, a cluster renders once with a count
   (`◆(3)`) and its hover lists the members. Never an unhoverable sliver.
5. **The prd12 bridge is stated, not built**: these are checkpoint moments;
   do NOT build fork affordances, lab calls, or checkpoint events. A code
   comment naming the bridge is the whole implementation.

Laws, test-stated:

- `chaptersFor` over a prefix equals the truncation of `chaptersFor` over
  the whole (the keystone's law, restated for marks).
- Every mark's seek target equals its event's ts; clicking is exact, not
  approximate.
- Replay opens collapsed; expansion is user state, never the default.
- The #136 contrast floor and the motion law stay green untouched.

## Fence (may touch ONLY)

- `packages/web/src/tide/` (all files)
- `packages/web/src/replay/` (all files)
- `packages/web/src/app/ReplayBar.tsx`

## Blocked by

Nothing (#169 landed; its dock is your canvas). Sibling lane #183 owns
`app/StreamContext`, `app/streamState`, and `hooks/` — if you need them,
`BLOCKED: <need>`. **Model:** sonnet. **Wave:** tide-chapters.

## Definition of done

- 50-lane recording opens to a legible band + sparse marks; click-seek
  exact; clusters counted; per-lane rows opt-in; laws test-stated.
- Browser-verify on a real recording AND the synthetic 21-lane fixture.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
