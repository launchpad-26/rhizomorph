You are a worker agent on The Observatory (prd1: the money layer).

FIRST read docs/prd1.md, docs/architecture.md and
research/2026-07-30-telemetry-capture-routes.md.

YOUR ISSUE — #46 (46. --extra-sessions does nothing cross-machine (slug inference, not a directory))

**Fence (may touch ONLY):** `packages/server/src/collectors/sessionlog/`, `packages/server/src/cli/args.ts`, `packages/server/src/cli/args.test.ts`
**Model:** sonnet

`--extra-sessions` exists, is documented, has passing unit tests — and does
nothing in the real cross-machine case it was built for. Verified live: pointing
it at a Windows-side conductor's project dir produced **zero** conductor events.

Cause: the flag takes a **cwd** and *infers* the session-log directory by
slugifying it (`worktree-slug.ts`: replace `/` and `_` with `-`, resolved under
the local `~/.claude/projects`). That inference bakes in three assumptions at
once — POSIX path separators, the projects root living in the local home, and
the conductor sharing the workers' filesystem. A conductor on Windows breaks all
three: its logs live under `/mnt/c/Users/<u>/.claude/projects/` and its slug is
Windows-shaped (`C--Users-operator-agenticlaunchpad`), which the POSIX slug
function can never produce.

**Design ruling (Lachlan, 2026-07-30): do not special-case Windows, and do not
require the conductor to live in WSL.** Fit any future setup instead. The raw
signal a collector consumes is *a directory of session JSONL* — slug inference
is sugar that got mistaken for the interface.

Fix, dir-first:
- `--extra-sessions <path>` where `<path>` is **the session-log directory
  itself** (contains `*.jsonl`). No slug inference, no root assumption, no
  platform knowledge. Works for a Windows conductor, a WSL conductor, a
  conductor on another machine via a mount, or a future non-Claude CLI whose
  logs live elsewhere.
- Keep the cwd form as a *fallback convenience*: if the path contains no
  `*.jsonl`, slugify it as today.
- Optional lane naming: `--extra-sessions <path>[:<lane>]`, defaulting the lane
  to the directory's basename. Role for these dirs stays `conductor`.
- Emit one `collector.disabled`/`collector.error` when a given path yields no
  readable sessions, so a misconfiguration is *loud* rather than silent — the
  reason this defect survived shipping.

**DoD:** a test that fails today, using a fixture directory of session JSONL
passed directly (no slugification) and asserting `role: conductor` events with
the lane from the dir name; a test for the cwd fallback; a test that a bogus
path emits a collector event rather than silence. Root `npm test` +
`npm run typecheck` green. Then prove it live: run the server with
`--extra-sessions /mnt/c/Users/operator/.claude/projects/C--Users-operator-agenticlaunchpad`
and paste evidence that conductor `llm.usage` events appear on `/api/stream`.
No NUL bytes; never push/merge; no git in sibling worktrees.

RULES: stay strictly inside the FENCE (another agent works in parallel);
import from @observatory/core, never redefine its types; small conventional
commits; committing on YOUR branch is REQUIRED; never push, merge, or run
git in a sibling worktree; deterministic tests only (no waitFor racing an
async boundary); no NUL bytes; STOP with a summary including any live
evidence the issue asks for.
