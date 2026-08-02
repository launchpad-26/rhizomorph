You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #6 (6. Server: SSE + sessions API + JSONL log + CLI)

**Fence (may touch ONLY):** `packages/server/src/{server,api,cli,log}/**` + `packages/server/src/index.ts` + server package bin config
**Blocked by:** #2. **Model:** sonnet. **Wave:** 2

Server + CLI per architecture:
- Session log writer: append JSONL events to `~/.local/share/rhizomorph/<repo-slug>/session-<ts>.jsonl` (slug from repo path basename + short hash); reader for history.
- Poll loop: every 2s run all registered collectors (registry accepts `Collector` instances — collectors are wired in `index.ts` by importing from `../collectors/*`, but DO NOT modify collector directories; if a collector doesn't exist yet, guard the import behind existence so the server runs with whatever is merged).
- Fastify: `GET /api/stream` (SSE: session-so-far then live-tail), `GET /api/sessions`, `GET /api/sessions/:id/events`, `GET /api/meta`; serve `packages/web/dist` statically when present.
- CLI entry `rhizomorph [path]`: boots collectors+server on the target repo (default cwd), prints URL. Port 4321 default, `--port` flag.
- Emit `session.started` on boot; collector exceptions → `collector.error` events, loop survives.

**DoD:** integration test for log write/read + SSE happy path (inject fake events, no real collectors needed); green root test+typecheck; fence respected; summary at end.


RULES (non-negotiable):
- Stay inside the FENCE above. Files outside it belong to other agents
  working in parallel right now; touching them causes merge conflicts.
- Small conventional commits as you go. Commit your work — an uncommitted
  worktree is invisible to the conductor.
- Never switch branches, never push, never merge, never edit git history
  outside your own branch.
- Import from @rhizomorph/core rather than redefining types locally.
- Definition of done: from the repo root, 'npm test' and
  'npm run typecheck' both green. Then STOP and write a short summary as
  your final message. Do not pick up another issue.
- If blocked on something environmental for more than ~10 minutes, write
  BLOCKED plus the exact command and error, then stop.
