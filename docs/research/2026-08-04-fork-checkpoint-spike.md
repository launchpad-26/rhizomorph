# prd11 spike — the FORK CHECKPOINT format (ruling 6a)

**Date:** 2026-08-04 · **For:** the fork prd (scrub replay to T, re-dispatch a
lane from that state under a different treatment, compare futures). **Method:**
live probes in WSL scratch (`~/fork-probe/`, claude 2.1.220, git; NOT the
product repo) + our collectors' source. Graded `[Ran]` / `[Verified]` /
`[Consensus]` / `[Thin]`.

## Verdict first

**A fork is buildable this week at prototype grade.** Every mechanism was
proven live today: a dirty worktree snapshots in 0.04s without disturbing the
lane; a **truncated** copy of a session JSONL, placed under a new id, resumes
as a fork that knows only the pre-cut past; a recorded-cwd mismatch does not
break resume [all Ran]. **The ONE keystone it needs first: the checkpoint
must be CAPTURED live, not synthesized later.** A past dirty worktree cannot
be reconstructed from any log — "scrub to T and fork" really means "scrub to
the nearest captured checkpoint". The keystone is an additive
`fork.checkpoint` event binding, at capture time: event-log index ↔
session-file byte offset ↔ workspace snapshot sha. Ship that hook (even on a
crude cadence: on commit, on idle, on demand) and the rest is assembly.

## Q1 — workspace snapshot [Ran]

**Verdict: temp-index `write-tree`/`commit-tree` under a namespaced ref.
Reject `git stash create`.**

- **`git stash create` skips untracked files entirely** — probe: untracked
  `notes.txt` absent from the stash tree. Agents create untracked files
  constantly; disqualifying. (`stash push -u` captures them but MUTATES the
  running lane's worktree — worse.) [Ran]
- **The winner**: copy `.git/index` to a tempfile; under
  `GIT_INDEX_FILE=$tmp`: `git add -A` → `write-tree` → `commit-tree $TREE
  -p HEAD` → `update-ref refs/rhizomorph/checkpoints/<id> $SNAP`. Captured
  tracked-modified, tracked-staged AND untracked in one commit; `.gitignore`
  honored (`node_modules/` stayed out — reinstall on restore). Wall:
  **0.037s**. `git status --porcelain` before/after IDENTICAL; the real
  index's bytes changed (stat-cache refresh from `status` itself — semantic
  state did not). [Ran]
- **Restore**: `git worktree add --detach <path> <snap>` → 0.037s; the dirty
  edit, staged edit and untracked file all present, status clean. Dirty
  state arrives *committed* in the fork — honest (a synthetic commit, marked
  by its ref namespace and message). [Ran]
- **Known exclusions, by design**: ignored-but-needed files (`node_modules`,
  build caches, any gitignored `.env`). Restore re-materializes via install +
  `rhizomorph env`, not via snapshot.
- **Law tension, named**: snapshot objects + ref land in the watched repo's
  shared `.git`. The fork engine is inherently a writer (refs, worktrees,
  dispatch) — it cannot live under the read-only law. It needs an
  operator-consented subsystem: writes confined to `refs/rhizomorph/*`,
  loose objects, new worktree dirs; never an existing ref. A ruling to
  request, not a detail to bury.

## Q2 — session context capture [Ran]

**Verdict: forking conversation state is nearly free. The session JSONL up to
T IS the conversation, and the CLI accepts a truncated copy.**

Probe (scratch, haiku, `-p`): a two-turn session — turn 1 taught codeword
ALPHA-PLUM; turn 2 (via `--resume <sid>`, which appends in place) taught
BETA-FIG. 21 JSONL lines: `user`/`assistant` content lines carrying
`sessionId` + `cwd`, plus chrome (`queue-operation`, `attachment`,
`ai-title`, `last-prompt`, `mode`). All of the following [Ran]:

1. **`--resume <sid> --fork-session`** (documented path): new session id,
   knew BOTH codewords, original untouched. Full-length fork works stock.
2. **Truncated copy, new id, plain `--resume`**: `head -12` (cut after turn
   1) placed as `<uuid>.jsonl` in the same project dir → resumed under the
   placed id, answered **ALPHA-PLUM only** — the cut genuinely erases the
   post-T future. Appends in place (12→22 lines); original untouched; the
   stale internal `sessionId` fields needed no rewrite.
3. **Truncated copy + `--fork-session`**: best of both — new id minted, the
   placed artifact stays pristine at 12 lines, and the CLI **rewrites every
   internal `sessionId`** to the minted id. This is the restore recipe.
4. **cwd mismatch is NOT fatal**: the truncated copy placed under a
   *different* worktree's project-slug dir, resumed from that other cwd
   (recorded `cwd` = wsA, actual = wsB) → worked, knew only ALPHA-PLUM,
   reported the NEW cwd as its working directory.

Caveats: probes were `-p` (print mode); interactive resume under
workmux/tmux is the same log machinery but untested `[Thin]`. Cut point was a
completed turn boundary; cutting mid-tool-call is untested (see Open
questions — safe rule: cut only after a completed assistant turn).

## Q3 — the checkpoint artifact

**Verdict: a small manifest that REFERENCES, never copies — into the git
object db for the workspace and into the session record's hash chain for
lineage.** Sketch (`rhizomorph.fork-checkpoint/1`):

