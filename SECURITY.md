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

**One live gap in that confinement, stated plainly because this document
invites you to report exactly this class of escape.** Restoring a
checkpoint into a fork worktree runs `npm install` in it, and it does so
*without* `--ignore-scripts` (`packages/server/src/lab/restore.ts`, whose
`install` option defaults to true). So a checkpointed tree carrying a
`preinstall`, `postinstall` or `prepare` hook executes that hook as you,
outside the ref-and-worktree namespace everything above describes — and
the namespace law never catches it, because its own fixtures only ever
exercise the `{install: false}` path. The confinement claim in this
section is therefore true of what the laboratory *writes* and not yet true
of what a restore can *run*. This is not news to the project: it is the
first Evidence item in
[`docs/prds/prd-41-the-laboratory-is-confined-in-fact.md`](docs/prds/prd-41-the-laboratory-is-confined-in-fact.md)
(blessed 2026-08-22), and closing it is a boarded issue in that
milestone's wave 2 — *a restored tree's install runs no scripts*. Until
that lands, treat `lab fork` on a checkpoint of a repo you do not trust as
running that repo's install hooks, because that is what it does.
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

This server answers **nine** mutating routes in total, not three. Two more
are gated exactly as the three above are: the concierge's granted powers,
`POST /api/concierge/clone` and `POST /api/concierge/launch` (prd-20
ruling 1 / `docs/adr/0019-the-fourth-hand.md`) — for the fourth hand the
gate *is* the grant, so neither may ever be reached from a collector or a
poll. The remaining four are the OTLP telemetry inbox (`POST /v1/metrics`,
`/v1/logs`, `/v1/traces`, and the bare-path fallback `POST /` that
`docs/adr/0018-bare-path-body-shape-routing.md` adds for an exporter which
never appends `/v1/<signal>`), and they are **deliberately ungated**, not an
oversight
(prd-23 ruling 6). Threading a per-process capability token into every
lane's environment block would fail worse than not gating it at all: the
token dies with the server on every restart while a lane's env block does
not, so an ordinary restart would silently kill every already-running
lane's telemetry — the invisible failure prd-19 exists to end. In place of a
token, the inbox checks the resource attributes every accepted export must
carry (the session id of the Rhizomorph instance it targets,
`packages/server/src/api/otel.ts`) and refuses — recording a throttled
`telemetry.refused` event, not merely dropping the request — anything
declaring a different instance or none at all. Which of those two classes each
mutating route falls into is declared in one place, `ROUTE_CLASSES`
(`packages/server/src/api/index.ts`) — and that is not a table of mutating
routes. It carries one row for **every** route this app answers, read and
mutation alike, under one of four classes: `gated-mutation`,
`ungated-mutation`, `gated-read`, `read`. `api/route-class-law.test.ts` walks
the real Fastify instance `buildApp` produces and fails the build if a
registered route has no row at all — and, since prd-29 ruling 1, if a row
calling itself gated names a route that does not actually carry the capability
`preHandler`, so deleting a gate is a red build rather than a later audit's
finding (prd-23 ruling 5, `docs/adr/0014-exhaustive-route-classification.md`,
amended by `docs/adr/0024-a-gated-read-is-the-fourth-route-class.md`).

**The token gates reads, too.** Until prd-29 ruling 1 / ADR-0024, `read` meant
"no check at all", which filed two different postures under one word: the
`GET /` shell a browser must be able to fetch tokenless, and the `/api` reads
that serve an agent's verbatim transcript, absolute paths and OS username on
the strength of a `Host` header any caller writes freely. A read that requires
the token is now its own class, `gated-read`, and these `GET` routes carry the
same `requireCapabilityToken` the mutations do: `/api/sessions`,
`/api/sessions/:id/events`, `/api/lanes`, `/api/transcript/:lane`,
`/api/lab/checkpoints`, `/api/lab/experiments`, `/api/lab/estimate`, the four
reads that postdate the route arithmetic — `/api/lane-index`,
`/api/lane-index/:handle`, `/api/session-preview/:sessionId` and
`/api/concierge/repos` (prd-29 ruling 7, #58) — then, as of wave 2a (prd-29
ruling 7, #59), `/api/meta` and `/api/doctor` themselves, and as of wave 2b
(prd-29 ruling 4, #60), `/api/stream`. The stream carries the same gate as the
rest, with one addition: because `EventSource` cannot set a custom header at
all, its `preHandler` also accepts the token from an HttpOnly, SameSite=Strict
cookie the HTML serve sets beside the meta tag. That cookie is an alternate
credential on `gated-read` routes ONLY — no mutation honours it, and
`api/security.test.ts` asserts that refusal against the very default gate every
mutation uses, rather than trusting the wiring to stay right.

What is *not* gated, stated here rather than left to be discovered: `GET /*`,
and now only `GET /*`. It stays tokenless **forever**, named that way in its
own row: it is the bootstrap the in-band `<meta>` delivery above depends on,
and gating it would break both the browser's first paint and
`rhizomorph rotate`'s scrape.
The ceiling stated above applies to all of this without exception — read-gating
cannot stop a local process that can already fetch the page, and nothing here
should be read as claiming otherwise.

One further control belongs in this account, because it bounds what the served
page may do rather than what a caller may ask for. Every HTML response carries
a Content-Security-Policy (`CONTENT_SECURITY_POLICY`,
`packages/server/src/server/static.ts`;
`docs/adr/0027-the-served-page-declares-its-own-security-policy.md`, accepted
2026-08-21): `default-src 'self'`, scripts self-only with no `eval`,
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'none'` — and assets additionally carry
`X-Content-Type-Options: nosniff`. Before it, the static route streamed HTML
with no policy at all, so the page ran with everything the platform allows,
`eval` included, on the say-so of nobody. `server/static-csp.test.ts` fails if
an HTML route loses the header, or if the policy ever grows `unsafe-eval` or an
absolute origin.

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
