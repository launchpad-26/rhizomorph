You are a worker agent on The Observatory (prd1: the money layer).

FIRST read docs/prd1.md, docs/telemetry.md and the files your issue names.

YOUR ISSUE — #49 (49. Conductor lane label is a raw project-dir slug, not a name)

**Fence (may touch ONLY):** `packages/server/src/collectors/sessionlog/`, `packages/server/src/cli/args.ts`, `packages/server/src/cli/args.test.ts`, `docs/telemetry.md`
**Model:** sonnet

`--extra-sessions` now works (#46, proven live). Its lane label does not: events
from a conductor's log dir arrive tagged

```
"lane":"C--Users-operator-agenticlaunchpad"
```

— the raw Claude Code project-dir slug. That is an implementation detail leaking
into the primary label a human reads in the worktree table, the spend ticker and
the ledger. It also means two conductors on different machines produce two
unrelated-looking lanes.

Fix:
- Support the documented `--extra-sessions <dir>[:<lane>]` form so an operator
  can name the lane (`…/projects/C--Users-…:conductor`). Verify it end to end —
  #46's brief specified it and the live run shows it unexercised.
- Default, when no `:lane` is given: **`conductor`** for the first extra dir, and
  `conductor-2`, `conductor-3`… for further ones. Never the raw slug.
- Un-slugify nothing and infer nothing else: the dir stays the input, the label
  is presentation.
- `docs/telemetry.md`: show the `:lane` form in the conductor section.

**DoD:** tests covering the explicit `:lane` form, the `conductor` default, and
multiple extra dirs; root `npm test` + `npm run typecheck` green. Then prove it:
run with `--extra-sessions <the conductor dir>:conductor` and paste stream
evidence showing `"lane":"conductor"`. No NUL bytes; never push/merge; no git in
sibling worktrees.

RULES: stay strictly inside the FENCE (another agent works in parallel);
import from @observatory/core, never redefine its types; small conventional
commits; COMMITTING ON YOUR OWN BRANCH IS REQUIRED (the prohibition is only
on pushing, merging, and switching branches); never run git in a sibling
worktree; deterministic tests only; no NUL bytes; STOP with a summary
including the live evidence your issue asks for.
