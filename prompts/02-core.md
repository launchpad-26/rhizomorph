You are a worker agent building The Observatory. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #2 (2. Core: event schema, reducer, selectors (KEYSTONE))

**Fence (may touch ONLY):** `packages/core/**`
**Blocked by:** #1. **Model:** OPUS. **Wave:** 1

The keystone. Implement per `docs/architecture.md`:
- Event envelope + all v0 event types as zod schemas; inferred TS types exported. `{ id, ts, source, type, payload }`; sources git|tmux|workmux|system; types exactly as the architecture doc lists.
- `Collector` interface: `poll(prevSnapshot) → { nextSnapshot, events[] }` (generic over snapshot type) + exec-wrapper type so server and collectors share the contract.
- Session reducer: `reduce(state, event) → state` building the full SessionState (worktrees, branches, commits, panes, agent statuses, errors).
- Selectors (pure, tested densely): worktree index; collision map (file → branches touching it, from `worktree.dirty` + `commit.landed` vs main); liveness (pane last-activity given a now-ts; flatline threshold as param); ahead-of-main counts.
- JSONL helpers: event → line, line → validated event (bad line → error value, never throw).
- Test fixture factory (make-event helpers) exported for other packages' tests.

Land the schema file(s) as your FIRST commit (within ~30 min) so review can start early.

**DoD:** dense vitest coverage on reducer + every selector + JSONL round-trip; `npm test`/`npm run typecheck` green at root; conventional commits; no files outside fence; finish with a summary.


RULES (non-negotiable):
- Stay inside the FENCE above. Files outside it belong to other agents
  working in parallel right now; touching them causes merge conflicts.
- Small conventional commits as you go. Commit your work — an uncommitted
  worktree is invisible to the conductor.
- Never switch branches, never push, never merge, never edit git history
  outside your own branch.
- Import from @observatory/core rather than redefining types locally.
- Definition of done: from the repo root, 'npm test' and
  'npm run typecheck' both green. Then STOP and write a short summary as
  your final message. Do not pick up another issue.
- If blocked on something environmental for more than ~10 minutes, write
  BLOCKED plus the exact command and error, then stop.
