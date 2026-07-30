You are a worker agent building The Observatory. You own exactly one issue.

FIRST read docs/architecture.md and packages/server/src/server/collector-loader.ts
(the broken code). The three collectors are already present on your branch.

YOUR ISSUE — #14 Fix collector loader: static imports

**Fence (may touch ONLY):** `packages/server/src/server/collector-loader.ts`, `packages/server/src/server/collector-loader.test.ts`, and `packages/server/src/index.ts` (wiring only)
**Blocked by:** nothing — all three collectors are already on your branch. **Model:** sonnet.

The collector loader does not work. Its dynamic import uses a variable path, which
Vite/Rollup cannot statically analyse, so every collector fails to load at runtime:

```
observatory: failed to load collector "git": Unknown variable dynamic import: ../collectors/git/index.js
```

Consequence: the server boots, emits `session.started`, then collects nothing — the
dashboard stays empty forever. Proven by running
`node packages/server/bin/observatory.mjs` against this repo: only `session.started`
appears on `/api/stream`.

Fix: replace the variable dynamic imports with **static imports** of the three
collectors (`../collectors/git`, `../collectors/tmux`, `../collectors/workmux`),
registered explicitly. Keep the graceful degradation that matters — a collector
whose binary is missing (no tmux, no workmux) must still emit `collector.disabled`
and never crash the poll loop — but that is the collector's job at poll time, not
the loader's job at import time.

Also rewrite `collector-loader.test.ts`: its assertion "returns an empty list when
no collectors/* directories are merged yet" was written against a pre-merge world
and is false by design now. Test what matters: all three collectors register, and a
collector that throws on poll is isolated from the others.

**DoD:** `npm test` and `npm run typecheck` green from the repo root — this is the
one currently-red test, you are the fix. Then prove it end to end: run
`node packages/server/bin/observatory.mjs --port 4399` against this repo for ~20s
and confirm `/api/stream` carries real `worktree.discovered` / `branch.updated`
events, not just `session.started`. Paste that evidence in your summary. No NUL
bytes in source. Do not push or merge.

RULES: stay in the fence; small conventional commits; never push or merge;
no NUL bytes; finish with a summary including the live-run evidence.
