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

## A conductor (setup-agnostic — works from Windows, WSL, or elsewhere)

The conductor is often the largest single spender (prd1's whole point:
orchestration overhead is real and otherwise invisible) and it doesn't run
inside a workmux-managed worktree, so it needs the same env block by hand,
wherever it happens to run:

```sh
eval "$(observatory env conductor --role conductor)"
```

That expands to the same env block any lane gets
(`packages/server/src/cli/telemetry-env.ts`) — telemetry on, an OTLP/HTTP-JSON
exporter, `OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor` — so it
works identically whether the conductor's `claude` process runs on the same
box as the Observatory server, in a different WSL distro, or natively on
Windows while the server runs under WSL:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321
export OTEL_METRIC_EXPORT_INTERVAL=5000
export OTEL_LOGS_EXPORT_INTERVAL=2000
export OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor
```

(`OTEL_EXPORTER_OTLP_ENDPOINT` is the bare host:port — the OTel SDK appends
`/v1/metrics` and `/v1/logs` itself.)

If the conductor runs on a different machine or a different WSL distro than
the Observatory server, point `OTEL_EXPORTER_OTLP_ENDPOINT` at wherever the
server is actually reachable — WSL's localhost forwarding means a Windows-side
conductor can usually still reach a WSL-side Observatory over
`http://127.0.0.1:<port>` (or `http://localhost:<port>`), but a genuinely
separate machine needs the server's real host/IP and an open port. The
otel receiver has no auth — don't expose it beyond a trusted LAN/localhost.

**Instrumentation attaches at launch, not retroactively.** These are
environment variables read once when a `claude` process starts; a conductor
session already running when you read this cannot be retro-instrumented by
exporting the vars into its shell afterward — it has to be restarted with the
env block already in place. The spend panel's dollar headline treats a
conductor with zero `llm.cost` events as an honest gap
(`conductor not instrumented — see docs/telemetry.md`), not a zero, precisely
because this is a common way to end up mid-session with no conductor cost
data yet. See "Two overhead numbers" below for which figure that is and how
it differs from the token ratio in `@observatory/core`.

A conductor's own Claude Code **session-log** directory (the `sessionlog`
collector's source, `~/.claude/projects/<slug>`) may also live somewhere the
Observatory wouldn't otherwise discover — a different filesystem entirely
(`/mnt/c/Users/<u>/.claude/projects/<slug>` for a Windows-side conductor
talking to a WSL-side Observatory). Point the server at it with (repeatable):

```sh
observatory --extra-sessions /mnt/c/Users/<u>/.claude/projects/<slug>:conductor
```

The optional `:conductor` suffix names the lane this session dir shows up as
in the worktree table, the spend ticker and the ledger — without it, the
label defaults to `conductor` for the first `--extra-sessions` flag, then
`conductor-2`, `conductor-3`… for any further ones (`--extra-sessions` is
repeatable). Either way the label is never the raw `<slug>` — that's an
implementation detail of where Claude Code happens to store the session log,
not a name a human should have to read.

Sessions discovered under an `--extra-sessions` dir are attributed
`role: conductor` automatically, no matter what `role` the OTel export used —
the two collectors attribute independently and cross-validate rather than
sharing one flag. **This is history and replay, not the cost metric.**
Tailing those logs yields tokens, tool-call counts and a timeline for a
conductor session that already happened — genuinely useful for "what did the
conductor actually do" — but session-log lines carry no `cost_usd` field at
all (`research/2026-07-30-telemetry-capture-routes.md` §S2). So a directory
full of token counts is not proof the conductor's dollars were ever measured,
and the spend panel's dollar headline says so.

## What is a token (not a unit)

**Operator ruling, 2026-07:** a "token" is not one unit. `TokenTotals`
(`packages/core/src/events/telemetry.ts`) carries four cache tiers that price
out very differently, so summing all four into one number and calling it "the
tokens" hides a mix of things worth up to ~50x apart. The Observatory's
standing rule since this ruling: **no unlabelled all-tier total, anywhere in
the product.** `TokenTotals.total` still exists on the type for a caller that
genuinely wants the raw sum, but nothing sorts, ranks, or headlines by it, and
no panel renders it without naming the tiers behind it.

