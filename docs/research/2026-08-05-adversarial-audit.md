# Rhizomorph — adversarial audit

Independent read-only audit against the product's own governing law (README Trust,
`docs/architecture.md`, `docs/prd9–13.md`, `docs/telemetry.md`, `docs/record-format.md`).
Grades: **[Ran]** = I executed something read-only that demonstrates it; **[Read]** =
evidenced by quoted code; **[Hypothesis]** = needs a measurement I could not run on the
live box. Every performance claim names the measurement that would confirm or kill it.

Repo read via UNC + read-only `wsl … grep/find`. No repo writes, no git mutations, no
server/tmux interaction, no test/build runs. A worker and a dev server are live on that box.

---

## Executive summary — top 5 by impact × confidence

1. **P1 — The Ledger re-folds the entire event log on every event, duplicating a fold
   the shell already maintains.** `packages/web/src/panels/ledger/index.tsx:43` is
   `useMemo(() => reduceAll(state.events), [state.events])`. `state.events` gets a fresh
   array identity on every single event (`streamState.ts:67` `events: [...state.events, event]`),
   so the memo recomputes every event, re-reducing the **whole** log from zero — while
   `state.session` is already exactly that fold, kept incrementally. This directly
   contradicts `streamState.ts`'s own doc comment ("Keeping the fold here rather than
   re-reducing per panel…"). On the measured 55,049-event session **[Ran]** that is ≥55k
   `reduce()` calls on the main thread per incoming event; during the #166 reconnect
   replay (server re-streams the whole session, one `setState` per event) it becomes
   O(N²) refolds — a quadratic meltdown on exactly the path #166 is trying to make
   responsive. Fix is one line (`state.session`), fence is one file.

2. **P1 — `StreamState.events` grows unbounded and is the array every hot consumer
   re-walks.** `streamState.ts:40` accumulates every event forever with no cap
   (contrast `news`/256 and `errors`/200 which *are* capped). At the stated ~46k
   events/day over multi-day sessions this is the dominant browser-resident structure,
   and its unbounded growth is what makes finding #1 (and the drawer/feed siblings)
   scale badly. A census of consumers **[Ran]** shows who actually needs raw events vs.
   who only needs the fold.

3. **P2 — The core reducer's telemetry fold is O(n)-per-event, so a full fold is O(n²).**
   `reduce.ts` scans the growing `telemetry.usage` array per `llm.usage`
   (`dedupedUsage` `findIndex`, `foldSessionCoverage` `.some`/`.filter`), and runs
   `placeCosts`/`placeLanes` (a `.map` over the full `costs`/`lanes` arrays) on **every**
   telemetry event. The real session holds 10,371 `llm.usage` + 1,546 `llm.cost` **[Ran]**.
   This is paid on boot recovery (`reduceAll(recorder.eventsSoFar())`, `cli/index.ts:228`)
   and re-paid in full by finding #1 every event.

4. **P2 — The scene rebuilds a filled ribbon for every finished strand, every frame,
   forever.** prd10 ruling 13 makes completed strands persist (never removed);
   `marks/index.ts:54` iterates *all* threads and `marks/thread.ts:89` routes each
   retired one through `persistentMarks`, which builds ribbon geometry with no cache
   (only the heart caches). The perf test pins 30 lanes + 2 cuts at 6.4 ms / 38% of
   budget; a field of 200 landed strands is unmeasured and scales linearly in per-frame
   ribbon builds. Named measurement below.

5. **P2 — The judge collector runs O(lanes²) speculative `git merge-tree` subprocesses
   every 60 s regardless of whether anything moved.** `collectors/judge/collector.ts`
   does a full pairwise sweep (`speculativeMergeTree` + per-lane `extractLaneSymbols`)
   on every cadence tick; the dedup only suppresses *emitting a finding*, not *spawning
   the process*. On a 30-lane fleet that is 435 `merge-tree` spawns + 30 `git diff`
   spawns per minute. On the live box this competes with the very agents being watched.

