# What needs fixing

Consolidated from six independent reviews of `1bed433`. Every item below was re-verified
against the tree — line references are checked, not quoted. Ordered by what to do first.

Detail and reasoning live in the per-strategy folders; this file is the work list.

**Findings here are now tracked as issues** — see the table at the end. Two items have
already landed. Line references were correct at `1bed433`; the PRD rename (`d4b7539`)
moved `docs/prdN.md` to `docs/prds/[done/]prd-nn-name.md`, and the per-strategy reports
still cite the old paths because they are dated artefacts, not live pointers.

---

## 0. CI had been red for 17 consecutive pushes — FIXED (`f01a41b`)

*Resolved. Kept for the record, because the shape of this failure is the most
instructive thing the review found.*

**While it was red, nothing else on this list was enforceable.**

Every run on `main` failed one job — `build-test-boot (macos-latest, current)` — at the
`Test` step. Because `Test` failed, the steps after it never executed on that leg:
**Typecheck, Lint, Packaging guard, and Boot smoke were not running at all.**

```
runs  1–17 : failure
runs 18–25 : success
```

Root cause is a single line. `lab/namespace-law.test.ts:655` asserts
`worktree.startsWith(realDataRoot)`, where `realDataRoot` holds the raw `/var/folders/…`
spelling and `git worktree list` returns canonical `/private/var/folders/…`. Git *did*
canonicalize; all three arms landed correctly. On Linux `os.tmpdir()` isn't a symlink, so
the assertion passes vacuously — macOS is the only leg carrying signal.

The tell is `:659`, whose comment reads "same canonicalization as above" while correctly
wrapping both sides in `realpathSync.native` — which `:655` does not do. Four commits have
attacked this bug class; this site was missed each time.

**Fixed in `f01a41b`** by canonicalizing `realDataRoot` at line 655 — and *only* the
expected side. Resolving git's side too would have let a git that stopped canonicalizing
register the arm under `data-link/…`, follow the symlink back, and pass anyway: the
assertion would have survived while silently ceasing to test anything. Verified by
mutation — simulating a non-canonicalizing git still fails it.

macOS-current has been green since. That leg now runs Typecheck, Lint, Packaging guard
and Boot smoke for the first time in 17 pushes; while `Test` was failing, every step after
it was skipped, so four gates were silently not executing.

**The lesson worth keeping:** a green bar is not evidence a gate ran. Check
`gh run list --branch main` before trusting one.

---

## 1. Unauthenticated command execution

Two independent defects that chain. Both need fixing; either alone leaves a hole.

**No auth on the launch route.** `requireCapabilityToken` appears exactly once across
`packages/server/src/api/` — on `/api/label` at `label.ts:38`. `api/security.ts` calls that
"the first" such route; the rest never landed. `POST /api/lab/launch` forks a worktree and
dispatches a live agent. The app-wide guard deliberately permits requests with no `Origin`
header, so plain `curl` passes. `/api/rotate` has the same gap at lower impact.

**Shell interpolation of `model`.** `api/lab.ts` validates an arm's `model` as a string and
nothing else. It flows through `runCli(['lab','fork',…,'--model',model])` to
`lab/fork.ts:120`:

```ts
argv.push('-a', `bash scripts/lane-agent.sh ${treatment.model}`)
```

`workmux add -a` takes that as a shell command line for a tmux pane. Every hop inside
rhizomorph uses argv arrays — the injection lands one hop downstream, in workmux.

**Severity: serious but not remote.** The Host/Origin guard does block the browser path.
The exposure is another local process — a compromised dependency, another tool — not a web
page.

**Fix:** add `preHandler: requireCapabilityToken(ctx.capabilityToken ?? '')` to
`/api/lab/launch` and `/api/rotate`; validate `model` against `^[A-Za-z0-9._:-]+$` or pass
it via env instead of interpolating into a shell string.

## 2. GET requests bypass the Host check

`mutation-guard.ts:136` — `if (!MUTATING_METHODS.has(request.method)) return`, where the
set is POST/PUT/PATCH/DELETE. Every GET, including `/api/stream` SSE and
`/api/transcript/:lane`, gets no Host validation.

The comment at `:35` defends this by arguing CORS blocks a cross-origin GET from reading
the response. That fails in the exact DNS-rebinding scenario the same file describes for
POST: once `evil.example` rebinds to 127.0.0.1 the browser treats it as same-origin, CORS
never applies, and the page reads transcripts and a continuously streaming EventSource.

