# prd20 spike — retargeting the watched repo in place (ruling 5, open question 1)

**Date:** 2026-08-10 · **Issue:** #265 · **For:** prd-20 ruling 5 — *"switching the
watched repo rotates the session and retargets the collectors; it never spawns a
second instance."* **Method:** the server's own source, plus live probes in a
scratch directory outside this repo (`<scratchpad>/retarget-probe/`, Node
22.23.1, darwin 25.5.0 — never the product). Graded `[Ran]` / `[Verified]` /
`[Read]`, the fork-checkpoint spike's discipline
(`docs/research/2026-08-04-fork-checkpoint-spike.md`).

**This note ships no code.** Its fence is itself.

## Verdict first

**Rotate-and-reinit in process. Reject supervised respawn.**

The single fact that decided it: **no collector holds a `repoPath`.** The premise
this spike was commissioned on — *"collectors are constructed at boot with their
repoPath"* (#265, and prd-20's sequencing note calling this the heaviest server
change) — is **false against the source**. All five collectors take `repoPath`
from the per-tick `CollectorContext`, rebuilt on every poll
(`packages/server/src/server/poll-loop.ts:95`,
`packages/core/src/collector.ts:317-331`); `loadCollectors` passes no repo
anything (`packages/server/src/server/collector-loader.ts:51-66`); and the one
collector with a real constructor closure, `createSessionlogCollector`, closes
over `claudeProjectsRoot`, `extraSessionDirs`, `backfill`, `processProbe` and
`turnGrammar` — **not one of which is repo-derived**
(`packages/server/src/collectors/sessionlog/collector.ts:137-144`). `[Verified]`

Exactly **one** object in the process closes over `repoPath`: the poll loop
itself (`poll-loop.ts:39`, captured at construction, read at `:95`). Everything
else that needs the repo reads it off `ServerContext` **at request time**, not at
registration — `/api/meta` (`api/meta.ts:209`), `/api/lanes` (`api/lanes.ts:110`),
`/api/rotate` (`api/rotate.ts:34-36`), `/api/lab/launch` (`api/lab.ts:540`),
`/api/sessions` and `/api/transcript` (both via `ctx.sessionDir`). `[Verified]`

So the reinit is not surgery. It is one `createPollLoop` call, one
`createFileSnapshotStore`, three re-pointed context fields, and one memoized
route probe. Respawn's whole selling point — *"a fresh process is the only way to
be sure nothing stale survives"* — is buying a guarantee against a hazard whose
actual surface is four lines wide.

**And the cost respawn is usually accepted for is not a cost either option
avoids.** The telemetry instance id **is the session id** (`api/otel.ts:22`,
read live per request at `:54` and `:83`). prd-20 ruling 5 says a retarget
rotates the session. Therefore the instance id changes under **both** options,
identically. There is no version of this where lanes keep exporting.

## Q1 — what each collector actually holds that is repo-shaped `[Verified]`

`repoPath` is never held. What *is* held is each collector's **snapshot**, which
the poll loop owns in a plain `Map` built once at construction
(`poll-loop.ts:43`) and persists per session
(`cli/run.ts:149` → `snapshotDirFor(sessionDir, sessionId)`).

| Collector | Constructor closure | Snapshot contents | Repo-shaped? | Retarget |
|---|---|---|---|---|
| `git` (`git-collector.ts:57-63`) | none — a module singleton | `mainBranch`, `worktrees{}`, `branches{}`, `dirty{}` | **Entirely** | **Rebuild** (drop to `initialSnapshot()`) |
| `sessionlog` (`collector.ts:137-152`) | `claudeProjectsRoot`, `extraSessionDirs`, `backfill`, `processProbe`, `turnGrammar` — all repo-independent | `files{}` (byte offsets per tailed JSONL), `knownWorktrees{}`, `lanes{}`, `erroredExtraSessionDirs{}` | **Entirely** — and `knownWorktrees` is *sticky by design*, remembered past a worktree's removal (#165, `collector.ts:216-228`) | **Rebuild.** Re-pointing keeps tailing the old repo's worktrees **forever** — the stickiness that is correct within a repo is a leak across one |
| `judge` (`collector.ts:82-91`) | `cadenceMs` only | `lastRunAt`, `reported{}` (`<kind>:<laneA>@<head>:<laneB>@<head>`), `laneSymbols{}` | **Entirely** — keyed by branch and head of the old repo | **Rebuild** |
| `tmux` (`collector.ts:63-69`) | none — a module singleton | `panes{}`, `worktreeByPath{}` | **No** — `list-panes -a` is machine-wide, no repo filter (`:76`); `worktreeByPath` is a pure path→toplevel cache, still true | **Rebuild anyway** — see below |
| `workmux` (`createWorkmuxCollector()`) | none | `agents{}` (handle → status/branch/worktreePath) | **No** — `workmux status`/`list` are run with no `cwd` (`:73`, `:88`), so machine-wide | **Rebuild anyway** — see below |