### The four tiers

- **output** — tokens the model produced this turn: the actual work. This is
  the headline figure everywhere the dashboard shows a single token count,
  because it is immune to being inflated by, say, a polling conductor
  re-reading its own growing context every cycle.
- **input** — fresh, not-previously-cached tokens read into context: new
  material the model had to actually process cold.
- **cache read** (`cacheRead`) — tokens served from the prompt cache: context
  that was already primed on an earlier turn and is being re-read now, cheap
  because the model doesn't reprocess it from scratch.
- **cache write** (`cacheCreation`) — tokens newly written into the prompt
  cache this turn, so a later turn can read them cheaply instead of paying
  input price again.

### Price ratios (as of 2026-07)

| Tier | Relative to input |
|---|---|
| output | ≈5x |
| input | 1x (baseline) |
| cache write (`cacheCreation`) | ≈1.25x |
| cache read (`cacheRead`) | ≈0.1x |

These are ratios across current Claude models, checked against Anthropic's
published per-model pricing as of 2026-07 — not a promise. Anthropic can and
does reprice models, and a new model generation can ship with a different
output/cache multiplier. Treat the exact multipliers as approximate and
re-check the provider's current pricing before leaning on them for anything
more precise than "output costs several times more than input, and a cache
read costs a fraction of it."

### Which number each dashboard surface shows, and why

- **Spend ticker headline** — OUTPUT tokens, labelled "output tokens — work
  produced." Beneath it, all four tiers render as their own labelled counts
  (`packages/web/src/lib/format.ts`'s `TOKEN_TIERS`); cache tiers are
  visually de-emphasized (dimmed, smaller bar segments) but never hidden.
  Once a real `llm.cost` event has arrived, the dollar total and $/hour rate
  sit alongside the token headline — dollars are never invented from tokens.
- **Ledger TOKENS column, worktree table token fallback, replay bar** — same
  output-led figure, with the full four-tier breakdown reachable via the
  existing `title=` tooltip. Never the bare all-tier sum.
- **Cost, with provenance, wherever OTel exists** — once a row has an
  authoritative `llm.cost` event, it shows real dollars instead of a token
  count at all; an estimate is flagged (`incl. estimate` / `est.`); a row
  with no cost telemetry shows tokens, never an invented `$0.00`.

### Rate limits: cache reads are why the tiers stay visible

Cache reads are the cheapest tier in dollars (≈0.1x input) but they are not
cheap against a **subscription plan's rate limit**. A lane that re-reads a
large, growing context on every turn — a polling conductor is the obvious
case — can burn through a meaningful share of the plan's rate-limit budget
almost entirely on cache reads while barely moving the dollar total. A reader
who only ever saw the output-led headline would have no way to see that
coming; this is why the four-tier breakdown stays visible under the headline
instead of collapsing into it.

### The overhead ratio's definition, and what it replaced

`RoleSpendSplit.overheadRatio` (`selectRoleSpend`,
`packages/core/src/selectors/spend.ts`) is **conductor OUTPUT tokens ÷ worker
OUTPUT tokens** — `null` unless both sides have reported output tokens,
`unattributed` spend excluded from both sides. prd1's original definition
divided all-tier totals; that definition was retired by this ruling, because
an all-tier ratio let a polling conductor's cache-read traffic (re-sending
the same growing context every poll) inflate the ratio far past what the
conductor's actual work — its output — cost. Output is immune to that
inflation, so it is the basis now.

This is a different number from the spend panel's headline overhead figure —
see the next section for the cost-based one and why the two are kept apart
rather than reconciled.

## Two overhead numbers, and which is which

There are two, they measure different things, and the audit's open question
("is `selectOverheadRatio` on tokens or cost?") is settled here:

