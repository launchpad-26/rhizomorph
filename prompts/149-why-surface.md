You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened.

YOUR ISSUE — #149:

## Direction

prd11 ruling 5: the WHY surface — causality made clickable. Read
docs/prd11.md first. Data: `tool.activity.filePath`/`toolUseId` (landed,
#145), `commit.landed.files`, the transcript API's records, and
`trace.span.toolUseId` for the waterfall join.

1. **Provenance selector** — new `packages/core/src/selectors/provenance.ts`:
   `selectFileProvenance(state, { lane?, path })` → the causal chain for a
   file: the tool.activity records that touched it (with toolUseId +
   timestamps), the commits whose `files` include it (sha, message,
   branch), grouped and ordered. `selectLaneTouches(state, lane)` → the
   files a lane touched with counts/recency (the drawer's entry list).
   FILE granularity, stated in the doc comments (prd11 ruling 1 — hunk
   attribution is named future work, never inferred).
2. **The WHY view** — in the lane drawer AND the lane page (reuse one
   component): a lane's touched-files list; picking a file shows its
   chain — tool calls (kind-glyphs, timestamps, links into the trace
   waterfall via toolUseId where spans exist) and the commits that landed
   it. Each tool call deep-links the CONVERSATION at that moment (the
   transcript already serves offsets — jump-to nearest entry is enough;
   perfect alignment is future work, say so in the UI title attr
   honestly).
3. **Honest gaps**: history predating #145 has no filePath — the view
   says "tool detail unavailable before <date>" style gap copy, never an
   empty pretending to be a fact.
4. Laws: legibility floor, mono/tabular for data, no new hues; readonly
   greps untouched.

## Fence (may touch ONLY)

- `packages/core/src/selectors/provenance.ts` (new)
- `packages/core/src/selectors/provenance.test.ts` (new)
- `packages/core/src/selectors/index.ts`
- `packages/core/src/index.ts`
- `packages/web/src/why/` (new — the shared component)
- `packages/web/src/drawer/index.tsx`
- `packages/web/src/drawer/index.test.tsx`
- `packages/web/src/lane-page/LanePage.tsx`
- `packages/web/src/lane-page/LanePage.test.tsx`

## Blocked by

#145 (landed before dispatch); barrels free (#143 landed). **Model:**
sonnet. **Wave:** prd11-surface.

## Definition of done

- A fixture session with tool activity + commits renders the chain; the
  span join works where trace fixtures exist; pre-#145 history shows the
  honest gap; drawer and page share the component by import.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
