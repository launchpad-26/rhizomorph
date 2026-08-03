You are a worker agent on rhizomorph (prd11: the causal record).
You own exactly one issue. Read docs/prd11.md IN FULL first, then
the files your issue names; import from @rhizomorph/core; laws
restated stronger, never weakened.

YOUR ISSUE — #145:

## Direction

prd11 Keystone A (ruling 2): `tool.activity` learns WHERE. Additive
fields, sessionlog extraction, full fan-out. Read docs/prd11.md first.

1. **Schema** — `toolActivityPayloadSchema` gains `filePath` (string,
   nullable/optional — repo-relative where derivable, else as reported)
   and `toolUseId` (string, nullable/optional — the CLI's tool_use id,
   the SAME id `trace.span.toolUseId` carries). Additive: nothing
   existing changes shape. Census/fixtures/reduce tests extended.
2. **Sessionlog extraction** — the sessionlog collector's tool parsing
   pulls both from the session log's tool_use blocks: Edit/Write/Read
   (and kin with a `file_path` input) populate `filePath`; Bash and
   non-file tools leave it null (never a guess); every tool_use carries
   its id → `toolUseId` always populated when the block has one.
   Normalize to repo-relative when the path sits under the lane's
   worktree; otherwise keep the raw path (honest).
3. **Law**: a `tool.activity` without the new fields (every event ever
   logged) folds and replays exactly as today — test with a pre-prd11
   fixture line.

## Fence (may touch ONLY)

- `packages/core/src/events/telemetry.ts`
- `packages/core/src/events/telemetry.test.ts`
- `packages/core/src/events/events.test.ts`
- `packages/core/src/fixtures.ts`
- `packages/core/src/fixtures.test.ts`
- `packages/core/src/reduce.ts`
- `packages/core/src/reduce.test.ts`
- `packages/core/src/reduce.telemetry.test.ts`
- `packages/core/src/state.ts`
- `packages/server/src/collectors/sessionlog/` (all files)

## Blocked by

Nothing (fences disjoint from the in-flight chips/scene lanes). **Model:**
sonnet. **Wave:** prd11-keystones. NOTE: gates for this wave run AFTER the
in-flight finale chain completes — commit and STOP as usual; landing may
lag your finish.

## Definition of done

- Real session-log fixture lines (Edit/Write/Read/Bash) produce the right
  filePath/toolUseId; pre-prd11 events replay unchanged; census extended.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
