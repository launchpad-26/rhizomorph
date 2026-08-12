@AGENTS.md

<!--
Claude Code reads CLAUDE.md, not AGENTS.md — the `@AGENTS.md` import above is
the supported bridge (code.claude.com/docs/en/memory, "AGENTS.md"). Without
this file, a Claude Code session in this repo loads no project instructions at
all, which is the state the repo was in between 2d77e5b and #399.

Tracked deliberately. It carries no personal content: everything below the
import is repo-wide, and anything personal belongs in CLAUDE.local.md, which
is gitignored and loads automatically alongside this file.

A symlink to AGENTS.md would also work, but not on Windows without Developer
Mode or admin — and this cohort runs Windows. The import is portable.
-->

## Claude Code specifics

- `CLAUDE.local.md` is yours, gitignored, and loads after this file. Put
  machine-specific paths, personal shortcuts and scratch notes there — not here.
- Verify the runbook actually loaded before trusting a session: run `/context`
  and check that `CLAUDE.md` and `AGENTS.md` both appear under **Memory files**.
  If `AGENTS.md` is missing, the import did not resolve and the agent is working
  without the conventions.
- Worktrees: `.workmux.yaml`'s `post_create` copies `CLAUDE.local.md` in, since
  git does not carry gitignored files into a new worktree. `AGENTS.md` and this
  file arrive on their own because they are tracked.