| Where | What it divides | Reads |
|---|---|---|
| `selectOverheadRatio` / `RoleSpendSplit.overheadRatio` (`packages/core/src/selectors/spend.ts`) | conductor **output tokens** ÷ worker output tokens | `null` unless both sides reported output tokens |
| `selectCostOverhead` / `formatCostOverhead` (`packages/web/src/panels/spend/format.ts`), the spend panel's headline | conductor **dollars** ÷ worker dollars | `conductor not instrumented — see docs/telemetry.md` when the conductor has no `llm.cost` events |

Issue #47 replaced the *panel headline* with the cost-based figure (and its
commit message said "cost", which is what the audit tripped over). It did not
change the core selector, and issue #69 re-based that core selector from an
all-tier token sum to output tokens specifically (see "What is a token" above)
without changing which of the two numbers the panel displays: **the core
orchestration overhead ratio is and stays output tokens ÷ output tokens, never
cost.** Tokens are the honest basis there, because cost is structurally absent
for any lane the OTel exporter never covered — a sessionlog-only conductor has
real tokens and no dollars at all, and a cost-based core selector would report
`null` for it forever while a token-based one reports something true. The two
numbers are kept apart rather than reconciled: the panel refuses to print a
token ratio where a reader expects money, and the core selector refuses to pretend the
tokens it can see are dollars it cannot.

## How dollars reach a branch — the `sessionId` join

Neither collector alone can fill the ledger's COST column:

- an OTel `llm.cost` carries the dollars, the model and `session.id`, and
  `branch: null` / `worktreePath: null` — the exporter genuinely does not know
  where the agent was working
  (`packages/server/src/collectors/otel/parse-metrics.ts`);
- a sessionlog `llm.usage` carries `cwd`/`gitBranch` and the same session id
  (the log's own `sessionId`, falling back to the session-log filename, which
  *is* Claude Code's session id), and no dollars.

The reducer joins them on `sessionId` (`packages/core/src/reduce.ts`): every
telemetry event that names a place teaches a session-id → place index, and an
`llm.cost` with no place of its own is booked against whatever that index
knows. The join is order-independent — a cost that arrives before anything
knows where its session runs is stored unplaced and reconciled the moment the
usage side says. Each cost record keeps a `placeSource` saying which happened:
`source` (the event carried its own place), `session-join` (we filled it), or
`null` (still unplaced).

**Unplaced dollars stay visible.** A cost whose session nobody can locate keeps
its lane and its money, appears in the session total and in the lane row, and
simply does not appear under any branch or worktree. It is never guessed onto
the nearest branch and never dropped.

What this means in practice: for a lane's dollars to show up per-branch, the
same `claude` session must be **both** exporting OTel **and** visible to the
sessionlog collector (its own worktree, or an `--extra-sessions` dir). One
without the other gives you tokens with no dollars, or dollars with no branch —
both honest, both incomplete.

## Threads

`llm.usage`, `llm.cost` and `tool.activity` each carry an optional
`thread: main | subagent | auxiliary | null`, and `LaneSpend.threads` exposes
per-thread sub-totals under the lane (prd2's ruling: sub-rows under the parent
lane, never a lane of their own). `null` means *the source did not say* and is
rendered as unknown, never as `main`. Both collectors already receive the
markers — OTel's `query_source` attribute and the session log's `isSidechain`
— and parsing them into the field is issue #65; until then every record reads
`null` and no sub-rows appear.

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

The `sessionId` join was proven live for issue #64 against a running server:
the sessionlog collector was tailing a real worker session
(`sessionId: 34468970-…`, `branch: 64-cost-joins-branch`) while a
`claude_code.cost.usage` export for that same `session.id` — declaring a
*different* lane and, as the real exporter always does, `branch: null` /
`worktreePath: null` — was POSTed to `/v1/metrics`. The stored event kept its
nulls; the fold placed it: `placeSource: "session-join"`, and the branch
ledger read `64-cost-joins-branch  COST $0.4242` against 990,616 tokens —
dollars, not a token count in a money column. A second export naming a
session nobody had seen stayed on its own lane with `branch: null`, counted
in the session total and absent from every branch row.
