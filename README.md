# The Rhizomorph

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/launchpad-26/rhizomorph)

An instrument that watches **wherever your coding agents are working** — every
repository one of them is running in, not a path you chose at startup. It shows
what a swarm is doing, live, and can replay the session afterward.

It **draws one repository at a time**, and that is a decision rather than a
limit: the scene composes a single colony so its supported size stays a
question with a measured answer. Nothing is hidden by it. Every other watched
repository is counted, its lanes are listed, and a lane anywhere that needs a
person reaches the tray — so choosing what to look at never changes what you are
told. Starting inside a repo puts that one first, which is why the
zero-configuration case looks exactly like it always did.

Watching is read-only, absolutely; there are separate, opt-in hands for
recording, for running experiments, and for setting a repo up in the first place
— see [Trust](#trust) below for exactly what each does and how that's enforced.

![The scene as the centerpiece — a busy 20-lane fleet, every thread live green but visibly different widths for visibly different output, ALL CLEAR above it](docs/screenshots/fixture-20-lane.png)

It works on a bare machine and needs no multiplexer. There are **three
levels**, and `rhizomorph doctor` names which one you are at and the single
command that climbs: **L0** is git and your own session logs, with no
cooperation from anything; **L1** adds dollars and traces; **L2** adds attention
that was *declared* rather than inferred, which `rhizomorph enlist claude`
reaches in one act. Agent panes (tmux) and
[workmux](https://github.com/raine/workmux) state are read when present —
enrichments that add pane previews and one-keystroke ATTACH, never requirements,
and their absence is never reported as something missing. It discovers worktrees
and branches from git and reflects reality within a couple of seconds via
polling. This watching hand — collectors, receiver, server,
UI — never sends a keystroke, launches an agent, or merges anything; only
the separate, explicitly-invoked laboratory can do any of that, and only on
your own command. If you're deciding whether to run this on the machine
where your agents work, the next two sections are the ones that matter;
everything past them is depth for once you've decided.

New here? [`docs/user-guide/getting-started.md`](docs/user-guide/getting-started.md) walks clone → first dashboard in five minutes; the rest of `docs/user-guide/` covers watching, replay, sessions, the desktop app, the lab, and troubleshooting.

## Install and run

There's no published package (see
[When this is published to npm](#when-this-is-published-to-npm) below) —
cloning the repo is the install story. Four commands, on a plain terminal,
no undocumented steps:

```sh
git clone https://github.com/launchpad-26/rhizomorph
cd rhizomorph
npm install
npm run build   # builds the dashboard once; the server serves it statically
npm start -- <path-to-repo>   # boots collectors + API on http://127.0.0.1:4321
```

Omit the path (just `npm start`) to watch the current directory instead of
some other repo. Either way it prints the URL it's listening on
(`http://127.0.0.1:4321` by default) — open it in a browser. To pass other
flags, forward them the same way: `npm start -- <path-to-repo> --port 5000`.

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `4321` | Port to listen on |
| `--flatline-minutes <n>` | `5` | Minutes of silence before an agent is flatlined |
| `--poll-interval <ms>` | `2000`, minimum `250` | Collector poll cadence in ms |
| `--fresh` | — | Start a new session instead of resuming the most recent one for this repo (default: resume if its newest event is under 4h old) |
| `--resume-window <ms>` | 4h | Override the resume boundary above. `--resume-window 0` behaves exactly like `--fresh`. The boot line and `rhizomorph doctor` both say which way this decided and why |
| `--backfill` | — | Read session logs from the beginning instead of end-of-file — ingest history on purpose; expect a large first tick |
| `--help`, `-h` | — | Show usage and exit |

Not sure something's missing rather than actually broken? Run the one
command that explains every gap at once:

```sh
npm start -- doctor <path-to-repo>
```

It checks the Node version, that the target path exists and is a git repo,
that the web build is present, that the port is free, Claude Code session
logs, tmux/workmux on `PATH` (as enrichments — present or absent, both read
`ok`), the telemetry env, the lane manifest, whether this boot found a live
writer already holding the session (the pid+heartbeat lock, see
[Trust](#trust) below), and which of the three levels this machine stands at
with the one command that climbs to the next — one
`ok`/`warn`/`FAIL` line per check, each with its exact remedy. It exits
non-zero only when the app genuinely cannot run at all (bad path, not a git
repo, no web build, port already taken); everything else is a `warn` that
degrades gracefully rather than a reason to stop.

### When this is published to npm

Not yet true — flagged here so it reads as a stated future, not a command
you can run. There is no npm publish yet: the repo stays clonable instead,
and the release machinery stays dormant, not deleted. Right now, `npx
rhizomorph <path-to-repo>` 404s
(`npm error 404 'rhizomorph@*' is not in this registry`) — there is no
package to fetch. Once one is published, that single command will fetch and
run it with nothing installed permanently, no clone required — the same
code the clone path above runs today, just fewer steps to get there.

The plan, not a date: publishing stays deliberately **last**, so the
instrument lands and gets exercised before a stranger's `npm install` is the
front door. prd15's agnosticism round put publishing back on the map — that
umbrella retired as superseded on 2026-08-24
([`docs/prds/done/prd-15-anywhere-instrument.md`](docs/prds/done/prd-15-anywhere-instrument.md)),
and the delivery thread it named is now **prd-34, the doorstep**
([`docs/prds/prd-34-the-doorstep.md`](docs/prds/prd-34-the-doorstep.md)),
reclassified the same day as release readiness: signing and an update feed
are deliberately deferred by its ruling 9, and a publish waits on a release
someone actually plans. prd8's packaging machinery (tarball-proven `files`
allowlist, tag-gated release workflow, no secrets) already exists and stays
dormant until then. The history question that used to gate this — whether
going public meant rewriting this repo's history or cutting a fresh tree, a
choice #177 named and left open — was settled by events rather than by a
ruling: this repo was re-uploaded to a fresh tree on 2026-08-21, so the
fresh-tree branch of that decision is simply the one we are standing on. No
wave here promises a date.

## CLI reference

Every subcommand `rhizomorph` dispatches on (`packages/server/src/cli/index.ts`); a `cli-surface-law` test asserts this list and that dispatch table name the same set, in both directions, so a registered subcommand can't go undocumented and a documented one can't go stale. `rhizomorph <subcommand> --help` has the full usage for any of them.

| Command | What it does |
|---|---|
| `rhizomorph [path]` | Boots the server + collectors, watching `path` (default: current directory). The fallback when `argv[0]` matches nothing below — see [Install and run](#install-and-run). |
| `rhizomorph doctor [path]` | Read-only preflight — Node version, target path, web build, port, session logs, tmux/workmux, telemetry env, harness roster — one `ok`/`warn`/`FAIL` line per check, each with its remedy. |
| `rhizomorph env <lane>` | Prints the exact, export-ready OTLP env block for a lane, read from a running instance — or, with `--hooks claude`, the Claude Code hooks that declare the lane's attention as beacons. See [Telemetry](#telemetry-the-money-layer) and [Hooks](#hooks-declared-attention). |
| `rhizomorph export-record` | Hands a recorded session to someone else as a portable, hash-chained file — see [the record format](docs/record-format.md). |
| `rhizomorph archive` | Seals a recording, verifies the archive, tombstones its lanes and then prunes the log — one command, in that order, or not at all ([prd-51 ruling 11](docs/prds/prd-51-the-split.md)). Needs `--older-than`; there is no default age. Writes `<repo-slug>-<session>.rhizorecord.json.gz` beside the session logs — gunzip it before handing it to `rhizomorph replay`. |
| `rhizomorph export-otlp` | Writes a recorded session's trace spans out as an OTLP/HTTP JSON export-trace request. Nothing is sent anywhere — it's an offline dump; replay it into Langfuse (or any OTLP-compatible backend) yourself. |
| `rhizomorph replay <record-file>` | Verifies a portable record's hash chain, then serves it read-only through the same dashboard a live recording uses. |
| `rhizomorph sessions [path]` | Lists every session recorded for a repo, newest first, with a title derived from its own events. |
| `rhizomorph label <sessionId> <text>` | Renames a recorded session's auto-title. |
| `rhizomorph rotate` | Asks the running instrument to close its current session log and open a new one. |
| `rhizomorph lab <checkpoint\|fork\|compare\|rd>` | The laboratory's namespace (opt-in, explicitly invoked) — see [The laboratory](#the-laboratory--opt-in-explicitly-invoked-and-separate-prd12-ruling-1). `rd` spawns **your own** agent CLI and spends **your own** money; this instrument holds no credential ([ADR-0048](docs/adr/0048-the-instrument-spawns-the-operators-own-tools-as-an-explicit-act.md)). |
| `rhizomorph enlist <harness>` | Adds the telemetry variables and lifecycle hooks to a harness's own user-level configuration, so agents you start yourself are witnessed too. Prints the diff and writes nothing without `--apply`; copies the original beside it first; refuses a key you already set. Needs a running server on `--port` — see [Enlistment](#enlistment--the-fourth-hands-third-power). |
| `rhizomorph unenlist <harness>` | Removes exactly what `enlist` added, leaving your own hooks and variables untouched. Same diff-first two-step. |
| `rhizomorph hook` | Not for you to type. It is what the hook entries `enlist` writes invoke: reads one hook firing on stdin and appends one line to this installation's beacon door. Takes no flags and exits 0 whatever happens, because the agent waiting on it must never pay for a broken instrument. |
| `rhizomorph connect team <url> --project <id>` | Turns on the shipper for this repo — the fifth hand, off by default. Reads a project-scoped `rzk_` ingest key on stdin, never argv. `--status` reports; `--ship` runs the batch timer in the foreground. See [The shipper](#the-shipper--the-fifth-hand-off-by-default-outbound-only-adr-0034--prd-51-ruling-2). |

## Trust

This is a tool that reads your machine's own record of what your coding
agents have been doing, so here is plainly what it does and doesn't do —
not a footnote, the second thing in this file. There are **five** hands here,
not one, each with its own reach and its own enforcing test — a single
blanket "read-only, never" claim would be weaker than this, not stronger,
because it would erase the hands that are allowed to write anything and
leave the rest looking like they need no fence at all.

### The observer — everything below, absolutely read-only

Collectors, receiver, server and UI. This hand never writes to the repo
you're watching, never sends a keystroke to an agent, never starts or stops
one, and never merges or otherwise acts on what it shows you — enforced by
this repo's own readonly law tests, not just stated: the lane drawer's
[`packages/web/src/drawer/readonly.test.ts`](packages/web/src/drawer/readonly.test.ts)
greps its own source for any HTTP verb but GET, any way to build a request
body, any execution channel, any credential; the judge's
[`packages/server/src/judge/mergetree.test.ts`](packages/server/src/judge/mergetree.test.ts)
proves a speculative merge check leaves HEAD, every ref, and the working
tree byte-for-byte unchanged. Every other collector reads the same three
read-only sources (git, tmux/workmux, your own session logs) and writes
nothing back to any of them.

**What it reads:** the git state of the repo you point it at (worktrees,
branches, commits — read-only, no writes); tmux panes and
[workmux](https://github.com/raine/workmux) state, if either is installed
(neither is required); your own Claude Code session logs under
`~/.claude/projects`, to show an agent's actual conversation in the lane
drawer; and **your machine's process table**, to see the agents you are
actually running.

That last one is the newest reach and the one that deserves the most precision,
because it is the only thing here that looks outside the repo you pointed at.
[ADR-0052](docs/adr/0052-the-observer-reads-the-operators-own-agent-processes.md)
is the decision and its bound, and the bound is narrow:

- **A process is only ever looked at if its command line names a known agent.**
  Anything else — your browser, your editor, your shell — is not counted, not
  named and not reported. This is not a general process monitor, and *"what is
  running on my machine"* is not a question it will answer.
- **What is recorded is: a process id, which agent it is, when it started, which
  worktree it is in, its CPU and memory, and which other agent started it.**
  Nothing else. Never the command line beyond the match that identified it — a
  command line can contain a prompt — and never any environment variable of any
  process, ever, because an environment can contain a key.
- **It never signals a process.** Not `kill`, not a stop, and specifically not
  signal 0, the usual way a program asks *"are you still there?"* — that is a
  call *at* your agent, and this hand only ever looks. Enforced by a grep over
  its own source, so the rule outlives whatever the collector grows into.
- **It sees only your own processes.** Another user's are invisible to it, and
  that is fine: your agents are yours.

On macOS and Windows this reach does not exist yet — the reader for those
platforms is not built, and the instrument says so rather than reporting an
empty table as an empty fleet.

**Where it listens:** `127.0.0.1` only, on the port you choose (default
`4321`). It does not bind a public interface. If you also point a live
`claude` process at its telemetry receiver (see [Telemetry](#telemetry-the-money-layer)
below), that receiver listens on the same loopback address, on the same
port, for the same reason.

**What it sends, and to whom:** nothing, until you type one command. There is
no analytics call, no update check and no phone-home of any kind anywhere in
this codebase, and the observer, the recorder and the laboratory send nothing
anywhere under any circumstances. Two things can leave this machine, and each
is your own explicit act, per repo: the concierge's clone-by-URL — your own
`git clone`, run because you asked for it, described in its own section below
— and the shipper, the fifth hand, which is off until you run
`rhizomorph connect team` and is described below in the same detail. Until
then there is no destination configured, no credential on disk and no timer
running.

### The recorder — the observer's own second hand, narrower than either (prd16 ruling 2)

Not a new authority: the observer has always written its own recording of
what it saw; what prd16 makes operable is *who decides when a recording
ends*. This hand may only ever close the current session log and open a
new one, writing solely inside the Rhizomorph's own data directory
(`~/.local/share/rhizomorph/<repo-slug>/`) — never the watched repo, never
a git ref, never a worktree, never `~/.claude`.

**When it records:** always, from the moment the server starts — there is
no opt-in flag and no way to run it without recording. What decides *when
one recording ends and the next begins* is your own explicit act, never a
collector, a lane, or a clock: `--fresh` forces a new session,
`--resume-window` sets how long a gap may be before the previous one counts
as over (default 4h; `--resume-window 0` behaves exactly like `--fresh`),
and the default resumes whatever session is still inside that window. Two
instances can no longer race onto the same log either: each boot claims a
pid+heartbeat lock beside the session (`session-<id>.lock.json`, refreshed
every 5s); a second instance finding a live lock starts its own fresh
session instead of splicing into a session another process is still
writing — [`packages/server/src/log/session-lock.ts`](packages/server/src/log/session-lock.ts),
proven in [`packages/server/src/log/session-log.test.ts`](packages/server/src/log/session-log.test.ts).
Every path this hand can write to is built from one function,
[`defaultDataRoot()`](packages/server/src/log/paths.ts) — there's no second
constructor for a session, label, snapshot or lock path to have drifted
from it.

**Ending a session on purpose:** `rhizomorph rotate`, or the dashboard's own
"end session · start fresh" button, asks the *running* instrument to close
its current log and open the next one — an explicit human invocation, never
something a background process performs on its own. On close, each lane's
live transcript is copied — redacted by the same hygiene discipline the
telemetry fixtures use — into that session's own artefact directory, so a
recording replayed in a year, on any machine, still shows its
conversations; replay reads the captured copy first and falls back to live
resolution only for the still-open session. A session whose transcripts
couldn't be fully captured says so precisely (`manifest.complete: false`)
rather than silently producing a conversation-less recording.

**What it writes:** its own recording of what it saw — a plain JSON-lines
session log under `~/.local/share/rhizomorph/<repo-slug>/`, one file per
session, never anything inside the repo you're watching. The log is
*exactly* the event stream every panel already reads: whatever privacy
allowlisting a collector applies happens before an event is even built, so
the log was never a second copy with more in it, and it never gains fields
after the fact. That's what makes Replay possible; delete the directory
and the next boot starts a fresh recording with nothing lost from the repo
itself. An event line from a future era this build doesn't recognize is
never silently dropped either — it's counted and preserved byte-for-byte,
and replay says so in words (`"N events from a newer era were preserved but
not understood (...)"`) rather than pretending nothing happened.

**What's in it, before you hand it to anyone:** no captured tmux pane
content enters an event — the collector derives a content hash and a line
count from a `capture-pane` and discards the text, so `pane.activity` says
*that* a pane changed and when, never *what* it said. A log recorded before
that was true (#292) may hold a `preview` line; it's stripped on the way
into any record built now, and the record still verifies. But a record is
not a redacted artefact: it still carries pane and window titles, absolute
paths including your home directory and username, commit subjects with the
author's name and email, branch and lane names, stderr from failed git or
tmux commands, and symbol names from your own diff. Nothing scans it for
secrets, and a hash-chained body can't be cleaned up afterwards. Read one
before you share it — [SECURITY.md](SECURITY.md#what-a-shared-record-contains)
has the full list.

**Where it writes it:** the exact path is printed at boot —
`watching <repo> — N worktrees, M branches · recording to <path>` — so you
never have to go looking for it.

**Finding, labelling, managing and replaying a recording:** `rhizomorph
sessions [path]` lists every session recorded for a repo — newest first,
each with a title *derived from its own events* (`2026-08-04 · 6 lanes · 5
landed · #144 #148 #152`, or `2026-08-04 · no activity recorded` for an
empty one), when it ran, how long, lanes, landings, tokens, cost and file
size. The same rows, plus rename-in-place and export, live in the
dashboard's own **`/recordings`** library — a management surface, deliberately
never a second live overview: it renders only what was recorded, never the
live fleet, a law its own source-grep test
([`packages/web/src/recordings/no-live-fleet-law.test.ts`](packages/web/src/recordings/no-live-fleet-law.test.ts))
holds it to. If an auto-title isn't the name you'd give it, rename it there
or run `rhizomorph label <sessionId> "<text>"` — either way it's written to
a sidecar file next to the log (`session-<id>.label.json`), never a
mutation of the log itself, and a rename refreshes every picker showing
that session, including the live dashboard's own. The dashboard's own save
talks to the exact instrument you booted: the page it's running on carries a
capability token, minted per process and never logged, that every mutating
route and every gated read requires — the label save is one such write, not
the token's whole job (prd-29 rules that reads gate too; only the served
page itself is tokenless, because that page is where the token comes from).
So it works against a real boot of the server, not a `vite`-only
preview with nothing behind it. Once you've found the one
you want, either replay it from the dashboard's own picker, or hand the
file to someone else first with `rhizomorph export-record` (see [the record
format](docs/record-format.md)).

### The laboratory — opt-in, explicitly-invoked, and separate (prd12 ruling 1)

Everything above runs the moment you start the server. The laboratory does
not: it's a second actor, reachable only by an explicit human action, never
a background poll — either your own command line (`rhizomorph lab
checkpoint <lane>`, `rhizomorph lab fork <lane> [--at <checkpoint>]
[--launch]`, `rhizomorph lab compare <forkId>`, `rhizomorph lab rd <lane>
--model <m>`), or the dashboard's buttons, which send `POST /api/lab/launch`
and `POST /api/lab/rd` to server routes that run those same commands
in-process (see [SECURITY.md](SECURITY.md) for what guards those routes
today). `checkpoint` snapshots a lane's live workspace
and session position; `fork` restores as many arms of one checkpoint as you
ask for, each into its own worktree, and runs `npm install` in each one;
`compare` reports what happened across them.

`rd` is the one that spends money somewhere other than a lane you started:
it reads this repo's own record — measured verdicts, retros, reviews — and
hands it to **your** agent CLI, resolved on this machine's PATH under the
name you declare, with **no tools granted**. This instrument holds no
credential and forwards none; the call is authenticated by your own already-
installed login and billed to your own account, which is the boundary
[ADR-0048](docs/adr/0048-the-instrument-spawns-the-operators-own-tools-as-an-explicit-act.md)
records. With no such CLI on your PATH it says so and spawns nothing.

What it's allowed to write, exactly: refs under `refs/rhizomorph/`, the git
objects those refs require, worktrees it creates itself under
`~/.local/share/rhizomorph/lab/worktrees/` (a sibling of the recording
directory above, never inside the repo you're watching), the checkpoint's ref
and its event-log entry alongside that recording directory, and — not beside
the worktrees directory, but into the harness's own
`~/.claude/projects/<slug>/` tree — the synthesized session, so a forked arm
is a session Claude Code itself can resume
([ADR-0032](docs/adr/0032-synthesized-sessions-live-in-the-harness-projects-tree.md)).
It never pushes, never merges, and never checks out or rewrites a branch that
already exists, and **nothing is created outside them at all**. The arm's
worktree is the laboratory's own, detached, with no ref outside
`refs/rhizomorph/` — so a fork no longer needs a multiplexer, or anything
else, to make somewhere for an arm to run.

**A fork restores arms; it does not start them.** Every arm is restored into its
own lab worktree and handed the exact command line to run, which you run
yourself. That is deliberate: a headless agent run is a whole turn, so starting
one per arm from inside the fork would run your arms one after another rather
than side by side, and spend real money while you watched a command that had not
returned. `workmux add` remains available as a launcher you can choose, and is
offered to nobody who does not already run workmux.

Enforced twice over. At runtime,
[`assertInsideLabWorktrees`](packages/server/src/lab/paths.ts) refuses —
unconditionally, not just in a test — any worktree path the lab tries to
create outside its own directory. And
[`packages/server/src/lab/namespace-law.test.ts`](packages/server/src/lab/namespace-law.test.ts)
is the test that watches everything else: no source file outside
`server/src/lab/` may even import it, except the one declared CLI wiring
point — a per-file check on which files name the lab *directly*, blind to a
reach that goes through that wiring point instead, which is exactly what
`api/lab.ts` does today (#245); no ref literal in
its source names anything but `refs/rhizomorph/`;
no lab file shells out to `push`, `merge`, `checkout`, `branch`, `reset`,
`rebase`, or any other verb that rewrites something that already exists;
nothing under `lab/` sets a timer of its own, so it never starts itself —
every run traces back to a deliberate act of yours, the command you typed or
the button you clicked, never a schedule; and a live run of
`lab fork` against a real fixture repo proves the whole write surface by
walking the filesystem and the ref namespace before and after, rather than
trusting the source to say so.

If you'd rather verify that yourself than take it on faith — the right
instinct for exactly this kind of tool — the source is right here: the
collectors that read git/tmux/workmux live under
`packages/server/src/collectors/`, the one that tails your session logs is
`packages/server/src/collectors/sessionlog/`, the server that binds the
port is `packages/server/src/index.ts`, and the laboratory's entire write
surface is `packages/server/src/lab/`, importable only from the CLI wiring
in `packages/server/src/cli/index.ts` — the dashboard's launch button
reaches it through that same wiring (`packages/server/src/api/lab.ts`
calling `runCli(['lab', ...])`), not a separate import.

### The concierge — the fourth hand, for getting set up at all (ADR-0019 / prd-20)

The three hands above assume you already have a repo with a wired
conductor in it. Getting *to* that state used to be homework — clone,
build, start, generate an env block, eval it in the right shell, relaunch
the agent — so the constitution was amended once more, deliberately and on
the record ([ADR-0019](docs/adr/0019-the-fourth-hand.md)), to grant a
closed list of powers — closed by its own terms, so a new one costs another
written amendment. There are three, and the third was added that way
([ADR-0053](docs/adr/0053-the-fourth-hand-may-enlist-a-harness.md)):

- **Clone a repo to disk** — a plain `git clone` through your machine's own
  existing git credentials, into the concierge's own namespace. This is the
  one outbound network call in the codebase, and it happens because you
  pasted a URL and clicked.
- **Launch or relaunch a conductor** — start the agent CLI inside an
  instrumented envelope, or offer *relaunch with continuity* for a
  conductor already running uninstrumented (it never claims to attach to a
  live process; see [prd-20 ruling 3](docs/prds/prd-20-the-concierge.md)).
  Relaunching may make **one create-only copy** of a session transcript
  into the watched repo's own harness directory
  ([ADR-0020](docs/adr/0020-transcript-migration-is-a-create-only-copy.md)):
  it never overwrites, never deletes, never edits a line, and the UI says
  every time what continuity means and what is lost.

- **Enlist or unenlist a harness** — see below. The one power that writes
  a file **outside** the watched repo, in your own home directory, and the
  one that had to be argued for in writing before it existed.

Every one of them is a **token-gated mutating route**, and every one is
invoked only by an explicit human act — in `/connect`, or by a command you
typed — never a collector, never a poll, never a timer. The fence is enforced the same way the laboratory's is:
[`packages/server/src/concierge/namespace-law.test.ts`](packages/server/src/concierge/namespace-law.test.ts)
watches the whole write surface, and
[`assertMigrationPaths`](packages/server/src/concierge/paths.ts) derives
both ends of that copy rather than trusting a supplied path.

#### Enlistment — the fourth hand's third power

The telemetry block above assumes every agent is launched through a lane
manager, because that is where this instrument grew up. It does not survive
you opening a terminal and typing `claude`. **Enlistment is the answer to
that**: it writes the same variables, plus the lifecycle hooks, into the
harness's own user-level configuration — `~/.claude/settings.json` for Claude
Code — where they apply to every future session, in every terminal, in every
repo, including ones this instrument has never seen.

That is a write in **your** home directory, to a file **another program**
owns, so every clause of the bound is mechanical rather than promised
([ADR-0053](docs/adr/0053-the-fourth-hand-may-enlist-a-harness.md)):

- **Never without you asking, and never for a harness you didn't name.**
  One harness per act, typed or clicked.
- **Diff first, always.** The first act computes what would change and
  writes nothing. The second sends back a digest of the bytes the first one
  read, and the server refuses it if the file has changed since — so a file
  you edited in between is never silently overwritten.
- **The original is copied beside it first**, create-only, never
  overwriting an existing backup.
- **Only declared keys**, and **merge never clobbers**: a variable you had
  already set is refused by name, with what was found and what is still on
  the table, rather than replaced. A setting of yours that this hand did not
  write is a setting this hand will not touch.
- **Reversible.** `rhizomorph unenlist claude` removes exactly what was
  added and leaves the rest of the file as it stands.
- **Never inside the watched repo** — the target is refused unless it
  resolves under your home directory ([ADR-0019](docs/adr/0019-the-fourth-hand.md)
  clause 4).

What the hooks then do is append one line per lifecycle event to this
installation's own beacon door, through `rhizomorph hook`. That line carries
when, which session, which working directory and which process — and
**never** what the agent was about to run, what you typed, or what it wrote
back. The one field carrying an agent's own words is a permission prompt's
short sentence, and it is bounded before it reaches disk. The writer is
[`packages/server/src/cli/hook.ts`](packages/server/src/cli/hook.ts); its
test plants a command line in the input and asserts the bytes on disk do not
contain it.

If you'd rather verify all of this yourself than take it on faith — the
right instinct for exactly this kind of tool — the source is right here:
the collectors that read git/tmux/workmux live under
`packages/server/src/collectors/`, the one that tails your session logs is
`packages/server/src/collectors/sessionlog/`, the server that binds the
port is `packages/server/src/index.ts`, the laboratory's entire write
surface is `packages/server/src/lab/`, and the concierge's is
`packages/server/src/concierge/`.

Sweep the app and the desktop shell (`packages/web/src` and
`packages/app/src`, every module format, comments stripped, excluding tests)
for a **named vocabulary** of request-originating spellings, and there are
**eighteen** call sites in **fifteen** modules:
`packages/app/src/host/fleet-feed.ts` (two),
`packages/web/src/app/StreamContext.tsx`,
`packages/web/src/concierge/clone.ts`,
`packages/web/src/concierge/enlist.ts`,
`packages/web/src/concierge/instrument.ts`,
`packages/web/src/concierge/retarget.ts`,
`packages/web/src/hooks/useEventStream.ts`,
`packages/web/src/lab/compare/save.ts`,
`packages/web/src/lab/launch/launch.ts`,
`packages/web/src/lab/measure.ts`,
`packages/web/src/lab/rd/rd.ts`,
`packages/web/src/recordings/capabilityRead.ts` (two),
`packages/web/src/recordings/label.ts`,
`packages/web/src/replay/rotate.ts`, and
`packages/web/src/scene/parity/capture.mjs` (two) —
`route-class-law.test.ts` runs that same sweep, over the same roots, and
fails if this list stops matching what it finds. The two numbers above and the
fifteen paths below them are all read out of this file and compared to it —
nothing here is a number typed twice.

**What "named vocabulary" means, and what it does not promise.** The law
matches a listed set of spellings: a call to `fetch`, `http.request`,
`https.request`, `http.get`, `https.get` or `navigator.sendBeacon`, plain or
optional-chained; the `new EventSource`, `new WebSocket` and
`new XMLHttpRequest` constructors; a
dynamic `import()` of `http`/`https`; and a reference to the platform function
taken under another name — `globalThis`/`window`/`self`, via `.fetch`,
`?.fetch`, `['fetch']`, or a renamed destructure. That list, with a pinned
expected count for each spelling, is the `it.each` table in the law itself,
which is the authority rather than this paragraph.

It is a **regression net over an enumerated grammar, not a proof of
exhaustiveness.** "Every way JavaScript can send a byte" is an open set, and no
regex closes it — five rounds of adversarial review added ten spellings to that
table, each one found by someone thinking of a cell nobody had listed. So the
honest claim is the bounded one: nothing in the listed vocabulary can appear
outside the list above without the build going red, and a genuinely novel
spelling needs a human to notice it and a row to be added. The loopback
argument below is what carries the actual security property; this sweep keeps
the enumeration honest.

Six further modules — `app/StatusBar.tsx`, `connect/meta.ts`,
`drawer/useTranscript.ts`, `fleet/manifest.ts`, `lane-page/LanePage.tsx` and
`lane-page/laneIndex.ts`, all under `packages/web/src/` — read
`typeof globalThis.fetch` to check the capability exists and then delegate to
`recordings/capabilityRead.ts`, whose own two calls are already counted above.
They are consumers of one egress point rather than six more of them, so
counting them again would overstate the surface rather than describe it.

Every one of the eighteen targets this instrument's own loopback origin, not
the wider internet: the browser-side calls pass a path relative to the page
itself, which only ever loads from `127.0.0.1`/`localhost` (the server binds
nowhere else, and `mutation-guard.ts`'s `Host` check refuses anything else
regardless); `capture.mjs` drives a headless browser pointed at
`http://127.0.0.1:<port>/`; and the Electron shell's two go through a
`baseUrl` that
[`app/src/host/boot-line.ts`](packages/app/src/host/boot-line.ts)'s
`readListeningUrl` refuses to set to anything but a loopback host in the
first place. The clone above is still the only path any of those eighteen can
take off this machine; the shipper below is the other one, and it is a
separate hand with a separate command and a separate fence.

### The shipper — the fifth hand, off by default, outbound only (ADR-0034 / prd-51 ruling 2)

This is the only hand that sends anything to another machine, and it exists
so that a team can see one shared picture instead of five private ones. It is
off until you turn it on, per repo, with one command — there is no flag on
the server, nothing in a config file elsewhere, and no way for a collector, a
background poll or the server's own boot to start it. That last part is
enforced rather than promised:
[`packages/server/src/shipper/hand-law.test.ts`](packages/server/src/shipper/hand-law.test.ts)
reads this repo's own import graph and its own source text and fails the build
if anything but the `connect team` command can reach the hand or start its
timer.

**Turning it on:**

```
echo "$RZK_INGEST_KEY" | rhizomorph connect team https://team.example --project acme-widgets
```

The key arrives on standard input and never on the command line, so it is
never in your shell history, never in `ps`, and never in this process's argv.

**What leaves:** exactly the lines a portable record would carry for that
session — every event re-serialized through the current event schema before
it goes, never the raw bytes of your log
([`packages/core/src/wire/reserialize.ts`](packages/core/src/wire/reserialize.ts)).
Concretely, that is the same set of facts the ["portable
record"](#the-recorder--the-observers-own-second-hand-narrower-than-either-prd16-ruling-2)
already lists: file and worktree paths, which include your home directory and
your username; branch and lane names; commit subjects with their author's
name and email; spend and token counts; and the stderr of a `git` or `tmux`
command that failed. It is **not** your words. Prompts, completions,
transcripts and pane content are not in a record, so they are not on the wire
— a field the current schema does not declare cannot survive the
re-serialization, and a test plants one and watches it fail to cross.

**When:** on a batch timer, inside a process you started and can see —
`rhizomorph connect team --ship`. Stop that process and nothing ships. There
is no daemon, nothing is installed into your login items, and the running
server never does this on your behalf.

**To whom:** the single team-server URL you named, and nowhere else.

**Under whose key:** one project-scoped `rzk_` ingest key, which the team
mints and can revoke. It is stored mode `0600` beside your session logs, in
`~/.local/share/rhizomorph/<repo-slug>/shipper/ingest.key`, and nowhere else:
never in argv, never in an environment variable, never in the browser, never
in the hash-chained record, and never in a log line — proven by
[`packages/server/src/shipper/no-key-in-output-law.test.ts`](packages/server/src/shipper/no-key-in-output-law.test.ts),
which runs the hand against a failing server that echoes the key back and
asserts the value reaches no log, no error, and no file but its own.

**How to see that it is on:** `rhizomorph doctor` reports the shipper's state
on one line — off, or on with its URL, its project, whether a credential is
present (never its value) and how far each session has shipped.
`rhizomorph connect team --status` prints the same in full, including any
line this build could not fold and therefore did not send.

**How to turn it off:** delete
`~/.local/share/rhizomorph/<repo-slug>/shipper/`. With no configuration file
there is no destination and no credential, and the hand cannot run. Your
session logs and recordings are untouched — they were always local and they
stay local.

## The generated wiki

[deepwiki.com/launchpad-26/rhizomorph](https://deepwiki.com/launchpad-26/rhizomorph)
is where an AI-generated, queryable wiki over this repository appears once the
repo is indexed, and the badge at the top links there. **Indexing is an explicit
operator act and may not have happened yet** — until it does, that page offers to
index rather than answer, and the MCP tools below report the repository as not
found. Nothing in this tree can tell you which state it is in; the page and the
MCP server both can.

It is reachable over MCP at `https://mcp.deepwiki.com/mcp` — free, remote and
unauthenticated, because this repo is public — which is what `.mcp.json`
declares, so an agent working here can query it without setup. **That file is
tracked, so every agent session opening this repo is offered that server**, and
each query it makes goes to the vendor. Nothing is sent unless a query is made,
and no credential is involved; but the offer is repo-wide and it is worth knowing
it is there.

**It carries no authority, and nothing here can make it true.** It is written by
a model from this tree and refreshed on its vendor's schedule; no test in this
repository can turn red when it says something wrong. Use it to find your way in.

**How stale it may be is not a documented number.** Cognition states one thing
about refreshing — *"We auto-refresh DeepWikis if their repo has a badge"* — which
is why the badge is here, and says nothing about cadence. Figures circulating
elsewhere ("weekly", "a five-day lag without a badge") trace to no primary source
we could find, so do not plan against them. Treat the page's age as unknown, and
the tree as the thing that is current.

When a claim has to hold, read the document, and find the law that holds it —
[docs/README.md](docs/README.md) is the map, and the laws live in tests beside the
code they hold ([CONTRIBUTING.md](CONTRIBUTING.md#laws-live-in-tests)).

What *is* held: the badge and the endpoint above both name this repository and
not another, pinned by `packages/server/src/deepwiki-law.test.ts`. That is the
part that lives in this tree, so it is the part a law can reach.
[ADR-0051](docs/adr/0051-the-generated-wiki.md) records why a third party
publishes a document about this project at all, what it costs, and the bound that
makes it free — it is free and uncredentialed only while this repo is public.

## Watched-repo envelope

Rhizomorph watches **every repository an agent is working in**, discovered from
the process table rather than chosen at boot ([prd-58](docs/prds/prd-58-the-watched-machine.md)
ruling 1). The client still draws one colony at a time; the others are counted,
listed and — when a lane in them needs a person — surfaced on the tray.

**The stated ceiling is the number of instruments you would otherwise run.**
Each watched repo gets its own poll loop and its own recorder, because a
recording's genesis hash contains the repo slug and `mergeRecords` refuses
across it — so N repos has always meant N recorders, and this feature removes
the need to run N *processes*, not the per-repo cost of watching. A colony costs
what one rhizomorph has always cost.

What this PRD adds on top of that is **discovery**, and it is measured rather
than reasoned (ruling 7, Success 7). On Linux, over three real repositories and
one linked worktree, `packages/server/src/server/colonies.bench.test.ts`:

```
3 colonies from 4 placed actors (one linked worktree)
  cold (first sighting, 4 git calls): 11.78 ms
  warm, 200 ticks: p50 0.0145 ms · p95 0.0318 ms · max 0.1146 ms
  warm p95 as a share of the 2000 ms interval: 0.0016%
```

The cold number is paid once per directory, ever: the resolver caches each
answer, negatives included, so a steady machine spawns no `git` at all after the
first sighting of each agent. The warm p95 is **0.0016% of one poll interval**,
which is why the envelope is not bounded by discovery.

**Two honest limits**, neither of them a number:

- **On Windows the process leg reports no working directory for any process**, so
  no colony can be discovered there and the instrument watches only the repo it
  was started in. `rhizomorph doctor` says so, counting the agents it could not
  place rather than presenting a short list as complete.
- **A repo with no agent in it is not a colony.** There is no act that adds one:
  a repository nothing is running in produces no facts this design would call a
  colony's, and the way to start watching one is to start working in it.

## Support matrix

**Nothing in this table is verified by CI any more.** GitHub Actions was retired
from this repository for cost, and no workflow has run since 2026-09-12. The
files under `.github/workflows/` remain in the tree as the declaration of what
each leg does — read them as a specification, never as evidence that anything
ran. What produces a verdict now is `scripts/ci-local.sh`, run by a contributor
on their own machine, which publishes a `Passed local CI` label and a per-sha
commit status through `scripts/pr-verdict.sh`.
[CONTRIBUTING.md](CONTRIBUTING.md#the-gate-standard) carries the standard and
what it does and does not prove.

| Platform | Status |
|---|---|
| Linux | **Where the verdict comes from.** `scripts/ci-local.sh` composes locally the same legs `.github/workflows/ci.yml` declares for `ubuntu-latest`, in the same order with the same gating. This is the platform a PR's `Passed local CI` label is almost always earned on. |
| WSL | The daily development platform — exercised constantly, just not by CI |
| macOS | **Declared, not currently witnessed.** `.github/workflows/ci.yml` still declares the `macos-latest` leg that ran build, suite, typecheck, lint and the boot smoke, and the `pack-smoke` job that covered it at both node legs; neither has run since Actions was retired, and nobody has re-run them by hand. Nobody daily-drives macOS either, so ergonomic rough edges are likelier here than correctness ones — and that gap is now wider than it was, not narrower. |
| Windows (native) | **Partial: installs and boots; the suite runs against a committed expected-fail list.** `.github/workflows/ci.yml` declares a `windows-latest` leg on the `pack-smoke` job at both node legs — packing the repo, installing the tarball into a clean project and booting the installed CLI under Git Bash, which is what first witnessed the `pathToFileURL` built-clone boot fix. `.github/workflows/windows-suite.yml` declares the full-suite run that compares failing files against `.windows-known-failures`, per file: a failure outside that list is red, a listed file that passes is a removal candidate, and every entry carries its cause class and evidence. `build-test-boot` has no Windows leg. **Neither declared job runs today**, and the local leg does not replace them here: `scripts/ci-local.sh` runs the suite raw and consults neither the expected-fail list nor `scripts/windows-triage.sh`, so it cannot go green on a native-Windows machine ([#457](https://github.com/launchpad-26/rhizomorph/issues/457)). A contributor on native Windows triages by hand, with `scripts/windows-triage.sh`. |

### The process witness is built per platform, and that is a different axis

The table above is about **what has been verified**. Which platforms the process
witness can actually read is a separate question with a separate answer, because
that reader is the least portable component this repo ships — `/proc` on Linux,
and two different base-system tools elsewhere.

**Linux and WSL2 — built.** One leg, not two: WSL2 runs a real kernel, so `/proc`
is native and complete for Linux-side processes and Node reports the platform as
`linux`. A Windows-side `claude.exe` is not visible from inside WSL, which is the
row below rather than this one.

**macOS — built, and it places as well as identifies.** Three base-system
reads: `ps -o …comm=` for argv[0] and every numeric field, `ps -o …command=`
for the rest of argv, and `lsof -d cwd` for the working directory, which macOS
exposes only through libproc. The open question was whether that last one works
without privilege; the capture settled it — `lsof` answers for every process
the reader owns, and an agent is always the reader's own user. So this leg has
Linux's shape rather than Windows', and `doctor` reports `provided` once an
actor has been seen.

Two things the capture taught that no man page does. `ps -o command=` is argv
joined by spaces with **no quoting**, and argv[0] of a real session contains a
space, so a whitespace split reads it as `…/Library/Application` and matches
nothing — which is why argv[0] comes from `comm`. And because there is no
quoting, argv[1..] cannot be recovered faithfully at all; only argv[0] is
exact. See `collectors/process/read-table-macos.ts` and
[the verification pass](docs/review/2026-09-16-prd57-macos-witness.md).

**Windows (native) — built, and it identifies agents without placing them.**
`Get-CimInstance Win32_Process` yields the command line, so identification ports
directly. The working directory does **not**: Windows does not expose another
process's cwd without native calls into the target. So this leg matches agents
and declines to place them — and since a lane is a place, a Windows actor reaches
no lane in this wave. `doctor` reports it `partial` with that reason, which is
neither the `provided` a complete leg earns nor the `absent` a platform with no
leg at all would get.
Placement arrives with the transcript and hook join
([prd-57](docs/prds/prd-57-the-universal-witness.md) ruling 3).

Why the rule is *capture first* rather than *write it from the documentation*:
a reader written from a man page proves we read the man page. prd-15 ruling 7
and [prd-57](docs/prds/prd-57-the-universal-witness.md) ruling 2 both draw that
line, and `fixtures/CAPTURE.md` is the recipe — including what to sanitise before
committing, since a capture emits your username and home directory by
construction.

**The Windows capture then taught that rule a second half, by breaking it.** With
the real bytes committed and every fixture test green, the first run against a
live table holding three real `claude.exe` processes matched **zero**: the tests
asserted that the capture PARSED and never that an agent MATCHED, and a Windows
basename is `claude.exe` where the roster holds `claude`. A capture proves the
format and cannot prove the match, because a capture is bytes and matching is
behaviour. So a leg owes a live run as well, and a record of what that run found
— [`docs/review/2026-09-16-prd57-windows-witness.md`](docs/review/2026-09-16-prd57-windows-witness.md)
is the Windows one, with the measured per-tick cost of both built legs in it.
macOS owes both.

**A local verdict is not a foreign-runner verdict, and the difference is the
point of the row above.** `scripts/ci-local.sh` runs on one contributor's
machine, with their Node, their line endings and their filesystem casing. The
three classes CI existed to catch — a case-only filename collision invisible on
Linux, a CRLF checkout changing what a fixture says, a machine-specific path —
are exactly the ones a single-machine verdict is worst at. Treat a green label
as "this passed somewhere", and attribute any red by failing **test name**
against a clean `main` rather than by file, because `.windows-known-failures`
names files and a new failure inside a listed file is invisible to a per-file
check.

**Node >= 22.22.2** — `engines` in `package.json` is the source of truth. The
`.github/workflows/ci.yml` matrix declares that exact minimum as its `min` leg,
and `scripts/ci-local.sh` runs at whatever Node the contributor has, so the
floor is currently declared rather than exercised. Older Node warns on install
and may not run at all; on Node 20 the `web` suite reports green counts with a
non-zero exit, which [CONTRIBUTING.md](CONTRIBUTING.md#running-it) explains.

## What the observer does not do

Read-only is the whole point for this hand, not a caveat — see
["The laboratory"](#trust) above for the one deliberately different hand,
what it's allowed to write instead, and how that's fenced:

- It never writes to the repo it's watching — no commits, no branches, no
  file changes.
- It never runs a git command that mutates anything (no merge, no rebase,
  no checkout, no push) — only read commands like `git worktree list`,
  `git log`, `git status`.
- It never sends a keystroke to an agent, never starts one, never stops one.
- It never merges a worktree or otherwise acts on what it shows you. The
  lane drawer's **ATTACH** button copies a `tmux`/`workmux` command to your
  clipboard; it never runs it. Every action after that is yours, in your
  own terminal.

## Maintenance

Released as-is. Issues are welcome, but there's no promise of response
times — this is a solo project maintained alongside everything else in
life, not a supported product with an SLA. If something's broken, file an
issue with what you ran and what happened; if you'd like to fix it
yourself, see [CONTRIBUTING.md](CONTRIBUTING.md).

The full suite (`npm test`), plus `npm run typecheck`, gates every change —
run `npm test` yourself for the current count rather than trust a number
pinned here: nothing in this file enforces one staying current, and a
literal count written here has already gone stale once (#238) and drifted
again since. Two scripts encode the landing discipline that keeps the suite
green: `scripts/fence-lint.sh` checks a wave's declared issue fences *before*
dispatch (vague fences, overlapping claims, gaps against a known coupling
point); `scripts/gate.sh` is the **operator's** landing step, not a lane's —
fence compliance, a clean rebase, no NUL bytes, `npm test` + `npm run
typecheck` green (optionally repeated under concurrent load to catch
race-condition flakiness), then the actual merge to `main` and push. A
lane's own job ends at a verified, gate-clean commit handed back for that
landing step — see `AGENTS.md` for the working agreement this repo runs on.

---

Everything below this line is depth for once you've decided to run it:
what the picture on screen means, how replay works, the keyboard map, and
where the rest of the documentation lives.

## Prerequisites, restated

- **git.** The Rhizomorph watches a git working tree; the directory you
  point it at (default: cwd) must be one.
- **tmux — optional.** Without it, agent-status detection stays quiet (one
  `collector.disabled` event) and the fleet table, scene, and collisions
  panel all keep working off git alone.
- **[workmux](https://github.com/raine/workmux) — optional.** Without it,
  the same graceful degradation applies to workmux-specific state (lane
  labels, pane↔worktree wiring, the WAITING pathology); nothing else is
  affected.

Neither tmux nor workmux is required to see a working dashboard — `doctor`
(above) tells you exactly which of these are missing and what that costs.

## First run, nothing else set up

Start it inside a fresh clone of some other repo — no worktrees beyond `main`,
no tmux session, no telemetry configured — and here's exactly what you get,
not a placeholder. (That repo becomes the pinned colony: the one this run starts
in, first in the selector, watched on exactly the same terms as any other it
discovers later.)

- The **attention strip** at the top reads `ALL CLEAR`, with an evidence
  line ("0 lanes · 0 branches · 0 files checked · collisions 0") rather than
  bare reassurance — every figure in it is something the fleet object
  already checked. `main` itself isn't a lane (a lane is a dispatched
  worktree), which is why a fresh clone with nothing but `main` checked out
  reads as zero.
- The **burn strip** shows `0` output tokens and the gap-voice line `NO COST
  FEED (OTel) — dollars unavailable — run: eval "$(rhizomorph env <lane>)"`
  in place of a dollar figure, plus `CONDUCTOR NOT INSTRUMENTED` in place of
  an overhead ratio.
- The **scene**, the first thing under the two docked strips, shows a single
  lit mass (`main`) with nothing reaching out from it, and the **fleet
  table** right beneath it shows no rows at all — nothing dispatched yet.
- The **ledger** and **collisions** panel stay at their own honest-empty
  states ("collisions: 0 — checked 0 branches / 0 files") until something
  commits or two branches touch the same file.
- The **provenance bar** along the bottom shows one dot per collector (Git,
  Tmux, Workmux, Sessionlog, OTel) plus the SSE stream dot — a dot dims when
  its collector is disabled (nothing to report) and glows the broken hue when
  it's erroring, so "nothing to report" never looks like "something's
  wrong."

None of that is a bug — it's `doctor`'s job (above) to tell "nothing to
report" apart from "something's actually wrong."

## Telemetry (the money layer)

Point a real `claude` process at this Rhizomorph's built-in OTLP receiver and
its spend shows up live in the burn strip and the fleet table's `$` column.
Every lane needs `CLAUDE_CODE_ENABLE_TELEMETRY=1`, an OTLP/HTTP JSON
exporter aimed at the running server, and an
`OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<worker|conductor|auxiliary>,instance=<id>`
tag so the event lands on the right row — the receiver refuses any export
that doesn't carry the instance id of the Rhizomorph it's meant for. With
the server already running (`env` reads that id from `/api/meta`, so it
refuses to print a block for a port nothing is listening on), get the exact,
export-ready block for any lane with:

```sh
npm start --silent -- env <lane> [--role worker|conductor|auxiliary|unattributed] [--port <n>]
eval "$(npm start --silent -- env test-lane)"   # then launch claude in the same shell
```

(`--silent` is npm's flag, not rhizomorph's — it just keeps npm's own
`> rhizomorph@0.1.0 start` banner out of the block that `eval` reads;
without it, `eval` chokes on that first line.)

A worker lane gets this by being dispatched through the tracked wrapper —
`workmux add … -a "bash scripts/lane-agent.sh <model>"` — because the env
has to be exported *inside the process that execs the agent*. A pane-command
env prefix looks like it works and does not; `.workmux.yaml` carries that
scar in its own comments, which is why the wrapper exists. A conductor, or any lane whose Claude
Code session-log directory lives outside the worktrees this repo's
`sessionlog` collector would otherwise discover (a cross-filesystem or
cross-machine conductor, say), is picked up with the repeatable
dialect's own user-level session directory and attributed `role: conductor` automatically.
Full walkthrough — the cross-machine note, the subscription-dollars honesty
note, live proof of the `OTEL_RESOURCE_ATTRIBUTES` lane tag — lives in
[`docs/telemetry.md`](docs/telemetry.md).

### Hooks (declared attention)

A beacon is a lane declaring its own attention — `waiting`, `working` or
`stopped` — rather than the instrument guessing it from transcript shape
(prd-27 ruling 4). Declared beats inferred: the false summons of #133 was
inference getting it wrong, and a hook that fires on the harness's own
lifecycle event cannot be fooled the way a transcript-shape heuristic can
(ADR-0036).

Print the fragment for a lane with the server already running:

```sh
npm start --silent -- env <lane> --hooks claude    # prints a {"hooks": …} fragment
```

Merge the fragment into that lane's `.claude/settings.json` (or
`settings.local.json`) `hooks` block, then start Claude Code in that worktree.
Each of the four hooks Claude Code fires maps to one attention kind:

| hook | kind |
|---|---|
| `Notification` | `waiting` |
| `Stop` | `stopped` |
| `UserPromptSubmit` | `working` |
| `PostToolUse` | `working` |

Three honesty notes. The server must be running when the fragment is printed —
it names the repo's own beacon directory, read off the same `/api/meta` scrape
`env` already uses. The CLI and the server must see the same
`RHIZOMORPH_DATA_DIR`, or the hooks and the collector disagree about where the
beacons live. And **`Notification` is the only source of `waiting`, and it
fires only when Claude Code actually stops to ask** — a lane left in the
default auto-accept-edits permission mode never opens a dialog, so it declares
`working` and `stopped` forever and the summons this feature exists to raise
never arrives. That is a property of the harness, not of the hook: the fix is
the lane's permission mode, not the fragment.
`packages/server/src/collectors/beacon/fixtures/CAPTURE.md` is the worked
example: a real capture of these hooks firing, recipe included.

## Performance

Two numbers a stranger loading a real recording would otherwise hit blind,
both measured on this project's own build-day sessions and fixed rather than
merely noticed:

- **Loading a long replay: ~20.9s of blocked main thread → ~25ms.** A 55,000-
  event session used to fold onto the page as 55,000 synchronous `setState`
  calls before the tab became interactive — 62 long tasks, over 224 seconds
  of blocking, one single task past 31 seconds, zero animation frames
  sampled while it ran. `useEventStream` now buffers incoming events and
  folds once per animation frame instead
  ([`packages/web/src/hooks/useEventStream.ts`](packages/web/src/hooks/useEventStream.ts),
  issue #183) — the same 55k-row session now costs ~25ms of main-thread work.
- **A 30-lane fleet with 200 retired scars, inside the 60fps frame budget.**
  Before caching, building that scene's display list cost 28.37ms/frame —
  170.2% of the 16.7ms a 60fps frame allows, well over budget. After caching
  the parts of a scar that don't change frame to frame, the same scene costs
  11.95ms — 71.7% of budget, comfortably inside it
  ([`packages/web/src/scene/perf.test.ts`](packages/web/src/scene/perf.test.ts),
  issues #175/#178) — a real, currently-running assertion, not a one-time
  measurement quoted from memory.

## Architecture

Event-sourced core (`packages/core`), collectors + Fastify API + CLI
(`packages/server`), and a React + Tailwind dashboard (`packages/web`)
sharing one set of selectors between the live view and replay, plus one
derived **fleet object** — the attention strip, fleet table, burn strip and
scene are four views of it and of nothing else. The scene itself is a
hand-rolled **WebGL2** painter with a 2D overlay for text and marks
([ADR-0021](docs/adr/0021-webgl2-for-the-living-scene.md), superseding the
canvas-2D era of [ADR-0006](docs/adr/0006-canvas-2d-over-webgl.md)) — no 3D
library either way: prd7 measured the then-canvas scene already locked to
60fps with zero `shadowBlur` calls, found "janky" was the form language
rather than the renderer, and removed the react-three-fiber dependency it
was originally scaffolded on; the move to WebGL2 came later, for the living
scene's own reasons. Full write-up
in [`docs/architecture.md`](docs/architecture.md); the product brief is in
[`docs/prds/done/prd-00-the-rhizomorph.md`](docs/prds/done/prd-00-the-rhizomorph.md), the visualization design rulings in
[`docs/prds/done/prd-03-viz-design-study.md`](docs/prds/done/prd-03-viz-design-study.md) and [`docs/prds/done/prd-04-human-facing.md`](docs/prds/done/prd-04-human-facing.md). See
[`docs/demo.md`](docs/demo.md) for the falsifiable demo script.

## Dashboard

The curated, top-to-bottom hierarchy ([ruling 6](docs/prds/done/prd-03-viz-design-study.md), reordered by
[prd4 ruling 2](docs/prds/done/prd-04-human-facing.md)) answers, in order: *does anything need me* →
*what is it costing* → *what is the fleet doing* → *who is doing what* →
*what happened* → *where did this come from*. The scene moved up to third
place, directly under the two docked strips: it's big, bright and
self-explanatory, so a first-time viewer reads it before the reference
instruments beneath it.

- **Attention strip** (docked top) — calm state is `ALL CLEAR` with an
  evidence line (lanes · branches · files checked · collisions); alert state
  is `N NEED ATTENTION` with up to four named, click-to-jump chips (lane +
  why + how long), `+N` beyond that. At `NEEDS-YOU` and above the browser
  tab itself flips (`● N need you`, favicon swaps color) so the signal
  survives a background tab.
- **Burn strip** (docked top, beside the attention strip) — four numbers, no
  chrome: output tokens, dollars (once an `llm.cost` event is authoritative),
  burn rate, and the conductor/worker overhead ratio. Any missing piece
  speaks the gap voice instead of guessing (`NO COST FEED (OTel) — …`,
  `CONDUCTOR NOT INSTRUMENTED — …`).
- **Scene** (the centerpiece, [prd4 ruling 2](docs/prds/done/prd-04-human-facing.md)) — the mycelium
  pulse-network ([ruling 28](docs/prds/done/prd-03-viz-design-study.md)): root-mass at the center, one
  tendril per lane, pulses of light traveling along them for real events
  (commits, token bursts) — never invented, never on history. Four channels,
  each a different fact, none of them a decoration:
  - **Thread width — how much a lane has produced**, on an absolute scale
    ([prd6 ruling 1](docs/prds/done/prd-06-living-cycle.md)): a 20K-token lane draws the same width
    whether it's alone or next to a 500K-token whale. Nothing balloons — the
    scale is capped.
  - **Distance from the mass — how far through its life a lane is**
    ([prd6 ruling 4](docs/prds/done/prd-06-living-cycle.md)): born close in, growing outward as it
    works, coming to rest at the rim when it retires. No legend needed —
    "closer to the middle" reads as "newer" on its own.
  - **Angle — identity**, stable for the whole session (a lane keeps its
    slot on the ring no matter how its status changes).
  - **Brightness — recency**: how long ago a lane last did something,
    independent of how far through its life it is.

  Looping, frozen, waiting, expensive, and off-fence lanes each read as an
  unmistakably different *shape* on their thread, not a color alone (see
  "The palette" below). It's also a place you can go: drag to pan, Ctrl/Cmd
  + wheel to zoom at the cursor, and a finished lane cuts loose from the
  mass rather than sitting there dyed a different color — see "The camera"
  and "The cord-cut" below. The root-mass itself is clickable: it opens the
  same drawer a lane does, on the conductor's own conversation. Lazy-loaded
  behind an error boundary: if it breaks, the rest of the panel grid stands
  alone. A "Focus Scene" button fills the whole viewport with it.
- **Fleet table** — one dense row per lane: state, output tokens, `$`,
  request/tool counts, thread/subagent count, age, and fence status. The
  STATE column draws the scene's own glyph *and* the scene's own hue at row
  scale, so this table is the scene's legend for both shape and color — no
  separate key needed to read the picture above it. Its own footer names
  three keyboard verbs: `n`/`Shift+n` jumps the shared selection to the
  next/previous lane that needs you, `f` focuses the table full-screen, and
  `a` copies that lane's attach command — see "Keyboard reference" below
  for the full set, scene included.
- **Ledger** — the deep per-branch/thread spend table the burn strip
  summarizes; cost and token totals, model, first/last seen, elapsed.
- **Collisions** — demoted to calm chrome until it matters: a real collision
  escalates straight to the attention strip, and the panel's own empty state
  carries evidence (`collisions: 0 — checked N branches / M files`) rather
  than bare reassurance.
- **Activity feed** — commits, landings, lane starts/stops, and collector
  events in one quiet, filterable-by-kind-and-by-lane stream.
- **Provenance bar** (docked bottom) — one dot per collector (Git, Tmux,
  Workmux, Sessionlog, OTel) plus the SSE connection dot; a dead collector
  escalates to the strip too, and speaks the same gap voice here.
- **Lane drawer** — click any fleet row to open it. Vitals (state, output,
  cost, age, fence, worktree) sit fixed above one tabbed body that gets the
  drawer's full height rather than four independently-scrolling boxes —
  **ACTIVITY, CONVERSATION, WHY, TRACE**, in that order, opening on ACTIVITY
  by default (an operator ruling: the activity ledger tells you whether the
  conversation is worth reading before you commit to it). **CONVERSATION**
  is the same thing you'd see sitting at that agent's own terminal — user
  turns marked with a `›` prompt, assistant prose in the page's own type,
  tool calls as quiet one-line bullets between them (`● Read — path/to/file`,
  `⎿ result, …+2K more` when a result was cut) — tailing the session log live
  and pausing (and saying so) once you scroll up. It caches the last-good
  page it read per lane, so switching back to one you've already opened
  resumes instantly instead of re-showing a loading frame, and a transient
  gap from the server (an absent/error tick) never blanks a conversation
  that's already on screen — it holds what it has and marks it `stale ▪`
  rather than erasing it. **WHY** names every file this lane has touched
  against its declared fence, a click-through back into ACTIVITY's own
  reading of the trespass. **TRACE** is the beta waterfall (see
  [`docs/telemetry.md`](docs/telemetry.md#enabling-beta-traces)) when spans
  are wired in, an honest gap otherwise. Below all of it, an **ATTACH**
  button that copies the exact `tmux`/`workmux` command for that lane to
  your clipboard — it never runs anything; interaction happens in your own
  terminal. Closing it (**Esc**, or the drawer's own close) always takes
  precedence over exiting panel focus. **Click the root-mass and the same
  drawer opens on the conductor** — the same frame, the same tabs, the same
  copies-never-executes ATTACH, just with main's own vitals up top (branch,
  worktrees landed, commits observed on it) instead of a lane's. An
  un-instrumented conductor says so in the gap voice rather than showing an
  empty pane.
- **Panel focus** — every panel has a "Focus" affordance that fills the view
  with just that panel; **Esc** restores it. No drag/resize/custom layouts.
- **Replay** — a full mode shift, not a tinted live view: the attention strip
  is replaced outright by a REPLAY banner (timestamp, session identity, an
  "Exit to live" button) in an ice-register frame, never a ladder hue, so a
  recording can never be mistaken for a live summons. The replay bar has a
  one-click **"Replay this session's birth"** button — it picks the recorded
  session with the most history and jumps straight into playback — plus a
  session dropdown and speed control (1x/4x/16x); live and replay share one
  reducer, so every panel above freezes to the scrubbed instant exactly as it
  would live. The dropdown names each session by its title — an operator
  label if one was set (`rhizomorph label`), else the auto-title
  `rhizomorph sessions` also shows — never a bare timestamp you'd have to
  decode.

  Underneath the transport sits **the dock** (prd13, cut to its final shape
  by ruling 13): a sparse **chapter-mark lane** above the scrubber, one mark
  per lane-born/landed/gate-held/summons/session-boundary moment, coalescing
  into a `×N` count under density the same way everything else in this app
  coalesces rather than invents. Hover a mark (or a cluster) for a portaled
  card — mounted straight to `document.body` rather than nested in place,
  so no ancestor's clipping or stacking context can bury or cut it off —
  naming who/what/when for every member. `Shift`+wheel zooms the mark lane about the *cursor's own
  timestamp*, never the whole scrubbable range (that stays full-width
  always); `[`/`]` step to the neighbouring chapter. What prd13 shipped and
  then walked back: a per-lane density band (state-fill strips, a row per
  lane) was cut outright on 2026-08-06 — *"get rid of the working green
  strips entirely"* — because it still read as noise to the one person using
  it after three rounds of fixes. What's left is exactly the marks, the axis,
  and the transport; nothing else. See [`docs/demo.md`](docs/demo.md) for the
  full replay check.

### The palette — the fleet table teaches it, the scene speaks it

Every state gets a real color, not just a glyph. Six hues, each meaning
exactly one thing everywhere in the app:

| Hue | Means | Where you'll see it |
|---|---|---|
| Green | Productive | `WORKING` (bright) and `done` (dimmer) — the same green at two brightnesses |
| Amber | Blocked on a human | `waiting` (muted, benign) and `NEEDS-YOU`/`WAITING` pathology (incandescent) — again one scale, two brightnesses |
| Red | Dead | `FROZEN` only — red never means anything softer than that |
| Cyan | Notice/anomaly | `EXPENSIVE`'s needle taper and the licks coming off it — something changed, nobody is summoned |
| Ice (blue-grey) | Structure, nothing to say | `idle`, `unknown`, and all of the chrome |

You don't need this table to read the app: the **fleet table's STATE column
is the legend**, in both senses. It draws the scene's own glyph (a coil for
LOOPING, a severed bar for FROZEN, a raised hand for WAITING, a radial burst
for EXPENSIVE, fence posts and a barb for OFF-FENCE) at row scale next to the
plain-English word, in the same hue the scene paints that lane's thread with.

Brightness, not color exclusivity, is what marks an alarm: a calm lane may
wear its hue at a healthy brightness (no more "too dark to read" fleet), but
only a `NEEDS-YOU`/`FROZEN` mark reaches the band of luminance above it — so
a summons is always the brightest thing on the screen, never merely "also
colored." One lane at a time takes the spotlight; every other lane recedes
around it rather than being drowned in more color.

### The organic form — ribbons, taper, and the centre that melts

A thread is a **filled ribbon whose width varies along its own length**,
not a stroked centre-line with glyphs glued onto it:

- **Width is still work** — a thicker ribbon has produced more, on the same
  absolute, capped scale as thread width above. Every ribbon narrows a
  little from where it leaves the root-mass to where it ends, the way a
  real hypha does.
- **Taper is EXPENSIVE.** A lane burning far above the fleet's median draws
  its last stretch down to a needle, plus three short ribbons peeling away
  from the tip like heat leaving it.
- **Pinch is FROZEN.** A dead lane's ribbon narrows to nothing at two points
  along its own length — the thread is genuinely cut in two places.
- **A fold at the tip is done.** A finished lane's cord runs past its node,
  turns back on itself near its own width, and comes home into the lens —
  no two lanes fold quite alike, since the fold's reach, tightness, and bow
  all come off that lane's own name.
- **Swell is a commit, and swell is the way home.** A commit rides as a
  travelling widening in the ribbon's own girth — matter moving through the
  hypha — and the same channel carries a finished lane's substance home: one
  last swell runs down the severing cord into the root-mass before the
  freed end springs back.
- **Length is lifecycle** — how far a thread reaches from the mass is how
  far through its life that lane is.

**The centre is one surface**, not a stack of rings — several soft fields
blended together and walked into one closed contour. It bulges toward
whichever lane's work is arriving, swelling as that lane's cord parts, and
settles back once the merge is done, leaving only the mass a little thicker
than before. **It grows with the session's landed work**: every lane whose
cord has been cut has sent its substance back down the thread, so the mass
is visibly bigger by the end of a night than at the start — the honest
reading of a merge, the work is part of `main` now. The cap is absolute and
bounded to half the distance from the centre to the nearest point of the
retirement band, so the mass can never crowd the rim or the lane labels at
any zoom; what a fuller mass gains is interior structure (more layers
resolved between the skin and the core), not a bigger silhouette relative to
its own likeness.

**Every lane looks hand-grown, and no lane misreads.** A thread also wanders
a little off the straight line between the mass and its node, and its width
wobbles by a few percent along its length, so twenty lanes never look like
twenty copies of the same drafted arc. That variation is seeded from a hash
of **the lane's own name**, never from the clock, so it can only ever add a
stable, private wiggle — it never touches where a thread sits on its
lifecycle, what hue it wears, or how wide it's encoded to be. The practical
result: the same lane, in the same session, draws the same shape every time
you look at it and every time you replay the recording — on your machine or
on someone else's.

| | |
|---|---|
| ![A close-up on a bundle of lanes — ribbons visibly different widths and gentle, individual wander, each narrowing toward its own node](docs/screenshots/ribbon-taper.png) | ![The root-mass as one smooth, melted surface — no rings, ribbons entering it at their own taper](docs/screenshots/organic-centre.png) |

### Parked lanes — acknowledged, never hidden

Sometimes a worktree is deliberately shelved rather than abandoned — a
spike, an idea kept for later — and the Rhizomorph needs to say so without
treating it as a bug. An operator (never this read-only instrument) declares
that by adding `"parked": true` to that lane's entry in `.swarm/lanes.json`:

```json
{
  "version": 1,
  "lanes": [
    { "handle": "60-shelved-idea", "branch": "60-shelved-idea", "fence": ["packages/web/src/panels/shelved/**"], "parked": true }
  ]
}
```

A parked lane renders a dimmed `PARKED` in the fleet table's STATE column —
visible, never hidden — and is exempt from the FROZEN and inferred-WAITING
alarms and skipped by the attention ladder, since silence in a lane you
parked on purpose isn't news. Everything else about it (output, cost, age,
fence compliance) keeps reading its real telemetry: parked mutes the alarm,
never the evidence.

### The camera — drag, zoom, and a way home

The scene is a place you navigate, not a picture that sits still. Click or
tab into it first — the keys below are scoped to a focused scene, on
purpose (see "Keyboard reference"):

- **Drag** (left or middle button) pans.
- **Ctrl/Cmd + scroll** zooms at the pointer — the point under your cursor
  stays under it. A trackpad pinch arrives the same way (it's a ctrlKey
  wheel stream under the hood), so pinch-to-zoom works with no separate
  handling.
- **A plain scroll is not the camera's** — the scene sits in a page you can
  scroll past, so an unmodified wheel scrolls the page exactly as if the
  canvas weren't there.
- **`1`** zooms to fit the whole network in view; **`0`** resets to the
  start position; **`+`/`-`** step the zoom. The same four actions sit as
  on-canvas buttons bottom-right (**−**, **+**, **Fit**, **Reset**), so a
  trackpad-only reader never needs the keyboard.
- **Recenter** fades in automatically, in the same corner, whenever you've
  panned or zoomed the network out of view entirely — a click brings it
  back.
- The zoom range is deliberately bounded (0.4×–6×): further out and the
  threads go sub-pixel; further in and you're looking at a gradient, not a
  network.

### The cord-cut — a finished lane leaves the network, honestly

When a lane finishes — workmux declares it `done`, or its worktree is
removed — its thread doesn't just change color. It **cuts loose**: the
thread goes slack at the root, the freed end springs back toward its own
node, and what's left settles into a small, permanently dimmed **scar** near
the rim, carrying the lane's name and its output figure for the rest of the
session. It's a roughly 1.4-second sequence, not a jump-cut, so you can
watch a lane stand down rather than just noticing it vanished.

- **A scar never disappears, and it keeps its size** — a lane that did more
  work leaves a visibly bigger scar. It's dim, well below a living lane's
  floor, but never zero, because invisible completion looks exactly like a
  bug. The fleet table still lists the lane too; only the scene's own
  picture is affected by anything below.
- **Hide finished** (top-right of the scene) toggles scars out of the
  picture if a long session has accumulated a lot of them — it always shows
  its own count (`Hide finished · 12`), so "hidden" never reads as "gone,"
  and it's remembered across reloads. Hiding a scar never shrinks the
  root-mass back down — the work still happened.

A lane you've parked on purpose scars the same way, just without the
animation — there's no "moment" a standing declaration can play back.

### Germinating seeds — a returning lane grows from where it left off

Dispatch the same handle again after it's retired — a re-dispatch, not a new
lane — and its thread doesn't sprout from a stranger's spot on the other
side of the ring. It **germinates from its own dormant seed**: same angle,
same seat, and it starts already as big as the seed it grew from, because
the worker returning is the same one that did that earlier work.

### Motion, pause, and reduced motion

The scene breathes gently and pulses on real events, but every bit of that
motion is budgeted, not decorative — ambient motion (the root-mass's slow
breath) stays under 3%, event motion (a pulse for a commit or a token burst)
caps at five moving at once and folds overflow into one pulse carrying a
count, and structural motion (a lane appearing, reflowing, or cutting loose)
never bounces.

**Pause motion** (top-left of the scene) stops all of that outright — every
ambient and event animation freezes at the instant you press it, and it
says so in words (`Motion paused`), not just by looking different. If your
system is set to reduce motion (`prefers-reduced-motion`), the scene keeps
every color and brightness change but drops travel and scale on its own,
with no button needed.

### Amber ages with attention

A `NEEDS-YOU` chip in the attention strip tells you *how long* it's been
true, and that duration changes how insistent it reads — quieter right when
it fires, full brightness past two minutes, a slow deliberate pulse past
ten. What never changes is *which rung* it's on — age makes the same fault
read more urgently, it never promotes a lane to a worse one.

### Keyboard reference

Three independent registers, scoped by *where* you are rather than one
global keymap — a key means one thing while the scene has focus and can
mean something else everywhere else on the page:

| Key | Scope | What it does |
|---|---|---|
| `1` / `2` / `3` | Page (scene unfocused) | Switch the driving log: live / 20-lane fixture / pathology fixture |
| `1` | Scene (focused) | Zoom to fit the whole network |
| `0` | Scene (focused) | Reset the camera |
| `+` / `-` | Scene (focused) | Step the zoom in/out |
| `n` / `Shift+n` | Page (global) | Jump the shared selection to the next/previous lane that needs you |
| `f` | Fleet table (a lane in hand) | Focus the fleet table full-screen |
| `a` | Fleet table (a lane in hand) | Copy that lane's tmux/workmux attach command |
| `Esc` | Page (global) | Close the lane drawer, then exit panel focus — never both at once |

Click the scene once, or tab to it, to put the first three rows in scope;
click anywhere else (or press Esc) to give `1`/`2`/`3` back to the page.
Every key here is ignored while you're typing into a form field.

| | |
|---|---|
| ![Staged pathology fixture — five lanes, five distinct pathologies, each a different hue and shape, named in the attention strip and the fleet table's STATE column](docs/screenshots/fixture-pathology.png) | ![The lane drawer's conversation view — a real session's turns and tool calls, CLI-style, with the ATTACH button below](docs/screenshots/drawer.png) |
| ![The live view against this project's own real, in-progress build swarm, with a genuine OFF-FENCE alarm firing on a sibling lane](docs/screenshots/live.png) | ![Replay mid-scrub at 16x against this project's own real build history — the REPLAY banner, ice-register frame, timestamp and session identity](docs/screenshots/replay.png) |
| ![The scene paused — the pause button pressed, "Motion paused" stated in words, camera and hide-finished controls visible](docs/screenshots/paused.png) | ![A rim of scars from this project's own real, 43-worktree build history, around a root-mass visibly thicker for having taken all of that work home](docs/screenshots/scars.png) |
| ![MAIN's own drawer, open on the root-mass's own vitals — clicked like any lane, honestly reporting the conductor isn't instrumented rather than showing a conversation it doesn't have](docs/screenshots/main-drawer.png) | |

A note on the header: the app itself still shows the wordmark **THE
OBSERVATORY** on screen — the project's original name, kept there as a
design element. The package, the CLI, and the command are all `rhizomorph`;
only that one piece of on-screen chrome hasn't caught up, on purpose.

## The build-day context

This repo is also the build log for a day of running several coding agents
across git worktrees at once — the Rhizomorph is the app that day built,
and its first real subject was its own construction. `docs/` has the full
decision record: [`docs/vision.md`](docs/vision.md) for the pitch,
[`docs/architecture.md`](docs/architecture.md) for how it's built and why,
and the numbered `docs/prd*.md` files for the rulings behind each stage.

## License

[MIT](LICENSE)
