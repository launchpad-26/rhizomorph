# Troubleshooting

Start here whenever something looks wrong: `rhizomorph doctor <path>` runs
every check below in one shot and prints the exact remedy for each. This
page explains what the common lines actually mean.

## Wrong Node version

```
[warn] Node v20.11.0 is older than the required >=22.22.2 — install a newer Node (e.g. `nvm install 22`)
```

This is a `warn`, not a `FAIL` — it won't stop `doctor`'s exit code from
being zero, but things may not run correctly below the floor. The check only
compares the major version (22 vs. whatever you have); fix it with
`nvm install 22` (or your Node manager's equivalent) and re-run `node
--version` to confirm.

## Port already in use

```
port 4321 is already in use — pass a different one with --port <n>
```

`doctor` catches this proactively, but it's not naive about it — a busy port
that's already answering `/api/meta` as a genuine Rhizomorph is reported
`ok`:

```
[ok  ] a rhizomorph is already serving <repo> on port 4321 (started <time>) — nothing to fix
```

Only a port that's busy with something *else* fails:

```
[FAIL] port 4321 is already in use — pass a different one with --port <n>
```

Either pass `--port <n>` with a free port, or — if it really is a stray
rhizomorph you meant to stop — find and stop that process first.

## No telemetry (the L0 story)

If you haven't set up any OTel environment variables at all, the dashboard
still works — this is by design, not a degraded mode you need to fix before
watching anything useful. Rhizomorph's own liveness/activity/token telemetry
comes from tailing an agent CLI's own session transcript, which needs *zero*
cooperation from the agent — no hooks, no wrapper, no terminal requirement.
The one thing that setup can't give you is **dollars**:

```
[warn] telemetry env is not set in this shell — spend stays at zero until you <remedy> (see docs/telemetry.md)
```

and in the burn strip / fleet table:

```
NO COST FEED (OTel) — dollars unavailable — run: eval "$(rhizomorph env <lane>)"
```

If you want authoritative or estimated dollars, run the printed command in
the same shell that launches the agent — see
[`docs/telemetry.md`](../telemetry.md) for the full setup, including the
cross-machine conductor case. If you never do, the app doesn't pretend to
know the cost — it says so, and every other signal (liveness, activity,
tokens) keeps working.

A related gap you may see on the conductor's own row/drawer specifically:

```
CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable
```

— means no cost telemetry has ever arrived with `role: conductor`. Fix with
`rhizomorph --extra-sessions <dir>:conductor` if your conductor's session
logs live outside the worktrees this repo's collector already discovers.

## Stale session lock

Each running instance holds a pid+heartbeat lock beside its session log,
refreshed every 5 seconds; a lock older than 20 seconds (or whose pid is
confirmed dead) is treated as abandoned and ignored on the next boot — you
shouldn't normally need to do anything about a stale lock at all; it clears
itself.

What you *will* see if a previous instance is genuinely still running (or
its process hasn't finished exiting yet):

```
session <id> is being written by a live instance (pid <pid>) — starting a
fresh session <newId> instead; use --fresh to silence, or stop the other
instance
```

This isn't an error — a new boot never splices into a log another process
might still be writing. If you expected the old instance to be gone and this
still fires, check for a leftover process (`ps aux | grep rhizomorph`) and
stop it, or just accept the fresh session; nothing is lost, and the old one
is still on disk (`rhizomorph sessions .` lists both).

## Why is my lane's conversation empty

The drawer's Conversation tab (or the conductor's own drawer on the
root-mass) says exactly which of these it is, rather than showing a blank
pane:

- **`CONDUCTOR NOT INSTRUMENTED`** — nothing in this session's event log was
  recorded against `role: conductor` at all. Fix: `rhizomorph
  --extra-sessions <dir>:conductor`.
- **`NO SESSION LOG for the conductor`** — the log has *telemetry* for the
  conductor, but no session id was ever attributed to it, so there's no file
  to tail. Fix: `rhizomorph doctor` (it reuses the same attribution check
  and will say precisely what's missing).
- **`NO SESSION LOG for "<lane>"`** — same shape, for a worker lane: the log
  knows the lane exists, but no session id was attributed to it.
- **`NO SUCH LANE "<lane>"`** — nothing in this session's event log names
  this lane at all; there's no transcript to tail because, as far as this
  session is concerned, the lane doesn't exist.

The most common root cause behind the first two: no Claude Code session logs
were found for this repo in the first place —

```
[warn] no Claude Code session logs at ~/.claude/projects — per-agent history
stays empty until `claude` has run at least once here (or point elsewhere
with --extra-sessions)
```

— i.e. the agent needs to have actually run at least once in that worktree
before there's anything to tail.

## No lane manifest (off-fence detection unavailable)

The single most common `warn` on a fresh dispatch:

```
[warn] no lane manifest at <repo>/.swarm/lanes.json — dispatch has not
written .swarm/lanes.json yet; off-fence detection stays unavailable until a
dispatch runs
```

`.swarm/lanes.json` is written by your dispatch tooling, not by Rhizomorph
itself (it only ever reads it) — this warning just means no dispatch wave
has run yet for this repo. It clears on its own once one has; nothing to fix
by hand.