**Why the two machine-shaped collectors must reset too, and this is the
non-obvious half.** A collector only emits a discovery event on a snapshot
*miss* — `worktree.discovered` at `git-collector.ts:116`, `pane.discovered` at
`tmux/collector.ts:119-131`, `agent.status` at `workmux/collector.ts:121`. A session
log that opens with a warm snapshot therefore contains **no discovery events at
all** for anything that already existed, and prd16 ruling 3's law is that a
recording is self-contained. So the reset is demanded by the **session**
boundary, not by the **repo** boundary — which means a retarget must clear every
snapshot regardless of whether that collector cares which repo it is.

> **This is already broken for plain rotation, today.** `POST /api/rotate` holds
> no reference to the poll loop at all (`api/rotate.ts`, whole file — it touches
> only the recorder), and the snapshot `Map` is built once at construction
> (`poll-loop.ts:43`). So a session opened by `rhizomorph rotate` has **no
> `worktree.discovered` for worktrees that existed one second earlier**, and
> `recorder/rotate.test.ts` asserts nothing about it. `[Verified]` See "Bugs
> spotted, not fixed" — flagged, not touched.

## Q2 — the session boundary: does a retarget end a session? `[Verified]`

Yes, and it must, because **the session directory is derived from the repo
path**: `sessionDirFor(repoPath)` = `<dataRoot>/<repoSlug(repoPath)>`, and
`repoSlug` is basename + sha1 of the absolute path (`log/paths.ts:14-28`). A
retargeted run's log physically cannot continue in the same file.

**It is a rotation in mechanism and a new event in meaning.** The mechanism is
already exactly right and already split for this: `rotateSession` is two
separately exported halves, `closeCurrentSession` (`recorder/rotate.ts:88`) and
`openNextSession` (`:125`), split — in the module's own words — so *"what a crash
between them leaves behind"* can be staged by a test. A retarget is those two
halves called with **two different session dirs**: close against the old repo's,
open against the new repo's. `rotateSession` itself takes a single `sessionDir`
(`:31-50`) and so cannot be reused as-is. `[Verified]`

The meaning is not the same, and reusing `reason: 'rotated'` would be a lie:

- `SESSION_CLOSE_REASONS` is `['rotated']` today, with a comment explicitly
  anticipating additive widening (`packages/core/src/events/system.ts:21-22`).
  **Widen it with `'retargeted'` — operator-decided 2026-08-10**, on this note.
  This is settled, not proposed: issue 1 below is groomed from a ruling, and a
  retarget must never close a log as `'rotated'`. The reason a reader needs the
  distinction is the next bullet — the successor is not where a `'rotated'`
  reader would look for it.
- A reader of a closed log currently infers the successor is the next file *in
  the same directory*. After a retarget the successor is in a **different
  directory under a different slug**, and nothing anywhere links the two. Neither
  `session.closed` nor `session.started` carries a predecessor/successor pointer.
  `[Verified]` The retarget must add one, or the record loses the seam.
- `decideSessionBoot` treats any `session.closed` as final regardless of reason
  (`log/session-log.ts`, `isClosedLog` at `:365`, ranked above staleness) — which
  is the correct behaviour for a retarget too, so no change is needed there.
  `[Verified]`

**The recording in flight is safe, in this order and only this order.**
`closeCurrentSession` captures every lane's transcript *before* it appends
`session.closed`, so a capture that throws leaves the session un-closed and
resumable rather than closed and hollow (`recorder/rotate.ts:88-118`). Capture is
driven off the closing session's own events, not off `repoPath`, so closing
against the old repo is correct with no extra argument. `[Verified]`

## Q3 — the instance gate `[Verified]`

The gate is three mechanisms, and only two key off the repo:

