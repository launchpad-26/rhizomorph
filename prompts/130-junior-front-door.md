You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (the rulings bind you),
then research/2026-08-03-trace-era-captures.md (evidence for your
issue). Wave A is LANDED on main — import from @rhizomorph/core and
the existing modules, never redefine.

YOUR ISSUE — #130:

## Direction

prd9 wave B — the junior front door (prd9 rulings 1, 2, 8; audit evidence
`research/2026-08-03-trace-era-captures.md` §5). The clone path is already
excellent (~15s to first signal, zero undocumented steps); the front door
points at the wrong entrance and the boot is mute. Fix exactly that.

1. **README leads with the clone block** (ruling 2). The operator ruled
   NO npm publish — the cohort inherits a clonable repo:
   - The quickstart's FIRST command sequence is the clone path (clone →
     `npm install` → `npm run build` → `npm start -- <path-to-repo>`),
     stated for a stranger's machine.
   - The `npx rhizomorph` story moves into a short "When this is published
     to npm" aside — clearly marked not-yet-true, because today it 404s
     (audit-proven). Do not delete it; it is the future, not the present.
   - The Trust section gains the one write it omits: session recordings at
     `~/.local/share/rhizomorph/<repo-slug>/` (reads and listens are
     already itemized; writes must be too).
   - Keep prd8's voice: trust-document first, honest support matrix
     untouched.
2. **The boot says what it found** (audit stumble: single mute line).
   At startup, after collectors start, print one honest line naming the
   watched repo and what discovery saw, e.g.:
   `watching <repo> — N worktrees, M branches · recording to <log path>`
   — real counts from the first poll, the actual session log path, no
   invented values; if a collector is disabled the existing degradation
   lines stay as they are. Update `cli/index.test.ts` assertions
   minimally.

## Fence (may touch ONLY)

- `README.md`
- `packages/server/src/cli/index.ts`
- `packages/server/src/cli/index.test.ts`

## Blocked by

Nothing (wave A landed). **Model:** sonnet. **Wave:** B.

## Definition of done

- A stranger following README top-to-bottom never hits a 404 command; the
  clone path is first; the npx aside is marked future.
- Trust section itemizes the write path.
- Boot line prints real worktree/branch counts and the session log path
  (test with the existing cli boot test patterns).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (the gate audits every touched
path); small conventional commits (committing is REQUIRED — review
happens from your branch); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests must be deterministic
(no waitFor racing async work — stub or await the boundary; a flaky
test blocks the gate); build for a stranger's machine (no personal
paths, 127.0.0.1 not [::1], degrade loudly never silently); if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
