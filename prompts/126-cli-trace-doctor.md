You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (the rulings bind you),
then research/2026-08-03-trace-era-captures.md (the captured shapes are
your source of truth, not memory). The #123 keystone is LANDED on main:
packages/core/src/events/trace.ts is the contract — import from
@rhizomorph/core, never redefine its types.

YOUR ISSUE — #126:

## Direction

prd9 wave A — the CLI: `rhizomorph env` learns the trace beta, and doctor
learns two honesty lessons (prd9 ruling 8; junior audit in
`research/2026-08-03-trace-era-captures.md` §5).

1. **`telemetry-env.ts`** — the emitted block gains exactly three lines,
   keeping existing lines and ordering stable:
   `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_TRACES_EXPORTER=otlp`,
   `OTEL_TRACES_EXPORT_INTERVAL=1000`. (Protocol/endpoint lines already
   cover traces — the SDK appends `/v1/traces` itself.) Tests assert the
   exact new lines and that nothing existing moved.
2. **Doctor recognizes its own kind** (the audit's worst stumble: a
   healthy running rhizomorph reported `[FAIL] port in use … fix these
   before rhizomorph can run`). When the checked port is busy, probe
   `GET http://127.0.0.1:<port>/api/meta`: a response with rhizomorph's
   meta shape (repoPath/repoName/sessionId/startedAt) → `ok` with copy like
   "a rhizomorph is already serving this repo (started <when>)"; anything
   else on the port stays `FAIL` with the existing remedy. Injected
   fetch/stub in tests — no real sockets.
3. **Trace-era doctor checks**:
   - CLI-vs-fixture drift: pin `TRACE_FIXTURE_CLI_VERSION = '2.1.220'` as
     a local constant (deliberately duplicated — the fixture lane runs in
     parallel and cannot be imported from; consolidation is follow-up
     work, note it in a comment). If `claude --version` output differs →
     `warn` naming both versions and the consequence (beta span names may
     have drifted from the pinned fixtures; parser maps unknowns to
     `other`).
   - The telemetry remedy copy must not name a bare `rhizomorph` binary
     (clone users don't have it on PATH — audit stumble): reference
     `npm start --` / `node packages/server/bin/rhizomorph.mjs` forms.
4. `cli/index.test.ts` is fenced for minimal reconciliation only.

## Fence (may touch ONLY)

- `packages/server/src/cli/telemetry-env.ts`
- `packages/server/src/cli/telemetry-env.test.ts`
- `packages/server/src/cli/doctor.ts`
- `packages/server/src/cli/doctor.test.ts`
- `packages/server/src/cli/index.test.ts` (minimal reconciliation only)

## Blocked by

#123 (landed). **Model:** sonnet. **Wave:** A.

## Definition of done

- Env block: three new lines exactly, existing lines untouched, tests
  assert both.
- Doctor: own-server-on-port → `ok` (stubbed test); non-rhizomorph busy
  port → unchanged `FAIL`; drift check warns on version mismatch; no
  remedy copy names a bare `rhizomorph` binary.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (the gate audits every touched
path); small conventional commits (committing is REQUIRED — review
happens from your branch); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests must be deterministic
(no waitFor racing async work — stub or await the boundary; a flaky
test blocks the gate); build for a stranger's machine (no personal
paths, 127.0.0.1 not [::1], degrade loudly never silently); if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
