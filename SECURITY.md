# Security

## What this tool actually does

Worth repeating here, not just in the README: watching is read-only,
absolutely. The observer — collectors, receiver, server, UI — never runs a
git command that changes anything, never sends a keystroke to an agent, and
never merges or launches anything, enforced by this repo's own readonly law
tests (e.g. `packages/web/src/drawer/readonly.test.ts`,
`packages/server/src/judge/mergetree.test.ts`). It watches git, tmux, and
workmux state in the repo you point it at, and it reads your own Claude
Code session logs (`~/.claude/projects`) to show what your agents are
doing. It serves that over HTTP on `127.0.0.1` only — nothing binds to a
public interface, and nothing it reads is ever sent anywhere else.

A second, separate hand exists on top of that: the laboratory. It creates
git objects and refs confined to `refs/rhizomorph/`, worktrees under its
own data directory, and — when launched — hands a dispatch off to
`workmux add`, which is what creates an actual branch and tmux pane. It
never pushes and never merges. Two things trigger it, both an explicit
human action rather than anything a collector, background poll, or timer
could reach: typing `rhizomorph lab checkpoint`/`fork`/`compare` at your
own command line, or clicking the dashboard's launch button, which sends
`POST /api/lab/launch` to a server route that runs the exact same
`rhizomorph lab fork --launch` in-process. The laboratory module itself
(`packages/server/src/lab/`) is still imported from exactly one file outside
itself — the CLI wiring point that route also goes through — so the dashboard
button is a second hand on the same lever, not a new path into the module.
`packages/server/src/lab/namespace-law.test.ts` asserts that, with a known
blind spot: it asks, file by file, whether that file's own import specifiers
name `lab/`, and it never follows the import graph further. `api/lab.ts`
names `../cli/index.js`, so the reach that lands in the lab a hop later is
invisible to it — the law passes because it cannot see that path, not
because the path is absent. Read it as a check on who imports the lab
*directly*, not as a structural boundary; the specifier scan does see
dynamic `import()` calls, so the gap is the indirection rather than the
syntax. Nothing in the tree enforces the boundary itself today, and #245
tracks building something that would.
Since #234, the launch route requires the same `x-rhizomorph-capability`
token `POST /api/label` does, on top of the Origin/Host/Content-Type guard
below. See the [Trust section](README.md#trust) for the full account.

If you find a code path that breaks either of those hands' fences — the
observer writing to the watched repo, the laboratory writing outside its
own namespace, anything listening on a non-loopback address, or anything
transmitting data off the machine — that's exactly the kind of thing this
file is for.

## What a shared record contains

A session record (`rhizomorph export-record`, or the dashboard's download
button) is meant to be handed to someone else, so it is worth being precise
about what travels with it.

The narrow claim first, because it is the only one this project can make
without lying: **no captured tmux pane content enters an event.** The tmux
collector shells to `capture-pane`, derives a SHA-256 content hash and a
line count from what comes back, and discards the text. `pane.activity`
therefore says *that* a pane changed and *when*, never *what* it said. The
payload's key-set is fixed at `paneId`, `contentHash`, `previousHash`,
`lines`, and `packages/core/src/events/tmux.test.ts` fails if a fifth key
appears.

Until #292 that payload also carried `preview`: the last non-empty line of
the capture, verbatim. A log recorded before that change still holds those
lines on disk. They are stripped on the way into any record built after it —
a record's body is re-serialized from parsed events, and parsing drops keys
the schema no longer declares — and the stripped line still verifies, so an
old session exports as a complete record rather than one with a hole in it.
`packages/core/src/record/reserialization-law.test.ts` holds the mechanism,
`packages/server/src/cli/export-record.test.ts` and
`packages/web/src/recordings/export.test.ts` hold both export paths end to
end. Nothing rewrites the old log itself; if you want the raw lines gone,
delete the log.

What a record still carries, honestly:

- pane and window titles, and the workmux status line — free-form text that
  a program or your shell can set to anything, including a hostname
- absolute paths, which normally include your home directory and username
- git commit subjects, and the author's name and email address
- branch and lane names
- verbatim stderr from a git or tmux command that failed
- symbol names lifted from your own diff, in judge findings

A record is **not** scanned for secrets, and it cannot be cleaned up after
the fact: the body is a hash chain, so editing any line invalidates every
link after it. Read a record before you share it. There is no override flag
to record the use of, because there is no scan and no gate to override —
the boundary is the event schema, enforced at parse time.

## Mutating routes and the capability token

The dashboard itself can mutate exactly three things, each behind a button
the operator clicks (`packages/web/src/replay/mutating-calls-law.test.ts`
enumerates them and fails on a fourth): rotating the current recording
(`POST /api/rotate`), renaming a recording's label sidecar
(`POST /api/label`), and dispatching a laboratory fork
(`POST /api/lab/launch`). Every mutating request — these three and the
telemetry inbox below — passes an Origin/Host/Content-Type guard
(`packages/server/src/server/mutation-guard.ts`) so a foreign web page can't
drive them cross-origin.

All three dashboard-driven routes additionally require
`x-rhizomorph-capability`: a token minted fresh each boot, held in memory,
and delivered in-band — stamped into `index.html`'s `<head>` as a `<meta>`
tag at serve time, where the dashboard's own JS reads it back
(`docs/adr/0012-in-band-capability-token-delivery.md`). Stated plainly, what
that buys and what it doesn't: a caller with no access to the served page —
no browser, no ability to issue a loopback `GET /` — cannot mutate anything
through them; a local process that *can* fetch the page gets the token
exactly as the browser does. A value handed to a page over unauthenticated
loopback HTTP cannot be hidden from something that can already reach that
page.

This server answers **six** mutating routes in total, not three — the other
three are the OTLP telemetry inbox (`POST /v1/metrics`, `/v1/logs`,
`/v1/traces`), and they are **deliberately ungated**, not an oversight
(prd-23 ruling 6). Threading a per-process capability token into every
lane's environment block would fail worse than not gating it at all: the
token dies with the server on every restart while a lane's env block does
not, so an ordinary restart would silently kill every already-running
lane's telemetry — the invisible failure prd-19 exists to end. In place of a
token, the inbox checks the resource attributes every accepted export must
carry (the session id of the Rhizomorph instance it targets,
`packages/server/src/api/otel.ts`) and refuses — recording a throttled
`telemetry.refused` event, not merely dropping the request — anything
declaring a different instance or none at all. All six mutating routes, and
which of these two classes each falls into, are declared in one place —
`packages/server/src/api/index.ts`'s `ROUTE_CLASSES` — walked by a test that
fails the build if a new mutating route lands in neither class (prd-23
ruling 5, `docs/adr/0014-exhaustive-route-classification.md`).

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's
private vulnerability reporting instead: on the repository's **Security**
tab, **Report a vulnerability**. That reaches the maintainer without putting
details (or a working exploit) somewhere public before there's a fix.

Include what you'd include for any bug report — what you ran, what you
expected, what happened instead — plus why it matters from a security
angle specifically (what it exposes, or what it lets an attacker do that
the observer's read-only fence, the laboratory's namespace fence, or the
localhost-only listener is supposed to prevent).

## Response

This project is released as-is (see [README.md](README.md#maintenance)):
no SLA, no promised response time. Security reports get priority attention
over everything else in the queue, but "priority" here still means a solo
maintainer's own time, not a support contract.
