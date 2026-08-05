You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The audit report is docs/research/2026-08-05-adversarial-audit.md — read
its fixtures finding first. The operator has confirmed the values are real
(see the issue comment); scrub them without ever echoing them into your
commit messages, test names, or summary.

YOUR ISSUE — #177:

## Direction

From the 2026-08-05 adversarial audit. The captured trace fixtures
(`packages/server/src/collectors/otel/fixtures/claude-code-2.1.220-traces-*.json`)
carry non-placeholder `organization.id`, `user.account_uuid`,
`user.account_id`, and `user.id` values on every span — while `user.email`
beside them WAS scrubbed to a placeholder. These are identity-relevant fields
by the product's own reckoning (prd9 ruling 5; record law 4). The values are
not quoted in this issue on purpose.

1. **Scrub** all identity fields across the six trace fixtures AND re-verify
   `metrics-token-and-cost.json`'s account fields, to obviously-synthetic
   values (zeroed UUIDs / `user_TEST...`). The parser allowlist ignores these
   fields (`parse-metrics.ts` reads only session.id/model/query_source/type),
   so no test outcome may change — assert that by running the suite before
   and after.
2. **Add a fixture-hygiene law test**: no file under `fixtures/` contains a
   non-placeholder value in the known identity fields (grep-law style).
3. **Record the history fact for the operator** in your summary and in a
   comment here: the unscrubbed values remain in git history (both the
   archive repo and this one). A scrub commit fixes the tree, not the
   history — if/when the repo goes public, the operator decides between a
   history rewrite and a fresh-tree release. That decision is NOT this lane's.

## Fence (may touch ONLY)

- `packages/server/src/collectors/otel/fixtures/` (all files)
- the new hygiene law test beside them in `packages/server/src/collectors/otel/`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** audit-surgical.

## Definition of done

- Fixtures scrubbed, suite provably unchanged, hygiene law test-stated,
  history note recorded; root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