```jsonc
{ "schema": "rhizomorph.fork-checkpoint/1",
  "checkpointId": "<uuid>", "capturedAt": "<iso>", "lane": "2-core",
  "parent": {                      // composes with ruling 3's record
    "actor": "<instance id>",
    "recordEventIndex": 1234,      // T as an index into the event log
    "recordChainHash": "sha256:…"  // chain value AT that index — a prefix
  },                               //   commitment: provable lineage
  "workspace": { "baseSha": "<HEAD at T>", "snapshotSha": "<commit-tree>",
    "ref": "refs/rhizomorph/checkpoints/<id>", "branch": "<lane branch>" },
  "session": { "sessionId": "<parent claude session>",
    "sourcePath": "~/.claude/projects/<slug>/<id>.jsonl",
    "cutLine": 12, "cutByte": 11840, "prefixDigest": "sha256:…" } }
```

- **Compose, don't duplicate**: lineage is `recordChainHash` at
  `recordEventIndex` — any holder of the parent record can verify the fork's
  claimed past is exactly that record's prefix, with no copy carried. The
  RAW session prefix (what `--resume` needs) cannot be rebuilt from the
  record (allowlisted/derived), so the checkpoint references the native file
  on local disk + offset + digest. Local-first is fine: forks don't
  federate; their *lineage proof* does.
- **Treatment lives on dispatch, not checkpoint**: a checkpoint is a frozen
  moment. A `fork.dispatched` event (additive; the reducer survives unknown
  types) carries `{checkpointId, treatment: {model|prompt|ruling}, armIndex,
  n, forkLane, forkSessionId}`.
- **Synthetic-timeline marking**: fork-lane events join the parent at
  `(checkpointId → recordEventIndex)`; the instrument branches the timeline
  at T and marks everything after as a possible future, never history. The
  fork's first transcript moment carries a provenance banner too.

## Q4 — non-determinism posture [Consensus]

No seeds exist for the API; the CLI exposes no temperature. One fork run is
an anecdote. Honest comparison: **n≥3 arms per treatment, report
distributions** (medians + ranges for cost/duration/outcome), name each
arm's first divergence point, never render a single-run "winner". (Our
identical-prefix resumes agreed only because the task was trivially
constrained — not evidence of determinism.) Whether futures *mean* different
things is the semantic-judge spike's problem (ruling 6b), not this format's.

## Q5 — restore mechanics + costs

Recipe (end-to-end, all pieces individually [Ran] except the last):

1. `git worktree add --detach <forkPath> <snapshotSha>` — sub-second.
2. Install hook (`npm ci` etc.) — **dominates**: ~6s this repo (junior
   audit), minutes elsewhere. Then `rhizomorph env` for telemetry.
3. Synthesize session: `head -c <cutByte>` of the parent JSONL →
   `~/.claude/projects/<forkPath-slug>/<uuid>.jsonl` (the FORK worktree's
   slug dir — the existing sessionlog collector then discovers it with zero
   new code `[Verified — collector.test.ts]`).
4. Dispatch: `claude --resume <uuid> --fork-session --model <treatment>` in
   the fork worktree (fork-session = pristine artifact + rewritten sids).
   First haiku turn resumed in ~12s wall `[Ran]`.

What breaks it: **absolute parent paths inside the transcript**. Resume
survives them [Ran], but the resumed agent's history quotes files under the
PARENT worktree — it may read or edit the parent's files. Prototype
mitigation: string-rewrite parent worktree prefix → fork path in the
synthesized copy (already a synthetic artifact; record `pathRewrite:
{from,to}`; digest is of the pre-rewrite prefix). This also fixes lane
attribution — the collector infers lane from the log's own cwd/gitBranch; a
stale prefix would smear fork lines onto the parent lane. Ports/servers: the
transcript may assert "the dev server is running" — in the fork it is not; a
restore preamble ("you are a fork at <path>; re-verify running processes")
is cheap honesty.

## What to avoid

1. `git stash create` for capture (loses untracked) and `stash push -u`
   (mutates the live lane).
2. Synthesizing checkpoints retroactively from the record — the dirty tree
   at a past T is gone; only live capture works.
3. Copying the session log into the checkpoint or the record — reference +
   digest; the record stays the single portable artifact.
4. Cutting the JSONL anywhere but a completed-turn line boundary until
   mid-tool-call cuts are probed.
5. Rendering fork futures on the parent's timeline unmarked; comparing arms
   at n=1.
6. Fork-engine writes outside `refs/rhizomorph/*` / new worktree dirs — and
   shipping any of it without an operator ruling amending the read-only law.

## Open questions

1. Interactive (workmux pane) resume of a synthesized session — same log
   machinery as `-p`, but unprobed. First dogfood task of the fork lane.
2. Cutting mid-tool-call: does the CLI repair a dangling `tool_use`, or
   reject? Determines whether T snaps to turn boundaries.
3. Checkpoint cadence: per landed commit? per idle? operator-triggered from
   the scrubber? (~0.04s + loose objects — cheap enough to be generous; a
   pruning policy for `refs/rhizomorph/*` is needed.)
4. Does `--fork-session` also rewrite recorded `cwd` fields (we verified
   `sessionId` only)? If yes, the pathRewrite step may partially collapse
   into it.
5. Sidechain files (`memory/` dir observed beside session logs) — does a
   fork need them copied? Unprobed.

## Sources / probe artifacts

- Live probes 2026-08-04, WSL, claude 2.1.220 (`--fork-session`,
  `--session-id`, `--resume` all in `--help`): scripts + workspaces kept at
  `~/fork-probe/` (`00b-env`…`04-verify.sh`, scratch repo `gitlab/`,
  sessions under `~/.claude/projects/-home-operator-fork-probe-ws{A,B}`).
  Haiku turns ~$0.016 each.
- Our source: `packages/server/src/collectors/sessionlog/*` (slug mapping,
  lane-from-cwd inference); `docs/prd11.md` rulings 3, 6a, 7;
  `research/2026-08-03-trace-era-captures.md` (CLI pin, env mechanism,
  install timing).
