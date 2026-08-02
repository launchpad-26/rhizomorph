You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — it explains why this work exists — then the
files your issue names. The acceptance test for this whole prd is that a
stranger on a fresh machine can run the app from the README alone, so
prefer being explicit and loud over being clever.

YOUR ISSUE — #51 (51. The documented run command installs a stranger's package (npx observatory))

**Fence (may touch ONLY):** `package.json`, `package-lock.json`, `packages/server/package.json`, `README.md`, `docs/demo.md`
**Model:** sonnet. **Wave: D — do this first.**

The only documented way to run this app does not run this app.

`README.md:19` and `docs/demo.md:12` both say `npx observatory <path>`. But:
- the root package is `private: true`, `version: 0.0.0`, with **no `bin`**;
- `package-lock.json` predates the `bin` field added to `packages/server`, so
  `npm ci` cannot link it (verified: `npx --no-install observatory --help` →
  *could not determine executable to run*; `node_modules/.bin/observatory` absent);
- **`observatory` is a real, unrelated package on the public npm registry**
  (`npm view observatory` → "Beautiful UI for showing tasks running on the
  command line"). A stranger following our README downloads someone else's code.

Fix, honestly:
1. Root `package.json` gains `"start"` (runs the server bin) and `"build"`
   (builds the web workspace) scripts, plus `"engines": { "node": ">=22" }`
   (README already claims Node 22; nothing enforced it).
2. Regenerate `package-lock.json` so the workspace bin is recorded.
3. **Remove every `npx observatory` reference** from README and demo docs.
   Document what actually works — verify each before writing it:
   `npm start`, and `node packages/server/bin/observatory.mjs --help`.
4. Note in the README that publishing (and therefore `npx`) is a later step
   because the name is taken. Do not choose a new name — that is Lachlan's call.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no waitFor racing an async boundary); no NUL bytes. Never push, merge, or run git in a sibling worktree — committing on YOUR branch is required. Finish with a short summary including any live evidence the issue asks for. Additionally: paste the output of the commands you documented, run
from a clean `npm ci` state.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