Everything I checked for command injection and the read-only/write posture held up
(see **Areas cleared**). The record format's integrity chain is sound for its stated
threat model. The sharpest findings are all in the *re-derivation* class the fold
trilogy (#160/#162/#166) was already fighting — #162's lesson was not applied to the
ledger, the drawer, or the feed.

---

## Findings, ranked

### P1 — Ledger re-folds the whole log every event; `state.session` already holds it

**Evidence** — `packages/web/src/panels/ledger/index.tsx:43`

```ts
const session = useMemo(() => reduceAll(state.events), [state.events])
const rows = useMemo(() => selectSpendByBranch(session), [session])
```

`state.events` identity churns every event (`packages/web/src/app/streamState.ts:64-73`):

```ts
export function foldStreamEvent(state: StreamState, event: RhizomorphEvent): StreamState {
  return {
    events: [...state.events, event],        // fresh identity every event
    session: reduce(state.session, event),   // the fold is ALREADY maintained here
    ...
```

The same file's doc comment states the law this violates (`streamState.ts:9-13`):
"Keeping the fold here rather than re-reducing per panel is also what lets four surfaces
read one derived fleet object." `reduceAll(state.events)` is bit-identical to
`state.session` by construction (both are `reduce` left-folded over the same events), so
the ledger throws away the incremental fold and rebuilds it from event zero.

**Census of the good path vs. this one** [Ran]: `FleetContext`, `LanePage`, `StatusBar`,
`drawer`, `Banner`, `feed`, `FocusPanel` all read `state.session`. The ledger is the
lone panel that calls `reduceAll(state.events)`.

**Falsifiable claim.** Replacing line 43 with `const session = state.session` produces
byte-identical `selectSpendByBranch` output on every fixture and every replay, and drops
the ledger's per-event cost from O(N) reduce-calls to zero. **[Read]** for the identity;
the constant factor is **[Hypothesis]** pending a microbench.

**How to measure.** In a browser profile (which I could not run), mount the ledger, drive
`/api/stream` on the 55k-event session, and record scripting time per SSE message; or in a
Vitest bench, `performance.now()` around `reduceAll(events)` at N=55049. The event count is
**[Ran]**: `wc -l` on `~/.local/share/rhizomorph/worktrees-challenge-71202028/session-1785739192605.jsonl`
= 55,049; type census below.

**Blast radius.** One file, one line — `panels/ledger/index.tsx`. No wire change, no core
change, no fence conflict. The `connected` guard on line 70 (`state.events.length > 0`)
can stay as-is or move to `state.session.eventCount > 0`.

---

### P1 — `StreamState.events` is unbounded; siblings re-walk it per event

**Evidence** — `packages/web/src/app/streamState.ts:39-50` (no cap on `events`), vs. the
things that *are* capped: `news` (`MAX_NEWS = 256`, line 37) and `state.errors`
(`MAX_ERRORS = 200`, `packages/core/src/state.ts:515`, applied `reduce.ts:154`).

**Event census on a real multi-lane session** [Ran] (55,049 events):

```
27204 pane.activity     10371 llm.usage      7282 trace.span
 4595 tool.activity      2077 agent.activeTime 1546 llm.cost
  681 worktree.dirty      551 commit.landed    340 branch.updated
   94 pane.discovered      92 agent.status      86 pane.closed …
```

Every one of these is retained forever in `StreamState.events`, and separately again in
`state.session.telemetry.*`, `state.session.traces.spans`, `state.session.commits`, etc.
(all unbounded appends — `reduce.ts:449,587,637,872`). `pane.activity` alone is ~49% of
volume and each carries a `preview` string (p50 91 chars, max 191 [Ran]).

**Who actually needs raw `.events`** [Ran] (`grep` census, non-test):
- `ledger/index.tsx` — only to `reduceAll` it → **needs `state.session`, not events** (finding P1).
- `drawer/index.tsx:78,81` — `foldActivity(state.events, lane)` and `attachPlan(state.events, lane)`,
  memoized on `state.events` → re-walks the full log per event while a drawer is open.
- `panels/feed/index.tsx:50` — `buildFeedEntries(state.events, …)` re-walks per event
  (bounded output via `FEED_LIMIT`/`COMMIT_POOL`, but the *scan* is full-length).
- `panels/fleet/index.tsx:102` — `attachPlan(state.events, lane)` in a keydown handler.
- `lane-page/LanePage.tsx:87` — `foldActivity(state.events, lane)`.
- `scene/index.tsx:104` — reads only `takeNews(state, cursor)`, the bounded news tail. **Correct.**

**Falsifiable claim.** Nothing that reads `.events` needs the *whole* history except the
activity/attach/feed folds, and each of those consumes a bounded projection — so a
windowed `events` (last K, or a ring buffer) would change no visible output for the fold
consumers, while capping resident memory. The ledger needs none of it. **[Read]**.

**How to measure.** Heap snapshot of the tab after an hour of live streaming: compare
`StreamState.events` retained size against `state.session`. Or count: 46k events/day ×
~1 object + preview strings ≈ tens of MB/day, growing without bound over multi-day runs.

**Blast radius.** Windowing `events` touches `streamState.ts` and every `.events`
consumer above — a wider fan-out than P1's one-liner, so it's a design decision (which
consumers can accept a window) not a mechanical fix. The zero-risk first step is P1 alone
(ledger → `state.session`), which removes the heaviest re-walker without touching the array.

---

### P2 — Reducer telemetry fold is O(n) per event → O(n²) per session

**Evidence** — `packages/core/src/reduce.ts`:

- `dedupedUsage` (`:471`) `usage.findIndex(...)` over the full usage array per `llm.usage`.
- `foldSessionCoverage` (`:506`) `usage.some(...)` and `usage.filter(...)` per `llm.usage`.
- `withTelemetry` (`:689`) runs on **every** telemetry event and calls `placeCosts`
  (`:748`, `costs.map`) and `placeLanes` (`:773`, loop over all lanes). The
  "returns unchanged when nothing moved" guard helps only when no session place is newly
  learned; a fresh `sessionId`/branch on a datapoint re-maps the whole `costs` array.

With 10,371 usage + 1,546 cost + 4,595 tool + 2,077 activeTime = ~18.6k telemetry events
[Ran], a from-scratch `reduceAll` is quadratic in the telemetry arrays.

**Where it's paid.** (a) Boot recovery: `cli/index.ts:228` `reduceAll(recorder.eventsSoFar())`
on resume of a 55k-event session. (b) Every ledger refold (finding P1) pays it again.
(c) Replay keyframe build (`replayFold.ts:131 buildSessionIndex`) folds the whole session
once — acceptable there since it's once per load and keyframed, but it inherits the same
per-event cost.

**Falsifiable claim.** `reduceAll` wall-time grows super-linearly in event count; a session
2× longer costs >2× to fold. **[Read]** for the algorithmic shape; **[Hypothesis]** for
the crossover point where it's felt.

**How to measure.** Vitest bench: `reduceAll(events)` at N = 5k, 15k, 30k, 55k from the
real log; plot ms vs N — a straight line kills the claim, a curve confirms it. (I could
not run it: no test execution on the live box.)

**Blast radius.** Fixing this means indexing `usage` by `requestId` and `costs`/`lanes`
by `sessionId` inside `TelemetryState` — a `packages/core` change touching `reduce.ts`,
`state.ts`, and every spend selector that reads those arrays. Wide fence. Lower-risk
partial mitigation: land P1 first so the quadratic is paid only at boot, not per event.

---

### P2 — Scene rebuilds every finished strand's ribbon every frame, unbounded in landings

**Evidence** — prd10 rulings 13–16 ("The network PERSISTS. Completed strands are never
removed"). `packages/web/src/scene/marks/index.ts:54` `for (const thread of depth) marks.push(...threadMarks(...))`
over *all* threads; `packages/web/src/scene/marks/thread.ts:89`
`if (thread.retire !== null) return persistentMarks(frame, thread, thread.retire, resting)`.
`persistentMarks` (`thread.ts:311`) builds ribbon marks each call with no memoization —
only `heart.ts` caches (`heart.ts:130-160`). `layoutScene` (`geometry.ts:773`) builds one
`ThreadGeometry` per `fleet.lanes` entry, retired included, every frame.

The screenshot set documents "a rim of scars from this project's own real, 43-worktree
build history" (README), and the fold trilogy context notes #161 made finished strands
persist — so the field only grows across a multi-day session.

**Falsifiable claim.** Per-frame scene cost is O(total strands ever dispatched), not
O(living lanes); a 200-landed field costs ~200 ribbon builds/frame on top of the living
ones, and the 38%-of-budget headroom the perf test measured at 30 lanes is consumed
linearly. **[Read]**; the 200-lane frame time is **[Hypothesis]** — the perf test only
covers 30 lanes + 2 cuts.

**How to measure.** Extend `scene/perf.test.ts` with a `finishedSpec` of 100–200 retired
lanes and record layout+marks+paint ms the same interleaved way #157 did; or profile the
live scene after a long session. The HIDE FINISHED control (prd10 ruling 16) mitigates
*paint* but `persistentMarks` still runs unless `cut.hidden` short-circuits (`thread.ts:320`)
— confirm the hidden path also skips `layoutScene`'s thread build, or the geometry cost
persists even while hidden.

**Blast radius.** `scene/**` is a single wide fence (prd10 landed it as one lane), so a
per-strand geometry cache (finished strands never change shape — ideal cache key: lane
handle + camera scale) is contained but non-trivial. It's the kind of cache `heart.ts`
already models.

---

### P2 — Judge collector spawns O(lanes²) git subprocesses every 60 s unconditionally

**Evidence** — `packages/server/src/collectors/judge/collector.ts:105-165`: nested loop
over all lane pairs, each running `speculativeMergeTree` (`:134`) and every lane running
`extractLaneSymbols` (`:85`, a `git diff` per lane, `judge/symbols.ts:95`). The `reported`
snapshot (`:35`) dedups *emitting a `judge.finding`* but is checked *after* the subprocess
runs (`:119`, `:143`) — the merge-tree and diff spawn every cadence regardless of whether
any head moved. Cadence default 60 s (`:18`), and `merge-tree --write-tree` writes loose
objects into `.git/objects` (documented, inert — `mergetree.ts:11-22`).

**Falsifiable claim.** On L lanes the judge issues L·(L−1)/2 `git merge-tree` + L `git diff`
child processes per minute even in a completely idle fleet. At L=30 that's 435 + 30 = 465
spawns/min; at L=43 (the documented build-day fleet) ~933/min. **[Read]** from the loop
structure. **[Ran]** confirms the 60 s cadence constant and that head movement is not a gate.

**How to measure.** `strace -f -e trace=execve` on the server for one cadence window, or
count `git merge-tree` invocations in a 60 s window with the judge enabled on a multi-lane
repo. I did not run it (no server interaction).

**Blast radius.** `collectors/judge/**` + `judge/**`. Gating the sweep on a per-lane head
digest (skip pairs where neither branch's head moved since last run) is contained to the
collector; the `reported` map already keys on `@<head>`, so the head is in hand.

---

### P3 — Per-poll git/tmux subprocess fan-out is O(worktrees + branches + panes) every 2 s

**Evidence** — every 2 s poll (`--poll-interval` min 250 ms):
- **git** (`git-collector.ts`): `worktree list` (1) + `for-each-ref` (1) + `rev-list`
  per non-main branch (`:191`) + `status --porcelain` per worktree (`:224`) + `log` per
  branch whose head moved (`:206`). On 40 branches/worktrees that's ~80+ `git` spawns/poll.
- **tmux** (`collectors/tmux/collector.ts:73`): one `capture-pane` per pane per poll,
  plus `list-panes` (1) and a `rev-parse --show-toplevel` on each new path (cached,
  `:68`). The real session discovered ~40 panes across worktrees + an `obs` session [Ran].

**Falsifiable claim.** Steady-state subprocess spawn rate is roughly (branches + worktrees
+ panes) per poll interval — dozens per 2 s on a busy fleet, on the same box the agents
run on. **[Read]** from the collector loops; pane/branch counts **[Ran]** from the log
(94 `pane.discovered`, 41 `worktree.discovered`, 340 `branch.updated` over the session).

**How to measure.** `execve` count per poll window. Not run (no server interaction).

**Blast radius.** Collectors are independently fenced; batching (`git status` across
worktrees is unavoidable, but `capture-pane` could hash fewer panes, or skip panes whose
`list-panes` activity marker is unchanged) is per-collector. Lower priority — it works at
today's scale, it's a scaling ceiling, not a bug.

---

### P3 — Transcript path is built from log-derived `sessionId`/`worktreePath` with no traversal guard

**Evidence** — `packages/server/src/api/transcript.ts:314-324`:

```ts
const fileName = `${attribution.sessionId}${JSONL_SUFFIX}`
return [
  path.join(claudeProjectsRoot, worktreePathToProjectSlug(attribution.worktreePath), fileName),
  path.join(attribution.worktreePath, fileName),
]
```

`attribution.sessionId` comes from `findLaneAttribution` (`:187`), which reads
`payload.sessionId` off recorded events with only a `typeof === 'string'` check; the core
schema (`events/telemetry.ts:113`) validates it as `nonEmptyString` with no format
constraint. A `sessionId` containing `../` (or an absolute `worktreePath`) would make
`path.join` escape `claudeProjectsRoot` and read any `*.jsonl` on disk. The `:lane` route
param itself is safe (used only to match events, never to build a path), so this is *not*
reachable from an HTTP client directly — it requires influencing the content of a session
log the collector tails.

**Falsifiable claim.** For the current threat model ("point it at your own repo, your own
`~/.claude/projects`") this is self-owned data and low-severity; but the tool is about to
go public and may be pointed at logs from a less-trusted origin (an imported record, a
shared machine), where a crafted `sessionId` is an arbitrary-`.jsonl`-file read. **[Read]**;
no exploit run.

**How to measure.** Unit test: feed `readTranscript` an event whose `sessionId` is
`../../../../etc/hostname` (or any `*.jsonl` outside the root) and assert it refuses rather
than reads. Today there is no such guard.

**Blast radius.** `api/transcript.ts` only — a `path.basename(sessionId)` (or a UUID-shape
assertion) before the join, plus a "resolved path stays under claudeProjectsRoot" check.
Self-contained.

---

### P3 — OTel trace fixtures ship real-looking account/org identifiers into a soon-public repo

**Evidence** [Ran] — `packages/server/src/collectors/otel/fixtures/claude-code-2.1.220-traces-*.json`
carry, on every span:

```
organization.id  = (redacted — see the fixture files)
user.account_uuid= (redacted — see the fixture files)
user.account_id  = (redacted)
user.id          = (redacted)
```

`user.email` was scrubbed to `lachlan@example.com` (good), but the account/org UUIDs and
the `user.id` hash were not — these are the exact fields prd9 ruling 5 / the record's law 4
call out as identity-relevant. The `metrics-token-and-cost.json` fixture scrubbed the email
too but I did not re-verify its account fields.

**Falsifiable claim.** These UUIDs are captured from a real `claude` probe run
(`research/2026-08-03-trace-era-captures.md`) and are the tester's genuine Anthropic
account/org identifiers, now tracked in git history and about to be public. **[Read]** —
they look like live IDs, not `example`-style placeholders; whether they are *this* account's
real IDs is **[Hypothesis]** (I can't confirm the account, only that they're
non-placeholder-shaped and unscrubbed while the email beside them *was* scrubbed).

**How to verify/fix.** Confirm with the operator whether these are real; if so, scrub to
zero-UUIDs across all six fixtures (the parser allowlist ignores them anyway —
`parse-metrics.ts` reads only `session.id`/`model`/`query_source`/`type`, per the prd9
ruling — so scrubbing changes no test outcome). Note it lives in git history too; a public
release from a fresh tree is cleaner than a scrub commit.

**Blast radius.** Fixtures + their `.test.ts` expectations (none assert on these fields).
Contained. Also flag the tracked `docs/roadmap.md:98` / `docs/prd3.md:175`
`@kelliherl/rhizomorph` scope name — intentional (matches the public GitHub handle), not a leak.

---

## Adversarial passes on the product's own guarantees

- **Read-only constitution (write path from observer code).** I tried to construct one.
  All collector/judge/server exec goes through `execFile` argv form (`server/exec.ts:9`),
  never a shell — no `shell:true`, no `execSync`, no `exec(\`…\`)` anywhere in
  `packages/server/src` non-test [Ran]. The judge's `merge-tree --write-tree` writes inert
  loose objects only (`mergetree.ts`), never a ref/index/worktree; the lab is import-fenced
  from all observer code and its writes are confined to `refs/rhizomorph/` + its own data
  dir, asserted live by `lab/namespace-law.test.ts` (which walks the filesystem before/after
  a real `lab fork`). The drawer's `readonly.test.ts` greps its own source for any mutating
  verb/exec channel. **I could not find a reachable observer write path.** The one honest
  seam: these are *source-text greps* — a write added via an aliased import or a
  dynamically-built verb string would pass them; but the live filesystem-diff test in the
  lab law and the argv-only `exec` make an *accidental* one very hard.

- **Honest-gap voices (siblings of #147).** The gap-voice discipline is unusually
  thorough — `conductorGap`/`missingLaneGap` (`transcript.ts:270-306`), the burn strip's
  `conductor not instrumented`, unplaced-dollars-stay-visible (`telemetry.md`). I did not
  find a surface showing a confident number that is actually stale. The closest structural
  risk is the ledger (P1): while it recomputes correctly, if `state.session` and
  `reduceAll(state.events)` ever *could* diverge (they can't today) the ledger would be the
  one panel disagreeing with the fleet object — which is precisely the "four surfaces
  disagree by one" failure the architecture exists to prevent. Fixing P1 also closes that
  latent seam.

- **Replay identity (live vs replay fold divergence).** Live folds via
  `foldStreamEvent`/`foldStreamEvents`; replay via `foldFrom`/`buildSessionIndex`. Both call
  the same core `reduce`. `replayFold.ts:175` documents and the `foldUpTo` oracle test pins
  the identity (`foldFrom` result === `foldUpTo`). The news/history split is the one thing
  that differs, and it's correctly forced to "all history" in replay
  (`StreamContext.tsx:82` `REPLAY_CONNECTED_AT = MAX_SAFE_INTEGER`). **No divergence found**;
  this is the best-defended part of the codebase. The one caveat: the ledger builds its
  session via `reduceAll(state.events)` in *both* modes, so it happens to stay consistent —
  but only because it ignores the mode-aware `state.session` entirely.

- **Portable record — truncation/reorder detection.** `record/verify.ts` walks the chain
  (each `prevHash`/`hash` recomputed via the self-contained SHA-256 in `hash.ts`), confirms
  closure to `manifest.chainDigest`, then checks `eventCount === body.length` and
  `startTs`/`endTs` against parsed lines. Truncating the tail breaks chain closure;
  truncating and rewriting `eventCount` is caught by the count check; reordering breaks the
  `prevHash` linkage; a middle-line edit breaks that link's `hash`. **The chain does what it
  claims.** Honest limits (all documented in `record-format.md`): `signature` is always
  `null`, so this proves *integrity*, never *authorship* — a whole record can be
  re-manufactured from scratch by anyone (recompute genesis + chain over forged lines) and
  verify clean. That's stated as reserved future work, not a hidden gap. A `merge` output is
  deliberately unchained. All consistent with the spec.

---

## What this audit could NOT see (blind spots, stated plainly)

- **No test runs, no typecheck, no build.** Every "this would be identical output" claim is
  by-construction reasoning, not a green run. I could not execute the Vitest benches that
  would turn the O(n²) and per-frame-cost claims from [Read]/[Hypothesis] into [Ran].
- **No browser.** No React profiler, no heap snapshot, no INP/frame-timing. The ledger
  refold cost, the `events` retained-size, and the 200-strand scene frame time are all
  reasoned from code + event counts, not measured in a running tab.
- **No live server / tmux / process interaction.** Subprocess spawn *rates* (judge, git,
  tmux) are read from loop structure and confirmed constants, not counted via `strace`.
- **Could not confirm the fixture UUIDs are a real account** — only that they're unscrubbed
  and non-placeholder-shaped while the email beside them was scrubbed.
- **Static-text law tests** (readonly greps) can't prove the absence of a cleverly-spelled
  write path; I reasoned about their coverage but a determined bypass is out of scope for a
  read-only pass.

---

## Areas cleared (what I checked, how hard)

- **Server binding.** `cli/index.ts:206,482` `app.listen({ host: '127.0.0.1' })` — matches
  the README Trust claim exactly. No `0.0.0.0`, no public bind. [Ran grep]
- **Outbound network / phone-home.** No `fetch`/`http.request`/`net.connect`/`WebSocket`
  in `packages/server/src` or `packages/core/src` non-test [Ran]. The only `fetch` in web is
  same-origin `/api/*` (`useTranscript.ts:182`, `manifest.ts:35`). README's "grep for
  fetch(; there isn't one" holds server-side.
- **Command injection via branch/tmux names.** All exec is argv-form `execFile`
  (`server/exec.ts`); a branch named `$(...)`/backticks/newline is an inert argv token to
  `git for-each-ref`, `rev-list ${main}...${branch}`, `merge-tree`, and `capture-pane -t`.
  No shell interpolation anywhere [Ran]. Newlines in `list-panes` output are handled by the
  tab-delimited `FIELD_COUNT` parser which throws on malformed lines.
- **OTLP receiver identity gate.** `api/otel.ts` refuses any export not carrying this
  server's instance id (all-or-nothing across resource blocks, `resourceSpans` included per
  the #124 fix), throttles refusals, and never records a foreign datapoint. Sound.
- **Privacy allowlist-by-construction.** `parse-metrics.ts` reads a fixed attribute list;
  `user.email` has no field to land in — asserted by test per the architecture decision log.
  The trace payload (`events/trace.ts`) has no attributes map. Verified the claim's shape;
  the fixtures leak (P3) is about the *test data*, not the parser.
- **`news` cap.** `MAX_NEWS = 256`, applied in `foldStreamEvent`/`foldStreamEvents`/
  `replayStreamState` via `.slice(-MAX_NEWS)` [Read] — genuinely bounded. `errors`
  (`MAX_ERRORS = 200`) likewise. The judge's `reported` map is rebuilt fresh each run so it
  can't grow unbounded (`collector.ts:33`). These are the caps that *do* work — contrast the
  uncapped `events`/`telemetry.*`/`traces.spans`/`commits` (findings P1–P3).
- **TODO/FIXME/HACK census.** Zero across `packages/**/*.{ts,tsx}` [Ran]. Dead code: only
  `core/src/placeholder.ts`, `@deprecated` and self-contained — harmless.
- **Sessionlog cross-collector double-count.** The collector dedups `llm.usage` only against
  the *immediately previous* `requestId` (`collector.ts:295`). I swept **197** real session
  logs >100 KB for non-adjacent `requestId` repeats that this would miss — **zero** [Ran].
  The single-slot dedup is sufficient for Claude Code's actual line ordering (a reply's
  repeated usage lines are always contiguous). Not a finding.
- **Boot resume shape.** `recorder.eventsSoFar()` returns a copy; SSE replay
  (`api/stream.ts:27`) writes the buffer then subscribes — correct, but note it re-parses
  nothing (the buffer is already parsed events), so the "re-read/re-parse whole JSONL per
  connect" worry does **not** apply to `/api/stream`. It *does* apply to `/api/sessions`
  (`listSessionListings` full-parses every session file per request) — but that's a
  once-per-mount call, documented as a deliberate correctness-over-cost choice
  (`architecture.md`), and I concur for that call site.
```