**Fix:** apply the loopback Host check to all methods. The file's own comment calls this a
one-line change.

---

## 3. Crashes and hangs

**One hung subprocess freezes everything, permanently.** `timeoutMs` is declared at
`core/src/collector.ts:15` and plumbed into `execFile` at `server/exec.ts:16` — those are
its only two non-test occurrences. **No caller sets it.** Combined with
`poll-loop.ts:121-128` returning the in-flight promise, one wedged `git` or `tmux` stalls
every collector for the process lifetime. `stop()` awaits `inFlightTick`, so graceful
shutdown hangs too. Trigger: a credential prompt on a private remote, or `git status`
blocking on an `.git/index.lock` held by a concurrent rebase.

**The error path can kill the server.** `poll-loop.ts:114-123` awaits
`recorder.record(...)` inside the catch block, unguarded. Disk fills → append rejects →
`runTick` rejects → `setInterval(() => void tick())` makes it an unhandled rejection →
Node 22 kills the process. The error-reporting path is the crash.

**A failed rotation seals the recorder forever.** `session-recorder.ts:96-108` takes the
seal *before* awaiting append/fsync. If that write throws, `sealed` is never released:
every later `record()` awaits forever, the in-flight tick never settles, and
`pollLoop.stop()` hangs. Server stays up, silently brain-dead.

---

## 4. Silent wrong data

The dashboard's job is telling the truth about worktrees. These all fail that quietly —
no error, no event, just wrong.

**A deleted worktree renders as healthy.** `git-collector.ts:260-267` — when a worktree is
removed outside rhizomorph, `git worktree list` still reports it (git only checks path
existence on `prune`), `git status` fails with ENOENT, and the catch carries forward the
last-known dirty set with no event emitted. The comment reasons correctly about the
*transient* case (mid-removal) and the same branch swallows the permanent one.

**Filenames with spaces are corrupted.** `git status --porcelain` quotes **any** path with
a space or non-ASCII byte:

```
 M "hello world.txt"
?? "caf\303\251.txt"
```

`parse-status.ts` strips three characters and takes the rest, so `DirtyFile.path` ends up
containing literal quotes and octal escapes. These paths feed the collision matrix — the
headline feature. Note `git worktree list --porcelain` quotes *neither*, so
`parse-worktrees.ts` is fine; the quoting rule is per-command.

**Fix:** `-z` output with NUL splitting, or unquote-on-parse. Add a fixture with a space in
the filename.

**Workmux rows never join on slashed branches.** `workmux/collector.ts:96-99` keys
`listByHandle` by `row.branch` but looks up by `row.handle`. It works only because workmux
currently names worktrees after branches verbatim; a branch like `feat/foo` sanitizes to a
different handle and `branch`/`worktreePath` stay null in every `agent.status`.

**Dotted paths resolve to nothing.** `sessionlog/worktree-slug.ts:10` replaces only `/` and
`_`; Claude Code also maps `.` → `-`. Any worktree path with a dot (`~/work/v2.0/wt`)
resolves to a nonexistent project dir, which is treated as "no session yet" — zero
transcripts, zero errors, forever.

**A tab in a pane path kills the tmux collector.** `tmux/list-panes.ts:33-38` splits on
`\t` and throws unless the field count is exactly 7. Tabs are legal in POSIX paths. The
throw aborts the poll and spams `collector.error` every 2s for as long as that pane exists.

**An unparseable git log line kills the git collector.** `parse-log.ts:83` throws on a
malformed `--raw` line, aborting the poll mid-`diffBranches`. The snapshot never updates,
so every tick re-attempts the same range and re-throws.

**Detached HEAD on the main worktree poisons everything.** `mainBranch` becomes null, so
every branch's `aheadOfMain`/`behindMain` degrades to null and the judge collector no-ops
— silently, in exactly the setups spike work creates.

**Transient failures are permanent.** Both the git and tmux collectors latch
`disabled: true` on their first failure with no retry, ever. `tmux kill-server` — or the
last pane closing — disables the tmux collector for the process lifetime even after a fresh
session starts. Worse, `cli/run.ts:125-133` appends `createSessionlogCollector` *outside*
`loadCollectors`, so it never gets the `withResilience` wrapper that exists precisely to
fix this.

**Truncated session logs are never re-read.** `sessionlog/tail.ts:22-26` returns the stale
offset when `size <= offset`, so a truncated or rotated file silently drops new lines
forever. No inode/mtime check anywhere.

