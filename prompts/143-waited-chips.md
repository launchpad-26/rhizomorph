You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened.

YOUR ISSUE — #143:

## Direction

prd9 S1 + prd10 ruling 9's data layer, one lane: the attention strip
learns what lanes WAITED for (retrospective, from traces), and
`buildFleet` gains the subagent vitals the scene lane will consume next.

1. **Core selector** — new `packages/core/src/selectors/subagents.ts`:
   per-lane live subagent activity from thread-marked telemetry recency
   (`thread: 'subagent'` on `llm.usage`/`tool.activity` within a named
   recency window), enriched with `agentId`/`subagentType` from
   `trace.span` records where present. Conductor counts too (its
   telemetry lane). Exported via the barrels. Honest gaps: a lane with no
   telemetry reports nothing, never zero-with-confidence.
2. **buildFleet vitals** (one object, four surfaces — the law): add
   (a) `waitedOnHuman` — per lane, from `selectWaitingOnHuman` (#125):
   total waited ms, count, decision census, longest wait with tool; and
   (b) `subagents` — from the new selector. Both marked with the existing
   detection-honesty conventions.
3. **The strip's retrospective chips** — a QUIET right-aligned region in
   the attention strip: up to 3 chips, each `<lane> waited <dur> ▸
   <decision glyph>` for the largest recent human-waits. RULES: prd9
   ruling 6 wording — "waited", never "waiting"; chips live BELOW the
   calm ceiling, no glow, no cartouche, no alarm grammar — this is
   memory, not summons (the summons ladder is untouched). Click focuses
   the lane (existing selection context).

## Fence (may touch ONLY)

- `packages/core/src/selectors/subagents.ts` (new)
- `packages/core/src/selectors/subagents.test.ts` (new)
- `packages/core/src/selectors/index.ts`
- `packages/core/src/index.ts`
- `packages/web/src/fleet/buildFleet.ts`
- `packages/web/src/fleet/buildFleet.test.ts`
- `packages/web/src/panels/attention/` (all files)

## Blocked by

Nothing (board empty). **Model:** sonnet. **Wave:** finale-1 (the scene
lane stacks after this — it reads the new buildFleet vitals).

## Definition of done

- Selector tested for: subagent-recency windows, trace enrichment,
  conductor lane, no-telemetry honesty.
- Chips: retrospective wording, sub-ceiling styling asserted (the
  legibility/9b law patterns), cap of 3, alarm ladder untouched by test.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
