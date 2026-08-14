# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Semver policy

What counts as a breaking change here is narrower than "anything visibly
different," because most of what's on screen is deliberately allowed to
evolve without a major bump:

- **Breaking (major):** the CLI's public surface — its subcommands, flags,
  and their meaning (`rhizomorph [path] [options]`, `rhizomorph doctor`,
  `rhizomorph env`) — and the shape of `.swarm/lanes.json`, the one file
  another tool (a dispatcher, a conductor) is expected to write and this
  one is expected to read. Removing a flag, changing a flag's default in a
  way that changes behavior, renaming an existing field in the lanes
  manifest schema, or dropping a documented HTTP API route all count.
- **Not breaking (minor or patch):** the scene's visual grammar — colors,
  motion, layout, what a pathology looks like — the shape of internal
  telemetry events, the on-disk session-log format under
  `~/.local/share/rhizomorph`, and anything under `packages/web` that isn't
  reachable through the two contracts above. These can change release to
  release; nothing external is meant to depend on them holding still.
- Adding a new flag, a new optional field, or a new subcommand is a minor
  bump. Bug fixes that don't change either contract are a patch bump.

## [Unreleased]

Everything below landed on top of 0.1.0 and has not yet been cut into a
tagged release — publishing itself is still gated on an open operator
decision (see the README's ["When this is published to
npm"](README.md#when-this-is-published-to-npm)). Grouped by era, newest
first; full write-ups are in the numbered `docs/prd*.md` files and
[`docs/architecture.md`](docs/architecture.md).

### Added

- **The honest middle gets a voice (prd-22 ruling 2, #304).** A collector that is
  answering but degraded — retrying after consecutive failures, not yet disabled —
  now reads `degraded` in the provenance bar's per-source pill (distinct from a dead
  `disabled` source and from a one-off `errored` blip) and speaks the same
  what/why/`rhizomorph doctor` gap voice a disabled collector already does. It stays
  ambient: unlike `error`, it never escalates to the attention strip, since it may
  self-heal on the very next poll.
- **`export-record --force` (#298).** An explicit `--out` that already
  exists is now refused with an error naming `--force`, which overwrites;
  the flagless default artifact is regenerable and always refreshes.
  `--force` without `--out` warns instead of silently doing nothing, and
  an `--out` naming a directory is named as such rather than advised a
  `--force` that would not help.
- **System agnosticism (prd15).** A transcript-tail state machine derives a
  lane's liveness and attention (`working`/`waiting`/`frozen`/`gone`) from
  the agent CLI's own session transcript alone — no tmux, hooks, or
  cooperation from the agent required. Every collector now declares which
  of six signals it can speak to, folded into a named "enrichment rung"
  (L0 zero-cooperation through L4 tmux/workmux) that `rhizomorph doctor`
  and `GET /api/meta` report per lane.
- **Sessions are a thing you can hold (prd16).** An explicit operator act —
  `rhizomorph rotate`, or the dashboard's "end session · start fresh"
  button — closes the current recording and opens the next one; a
  pid+heartbeat lock stops two instances from racing onto the same session
  log; `--resume-window <ms>` makes the resume boundary configurable and
  self-explaining. Each lane's live transcript is captured, redacted, into
  its session's own recording on close, so a replayed recording still shows
  real conversations on another machine, a year later. A new `/recordings`
  library lists every recording, with rename-in-place and export.
- **The TIDE (prd13).** The replay bar grew a body: a chapter-mark lane
  over a time axis, with portaled hover cards, cursor-anchored zoom, and
  `[`/`]` chapter stepping. (An earlier, richer per-lane density-band
  version was built, given three rounds of affordances, and cut outright
  by the operator once it still read as noise in practice — see
  `docs/prds/done/prd-13-tide.md` ruling 13.)
- **The drawer, tabbed (#163/#164).** ACTIVITY, CONVERSATION, WHY and TRACE
  each get the drawer's full height instead of four independently-capped
  boxes, opening on ACTIVITY by default. The conversation view now caches
  the last-good page it read per lane and never blanks on a transient
  server hiccup (#191).
- **Recordings never rot (prd17).** An event line from a future era this
  build doesn't recognize is counted and voiced rather than silently
  dropped; one real recording per era folds byte-identically in CI against
  a committed snapshot; an `upcast()` chokepoint is reserved for the day a
  real schema migration is needed.
- **The trace era (prd9).** A beta OTLP trace layer (Claude Code's own
  span export) surfaces a request waterfall in the drawer's own TRACE tab,
  with dollar estimates for non-instrumented setups backed by a
  SHA-pinned, vendored Langfuse pricing table.
- **Provenance and the portable record (prd11).** File-level provenance
  (transcript moment → tool call → file touched → landing commit); a
  portable, hash-chain-integrity-checked session record
  (`rhizomorph export-record` / `rhizomorph replay <record>`) — see
  [`docs/record-format.md`](docs/record-format.md).
- **The laboratory (prd12).** A second, explicitly-invoked hand —
  `rhizomorph lab checkpoint|fork|compare` — for forking a lane's live
  workspace and conversation into its own worktree to try something risky,
  under its own write-scope namespace law, entirely separate from the
  read-only observer.

### Security

- **`POST /api/rotate` and `POST /api/lab/launch` now require the capability
  token (#234).** Both were reachable by a plain `curl` from any local
  process — a compromised dependency, another tool, malware running as you.
  The mutation guard deliberately admits a request carrying no `Origin`
  (every non-browser caller), and `requireCapabilityToken` had only ever
  been applied to `/api/label`. Rotation ends the operator's recording;
  the launch route forks a worktree and dispatches a live agent that spends
  real money. Both now carry the same gate `/api/label` has carried since
  the 2026-08-06 audit. All three of their callers were widened in the same
  change rather than a follow-up — the dashboard's rotate button, the lab's
  launch panel, and `rhizomorph rotate` — because gating a route whose
  callers cannot authenticate is exactly how #249 shipped.
- **An arm's `model` is validated against `^[A-Za-z0-9._:-]+$` (#234).** It
  was checked as `typeof === 'string'` and nothing more, then interpolated
  into `` `bash scripts/lane-agent.sh ${model}` `` — a *string* workmux runs
  through a shell in a tmux pane, so a `model` carrying `;`, `$(`, a
  backtick or a space ran a second command as the operator. Chained with
  the ungated route above, that was unauthenticated local code execution,
  which is why the two landed together. Refused now at the HTTP boundary
  and again in `lab/fork.ts`, which covers `rhizomorph lab fork --model` —
  a path no request crosses. Every hop inside rhizomorph already used argv
  arrays; the injection landed one hop downstream, in workmux's own
  execution of that string, which is why an audit of this repo's spawn
  sites cleared it. `lane` is refused a leading `-` for the adjacent
  reason: it travels as an argv positional, where a `-`-prefixed value is
  read as a flag. Deliberately disclosed blast radius: a model id
  containing `/` or `@` — a Bedrock inference-profile ARN, a
  provider-prefixed id — is now refused as well. Every model string this
  repo dispatches passes (`sonnet`, `opus`, `haiku`, `claude-opus-5`,
  `claude-3-5-sonnet-20241022`, and a bedrock-style
  `us.anthropic.claude-3-5-sonnet-20241022-v1:0`).
- **The loopback `Host` check now runs for every request, not just
  mutations (#235).** A DNS-rebound page could previously read
  `/api/transcript/:lane` and the `/api/stream` SSE, because every GET
  returned early past the guard. Deliberately disclosed blast radius: a
  request whose `Host` spells anything outside `127.0.0.1` / `localhost` /
  `::1` / `[::1]` (a numeric `:port` is fine after all but bare `::1`, which
  takes none — bracket it to add one) is now refused with a 400
  on **every** route, where reads used to pass. Concretely that now refuses
  `curl http://0.0.0.0:PORT/...` (dialling `0.0.0.0` reaches a
  `127.0.0.1`-bound socket as a Linux/macOS convenience), Host-less HTTP/1.0
  requests, and the trailing-dot `localhost.`. Address the instrument as
  `127.0.0.1` or `localhost` instead — see
  [troubleshooting](docs/user-guide/troubleshooting.md#refused-host--is-not-loopback).
  `0.0.0.0` was considered for the accepted set and rejected: it is the
  unspecified address, not a loopback name, and the dial-through is not
  portable (the rationale lives on `LOOPBACK_HOSTNAMES` in
  `packages/server/src/server/mutation-guard.ts`).

### Removed

- **`pane.activity` no longer carries `preview` (#292).** The tmux
  collector used to put the last non-empty line of every `capture-pane`
  into the event, which meant a stranger's terminal text was written to the
  session log and exported verbatim into a hash-chained record — an
  artefact that, by construction, cannot be redacted after the fact.
  `contentHash` and `lines` already carried every signal the fleet reads
  (the flatline detector compares hashes; nothing rendered the preview), so
  nothing on screen changes. Recordings made before this remain readable:
  the field is ignored on parse, the line still folds, and an old session
  still exports as a complete, verifying record — the value is stripped,
  not the line dropped. One consequence worth stating: re-exporting a
  *pre-change* session after this lands yields a different `chainDigest`
  than an export taken before it, because a record's body is re-serialized
  from parsed events rather than copied from the log's bytes. Files already
  on disk are unaffected. #292's definition of done asks that any override
  path leave a record of having been used; there is no override here,
  because there is no scan and no gate to override — the boundary is the
  event schema itself, enforced at parse time. See
  [SECURITY.md](SECURITY.md#what-a-shared-record-contains) for what a
  shared record does still contain.

### Changed

- **`rhizomorph rotate` now needs the dashboard to be built (#234).** The
  capability token the command must now send is handed out through the
  served page and nowhere else
  ([ADR-0012](docs/adr/0012-in-band-capability-token-delivery.md)), so the
  command reads it the way the browser does: one loopback `GET /`, then the
  `<meta>` tag. A server started without `packages/web/dist` serves a
  placeholder page carrying no token, and rotation there now exits 1 —
  naming `npm run build --workspace packages/web` rather than surfacing a
  bare 401 about a header the operator has no way to supply. Putting the
  token in `GET /api/meta` was rejected: it would hand it to precisely the
  local process #234 defends against. The dashboard's own rotate and launch
  buttons refuse the same way under `npm run dev:web`, where vite serves
  `index.html` itself and the injection never runs — a gap ADR-0012 already
  named and this change does not close, only makes honest.
- **Measured performance fixes.** Dragging the scrubber now rebuilds the
  derived fleet once per animation frame instead of once per pointer event
  (#269): the scrub position and the fold it drives are two clocks now, so
  the thumb still tracks the finger exactly while the fold and the
  `buildFleet` rebuild behind it move at a frame's cadence. Where a drag
  used to rebuild once per `onChange` — up to ~120 a second onto a screen
  that shows 60 — the tests that ship with it count 9 rebuilds across an
  80-seek drag over 8 frames, and 13 folds across a 120-seek drag over 12
  frames of a 25,000-event recording. A 55,000-event replay's main-thread load
  time dropped from ~20.9s blocked to ~25ms by folding the incoming event
  stream once per animation frame instead of once per event (#183). A
  30-lane scene with 200 retired lanes dropped from 28.37ms/frame (170.2%
  of the 60fps frame budget) to 11.95ms (71.7%) by caching the unchanging
  part of a scar (#175/#178).
  Replay playback advances the timeline clock on an animation frame rather
  than a 100ms interval (#271), so a playing scene animates at frame rate
  instead of the 10fps its own 60fps ambient loop was being sampled at —
  the cadence changed, not the clock's owner, so #155's single wall-clock
  read in the replay path is untouched.
- An independent, read-only adversarial audit of the whole instrument
  surfaced several findings, triaged into follow-up issues (#171–#177) —
  among them, unscrubbed identifiers in captured OTel fixtures, and the
  still-open question of whether going public means rewriting this
  repo's history or cutting a fresh tree (#177, unresolved).

### Fixed

- **A pane parked in a worktree subdirectory on its very first poll now shows
  the right worktree path (#463).** `worktreePath` resolved only by joining
  `status`'s `workdir` against `list`'s `path` exactly; a pane whose workdir
  was already a subdirectory of its worktree (e.g. a pane that `cd`s into
  `packages/server`) never matched that join, and with no prior poll to carry
  a good value forward, `worktreePath` stayed `null` for the whole session.
  When `list` is otherwise healthy but the exact-path join misses,
  `worktreePath` is now resolved directly via `git rev-parse
  --show-toplevel`, memoised per workdir so a pane parked in the same
  subdirectory across polls only pays the extra `exec` once.
- **`withBranchReconciliation`'s "did this poll observe reality" signal is
  still inferred from allocation identity, but the snapshot shape it can be
  inferred from is now compiler-checked (#454).** The wrapper decided "not
  observed" from `branches`' reference identity — correct for `gitCollector`
  today (verified exhaustively, #449), but invisible to the compiler: the
  wrapper was generic over any snapshot with a `branches` field, so an
  unrelated future collector reusing it would get no warning if its own
  "nothing changed" fast path never allocated fresh. The wrapper's signature
  now names `GitSnapshot` concretely instead of a generic bound, so only a
  structurally-matching snapshot type-checks; an explicit "observed" marker
  the collector sets itself — the shape that would make the signal explicit
  rather than inferred — is deferred to a future migration. A poll that
  defies the identity contract without one of the two known failure events
  now surfaces a loud `collector.error` instead of silently skipping
  reconciliation forever.
- **A resumed session with a stale fold now retires ghost branches too
  (#449).** `withBranchReconciliation` (#139) diffed a resume's folded
  branches against reality correctly since #132-134, but was never wired into
  `loadCollectors` — a branch removed before #137 shipped, or while the git
  collector's own snapshot was stale, stayed in the fold forever, `NEED
  ATTENTION` banner and all. It is now applied to the git collector the same
  way `withAgentReconciliation` (#418) is applied to workmux, and carries the
  same one-shot-latch fix: a transient `git worktree list --porcelain`
  failure on the very first post-resume poll no longer burns the wrapper's
  only shot and mass-reports every folded branch as removed.
- **A failing dirty-status poll now voices one honest event per incident, not
  a heartbeat (#415).** Once `MAX_DIRTY_STATUS_FAILURES` (#241) was crossed,
  `git status --porcelain`'s `collector.error` re-fired on every subsequent
  failed poll, with the growing failure count baked into the message — never
  the same string twice, ~35 → 45 session-log lines in 10s. It now fires once,
  on the poll that crosses the bound, and stays silent through further
  failures; the counter resets silently on recovery so a later incident
  re-arms and voices again.
- **A removed workmux agent's lane stops rendering as healthy (#417).**
  `AgentState` gained `present`/`removedAt` in #306, but `findAgent()`
  (`selectors/worktrees.ts`) matched by path/branch/handle with no presence
  filter — unlike the worktree and pane joins beside it — so a departed
  agent's last-known status (`working`, `waiting`, …) stood forever even
  though the worktree itself was never removed. `findAgent` now filters on
  `present` first, the same way the worktree and pane selectors already do.
- **A resumed session with no workmux snapshot now retires its stale agents
  too (#418).** `agent.removed` (#306) only fires from a live poll's
  snapshot-to-snapshot diff; a session resumed with a missing or stale
  workmux snapshot had nothing to diff against, so a lane folded away before
  or during the restart stayed `present` for the rest of the session. The
  first live poll after resume now reconciles the fold's still-present
  handles against reality, the same way `withBranchReconciliation` (#139)
  retires a ghost branch. The reconciliation's one-shot latch no longer
  spends itself on a poll that failed transiently — a workmux hiccup on the
  very first post-resume tick used to burn the shot for nothing and leave the
  ghost `present` for the rest of the process; the wrapper now waits for a
  poll that actually observed reality before latching.
- **A departed workmux agent is now announced (#306).** `workmux status`
  failing for a reason other than a missing binary used to parse as an empty
  roster and drop every known agent with no event at all; a handle that
  genuinely left a healthy poll was never diffed against the previous roster
  either, so it also just stopped appearing. Both now read distinctly: a
  transient failure carries the roster forward and reports
  `collector.disabled` (letting the existing degraded/disabled ladder handle
  it), and a genuine departure emits the new `agent.removed` event —
  [ADR-0015](docs/adr/0015-agent-removed-is-an-event.md).
- **A deleted worktree now leaves the dashboard, instead of rendering as
  healthy forever (#241).** `git worktree list` never stops listing a
  worktree removed by hand outside rhizomorph, and the git collector's
  `git status` catch silently carried its last-known dirty-file set forward
  with no event. The collector now reads git's own `prunable` annotation
  (already parsed, already free) as proof a worktree is gone, drops it, and
  emits `worktree.removed`; a real transient failure still carries forward,
  but only for a bounded number of polls before it becomes a visible
  `collector.error` instead of stale silent data. Decision and rejected
  alternatives (including why the issue's own suggested ENOENT check would
  have been wrong) in
  [ADR-0016](docs/adr/0016-prunable-not-enoent-proves-a-worktree-gone.md).
- **A recovered collector's pill no longer sticks on `errored` forever (#304).**
  A collector that had failed and then recovered (`status: 'healthy'`) used to
  read `errored` in the provenance bar forever, with its last (stale) error
  message still shown on hover — the pill never got the self-heal news. It now
  reads `live`, silently, the moment `collector.recovered` folds.
- **C-quoted git paths round-trip (#237).** `git status --porcelain` C-quotes any
  path with a space or non-ASCII byte, and `git log --raw` quotes non-ASCII;
  both parsers took the quoted slice verbatim, so a file as ordinary as
  `my file.ts` reached the collision matrix as the literal `"my file.ts"` and
  matched nothing. Paths are now unquoted on parse and status renames split on
  the real arrow, not a ` -> ` inside a filename.
- **A tab in a tmux pane path, or one malformed `git log --raw` line, no
  longer kills the collector (#242).** `list-panes.ts` and `parse-log.ts`
  quarantine the one unparseable line — skipped, counted, and voiced as a
  `collector.error` — instead of throwing and losing the rest of that poll's
  events.
- **Three silent lane-identity gaps close (#243).** `workmux/collector.ts`
  joined `workmux list`'s rows by branch name but looked them up by handle,
  so a slashed branch (`feat/foo`) never matched and `branch`/`worktreePath`
  stayed `null` in every `agent.status` for that lane; the join now keys off
  the worktree directory name both commands actually share. `worktree-slug.ts`
  mapped only `/` and `_` to `-`, so a dotted worktree path resolved to a
  session directory that never existed and read as "no session yet" forever;
  it now maps `.` too, matching Claude Code's own transform. A detached HEAD
  on the *main* worktree silently degraded every branch's
  `aheadOfMain`/`behindMain` to `null`; the git collector now emits one
  `collector.error` naming the detached main worktree instead of staying
  quiet about it.
- **A rotated or truncated session log resumes being read (#305).**
  `sessionlog/tail.ts` treated "the file is now smaller than the offset we
  hold" the same as "no new bytes" and handed back the same stale offset
  forever, so a log truncated or rotated out from under the collector
  (log rotation, a fresh `claude` session reusing a path) went quiet with
  no error and never recovered short of a restart. The read cursor now
  resets to the start of the file whenever it shrinks below the held
  offset, so the next poll resumes reading normally. A same-path rotation
  whose replacement had already grown past the old offset by the next poll
  went undetected by size alone and read garbage from the middle of
  unrelated content; the cursor now also resets whenever the file's inode
  changes, so identity — not just size — decides when a poll is reading a
  different file.
- **A rotated session log no longer folds onto its predecessor's turn state
  (#366).** #305 made `sessionlog/tail.ts` reset the byte cursor on a
  same-path rotation, but the collector still resumed `turnShape`,
  `lastUsageRequestId`, lane, and branch from the file the rotation replaced
  — so the replacement's first lines folded onto a stale mid-turn shape, a
  coincidentally-repeated request id could suppress its own first usage
  block, and its liveness was misattributed until an assistant line
  happened to overwrite it. All four now reset to a fresh fold on a
  detected rotation instead of resuming the predecessor's.
- **A hung collector subprocess no longer freezes all polling or shutdown
  (#236).** Every collector exec now carries a default timeout, and a
  per-collector watchdog abandons a poll that exceeds its budget — surfacing
  a `collector.error` — so one wedged `git`/`tmux`/`workmux` child can no
  longer stall the other collectors or hang graceful shutdown. Decision and
  budget rationale in
  [ADR-0013](docs/adr/0013-collector-ticks-are-bounded.md) and
  [`docs/design-notes/collector-tick-budget.md`](docs/design-notes/collector-tick-budget.md).
  A bounded `git status` failure (including this new timeout) inside the
  dirty-file diff was carrying forward the last known state silently, with
  no `collector.error` — the one exec in the git collector that didn't
  already follow this PR's own "a timeout is a visible error, not silence"
  rule. It now reports one.
- **The replay scrubber glides (#270).** Its `step` was `max(1000, span /
  1000)` — about a thousand stops across any recording, so on an eight-hour
  session the thumb jumped between notches ~29 seconds apart with nothing
  between them reachable, and any session under a second was frozen on a
  single stop. The step is now sized to the rendered track instead: the
  session is cut into the smallest power of two notches at least as many as
  the track has pixels, so a notch is never wider than a pixel at any window
  size, and one arrow press still moves ~0.1% of the session. `end` stays a
  grid point at every width and every session length — including multi-day
  ones, where the step's exact quotient outgrows what the `step` attribute's
  shortest decimal can carry and the last notch would otherwise be
  unreachable. Native keyboard behaviour is untouched: this configures the
  range input, it does not reimplement it.
- **Rename-in-place actually works (#249).** `POST /api/label` required a
  per-process capability token nothing ever delivered to the browser, so
  every rename in `/recordings` 401ed, on every boot. The server now
  stamps the token into `index.html`'s `<head>` at serve time and the
  dashboard reads it back — decision and threat-model consequences in
  [ADR-0012](docs/adr/0012-in-band-capability-token-delivery.md), the
  operator-facing account in [SECURITY.md](SECURITY.md#mutating-routes-and-the-capability-token).

## [0.1.0] - 2026-08-03

First published release. What the tool actually is, at this point:

### Added

- A live dashboard for a git-worktree agent swarm: point it at a repo
  (`npx rhizomorph <path>`) and it discovers worktrees and branches (git),
  agent panes (tmux), and [workmux](https://github.com/raine/workmux) state
  if present — each source optional, each degrading gracefully — and
  reflects reality within a couple of seconds via polling.
- **The scene**, a procedural, organism-like rendering of the fleet: one
  thread per lane, width and color carrying real signal (output volume,
  liveness, cost), pathologies (stalled, flatlined, collided) each drawn
  with their own unmistakable shape.
- **The fleet table**, the scene's tabular counterpart: every lane's
  handle, role, status, and cost, sortable and filterable.
- **Replay**: every session is recorded to a local, appendable event log
  and can be replayed afterward at the same fidelity it was watched live,
  scrubbing through exactly what happened.
- **The lane drawer**, opened per-lane, showing the agent's own
  conversation — the actual Claude Code session transcript for that lane —
  alongside its cost and timing.
- **`rhizomorph doctor`**, a read-only preflight that checks Node version,
  target path, web build, port availability, session logs, tmux/workmux,
  telemetry env, and the lane manifest — one `ok`/`warn`/`FAIL` line per
  check, each with its remedy.
- **`rhizomorph env <lane>`**, printing the exact environment block a lane
  needs to export OpenTelemetry cost/token telemetry to this instance's
  local OTLP receiver.
- Read-only and localhost-only throughout: no writes to the watched repo,
  no outbound network calls, nothing bound beyond `127.0.0.1`.
