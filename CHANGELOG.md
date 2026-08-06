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
  `docs/prds/prd13.md` ruling 13.)
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

### Changed

- **Measured performance fixes.** A 55,000-event replay's main-thread load
  time dropped from ~20.9s blocked to ~25ms by folding the incoming event
  stream once per animation frame instead of once per event (#183). A
  30-lane scene with 200 retired lanes dropped from 28.37ms/frame (170.2%
  of the 60fps frame budget) to 11.95ms (71.7%) by caching the unchanging
  part of a scar (#175/#178).
- An independent, read-only adversarial audit of the whole instrument
  surfaced several findings, triaged into follow-up issues (#171–#177) —
  among them, unscrubbed identifiers in captured OTel fixtures, and the
  still-open question of whether going public means rewriting this
  repo's history or cutting a fresh tree (#177, unresolved).

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
