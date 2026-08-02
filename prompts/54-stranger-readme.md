You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — it explains why this work exists — then the
files your issue names. The acceptance test for this whole prd is that a
stranger on a fresh machine can run the app from the README alone, so
prefer being explicit and loud over being clever.

YOUR ISSUE — #54 (54. README for a stranger + LICENSE + purge personal data from shipped UI)

**Fence (may touch ONLY):** `README.md`, `LICENSE` (new), `docs/demo.md`, `packages/web/src/scene/fixtures.ts`
**Blocked by:** #51 (the commands must be true before they are documented). **Model:** sonnet. **Wave: D**

Rewrite the README for someone who has never seen this repo and has nobody to
ask. Today it begins mid-air: no `git clone`, no repo URL anywhere in the repo,
and it assumes a running swarm.

- Start from `git clone https://github.com/KelliherL/worktrees-challenge`.
- Prerequisites stated plainly (Node 22; git; tmux and workmux **optional** —
  say what degrades without them).
- The real command sequence from #51, in order, each one you have run yourself.
- A "first run with nothing else set up" section: what you see with no worktrees,
  no tmux, no telemetry — and the one command (`rhizomorph doctor`, #52) that
  explains any gap.
- `docs/demo.md`: stop assuming a swarm already exists; point at telemetry setup
  before Act 2 rather than after.
- Add a **LICENSE** (MIT unless the repo says otherwise elsewhere).
- **Remove personal data from shipped UI:** `scene/fixtures.ts:39,55` hardcodes
  `/home/operator/rhizomorph` and real author names into the demo constellation
  that renders whenever the stream is empty. Replace with neutral placeholders.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no waitFor racing an async boundary); no NUL bytes. Never push, merge, or run git in a sibling worktree — committing on YOUR branch is required. Finish with a short summary including any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
