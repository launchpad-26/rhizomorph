You are a worker agent building The Observatory (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #84 (84. Chat at a click: the lane drawer + transcript tail (ruling 17))

## Direction

Click a lane → right-side DRAWER; the fleet stays visible. The read-only
constitution stands absolutely: the Observatory never sends keys.

**Web** (`packages/web/src/drawer/**`, new):
- Opens from the keystone's selection context (strip chip, table row,
  scene node all select). Esc closes (context clears).
- **Vitals header:** the lane's fleet-object vitals — state glyph + word,
  evidence string, output, $, age, branch, fence (gap-honest cells, same
  rules as the table).
- **ACTIVITY view (default reading):** tool calls, files touched, commits
  — folded from the lane's events, newest first, quiet lines, mono data.
  This is the default because a transcript is for reading *after* the
  activity view says something is worth reading (ruling 17's ordering).
- **Full transcript below, expandable, live-tailing** from the server
  endpoint; renders text, auto-follows at the tail, stops following on
  scroll-up (standard tail UX).
- **ATTACH button:** copies the exact attach command for YOUR terminal —
  `tmux attach -t <session> \; select-window -t <window>` when the lane's
  tmux identity is known from events, else the workmux equivalent; shows
  what it copied. It never executes anything.

**Server** (`packages/server/src/api/transcript.ts`, new): 
`GET /api/transcript/:lane?offset=N` — tails the lane's session JSONL via
the existing sessionlog machinery (the data already flows; reuse
`log/`/collector context, do not re-implement discovery). Returns text
chunks + next offset; honest 404-with-reason when the lane has no known
session log. Bounded reads (no whole-file slurps); no watch processes.

## Fence (may touch ONLY)

- `packages/web/src/drawer/**` (new)
- `packages/server/src/api/transcript.ts` (new), `packages/server/src/api/transcript.test.ts` (new)
- `packages/server/src/api/index.ts` (the one registry line)

## Blocked by

#75, #76 (api registry file is sequential), #78 (selection UX exists).
**Model:** opus. **Wave:** 3.

## Definition of done

- Tests: drawer opens/closes from selection; vitals from fixture; activity
  fold (three kinds); transcript endpoint offset paging + honest absence;
  ATTACH copies the right command per available identity and never
  executes.
- Read-only proven: no server route accepts POST/keys; grep-level
  assertion in tests that the drawer sends only GETs.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
