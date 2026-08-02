# Security

## What this tool actually does

Worth repeating here, not just in the README: the Rhizomorph is read-only. It
watches git, tmux, and workmux state in the repo you point it at, and it
reads your own Claude Code session logs (`~/.claude/projects`) to show what
your agents are doing. It serves that over HTTP on `127.0.0.1` only — nothing
binds to a public interface, and nothing it reads is ever sent anywhere else.
It never runs a git command that changes anything, never sends keystrokes to
an agent, and never merges or launches anything. If you find a code path
that does — writes to the watched repo, listens on a non-loopback address,
or transmits data off the machine — that's exactly the kind of thing this
file is for.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's
private vulnerability reporting instead: on the repository's **Security**
tab, **Report a vulnerability**. That reaches the maintainer without putting
details (or a working exploit) somewhere public before there's a fix.

Include what you'd include for any bug report — what you ran, what you
expected, what happened instead — plus why it matters from a security
angle specifically (what it exposes, or what it lets an attacker do that
the read-only, localhost-only design is supposed to prevent).

## Response

This project is released as-is (see [README.md](README.md#maintenance)):
no SLA, no promised response time. Security reports get priority attention
over everything else in the queue, but "priority" here still means a solo
maintainer's own time, not a support contract.