**Workmux failures make agents vanish.** `workmux/collector.ts:88-90` — a non-ENOENT
failure yields an empty parse, so all agents disappear from the snapshot with no event,
then re-emit as "changed" on recovery. Flapping, invisible.

---

## 5. Resource growth

**`SessionRecorder.buffer` is unbounded** (`session-recorder.ts:36,115,129`) — every event
of the session, reset only by rotation. `eventsSoFar()` has **9 non-test call sites** and
returns a full `[...buffer]` copy; two of them (`api/meta.ts:107`, `cli/run.ts:184`) fold
the whole thing through `reduceAll`. An `/api/meta` request is O(n) against an unbounded n.

**SSE live path ignores backpressure.** `stream.ts:129-132` — only the backlog flush
respects `drain`; the live path discards `writeEvent`'s signal, so a slow client grows the
socket buffer without bound, and `queued` accumulates while a long backlog flushes.

**Dangling drain promise.** If a socket is destroyed while `onceDrained` awaits a `drain`
that will never fire, the promise hangs forever. Harmless, but real.

**One syscall cycle per event.** `session-log-writer.ts:82` uses a bare `appendFile` for
every event — a full open/write/close. Appends are correctly serialised so ordering is
safe; the cost is I/O churn competing with the polling loop. A held handle removes it.

**Judge sweeps are quadratic.** `judge/collector.ts:196-231` spawns one `git merge-tree`
per lane *pair*: 15 lanes is 105 subprocesses plus 15 symbol diffs per minute.

**OTel body limit misdiagnoses.** `api/otel.ts` never raises Fastify's 1MB `bodyLimit`, so
an oversized export surfaces as "malformed OTLP request body" (400) — a misdiagnosis that
makes a legitimate exporter retry forever. The refusal-throttle `Map` also grows unbounded
across distinct bogus `instance` ids.

---

## 6. Testing

**The canvas is never exercised.** 65 `getContext()` "not implemented" warnings — jsdom has
no Canvas 2D or `Path2D`. The scene tests assert computed values so they pass, but for a
product whose identity is a canvas visualisation language, the layer that draws pixels has
zero coverage. 11,522 lines of scene tests obscure this rather than reveal it.

**Coverage is unmeasured.** No provider, report, or threshold anywhere — not in
`vitest.config.ts`, the workspace configs, or CI. 60,275 lines of tests (53.7% of the repo)
and no way to say what they cover.

**No end-to-end path.** Nothing tests collector → reduce → SSE → web. The CI boot smoke
only hits `/api/meta` and `/`. For a tool whose core risk is mis-parsing real `git`/`tmux`
output, the fixture layer is load-bearing and it is the weakest.

**Fixture gaps with live bugs behind them:** quoted git paths (§4), tabs in tmux pane paths
(§4), detached HEAD on the *main* worktree (§4). Detached HEAD is covered for *secondary*
worktrees only. The OTel fixtures deliberately include malformed payloads — a good habit
that hasn't reached git/tmux/workmux.

**The namespace law can't see its own bypass.** `walkSourceFiles(SERVER_SRC, [LAB_DIR])` at
`:152` excludes `LAB_DIR` from the walk, so `api/lab.ts:361`'s dynamic
`import('../cli/index.js')` is invisible — and it closes a real `lab→cli→lab` runtime cycle
the law's "sole importer" story denies. Biome's `noRestrictedImports` is *not* a drop-in
replacement: it can't express "only this file may import X" nor detect cycles. Keep the law
tests, stop describing them as airtight, document the exclusion.

**~15–20% of `marks.test.ts` assertions restate constants**, e.g. line 2340 confirming a
function is wired to the right palette constant. `renderEverything` and `frameBudget` are
performance probes, not correctness tests.

---

## 7. Architecture

**`lab` is a second product with no structural wall.** Mutation, dispatch, and speculative
merge share one process and one route table with a read-only observer. Containment rests on
a grep-based test and a runtime assert *inside the same process* — and §6 shows the grep is
already bypassed. Either give it a real boundary (separate process or package tier, with
different capabilities and routes) or move it out. Every fix above patches a boundary that
doesn't exist.

