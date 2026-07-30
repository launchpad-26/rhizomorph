# Telemetry — enabling prd1's money layer

> How to point a real `claude` process at this Observatory's OTLP receiver so
> its spend shows up live. Background and payload shapes:
> `docs/prd1.md`, `research/2026-07-30-telemetry-capture-routes.md`.

## The short version

Every lane's `claude` process needs three things: `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
an OTLP/HTTP JSON exporter pointed at this server, and an
`OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<role>` tag so the event lands on
the right row in the spend ticker. Get the exact block for any lane with:

```sh
observatory env <lane> [--role worker|conductor|auxiliary] [--port <n>]
```

`--port` defaults to 4321 (the Observatory's own default); pass whatever
`--port` you actually started the server with. The output is `export`-ready:

```sh
eval "$(observatory env test-lane)"
claude -p "..."
```

## Workers (workmux)

`.workmux.yaml` in this repo already does this for you — every new worktree's
agent pane runs `claude` prefixed with the env block above, `lane` set to the
worktree's own directory name (`$(basename "$PWD")`, the same handle workmux
and the worktree table use elsewhere) and `role=worker`. Nothing to enable by
hand; a lane created after this file landed exports telemetry automatically.
If you retarget the Observatory to a different port, update the
`OTEL_EXPORTER_OTLP_ENDPOINT` in `.workmux.yaml`'s `panes` block to match, or
existing lanes will export to a receiver that isn't listening (a silently
dropped export, not a crash — `claude` doesn't hard-fail on a bad OTLP
endpoint).

## A conductor (cross-machine note)

The conductor is often the largest single spender (prd1's whole point:
orchestration overhead is real and otherwise invisible) and it doesn't run
inside a workmux-managed worktree, so it needs the same env block by hand:

```sh
eval "$(observatory env conductor --role conductor)"
```

If the conductor runs on a different machine or a different WSL distro than
the Observatory server, point `OTEL_EXPORTER_OTLP_ENDPOINT` at wherever the
server is actually reachable — WSL's localhost forwarding means a Windows-side
conductor can usually still reach a WSL-side Observatory over
`http://127.0.0.1:<port>` (or `http://localhost:<port>`), but a genuinely
separate machine needs the server's real host/IP and an open port. The
otel receiver has no auth — don't expose it beyond a trusted LAN/localhost.

A conductor's own Claude Code **session-log** directory (the `sessionlog`
collector's source, `~/.claude/projects/<slug>`) may also live somewhere the
Observatory wouldn't otherwise discover — a different filesystem entirely
(`/mnt/c/Users/<u>/.claude/projects/<slug>` for a Windows-side conductor
talking to a WSL-side Observatory). Point the server at it with (repeatable):

```sh
observatory --extra-sessions /mnt/c/Users/<u>/.claude/projects/<slug>
```

Sessions discovered under an `--extra-sessions` dir are attributed
`role: conductor` automatically, no matter what `role` the OTel export used —
the two collectors attribute independently and cross-validate rather than
sharing one flag.

## The subscription-dollars honesty note

On a metered API key, `cost_usd` from OTel is a real dollar figure. On a
**subscription plan** (Team/Pro/Max — no API key, the common case for this
build day), the cost the CLI reports is still computed and still real
per-request, but it isn't money actually changing hands per call — you're
already paying a flat rate. The number's honest meaning there is **efficiency
and rate-limit budget**: which lane is burning the most of your plan's
capacity, not a literal invoice line. The spend ticker's copy says this
outright rather than let a subscription user read the total as a real bill.
Dollars stay the universal unit either way — API-key users get a literal
cost, subscription users get a comparable efficiency signal — so the same UI
serves both without a mode switch.

## Live verify

`OTEL_RESOURCE_ATTRIBUTES` lane tagging was the research note's one unrun
claim (§ "Open questions"). It was proven live for issue #36: a real
`claude -p` run exporting `OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker`
to a running Observatory's `/v1/metrics` produced a stored `llm.usage` /
`llm.cost` event carrying `lane: "test-lane"` — see that issue's summary for
the exact request/response evidence.
