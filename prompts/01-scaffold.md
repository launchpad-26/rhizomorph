You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #1 Scaffold: workspaces + vite/fastify/vitest wiring

Scaffold the npm-workspaces monorepo per docs/architecture.md:
- Root package.json with workspaces `packages/*`; scripts: `test` (vitest run,
  all packages), `typecheck` (tsc --noEmit, all packages), plus `dev:web` and
  `dev:server`.
- packages/core: TS strict, zod dep, placeholder src/index.ts + one passing
  vitest test.
- packages/server: fastify dep, placeholder entry + one passing test.
- packages/web: Vite + React + TS + Tailwind 4 + react-three-fiber and
  @react-three/drei deps installed (not used yet), placeholder App + one
  passing test (jsdom).
- .gitignore: node_modules, dist, coverage.
- Record the exact pinned versions in docs/architecture.md under Platform
  (table, appended — do not rewrite the doc).

FENCE — you may create/modify ONLY: root configs (package.json,
tsconfig.base.json, .gitignore, vitest workspace config), packages/core/,
packages/server/, packages/web/ skeletons, and the version-table append in
docs/architecture.md §Platform.

RULES:
- Small conventional commits as you go.
- Never switch branches, never push, never merge, never touch files outside
  the fence.
- Definition of done: `npm install` clean from root, `npm test` green,
  `npm run typecheck` green. Then STOP and write a short summary of what you
  built as your final message. Do not start other issues.
- If blocked by an environment problem for more than ~10 minutes, write
  BLOCKED plus details, and stop.
