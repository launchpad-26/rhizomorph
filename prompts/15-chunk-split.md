You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md — they are the contract.
The whole spine is already merged on main: core, server, three collectors,
web shell, three panels, replay, and the three.js scene. Match the existing
theme tokens in packages/web/src/theme/theme.css.

YOUR ISSUE — #15 (15. Code-split the three.js vendor chunk (935 kB))

**Fence (may touch ONLY):** `packages/web/vite.config.ts`, `packages/web/src/scene/index.tsx` (lazy boundary only), `packages/web/src/app/SceneSlot.tsx`
**Model:** sonnet

`npm run build --workspace packages/web` warns:

```
dist/assets/scene-mpKX58f_.js  935.40 kB │ gzip: 250.68 kB
(!) Some chunks are larger than 500 kB after minification
```

three.js dominates that chunk. The scene is already lazy, so first paint is not
blocked — but a 935 kB chunk is a slow reveal on the one panel that is meant to
feel alive, and prd0 promises the grid stands alone if the scene degrades.

Split three.js and the drei helpers into their own vendor chunk (manualChunks /
codeSplitting), keep the scene behind its lazy boundary and error boundary, and
show a lightweight loading state in `SceneSlot` while the chunk arrives.

**DoD:** build output shows the scene chunk materially smaller with a separate
vendor chunk; `npm test` and `npm run typecheck` green from the repo root; paste
the before/after chunk table in your summary. No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (other agents are working in parallel);
consume core selectors, never edit packages/core; small conventional commits;
never push or merge; no NUL bytes in source; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
