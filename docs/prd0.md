# PRD 0 — The Rhizomorph

> **Status:** blessed by Lachlan, 2026-07-30, before any code.

## One-liner

Run `rhizomorph` in any repo hosting a git-worktree agent swarm and get a
live, replayable dashboard at localhost — who's working, what's landing, and
what's about to collide.

## Who it's for

Lachlan and anyone running multi-agent worktree workflows. First real user is
this build day itself: the Rhizomorph watches its own construction.

## The core promise

1. One command from the repo root, zero config.
2. It discovers worktrees and branches (git), agent panes (tmux), and workmux
   state *if present* — each source optional, degrading gracefully.
3. Browser dashboard reflects reality within ~2 seconds (polling; no watchers
   needed).
4. Recording starts at first launch; any moment is replayable.
5. **Read-only, always**: it never mutates the repo, sends keys, or merges
   anything.

## v0 scope — the day's must-haves

- **Worktree table** — branch, agent status, last activity, commits ahead of
  main, files touched.
- **Flatline detector** — per-agent liveness from tmux pane-content deltas; an
  agent silent for N minutes visibly dims.
- **Collision matrix** — files touched per branch (diff vs merge-base with
  main); two branches touching the same file = the cell glows. The day's own
  failure mode, made visible before merge pain.
- **Commit ticker** — commits as they land on any branch, with diffstat.
- **Branch graph** — live DAG of the swarm's branches. 2D is acceptable here,
  because —
- **The scene (parallel track)** — Three.js constellation of the swarm:
  stations, pulses, convergences. Nothing depends on it; it can degrade
  without sinking the demo.
- **Replay** — time scrubber over the event log: play, pause, speed.
- Dark, neon-accented instrument aesthetic throughout.

## Non-goals

No conducting (launch/merge/send/kill — never). No auth, cloud, accounts, or
multi-user. No filesystem watchers — polling is honest work. No
native-Windows support today (tmux-land only: WSL/Linux/macOS). Not a tmux
plugin, wrapper, or replacement — a sidecar.

## Definition of demo (end of day)

The Rhizomorph running against this very repo showing the real swarm
building it; the birth replay from the first recorded event; stretch: single
`npx`-style invocation.
