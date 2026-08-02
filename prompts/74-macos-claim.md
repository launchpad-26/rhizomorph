You are a worker agent on The Rhizomorph (prd2 follow-up, operator-ruled).
You own exactly one issue — a one-sentence-scale docs truth alignment.

YOUR ISSUE — #74 (74. Align the macOS claim with what CI verifies)

**Fence (may touch ONLY):** `README.md`
**Blocked by:** — . **Model:** sonnet. Operator-ruled 2026-07-31.

The repo is PRIVATE, so a macos-latest CI leg bills at 10x — the operator
ruled: align the claim with the verification instead. The prd docs
(prd0.md:49, prd2.md:50) stay untouched as historical record of intent.

In the README, wherever platform support is stated or implied: say plainly
that Linux is CI-verified on every push, WSL is first-class and exercised
daily, and macOS is expected to work (no platform-specific code; paths via
node:path; collectors degrade loudly) but is NOT CI-verified. One honest
sentence, not a hedge-paragraph. If a macos leg is added later (repo goes
public, or the cost is accepted), this sentence is the one to update.

**DoD:** root `npm test` + `npm run typecheck` green; no NUL bytes. Never
push, merge, or run git in a sibling worktree — committing on YOUR branch is
required.

RULES: stay strictly inside the FENCE; build for a stranger machine;
small conventional commits; committing on YOUR branch is REQUIRED;
never push, merge, or run git in a sibling worktree; no NUL bytes;
STOP when done.
