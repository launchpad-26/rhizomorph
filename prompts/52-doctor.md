You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — it explains why this work exists — then the
files your issue names. The acceptance test for this whole prd is that a
stranger on a fresh machine can run the app from the README alone, so
prefer being explicit and loud over being clever.

YOUR ISSUE — #52 (52. observatory doctor — say what is missing and how to fix it)

**Fence (may touch ONLY):** `packages/server/src/cli/doctor.ts` (new), `packages/server/src/cli/doctor.test.ts` (new), `packages/server/src/cli/index.ts` (subcommand wiring only), `packages/server/src/cli/args.ts` (subcommand parse + help)
**Model:** sonnet. **Wave: D**

There is no way to find out why the app is not working. `observatory` with no
flags prints one line (`observatory running at <url>`) and validates nothing:
not that the path exists, not that it is a git repo, not that the web build is
present, not the Node version.

Add `observatory doctor` — a read-only preflight that tells a stranger exactly
what is wrong and what to do next:
- Node version vs the `engines` requirement;
- target path exists **and is a git repository**;
- `packages/web/dist/index.html` present (else: run the build — name the command);
- requested port free (else: name the flag to change it);
- `~/.claude/projects` (or the platform equivalent) present — this is the
  sessionlog source, and its absence is the most likely stranger failure;
- `tmux` / `workmux` presence — **optional**, reported as degraded not fatal;
- telemetry: whether any `CLAUDE_CODE_ENABLE_TELEMETRY`/OTLP env is configured,
  pointing at `docs/telemetry.md` when not.

Each check prints ok / warn / FAIL with a one-line remedy. Exit non-zero **only**
when the app genuinely cannot work (bad path, not a repo, no web build, port
taken). Keep output plain text, no colour codes required for correctness.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no waitFor racing an async boundary); no NUL bytes. Never push, merge, or run git in a sibling worktree — committing on YOUR branch is required. Finish with a short summary including any live evidence the issue asks for. Additionally: paste real `observatory doctor` output from (a) a
healthy repo and (b) a non-git temp directory.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
