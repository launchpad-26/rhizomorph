# Security

## What this tool actually does

Worth repeating here, not just in the README: watching is read-only,
absolutely. The observer — collectors, receiver, server, UI — never runs a
git command that changes anything, never sends a keystroke to an agent, and
never merges or launches anything, enforced by this repo's own readonly law
tests (e.g. `packages/web/src/drawer/readonly.test.ts`,
`packages/server/src/judge/mergetree.test.ts`).

Since [ADR-0052](docs/adr/0052-the-observer-reads-the-operators-own-agent-processes.md)
the observer also reads the operating system's **process table** — which agent
processes are running, their cpu and memory, and when one goes away. That adds
one more thing it must never do, and it is the sibling of the keystroke clause
above: **it never signals a process.** No kill, no stop, no continue, no
priority change. Reading `/proc` (or the platform's equivalent) is how it knows
an agent died; it has no way to be why. It watches git, tmux, and
workmux state in every repository it watches — the one you started it in and
any other your agents are working in — it reads your own Claude
Code session logs (`~/.claude/projects`) to show what your agents are
doing, and it reads your machine's **process table** to see agent processes
that no multiplexer and no transcript would reveal. It serves that over HTTP
on `127.0.0.1` only — nothing binds to a public interface, and nothing it
observes goes anywhere else **by any path this paragraph describes**.

That last clause used to read "nothing it reads is ever sent anywhere else",
and it stopped being true when the shipper shipped. One outbound path now
exists, it is off on a fresh install, and it is described in full under
[The shipper and the team server](#the-shipper-and-the-team-server) below:
one hand, one command that a human runs per repo, one destination, one
credential. Nothing else here sends anything, and nothing at all listens
except the loopback server above.

What the process reader keeps, and what it never touches (ADR-0052, prd-57
ruling 2): a process becomes an **actor** only when its command line matches a
known agent signature, and only its pid, dialect, start time, placement,
CPU/memory deltas and parentage among other actors are recorded. It keeps **no
command line beyond the match**, **no environment variable of any process**, and
**nothing whatsoever about a process that is not an agent** — this is not a
general process monitor, and "what is running on my machine" is a question it
must not answer. It never signals a process, not even signal 0, and it never
writes: `packages/server/src/collectors/process/process-law.test.ts` enforces
all three against the module's own source rather than trusting it to behave.

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

**A gap that was live here until 2026-08-26, recorded rather than deleted
because this document invites you to report exactly this class of escape.**
Restoring a checkpoint into a fork worktree runs `npm install` in it, and
it used to do so *without* `--ignore-scripts` — so a checkpointed tree
carrying a `preinstall`, `postinstall` or `prepare` hook executed that hook
as you, outside the ref-and-worktree namespace everything above describes.
The namespace law could not catch it, because its own fixtures only ever
exercised the `{install: false}` path: a fence asserted on the one route
the default never takes.

**Both halves are closed.** `packages/server/src/lab/restore.ts` now passes
`--ignore-scripts` on every install it runs, and
`packages/server/src/lab/namespace-law.test.ts` now exercises
`{install: true}` — the default path — against a fixture whose
`postinstall` attempts a write outside `refs/rhizomorph/` and fails if it
lands. Both shipped in prd-41 wave 2 and are on `main`; the account,
including what the plan got wrong, is in
[`docs/prds/done/prd-41-the-laboratory-is-confined-in-fact.md`](docs/prds/done/prd-41-the-laboratory-is-confined-in-fact.md).

Note what did *not* change: `install` still defaults to true, so a restore
still installs dependencies. What it no longer does is execute the
checkpointed tree's own lifecycle scripts. The confinement claim in this
section is now true of what the laboratory writes **and** of what a restore
can run.

Since #234, the launch route requires the same `x-rhizomorph-capability`
token `POST /api/label` does, on top of the Origin/Host/Content-Type guard
below. See the [Trust section](README.md#trust) for the full account.

If you find a code path that breaks either of those hands' fences — the
observer writing to the watched repo, the laboratory writing outside its
own namespace, anything listening on a non-loopback address, or anything
transmitting data off the machine **other than the shipper described below,
by the one act that enables it** — that's exactly the kind of thing this
file is for. The shipper is not the exception that swallows the rule: a path
that ships without that act, ships to somewhere other than the configured
team server, or ships something a portable record would not carry, is a
report worth making.

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

## The shipper and the team server

Everything above describes a machine that keeps what it sees. Since prd-51
there is one path off it, and this section is the boundary in full, because a
reader who gets this far should not have to infer it.

**What leaves.** Exactly the lines a portable record would carry for that
session — the list immediately above, unchanged — re-serialized through the
current event schema on the way out, never the log file's raw bytes
(`packages/core/src/wire/reserialize.ts`). That equality is the veil, and it
is the load-bearing clause: a field the current schema no longer declares
cannot survive re-serialization, so it cannot cross, and
`packages/server/src/shipper/veil.test.ts` plants one and watches it fail to.
Spend and token counts are in a record and are therefore on the wire. Prompts,
completions, transcripts and pane content are in no event, so they are on no
wire. `docs/record-format.md` Law 2 and its 2026-09-08 amendment are the
binding text.

**To where, and under whose act.** One team server, at the single URL named
when a human ran `rhizomorph connect team <url> --project <id>` in that repo.
There is no flag on the server, nothing in a config file elsewhere, and no
path from a collector, a background poll or the server's own boot —
`packages/server/src/shipper/hand-law.test.ts` reads this repo's own import
graph and fails the build if anything but that command can reach the hand or
start its timer. The hand opens no listening socket: v1 is outbound only, and
nothing comes back down to your machine. Deleting the shipper directory under
the data root removes the destination and the credential, and with neither the
hand cannot run.

**Membership is the boundary, and it is the whole of it.** A human reaches the
team view by signing in with GitHub, and the check is organisation membership:
`GET /orgs/{org}/members/{user}` on an installation token, where **204 is a
member and every non-204 is not** — including an invitation still pending,
which is not a membership (`packages/team/src/auth/membership.ts`). There is
no second tier, no per-project grant list and no sharing link. Being in the org
is what it means to be allowed to see the team's work, and leaving it is what
it means to stop.

**The two identity planes never fuse.** Humans hold GitHub sessions; machines
hold ingest keys, and neither is ever accepted where the other belongs. No
GitHub token is accepted on the ingest route, no key is derived from a GitHub
token, and the ingest hot path never calls GitHub at all. An ingest key is 32
random bytes shown once at mint and stored on the server **only as a SHA-256
hash** — a key it issued is one it cannot reproduce — scoped to one project,
and kept on the member's machine in exactly one file at mode `0600`: never in
argv, never in an environment variable, never in the browser, never in the
hash-chained record and never in a log line. `doctor` reports that a credential
is present, never its value.

**A revoked key is refused within one batch.** Revocation is a row flag, and
the flag is read **once per batch and never memoised** — a fresh read per
request, taken before a byte of the body is read
(`packages/team/src/api/http.ts`, `packages/team/src/keys/verify.ts`). That is
what bounds revocation lag to one batch interval; a verdict cached between
requests would unbound it silently, with every test still green. The check
**fails closed**: a storage that cannot answer *"is this key revoked?"*
produces a 503 and no journal write, rather than the tempting shape that
accepts the batch and refuses the acknowledgement — and the storage's own error
never reaches the wire, because a database error names a host, a port, a role
or a relation.

For the record, so a reader can check rather than trust: a shipper
authenticates every batch by presenting its key in the `x-rz-ingest-key`
request header on `POST /v1/rhizomorph/ingest`, and an ingest key is the
prefix `rzk_` followed by its random body. Those three values are held to the
team server's own declarations by
`packages/server/src/security-doc-law.test.ts`, so a rename on that side
reddens this document rather than quietly outdating it.

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

This server answers **fifteen** mutating routes in total, not three. Four more
are gated exactly as the three above are: `POST /api/lab/measure` (prd-53 ruling
3 — measuring runs a gate and records its verdict, so it is gated like the launch
it measures), and the concierge's three granted powers,
`POST /api/concierge/clone`, `POST /api/concierge/launch` (prd-20
ruling 1 / `docs/adr/0019-the-fourth-hand.md`) and `POST /api/concierge/enlist`
(prd-57 ruling 4 / `docs/adr/0053-the-fourth-hand-may-enlist-a-harness.md`) —
for the fourth hand the gate *is* the grant, so none of them may ever be reached
from a collector or a poll. The clone lands only inside the concierge's own
fenced namespace, `~/rhizomorph/repos` by default (`concierge/paths.ts`'s
`defaultClonesRoot`); the launch's one further write, a create-only transcript
copy (ADR-0020), lands only under `~/.claude/projects/<watched-repo-slug>/`,
never elsewhere under `~/.claude`.

**The enlist is the one that writes to a file you use every day**, and it is
bounded accordingly: exactly one file, `~/.claude/settings.json`, never inside
any repository; the original copied beside itself before a byte moves; exactly
the declared keys changed and an operator's own hooks and variables left alone;
a pre-existing OTLP endpoint refused by name rather than overwritten; and the
whole act reversible — `intent: 'unenlist'` puts the file back. It is also the
only route that cannot be reached in one call: the write requires a digest of
the diff, which the read returns and nothing else produces, so a write this
server cannot tie to a diff somebody saw does not happen.

A sixth, `POST /api/retarget` (prd-20 ruling 5's repo switch, #389), is
gated the same way and, since #216, has exactly one caller: the setup
wizard's conductor step, through
[`concierge/retarget.ts`](packages/web/src/concierge/retarget.ts) — the app's
sixth mutating call, enumerated in `replay/mutating-calls-law.test.ts`,
reachable from one file (`concierge/explicit-invocation-law.test.ts`), and
armed by one click before a second one acts. `api/retarget-law.test.ts` still
proves the server side is reachable only from the route registrar, never a
collector or a poll.

A seventh, `POST /api/operator/:act` (prd-17 ruling 1's operator door, #276),
records one of three human acts — `operator.ack`, `operator.verdict`,
`operator.note` — each stamped with the log offset it was decided against.
Recording a decision is not routing one (the PRD's own non-goal): the route
never gates, queues or notifies, it only appends the event the act already
produced, the same posture `POST /api/rotate` holds over the instrument's
own log.

An eighth, `POST /api/lab/comparisons` (prd-14 ruling 5, #213), is gated the
same way and, like the retarget, has no browser caller wired to it yet —
#214 is where the comparison surface's save control arrives. Its one write is
a sidecar file under the repo's own recording directory
(`packages/server/src/comparisons/store.ts`), never the watched repo and
never the laboratory's namespace
(`docs/adr/0041-a-saved-comparison-is-a-sidecar-not-an-event.md`).

The remaining four are the OTLP telemetry inbox (`POST /v1/metrics`,
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