1. **The port** — machine-keyed, not repo-keyed. A busy port is `EADDRINUSE` and
   exit 1 (`cli/run.ts:168-175`); `doctor` softens this to `ok` when `/api/meta`
   answers with a rhizomorph shape, naming which repo it serves
   (`cli/doctor.ts:312-320`). **In-process retarget never touches it. Respawn
   must give it up and take it back** — see Q4's measurement.
2. **The session lock** — repo-keyed, because it lives in
   `sessionDirFor(repoPath)`. `decideSessionBoot` returns `writer-alive` when a
   lock's heartbeat is fresh *and* `isPidAlive` agrees (`log/session-lock.ts:103-106`).
   **This is where "one repo, one rhizomorph" is actually enforced**, and it is
   the check a retarget must run against the *new* repo's dir before it lets go
   of the old one.
3. **The OTLP instance id** — `recorder.sessionId`, all-or-nothing per body,
   403 with a self-explaining message (`api/otel.ts:83`, `:219`).

## Q4 — the telemetry cost, named precisely `[Verified]` + `[Ran]`

Every lane launched before the retarget carries
`OTEL_RESOURCE_ATTRIBUTES=...,instance=<old session id>`, attached at launch and
never retroactively (`docs/telemetry.md` `[Read]`). After a retarget:

- Every OTLP POST from every such lane is refused **whole** — 403, never
  partial: a body mixing our id with a foreign one is refused entire, by design,
  because splitting it would be the silent merge prd2 forbids
  (`api/otel.ts:167-176`). `[Verified]`
- The log noise is **roughly one event per window, not one per lane**. The
  throttle keys by *declared* instance — `key = instance ?? ''`
  (`api/otel.ts:242`, in `createRefusalThrottle` at `:237-257`) — and every
  pre-retarget lane declares the **same** old session id, so an eight-lane swarm
  is one key: at most one recorded `telemetry.refused` per 60 s
  (`REFUSAL_THROTTLE_MS`, `:154`), with the suppressed count riding along on the
  next one (`:250`, `:254`). A standing fault, and a quiet one. `[Verified]`
  *(Corrected 2026-08-11 after review — the first draft charged this per lane.)*
- **What is lost is dollars, traces and active-time, not the lane.** OTLP is the
  only source of `llm.cost` and `trace.span`; git and the sessionlog transcript
  organ keep working untouched, so a retargeted instrument drops from rung L1 to
  L0 for every pre-existing lane until relaunch (`core/collector.ts:250-256`,
  `api/meta.ts:93-140`). `[Verified]`
- The remedy is already in the refusal text — `rhizomorph env <lane> --port <n>`
  (`api/otel.ts:219`) — but it only arrives *after* the first refusal. The
  retarget's own answer should say it first.

**This cost is identical under both options.** The instance id is the session id
(`api/otel.ts:22`); prd-20 ruling 5 rotates the session; therefore it changes
either way. Anyone arguing for respawn on instance-hygiene grounds is arguing for
a difference that does not exist.

## Q5 — in-flight state: what a connected browser sees `[Verified]`

**Under rotate-and-reinit, the socket survives.** `SessionRecorder` swaps the
session *inside* the object rather than being replaced — `sessionId` and
`filePath` are getters, subscribers are held on an `EventEmitter` that
`openSession` never touches (`recorder/session-recorder.ts:20-32`, `:59-66`,
`:111-120`). A connected dashboard receives `session.closed` then
`session.started` **on the stream it is already holding**. The StatusBar already
re-reads `/api/meta` whenever the live session id changes
(`web/src/app/StatusBar.tsx:135`), so `repoPath`/`repoName` refresh for free.

**Under respawn, the socket dies.** Probed: with one client holding an open
SSE-shaped response, `process.execve` severed it — the client received stage A's
frame and then EOF `[Ran]`. A browser `EventSource` reconnects on its own with
`Last-Event-ID`, which the new process's buffer has never held, so
`resumeBacklog` falls back to a **full replay** of the new session
(`api/stream.ts:47-49`) — honest, and the intended behaviour.

**Both options are dishonest in the same place, and neither fixes it for free.**
The web fold is never reset: `useEventStream`'s effect re-runs only when `url`
changes (`hooks/useEventStream.ts:92`, deps at `:160`), and `sessionStarted`
replaces `state.session` **only** — every worktree, branch, lane, commit and
spend fact from the old repo stays folded (`core/reduce.ts:149-156`). So a
retargeted browser shows **the new repo's name over the old repo's fleet**, under
either option, until a client-side reset lands. This is the honesty hole, and it
is a web issue, not a server one.

