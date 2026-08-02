You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own the LAST issue of the prd — the stranger audit. You are the
only lane running; your fence is the whole shipped surface, but your
changes must be minimal fixes with every one listed file:line in your
summary. Findings you cannot fix minimally get FILED in the summary,
not changed.

YOUR ISSUE — #72 (72. The stranger audit: hunt machine-specific assumptions in everything we ship)

**Fence (may touch ONLY):** any file that ships to a stranger (source, docs, fixtures, workflows) — but ONLY for removing machine-specific assumptions found by this audit; every change listed in the summary with file:line. If a fix is structural (needs design), file it in the summary instead of changing it.
**Blocked by:** #70, #71. **Model:** sonnet. **Wave: E (the stranger audit)**

prd2's operator observation: unstipulated, agents build software that works
perfectly on the author's machine and nowhere else — small non-replicable
assumptions compound into "a super cool personal project that is totally
useless to anyone else." Wave D fixed the instances we knew (`npx
rhizomorph`, the `[::1]` bind, `/home/operator` in fixtures). This issue
hunts the ones we don't.

Audit everything a stranger receives:
- **Grep the shipped surface** (packages/, docs/, README, .github/, any
  committed config) for personal paths (`/home/`, `/mnt/c/`, `C:\\Users`),
  personal names, hardcoded hostnames/ports outside documented defaults, and
  OS-specific assumptions (path separators, `wsl`, `brew`-only steps
  presented as universal).
- **Run `rhizomorph doctor` in a bare context** (fresh clone, no tmux, no
  workmux, no worktrees, empty `~/.claude/projects`) and check every gap it
  reports is loud, actionable, and true.
- **Verify the README's degradation claims**: without tmux/workmux the
  collectors must report disabled loudly in the status bar, not silently
  show nothing.
- Check `.workmux.yaml`, prompts in `prompts/`, and CI for anything a
  non-WSL Linux or macOS user would trip over that the docs don't flag.

**DoD:** root `npm test` + `npm run typecheck` green; no NUL bytes. The
summary is the deliverable: every finding with file:line, fixed-or-filed
status, and the bare-context doctor transcript. Never push, merge, or run
git in a sibling worktree — committing on YOUR branch is required.


RULES: minimal fixes only, everything listed in the summary; build for
a stranger machine — that IS the issue; small conventional commits;
committing on YOUR branch is REQUIRED; never push, merge, or run git
in a sibling worktree; no NUL bytes; STOP when done.
