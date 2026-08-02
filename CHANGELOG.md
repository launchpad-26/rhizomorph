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