**And there is no compiler to catch it — I claimed there was, and I was wrong.**
The first draft said `bootExplanation`'s exhaustive switch would fail the build
on a widened union. It will not, and the reason matters for issue 1:

- **`SessionCloseReason` has no consumer anywhere.** It is declared and used only
  by its own zod enum (`core/events/system.ts:21-22`, `:36`); a repo-wide grep
  finds nothing else in `core`, `server` or `web`. Widening
  `SESSION_CLOSE_REASONS` forces **nothing at all**. `[Verified]`
- **The web never sees the server's `SessionBootReason` either.** `StatusBar.tsx`
  declares its *own* `KNOWN_BOOT_REASONS` and shadows the type name locally
  (`:47-48`); `parseBootFacts` validates with `.includes()` and returns `null`
  for anything it doesn't know (`:70-80`), deliberately — the comment at `:44`
  says an unknown reason must read as *unavailable* rather than be half-trusted.
  So `bootExplanation`'s switch (`:162-190`) is exhaustive over a **local** union
  that no upstream widening reaches. `[Verified]`
- **And it cannot simply import the server's type**: `SessionBootReason` lives in
  `packages/server/src/log/session-log.ts:203-211`, and `packages/web/src` imports
  from `@rhizomorph/server` nowhere — the layering ADR-0003 protects. `[Verified]`

So a `retargeted` boot would silently render the provenance bar as **unavailable**,
which is the opposite of the property issue 1 was being groomed to rely on.
*(Found by review, 2026-08-11; verified here.)*

> **This drift already exists, today.** The server's `SessionBootReason` includes
> `'writer-alive'` (`session-log.ts:203-211`); `KNOWN_BOOT_REASONS` does not
> (`StatusBar.tsx:47`). A boot that refused to resume because another process
> holds the session already shows the bar as unavailable rather than saying so.
> `[Verified]` Flagged, not fixed — see the bug list.

## Q6 — where the failure lands if the new repo is invalid

This is the requirement that most constrains the design, and it is the one place
the two options genuinely differ in kind rather than degree.

**Rotate-and-reinit can validate before it lets go, and refuse with the old
target still running.** Three checks, all cheap, all available in-process before
`closeCurrentSession` is called: the path exists; `git rev-parse
--is-inside-work-tree` succeeds (the exact check `doctor` already uses,
`cli/doctor.ts:261-279` `[Verified]`); and `decideSessionBoot` against the *new*
repo's session dir does not return `writer-alive` — because another rhizomorph
already watching that repo is precisely the second instance ruling 5 forbids. A
retarget that fails any of the three is a 409 and **nothing has happened**.

**Respawn can validate too — but only in the image it is about to destroy, and
the destruction has no error path.** `execve` never returns on success: the old
image is gone, and Node offers no "come back". On failure it does not return
either — it **aborts**, uncatchably, exit code 134 `[Ran]` (see the failure-modes
section). So the validation is real but the commit is not transactional in either
direction: a check that passes leaves no rollback, and a check that was wrong
leaves no process.

Two failure shapes follow, both `[Verified]` against source:

- **Unlaunchable target** — the `execve` itself fails (bad `execPath`, a
  permissions change between check and use). SIGABRT, no handler, no message.
- **Launchable but not a repo** — the new image starts fine. `run.ts` exits 1
  only on a *listen* failure (`:159-175`); a bad repo produces no exit at all,
  because the git collector merely disables itself (`git-collector.ts:73-81`).
  The result is a **running instrument watching nothing**, reporting healthy.

Rotate-and-reinit has neither shape, because it never gives up the thing it would
need to fall back to.

> **On phrasing, after review.** An earlier draft called "watching nothing" the
> outcome *"the operator has explicitly ranked worst"* and attributed it to #265.
> That attribution was wrong and is withdrawn: prd-20's open questions say only
> *"Retarget semantics — rotate-and-reinit in process vs. supervised respawn.
> Needs its spike; open, not ruled"* (`docs/prds/prd-20-the-concierge.md:109-110`),
> and #265's body ranks nothing `[Verified]`. The sentence came from this lane's
> own dispatch brief (`.workmux/PROMPT-265-retarget-spike.md:53-54`), which is
> **untracked** — `git ls-files .workmux/` is empty `[Ran]` — so it is exactly the
> kind of citation the ADR README's reachability rule exists to prevent. The
> argument above stands on the two source-verified failure shapes and needs no
> appeal to anyone's prior preference.

