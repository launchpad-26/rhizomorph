You are a worker agent building The Observatory (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #76 (76. Lane geography: serve .swarm/lanes.json as /api/lanes (ruling 19))

## Direction

The prd's one data addition. The conductor's dispatch now writes
`<repo>/.swarm/lanes.json` (contract already live in dispatch tooling):

```json
{ "version": 1, "lanes": [ { "handle": "77-attention-strip",
  "branch": "77-attention-strip", "fence": ["packages/web/src/panels/attention/**"],
  "issue": "77", "model": "sonnet", "dispatchedAt": "2026-07-31T20:30:00Z" } ] }
```

Serve it: `GET /api/lanes` on the existing Fastify app.

- Validate the shape (version, lanes[], each lane: handle + branch +
  fence[] strings; issue/model/dispatchedAt optional). A malformed file is
  a **loud** degradation: serve `{ available: false, reason: "<parse or
  schema error>" }` with the detail, never a silent `[]`.
- Absent file is an honest state: `{ available: false, reason: "no lane
  manifest — dispatch has not written .swarm/lanes.json" }`. The web gap
  voice (ruling 12) consumes exactly this.
- Re-read per request (no caching) — the file changes at every dispatch;
  it is tiny.
- The watched repo root is the server's existing target-repo context — use
  it, do not invent a new flag.
- `doctor` gains a lane-manifest check using the existing three-state
  vocabulary (#73): present-and-valid / absent (info, with the one-line
  fix) / present-but-broken (the error).
- Document the schema + the dispatch contract in `docs/architecture.md`
  (short section: who writes it, who reads it, what absence means).

## Fence (may touch ONLY)

- `packages/server/src/api/lanes.ts` (new), `packages/server/src/api/lanes.test.ts` (new)
- `packages/server/src/api/index.ts` (the one registry line)
- `packages/server/src/cli/doctor.ts`, `packages/server/src/cli/doctor.test.ts`
- `docs/architecture.md`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** 1.

## Definition of done

- Tests: valid manifest served; absent → `available:false` with reason;
  malformed → `available:false` with parse detail; doctor three states.
- No new CLI flags; binds nothing new; stranger-machine clean (no
  hardcoded paths in fixtures — temp dirs only).
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
