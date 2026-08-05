You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The audit report is docs/research/2026-08-05-adversarial-audit.md — read its transcript finding first.

YOUR ISSUE — #173:

## Direction

From the 2026-08-05 adversarial audit. `packages/server/src/api/transcript.ts:314-324`
builds the transcript path as
`path.join(claudeProjectsRoot, slug, `${attribution.sessionId}.jsonl`)` where
`sessionId` comes off recorded events with only a `typeof === 'string'` check
(schema: nonEmptyString, no format constraint). A `sessionId` containing
`../` escapes `claudeProjectsRoot` and reads any `.jsonl` on disk. Not
reachable from an HTTP client directly — it requires a crafted session log —
but the tool is going public and will be pointed at less-trusted logs
(imported records, shared machines).

Fix:

1. Validate `sessionId` shape before the join (UUID-shape assertion, or
   `path.basename(sessionId) === sessionId`), AND assert the resolved path
   stays under its intended root (`path.resolve` + prefix check) for BOTH
   candidate paths.
2. Refusal is loud, in the existing gap-voice style: the drawer shows a
   precise "transcript path refused" voice, never silence.
3. Tests: traversal payloads refused (relative, absolute, embedded NUL);
   legitimate UUID sessions still resolve; the gap voice renders.

## Fence (may touch ONLY)

- `packages/server/src/api/transcript.ts`, `packages/server/src/api/transcript.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** audit-surgical.

## Definition of done

- Guard in place, refusals loud, tests as above; root `npm test` +
  `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