## The two options, with their honest failure modes

**Rotate-and-reinit in process — its honest failure mode is that correctness is a
checklist, in a process that has already missed items on it.** Nothing enforces
completeness of the reset. The evidence that this is a real risk and not a
rhetorical one is that the *existing* rotation already drops an item (Q1's box:
warm snapshots across a session boundary, untested), and every miss of this kind
is silent — the instrument keeps running and keeps looking right. Mitigation is a
law test, not a promise: assert that after a retarget the new log contains a
`worktree.discovered` for every worktree the new repo has.

**Supervised respawn — its honest failure mode is that it needs a supervisor
this project does not have, and pays for it with an irreversible cut.** There is
none: `packages/server/src/index.ts` installs SIGINT/SIGTERM and nothing more
`[Verified]`. So "supervised" means writing one, and "re-exec" means the
mechanics below. Measured:

- **`process.execve` is experimental and POSIX-only — not version-gated.** It
  landed in Node 22.15.0 and `package.json` requires `>=22.22.2` (`:25-27`), so
  **every supported runtime has it** `[Verified]`. Node 20 is below this repo's
  floor and is not a gate at all. *(The first draft called this "version-gated on
  a runtime the repo pins but the shell does not" — wrong, and corrected after
  review 2026-08-11.)* What it is instead is **experimental**, and on non-POSIX
  hosts the property exists while the call fails with
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` — observed by the reviewer on their
  machine, not reproduced here `[Read]`. That is a worse foundation for the
  heaviest server change in a PRD than a version gate would have been.
- On darwin arm64 / Node 22.23.1 it **works** and replaces the image preserving
  the pid (`typeof process.execve` = `function`; `pid=5872` in both stages,
  re-run 2026-08-11) `[Ran]`.
- **A failed `execve` is not catchable — it aborts the process.** Calling it with
  a bad path raised no JS exception: `try/catch` never ran, nothing after the
  call executed, and the process died with a native stack trace and **exit code
  134 (SIGABRT)** `[Ran]`. So on the one platform where the primitive works, a
  respawn onto a target that turns out to be unlaunchable has **no error handler,
  no rollback, and no way to tell the browser what happened**. (No
  `ExperimentalWarning` surfaced on darwin across three runs, including under
  `--trace-warnings` `[Ran]` — the warning the reviewer saw appears to be
  platform-specific.)
- The listening socket is **not** inherited: stage B had to re-bind, and did so
  in **59 ms, first attempt**, with one client connection held open `[Ran]`.
  Two caveats on that number: it was measured on **macOS only**, and socket
  behaviour is exactly what it is about; and it is a floor — a trivial script's
  whole Node boot — not the product's, which must additionally load Fastify +
  core and complete a first poll before it can answer honestly.
- **Only if a respawn re-execs *without* closing first**, preserving the pid
  breaks the lock's own liveness backstop: the lock left in the old repo's dir
  keeps naming a pid `isPidAlive` reports as running (`log/session-lock.ts:85-94`),
  so for up to `LOCK_STALE_MS` = 20 s (`:23`) a boot against the old repo is told
  a live writer holds a session nobody is writing. **The close-first sequence this
  note recommends does not pay it**: `closeCurrentSession` calls
  `removeSessionLock` (`recorder/rotate.ts:115`) and the heartbeat skips the
  sealed instant so it cannot be recreated (`cli/run.ts:119-121`). `[Verified]`
  *(Condition added after review 2026-08-11 — the first draft charged respawn for
  an ordering nobody proposed.)*

Respawn's real advantage is genuine and should not be waved away: **it makes the
whole class of stale-state bugs structurally impossible.** That is worth a lot on
the heaviest server change in a PRD. It loses on two facts of its own, with no
appeal to anyone's prior preference: Q1 shows the class it protects is four lines
wide, and the primitive it rests on is an experimental, POSIX-only call whose
failure mode is `SIGABRT` — so the retarget that goes wrong takes the instrument
with it instead of refusing, which is the outcome Q6 exists to prevent.

## What to avoid

1. **Reusing `rotateSession` for a retarget.** It takes one `sessionDir` and
   would close and open in the same repo's directory (`recorder/rotate.ts:31-50`).
   Use the two exported halves against two dirs.
2. **Mutating the `ServerContext` you handed to `buildApp`.** `buildApp` spreads
   it into a copy (`server/build-app.ts:69`), so the routes hold a different
   object and your mutation is silently ignored.
3. **Reusing `reason: 'rotated'`** for a boundary whose successor lives in
   another directory.
4. **Resetting only the repo-shaped snapshots.** tmux and workmux are
   machine-shaped and must still reset, or the new recording opens with no
   discovery events (Q1).
5. **Closing the old session before the new target has passed all three
   validations** (Q6).
6. **Claiming the retarget preserved telemetry.** It cannot (Q4). Say so in the
   route's own answer, before the first `telemetry.refused` says it for you.

## What I could not settle, and the experiment that would settle it

**Unsettled: the real cost of a respawn's dark window on a live repo.** 59 ms is a
trivial script's re-bind `[Ran]`; the product's number is boot + Fastify + the
first `pollLoop.tick()` that `run.ts:181` awaits before it prints, on a repo with
real worktrees. I could not measure it: starting the dev server is out of fence
for this lane, and a synthetic stand-in would be measuring my stand-in.

**The experiment.** In a scratch clone outside the repo, with a 6-worktree
fixture: (a) time from retarget request to the first `worktree.discovered`
naming a *new-repo* worktree, in-process versus re-exec, n≥5 each, reported as
medians and ranges — not a single run, for the fork spike's Q4 reason; (b) point
a real Chrome `EventSource` at it across both and record what the fold actually
shows at t+1 s, t+5 s. If (a) shows respawn under ~1 s and (b) shows the browser
recovering identically, respawn's simplicity argument deserves a second hearing —
but it still has to answer Q6, and I do not think it can.

**A second thing I did not verify:** that the warm-snapshot gap in Q1's box is
observable end-to-end today. The source chain is airtight
(`api/rotate.ts` holds no poll loop → `poll-loop.ts:43` builds the Map once →
`git-collector.ts:116` gates on a miss), but no test in this tree stages it. A
regression test against today's `rhizomorph rotate` would convert `[Verified]`
into `[Ran]` and is worth writing regardless of which option ships.

## Implementation issues to groom from this ruling (dependency order — not opened)

1. **`session.closed` learns `'retargeted'`, and the two logs learn about each
   other.** *(The reason itself is operator-decided 2026-08-10 — see Q2; this
   issue implements a ruling, it does not re-open one.)* Widen
   `SESSION_CLOSE_REASONS` additively; add the predecessor/successor pointer so a
   closed log names the slug dir its run continued in.

   **This issue gets no compiler help — plan for that.** An earlier draft
   promised two forcing functions; there are **zero** (Q5). `SessionCloseReason`
   has no consumer at all, and the web validates boot reasons against its own
   local `KNOWN_BOOT_REASONS` list. **The remedy this issue inherits: widen the
   local union in `StatusBar.tsx:47` too, in the same PR, and pin the two lists
   together with a test** — because nothing else will catch the drift. The
   alternative (move the boot-reason union into browser-safe `core` and have both
   sides read it) is *not* chosen here: it would trade away the deliberate
   forward-compat posture at `StatusBar.tsx:44` — an unknown reason must read as
   *unavailable*, never half-trusted — and it is a layering change that deserves
   its own issue rather than riding along on this one. Ship the test instead.
   Core-first, web in the same PR. Blocks everything below.
2. **`retargetSession()` beside `rotateSession()`.** `closeCurrentSession(oldDir)`
   → `openNextSession(newDir)`, reusing the two halves already split for exactly
   this. Extends `recorder/namespace-law.test.ts` to the second dir.
3. **Validate-then-release.** Exists · is a git work tree · no `writer-alive` in
   the new repo's session dir. All three pass before anything closes; any failure
   is a 409 with the old target untouched.
4. **`ServerContext` becomes re-pointable.** `repoPath`/`repoName`/`sessionDir`
   read live by routes; kill `build-app.ts:69`'s silent copy; give
   `registerDoctorRoute`'s memoized probe (`api/doctor.ts:226`) an invalidation
   hook — it is the only route that binds `repoPath` at registration.
5. **The poll loop becomes rebuildable, and boot's `sessionDir` stops being a
   constant.** Fresh `createPollLoop` + `createFileSnapshotStore`; move the lock
   heartbeat and `stop()`'s release off the boot-time `sessionDir`
   (`cli/run.ts:118-123`, `:204`), which after a retarget write the *new*
   session's lock into the *old* repo's directory.
6. **`POST /api/retarget`, token-gated.** Under #234's guard, with prd-20 ruling
   1's law test (explicit human act only; no collector, no poll, reaches it).
   Depends on 2–5.
7. **The client resets its fold at a repo boundary.** Drop accumulated state when
   a `session.started` names a different `repoPath`; today the fold resets only
   on a URL change. Ships with 6 or the dashboard lies. Independent of 2–5.
8. **The retarget says what it cost.** Its answer names the lanes whose telemetry
   is now refused and the `rhizomorph env` re-issue, before the first
   `telemetry.refused` arrives.

## Bugs and gaps spotted while reading — flagged, not fixed

- **a.** `POST /api/rotate` leaves the poll loop's snapshots warm, so a rotated
  session log opens with no `worktree.discovered` / `pane.discovered` /
  `agent.status` for anything already there. The recording is not self-contained
  until the next process restart. Untested. `[Verified]`
- **b.** The snapshot store is bound at boot to `snapshotDirFor(sessionDir,
  bootSessionId)` (`cli/run.ts:149`), so after a rotation, snapshots are written
  into the **closed** session's directory and a later resume of the new session
  never finds them. `[Verified]`
- **c.** The tmux collector runs `list-panes -a` with no repo filter
  (`tmux/collector.ts:76`) and workmux runs with no `cwd` (`:73`, `:88`) — a
  session log for repo A already contains panes and agents belonging to repo B.
  Retarget makes this visible; it does not cause it. `[Verified]`
- **d.** `/api/doctor`'s probe binds `repoPath` at registration and memoizes for
  3 s (`api/doctor.ts:226`, `:151`). `[Verified]`
- **e.** `build-app.ts:69` copies the context, so any "just mutate the context"
  approach fails silently. `[Verified]`
- **f.** The web's `KNOWN_BOOT_REASONS` (`StatusBar.tsx:47`) is already missing
  `'writer-alive'`, which the server has emitted since #187
  (`log/session-log.ts:203-211`). So a boot that refused to resume because
  another process holds the session **already** renders the provenance bar as
  *unavailable* instead of explaining itself — the drift issue 1 must not repeat
  is a drift that already happened. `[Verified]`

## Sources / probe artifacts

- **Live probes, 2026-08-10, re-run and extended 2026-08-11 after review.**
  **darwin 25.5.0 arm64, Node 22.23.1 — one platform only**, which matters
  because the two headline numbers (the 59 ms re-bind; `execve` succeeding at
  all) are both platform-dependent. Scripts kept at
  `<scratchpad>/retarget-probe/` (`01-execve.mjs`, `02-port-handoff.mjs`, with
  `server.out` / `client.out`). Probe 2 required the sandbox off to bind a
  loopback socket; it binds `127.0.0.1:45671` from a standalone script and never
  starts the product. The 2026-08-11 round added: `typeof process.execve`, a
  bad-path `execve` (uncatchable, exit 134), and a `--trace-warnings` run.
  **Not reproduced here:** the reviewer's `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`
  and `ExperimentalWarning`, which are on their platform, not this one — carried
  as `[Read]`, not upgraded to `[Ran]`.
- **Review round, 2026-08-11** (PR #357, KelliherL): four findings, all in the
  citations rather than the conclusion. Three corrections landed above — the
  withdrawn attribution (Q6), the zero-not-two forcing functions (Q5, issue 1),
  the version gate that was really an experimental POSIX-only primitive — plus
  two conditions on costs charged to respawn. The ruling is unchanged; the
  failure-mode evidence for respawn came out stronger, not weaker.
- **Our source:** `packages/server/src/{server,recorder,api,collectors,log,cli}/*`
  and `packages/core/src/{collector,reduce}.ts`,
  `packages/core/src/events/system.ts`, `packages/web/src/hooks/useEventStream.ts`,
  `packages/web/src/app/StatusBar.tsx` — cited inline by file and line.
- **Documents:** `docs/prds/prd-20-the-concierge.md` ruling 5 and open question 1;
  ADR-0005 (the log lives outside the watched repo) and ADR-0008 (localhost-only,
  single origin); `docs/architecture.md` prd16 rulings 2/3/6 and prd17 ruling 3;
  `docs/telemetry.md`; `docs/research/2026-08-04-fork-checkpoint-spike.md` for
  the grading discipline and the n≥3 posture. All `[Read]`.
