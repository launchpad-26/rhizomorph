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

A second, separate hand exists on top of that: the laboratory, reachable
only from your own command line (`rhizomorph lab checkpoint`/`fork`/
`compare`), never from the server or the UI. It creates git objects and
refs confined to `refs/rhizomorph/`, worktrees under its own data
directory, and — only when you pass `--launch` — hands a dispatch off to
`workmux add`, which is what creates an actual branch and tmux pane. It
never pushes, never merges, and never runs without you typing the command.
See the [Trust section](README.md#trust) for the full account, and
`packages/server/src/lab/namespace-law.test.ts` for the test that enforces
it.

## Mutating routes and the capability token

The dashboard itself can mutate exactly three things, each behind a button
the operator clicks (`packages/web/src/replay/mutating-calls-law.test.ts`
enumerates them and fails on a fourth): rotating the current recording
(`POST /api/rotate`), renaming a recording's label sidecar
(`POST /api/label`), and dispatching a laboratory fork
(`POST /api/lab/launch`). Every mutating request passes an Origin/Host/
Content-Type guard (`packages/server/src/server/mutation-guard.ts`) so a
foreign web page can't drive them cross-origin.

`POST /api/label` additionally requires `x-rhizomorph-capability`: a token
minted fresh each boot, held in memory, and delivered in-band — stamped
into `index.html`'s `<head>` as a `<meta>` tag at serve time, where the
dashboard's own JS reads it back
(`docs/adr/0012-in-band-capability-token-delivery.md`; the other two routes
adopt the same mechanism under #234). Stated plainly, what that buys and
what it doesn't: a caller with no access to the served page — no browser,
no ability to issue a loopback `GET /` — cannot rename anything; a local
process that *can* fetch the page gets the token exactly as the browser
does. A value handed to a page over unauthenticated loopback HTTP cannot
be hidden from something that can already reach that page.

If you find a code path that breaks either of those hands' fences — the
observer writing to the watched repo, the laboratory writing outside its
own namespace, anything listening on a non-loopback address, or anything
transmitting data off the machine — that's exactly the kind of thing this
file is for.

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