**Replay is incomplete.** Three side doors the event log never sees: `/api/lanes` reading
`.swarm/lanes.json` fresh per request, `/api/transcript/:lane` reading the agent's own
JSONL, and the OTel collector's attribution path. Replay returns `available: false`
honestly for these, so the code isn't lying — the overclaim is in `architecture.md`'s "live
and replay are the same reducer," true of the fold but not of the dashboard. Documentation
fix.

**`buildFleet` is in the wrong package.** `web/src/fleet/buildFleet.ts` holds the
frozen/waiting diagnosis and ladder — the judgment the instrument exists to deliver — while
`core` holds only facts. `api/lab.ts` can't reach it and re-folds instead. Any future CLI
or daemon duplicates it.

**Event-ID factories are per-subsystem** though IDs are documented as session-unique.

---

## 8. Cleanup

- **`core/src/events/upcast.ts`** — identity function that "does nothing today," with law
  tests pinning that it stays one. One era exists. Delete until era-2 (~150 lines with
  tests).
- **`formatDuration` duplicated 7×** across web and server; `formatBytes` and `formatTokens`
  twice each (~120 lines).
- **`core/src/selectors/spend.ts:178-462`** — four selectors hand-rolling the same
  accumulate-and-sort pattern (~150–200 lines).
- **`scene/` is 21% of the repo** (23,513 lines, half of it tests). For this product that
  engine *is* the identity — but name it and freeze its scope.
- **`server/static.ts:33`** — `requested.startsWith(root)` with no separator guard; compare
  against `root + path.sep`.
- **`api/otel.ts`** — the OTLP `instance` gate is published on unauthenticated
  `GET /api/meta`, so it's misconfiguration detection, not integrity protection. Don't
  describe it as the latter.
- **911 `prdN ruling M` cross-references** in comments — inline the ruling's content, cite
  the PRD second.
- **`eval` in `rhizomorph env` consumption** — remove it or implement complete target-shell
  quoting.

---

## 9. Documentation corrections

- **SECURITY.md** — "the laboratory is reachable only from your own command line, never from
  the server or the UI" is false (§1).
- **README** — advertises 3,158 tests; the suite has 3,412.
- **roadmap.md** — says prd14's wave plan hasn't landed; `/lab` ships.
- **architecture.md** — "live and replay are the same reducer" overclaims (§7).
- **README's 347-line Dashboard section** — palette rules, ribbon math, keyboard reference.
  Move to `docs/dashboard.md`; keep the Trust section, which earns its length.

---

*Sources: [fable/](./fable/), [sol-xhigh/](./sol-xhigh/), [kimi-k3/](./kimi-k3/),
[gemini-3.1-pro/](./gemini-3.1-pro/), [glm-5.2/](./glm-5.2/),
[deepseek-v4-pro/](./deepseek-v4-pro/). No product code was changed by any review.*

---

## Where these findings now live

| § | Finding | Issue |
|---|---|---|
| 0 | CI red 17 pushes / namespace-law canonicalization | **fixed** `f01a41b` |
| 1 | Unauthenticated lab launch + `model` shell injection | [#234](../../issues/234) |
| 2 | GET bypasses the Host check | [#235](../../issues/235) |
| 3 | No subprocess timeout; poll loop freezes | [#236](../../issues/236) |
| 3 | Error path kills the process; recorder seal hangs | [#239](../../issues/239) |
| 4 | `git status` C-quoted paths | [#237](../../issues/237) |
| 4 | Deleted worktree renders as healthy | [#241](../../issues/241) |
| 4 | Parser throws kill collectors (tmux tabs, git log) | [#242](../../issues/242) |
| 4 | Identity gaps: workmux join, slug dots, detached main | [#243](../../issues/243) |
| 4 | Permanent self-disable; sessionlog unwrapped | [#240](../../issues/240) |
| 5 | Unbounded buffers, SSE backpressure, OTel map | [#213](../../issues/213) |
| 6 | Coverage unmeasured; canvas never exercised | [#244](../../issues/244) |
| 6 | Fixture pruning and classification | [#218](../../issues/218) |
| 6 | Namespace-law duplication | [#233](../../issues/233) |
| 7 | Lab has no structural boundary | [#245](../../issues/245) |
| 7 | `buildFleet` in the wrong package | [#246](../../issues/246) |
| 8 | Dead and duplicated code | [#247](../../issues/247) |
| 9 | False claims in SECURITY.md / README / architecture.md | [#238](../../issues/238) |

Closed as resolved or superseded: #228 (fixed by `f01a41b`), #176 (folded into #213).
