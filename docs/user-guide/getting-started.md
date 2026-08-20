# Getting started

You're pointing this at a repo where coding agents are working — worktrees,
branches, maybe tmux/workmux, maybe Claude Code session logs. This page gets
you from a clean clone to a browser tab showing your own fleet, in five
minutes, no undocumented steps.

## Before you start: Node

**Node >= 22.22.2** — enforced in `package.json`'s `engines` field. Check
what you've got:

```sh
node --version
```

`[Ran]` on this machine: `v22.23.2` — satisfies the floor. If yours is older,
`rhizomorph doctor` (below) will tell you so and suggest `nvm install 22`
rather than failing silently later. An old Node is a `warn`, not a hard stop,
but things may not run correctly below the floor — don't rely on that.

## Install

There's no published package yet — cloning the repo is the install story
(see [Trust and reach](../architecture.md) in the README for why). Four
commands:

```sh
git clone https://github.com/KelliherL/rhizomorph
cd rhizomorph
npm install
npm run build   # builds the dashboard once; the server serves it statically
```

`[Ran]` in this repo (already a clone): `npm install` → `up to date, audited
217 packages in 803ms … found 0 vulnerabilities`. `npm run build` → builds
both workspaces; the web build lands at `packages/web/dist/`, ends with `✓
built in 384ms` (your numbers will differ, the shape won't).

## Point it at a repo

```sh
npm start -- <path-to-repo>
```

Omit the path (just `npm start`) to watch the current directory. Either way
it prints the URL it's listening on and where it's recording:

```
starting session 1785975801972 (no previous session recorded)
rhizomorph running at http://127.0.0.1:4321
watching <path> — N worktrees, M branches · recording to ~/.local/share/rhizomorph/<repo-slug>/session-<id>.jsonl
```

`[Ran]` against this very repo on an alternate port (4321 was already taken
by another instance watching this build):

```sh
npm start -- --port 4399
```
```
starting session 1785975801972 (no previous session recorded)
rhizomorph running at http://127.0.0.1:4399
watching /home/…/220 — 10 worktrees, 10 branches · recording to /home/…/.local/share/rhizomorph/220-dc94e1a5/session-1785975801972.jsonl
```

Open the printed URL in a browser. To pass other flags, forward them the same
way: `npm start -- <path-to-repo> --port 5000`.

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `4321` | Port to listen on |
| `--flatline-minutes <n>` | `5` | Minutes of silence before an agent is flatlined |
| `--poll-interval <ms>` | `2000`, minimum `250` | Collector poll cadence |
| `--extra-sessions <path>[:<lane>]` | — | Foreign Claude session-log dir to tail as a conductor (repeatable) |
| `--fresh` | — | Start a new session instead of resuming the most recent one |
| `--resume-window <ms>` | 4h (`14400000`) | Override the resume boundary; `0` behaves like `--fresh` |
| `--backfill` | — | Read session logs from the beginning instead of end-of-file |
| `--help`, `-h` | — | Show usage and exit |

Full flag reference: `npm start -- --help`.

## Check for gaps before you look

Not sure something's missing rather than actually broken? Run the one command
that explains every gap at once — `[Ran]` against this repo:

```sh
npm start -- doctor .
```
```
[ok  ] Node v22.23.2 satisfies the required >=22.22.2
[ok  ] /home/…/220 exists and is a git repository
[ok  ] web build present at /home/…/220/packages/web/dist/index.html
[ok  ] a rhizomorph is already serving worktrees-challenge on port 4321 (started …) — nothing to fix
[ok  ] Claude Code session logs found at /home/operator/.claude/projects
[ok  ] no rhizomorph session recorded yet for /home/…/220 — the next run starts a fresh one (resume window 4h)
[ok  ] tmux found on PATH
[ok  ] workmux found on PATH
[ok  ] CLAUDE_CODE_ENABLE_TELEMETRY=1 is set in this shell
[warn] no lane manifest at /home/…/220/.swarm/lanes.json — dispatch has not written .swarm/lanes.json yet; off-fence detection stays unavailable until a dispatch runs
[ok  ] this repo sits at L4 — tmux/workmux — top rung — nothing further to climb

All required checks passed.
```

Every line is `ok`, `warn`, or `FAIL`, each with its exact remedy baked in.
Only `target-path`, `web-build`, and `port` can make the exit code non-zero
(a genuinely unrunnable state); everything else is a `warn` that degrades
gracefully. See [troubleshooting.md](troubleshooting.md) for what the common
`warn`/`FAIL` lines mean.

## Your first dashboard, in five minutes

With nothing else set up — no worktrees beyond `main`, no tmux, no
telemetry — here's exactly what a fresh clone looks like, not a
placeholder:

- The **attention strip** reads `ALL CLEAR`, with an evidence line like
  `0 lanes · 0 branches · 0 files checked · collisions 0`.
- The **burn strip** shows `0` output tokens and the gap line `NO COST FEED
  (OTel) — dollars unavailable — run: eval "$(rhizomorph env <lane>)"` in
  place of a dollar figure.
- The **scene** shows a single lit mass (`main`) with nothing reaching out
  from it; the **fleet table** beneath it has no rows — nothing dispatched
  yet.
- The **provenance bar** along the bottom shows one dot per collector (Git,
  Tmux, Workmux, Sessionlog, OTel) plus the SSE stream dot.

That's the honest empty state, not a bug — see
[watching.md](watching.md) for what each panel means once agents are
actually running, and [the-lab.md](the-lab.md) for the separate, opt-in
experiment hand.

## Next

Prefer a window to a browser tab? [The desktop app](the-desktop.md) is the
same instrument in its own shell — installers, first run, and the settings
survey.

- **[watching.md](watching.md)** — read the scene, the fleet table, the lane
  drawer, and what the state words mean.
- **[replay.md](replay.md)** — scrub back through what already happened.
- **[sessions.md](sessions.md)** — how a session is bounded, and where its
  recording lives.
- **[the-lab.md](the-lab.md)** — the separate, explicitly-invoked hand for
  running experiments.
- **[troubleshooting.md](troubleshooting.md)** — the failures a first run
  actually hits.

For how it's built rather than how to run it, see
[`docs/architecture.md`](../architecture.md) — this guide deliberately
doesn't repeat that tour.
