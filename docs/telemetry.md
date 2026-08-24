# Telemetry — enabling prd1's money layer

> How to point a real `claude` process at this Rhizomorph's OTLP receiver so
> its spend shows up live. Background and payload shapes:
> `docs/prds/done/prd-01-money-layer.md`, `research/2026-07-30-telemetry-capture-routes.md` [never committed].

## The short version

Every lane's `claude` process needs three things: `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
an OTLP/HTTP JSON exporter pointed at this server, and an
`OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<role>` tag so the event lands on
the right row in the spend ticker. Get the exact block for any lane with:

```sh
rhizomorph env <lane> [--role worker|conductor|auxiliary] [--port <n>] [--shell sh|powershell|cmd]
```

`--port` defaults to 4321 (the Rhizomorph's own default); pass whatever
`--port` you actually started the server with. `--shell` defaults to `sh`
and picks the assignment syntax the block is printed in — `sh`'s
`export NAME=value`, PowerShell's `$env:NAME = "value"`, or cmd's
`set NAME=value` — same variables, same live-fetched instance id, every
shell. The `sh` output is `export`-ready:

```sh
eval "$(rhizomorph env test-lane)"
claude -p "..."
```

A Windows conductor with no `export`/`eval` uses `--shell powershell` and
pipes the output into `Invoke-Expression` instead — see "Wiring the
conductor" below for the full copy-paste form.

## Workers (workmux)

A lane's telemetry comes from `scripts/lane-agent.sh`, and it arrives only if the
lane was dispatched **through** that wrapper:

```sh
workmux add <handle> -a "bash scripts/lane-agent.sh <model>"
```

The wrapper resolves the main checkout from the linked worktree
(`git rev-parse --git-common-dir`), runs `rhizomorph env "$(basename "$PWD")"`
against port 4321 — so `lane` is the worktree's own directory name, the same
handle workmux and the worktree table use elsewhere, and `role` is the `env`
default, `worker` — `eval`s the block it prints, and then `exec`s `claude` **in
that same process**. That is the whole point of the wrapper: the env is set in
the process that goes on to become the agent, so inheritance is by construction
rather than by arrangement. If the server is down on 127.0.0.1:4321, or the main
checkout is unbuilt, it says so on stderr and starts the agent anyway,
uninstrumented, rather than refusing to dispatch.

**A pane-command env prefix never reaches the agent**, and `.workmux.yaml` holds
no `OTEL_*` variable of any kind — so there is nothing in it to enable and
nothing in it to retarget. This section used to say the fleet config wired every
lane automatically; it did not, and a pane-command prefix never could, because
workmux launches the agent *outside* the pane command's shell. That is a scar,
not a theory (2026-08-04, twice-learned: `/proc/<agent>/environ` read empty of `OTEL_*`
after two prefix "fixes" changed nothing), and `.workmux.yaml`'s own comment
above its `panes` block records it. If the Rhizomorph runs on a different port,
the one line to change is the `--port` in `scripts/lane-agent.sh`; a lane pointed
at a receiver that isn't listening drops its exports silently rather than
crashing — `claude` doesn't hard-fail on a bad OTLP endpoint — which is why this
is worth getting right before dispatch rather than after.

## Wiring the conductor (setup-agnostic — works from Windows, WSL, or elsewhere)

The conductor is often the largest single spender (prd1's whole point:
orchestration overhead is real and otherwise invisible) and it doesn't run
inside a workmux-managed worktree, so it needs the same env block by hand,
wherever it happens to run — **before** you hand off to it, since
instrumentation only attaches at launch (see below). Pick the block below for
whichever shell the conductor is about to run `claude` in.

### sh / bash / zsh (Linux, macOS, WSL)

```sh
eval "$(rhizomorph env conductor --role conductor)"
claude
```

### PowerShell (Windows, native)

`export`/`eval` don't exist in PowerShell, so `--shell powershell` prints
`$env:NAME = "value"` lines instead, and `Invoke-Expression` (`iex`) is the
PowerShell equivalent of `eval "$(...)"` — it runs each printed line as a
command in the current session, which is what actually sets the vars for the
`claude` launched right after:

```powershell
node packages/server/bin/rhizomorph.mjs env conductor --role conductor --shell powershell | Invoke-Expression
claude
```

(Same command, `rhizomorph env conductor --role conductor --shell powershell | iex`, if `rhizomorph` is on PATH.)

### cmd.exe

`set` has no piping-into-itself trick like `Invoke-Expression`, so print the
block once and paste its lines by hand — there's no one-liner:

```bat
node packages/server\bin\rhizomorph.mjs env conductor --role conductor --shell cmd
:: paste the printed "set NAME=value" lines here, then:
claude
```

### If the server isn't running yet: degrade loudly, don't block the launch

`rhizomorph env` reads the *live* instance id off a running Rhizomorph's
`/api/meta` (#60) — there is no static block to fall back to, because a
per-server-session id can't be guessed. If nothing answers on `--port`, the
command fails loudly instead of printing something the receiver would refuse:

```
cannot read this Rhizomorph's instance id on port 4321: ...
Start the server first (`npm start -- --port 4321`) — `rhizomorph env` reads the id from its /api/meta, ...
```

That is the correct failure — **say so, then launch uninstrumented anyway**
rather than let a missing server block the conductor from starting at all.
An uninstrumented conductor session is not silently miscounted: the burn strip's
overhead figure reads `CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable`
(`CONDUCTOR_NOT_INSTRUMENTED_GAP`, `packages/web/src/panels/burn/format.ts`) and
the drawer's evidence line for main reads `conductor not instrumented — its burn
is unknown, not zero` (`packages/web/src/drawer/Vitals.tsx`) — an honest gap
rather than an invented `$0.00` (see "Instrumentation attaches at launch" just
below for why that gap can't be closed retroactively once the session's
running).

That expands to the same env block any lane gets
(`packages/server/src/cli/telemetry-env.ts`) — telemetry on, an OTLP/HTTP-JSON
exporter, `OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor` — so it
works identically whether the conductor's `claude` process runs on the same
box as the Rhizomorph server, in a different WSL distro, or natively on
Windows while the server runs under WSL. The `sh` form, spelled out in full:

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
the Rhizomorph server, point `OTEL_EXPORTER_OTLP_ENDPOINT` at wherever the
server is actually reachable — WSL's localhost forwarding means a Windows-side
conductor can usually still reach a WSL-side Rhizomorph over
`http://127.0.0.1:<port>` (or `http://localhost:<port>`), but a genuinely
separate machine needs the server's real host/IP and an open port. The
otel receiver has no auth — don't expose it beyond a trusted LAN/localhost.

**Instrumentation attaches at launch, not retroactively.** These are
environment variables read once when a `claude` process starts; a conductor
session already running when you read this cannot be retro-instrumented by
exporting the vars into its shell afterward — it has to be restarted with the
env block already in place. This is exactly why the block above must be
wired **before** handover, on whichever shell the conductor actually runs:
there is no supported way to attach it after the fact. The burn strip treats a
conductor with zero `llm.cost` events as an honest gap rather than a zero: its
overhead figure gates on `conductorInstrumented`, which is a cost-event fact and
not a token one, so a conductor whose tokens arrive through `--extra-sessions`
with no cost telemetry behind them still reads as a gap — precisely because this
is a common way to end up mid-session with no conductor cost data yet. See "The
overhead number" below for which figure that is.

A conductor's own Claude Code **session-log** directory (the `sessionlog`
collector's source, `~/.claude/projects/<slug>`) may also live somewhere the
Rhizomorph wouldn't otherwise discover — a different filesystem entirely
(`/mnt/c/Users/<u>/.claude/projects/<slug>` for a Windows-side conductor
talking to a WSL-side Rhizomorph). Point the server at it with (repeatable):

```sh
rhizomorph --extra-sessions /mnt/c/Users/<u>/.claude/projects/<slug>:conductor
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
all (`research/2026-07-30-telemetry-capture-routes.md` [never committed] §S2). So a directory
full of token counts is not proof the conductor's dollars were ever measured,
and the spend panel's dollar headline says so.

## The enrichment rung

Before this doc gets into dollars specifically, it's worth being precise
about what "instrumented" means at all — prd15's transcript organ (see
[`docs/architecture.md`](architecture.md#prd15--the-anywhere-instrument-system-agnosticism))
changed the honest floor.

Every collector declares which of six signals it can actually speak to —
`identity | liveness | activity | attention | telemetry | cost`
(`packages/core/src/collector.ts`) — each at `provided`, `partial`, or
`absent` (the latter two carry a one-line reason by construction, never a
silent gap). `mergeCapabilities` folds every collector watching a lane into
the best level any of them reaches per signal, and `deriveRung` maps the
result onto exactly one rung:

| rung | what it takes | what it gets you |
|---|---|---|
| **L0** | nothing — git plus the agent's own transcript, zero cooperation | full liveness + attention (waiting/working/frozen/gone) + token telemetry, **no dollars** |
| **L1** | this doc's env block, at launch | authoritative dollars (OTLP) or estimated ones (the vendored pricing table) |
| **L2** | a hook beacon (not shipped in this repo yet) | attention *declared* by the CLI's own hooks instead of inferred from transcript shape |
| **L3** | a PTY wrapper, `rhizomorph run` (not shipped yet) | a live output stream |
| **L4** | tmux/workmux | pane previews, one-keystroke ATTACH |

**The load-bearing distinction: L0 is "zero-cooperation," not "zero-
signal."** Bare git alone sits at L0 with almost every signal absent. But
git *plus* the transcript-tail state machine (prd15 ruling 1 — every
agent CLI's session transcript, folded as a state machine per lane, no
tmux/hooks/terminal/OS requirement) also sits at L0, and it already has
full liveness, activity, and **token** telemetry `provided` — the one thing
still `absent` at L0 is `cost`, dollars specifically. So a lane can read
tokens honestly with no setup at all; what the rest of this document is
for is the one thing the transcript alone cannot give you: authoritative or
estimated *dollars*, which is what climbing from L0 to L1 buys.
`rhizomorph doctor` and `GET /api/meta` both say the rung a lane is
actually sitting at and what climbing it requires, so "is this lane
instrumented" always has a precise, checkable answer rather than a yes/no
guess.

## What is a token (not a unit)

**Operator ruling, 2026-07:** a "token" is not one unit. `TokenTotals`
(`packages/core/src/events/telemetry.ts`) carries four cache tiers that price
out very differently, so summing all four into one number and calling it "the
tokens" hides a mix of things worth up to ~50x apart. The Rhizomorph's
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

- **Spend ticker headline** — OUTPUT tokens. Beneath it, all four tiers render
  as their own labelled counts — `output`, `input`, `cache read`, `cache write`,
  the order and the labels both fixed by `TOKEN_TIERS`
  (`packages/web/src/lib/format.ts`); cache tiers are visually de-emphasized
  (dimmed, smaller bar segments) but never hidden. Once a real `llm.cost` event
  has arrived, the dollar total and $/hour rate sit alongside the token
  headline — dollars are never invented from tokens.
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

This is the number the burn strip renders, not a different one from it — see the
next section for how the strip gates it, and why no cost-based overhead figure
exists anywhere in the product.

## The overhead number, and why there is only one

The audit's open question ("is `selectOverheadRatio` on tokens or cost?") is
settled: **output tokens**, and there is no cost-based counterpart to compare it
against.

| Where | What it is | Reads |
|---|---|---|
| `selectOverheadRatio` / `selectRoleSpend` → `RoleSpendSplit.overheadRatio` (`packages/core/src/selectors/spend.ts`) | the number: conductor **output tokens** ÷ worker output tokens, `unattributed` spend excluded from both sides | `null` unless both sides reported output tokens |
| `formatOverheadOrGap` / `overheadHoverTitle` (`packages/web/src/panels/burn/format.ts`), the burn strip's overhead figure | that same number, formatted — it reads `burn.overheadRatio` and never recomputes the division | `CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable` when the conductor has no `llm.cost` events; `unknown — no worker output yet` when the ratio is `null`; otherwise `<n>×`, with `conductor ÷ worker output tokens` spelled out on hover |

So those are one number and its formatter, not two competing measures. Issue #47
is why this ever needed saying: it replaced the *panel headline* and its commit
message said "cost", which is what the audit tripped over — but no cost-based
overhead figure survives in the tree today, and issue #69 re-based the core
selector from an all-tier token sum to output tokens specifically (see "What is a
token" above). **The orchestration overhead ratio is and stays output tokens ÷
output tokens, never cost.** Tokens are the honest basis, because cost is
structurally absent for any lane the OTel exporter never covered — a
sessionlog-only conductor has real tokens and no dollars at all, and a cost-based
selector would report `null` for it forever where a token-based one reports
something true.

What #47's concern survives as is the **gate**, not the basis.
`formatOverheadOrGap` refuses to print a ratio unless `burn.conductorInstrumented`
is true — a cost-event fact, not a token one — even when `overheadRatio` is
itself a perfectly good number, because a conductor whose tokens arrive through
`--extra-sessions` with no cost telemetry behind them is exactly the "worse than
absent" shape the gap voice exists to name. The selector and the strip therefore
part company on purpose: the selector says what the tokens are, and the strip
declines to headline them while the conductor's own instrumentation is unproven.

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
`thread: main | subagent | auxiliary | null`, and `LaneSpend.threads`
(`packages/core/src/selectors/spend.ts`) exposes per-thread sub-totals under
the parent lane (prd2's ruling: sub-rows under the parent lane, never a lane
of their own), dearest first. `null` means *the source did not say* and is
rendered as unknown, never as `main`.

Both collectors populate the field (issue #65, shipped):

- **OTel** reads the `query_source` attribute and stores it verbatim through
  `resolveThread` (`packages/server/src/collectors/otel/parse-metrics.ts`)
  when it's a value the core schema recognises (`main | subagent |
  auxiliary`) — `null` for anything else, including absent, rather than
  guessing.
- **sessionlog** reads the line's own `isSidechain` marker
  (`packages/server/src/collectors/sessionlog/collector.ts`): `true` maps to
  `subagent`, everything else to `main`.

A lane's sub-rows are built only when at least one record in that lane
actually named a thread — an all-unknown lane gets no sub-rows at all, never
a single row of unknowns, so `LaneSpend.threads` always sums back to the
lane's own total.

## Enabling beta traces

prd9 (`docs/prds/done/prd-09-trace-era.md`) adds a trace layer on top of the money layer above.
Claude Code 2.1.220 — the version already installed, no CLI upgrade needed —
exports OTLP traces behind a beta gate
(`research/2026-08-03-trace-era-captures.md` [never committed] §1). On top of the metrics/logs
block earlier in this doc, three more lines turn it on:

```sh
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # beta gate for traces
export OTEL_TRACES_EXPORTER=otlp
export OTEL_TRACES_EXPORT_INTERVAL=1000         # default 5000
```

(`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` is already in the block above; traces
POST to the same base endpoint's `/v1/traces`.) These lines are additive to
what `rhizomorph env` already renders
(`packages/server/src/cli/telemetry-env.ts`); wiring them into that renderer
automatically, plus a `doctor` check for trace reachability and
fixture-vs-CLI drift, is issue #126, this wave's sibling lane — add them by
hand until it lands.

**Spans export when they end, not live** (prd9 ruling 6). A lane's open,
unfinished span is invisible until it closes, so the trace instrument reports
how long a lane SAT waiting on a human and what was decided — always after
the fact. LIVE waiting, an open permission prompt right now, stays the
attention strip's own job; no surface built on the trace layer may imply
otherwise.

**Beta span names can churn.** The parser stores the raw span `name` verbatim
and derives a stable `kind` from it; an unrecognised name lands on `other`,
never an error. Fixtures are pinned to claude 2.1.220 — a CLI upgrade that
renames a span is a fixture update, not a schema migration.

## Coexisting with Langfuse

The Rhizomorph is a pure sink for the OTLP stream it receives at
`/v1/traces` (and `/v1/metrics`, `/v1/logs`) — it only ever reads. Nothing it
does sends that stream, or anything derived from it, anywhere else; the
Trust section's promise (`docs/prds/done/prd-08-published-software.md` ruling 6 — "nothing is ever sent
anywhere") holds for traces exactly as it does for the money layer.

An organization already running Langfuse does not have to choose between the
two. The fan-out happens on the **emitting** side, not the Rhizomorph's: an
OTel Collector, or the agent CLI's own exporter config, can point at more
than one OTLP endpoint at once, so the same span stream reaches an org's
Langfuse instance and a developer's local Rhizomorph simultaneously, with
neither aware of the other. `research/2026-08-03-trace-era-captures.md` [never committed] §3
confirms Langfuse (v4.1.0, MIT core) already auto-classifies Claude Code's
beta spans (`llm_request` → `GENERATION`, `tool.execution` → `TOOL`) — the
same span vocabulary this parser reads.

**Rung 3, the offline dump, ships:** `rhizomorph export-otlp [path] [--session
<id>] [--out <file>]` reads back the `trace.span` events one of this repo's
recorded sessions already stored — never the original exporter stream, so
the privacy allowlist (ruling 5) still bounds what can appear in it — and
writes them out as one OTLP/HTTP JSON export-trace request, byte-identical
in shape to what Claude Code's own exporter would have sent. The tool itself
sends nothing: the file just sits on disk until an operator replays it by
hand, e.g.

```
curl -u <public-key>:<secret-key> \
  https://<your-langfuse-host>/api/public/otel/v1/traces \
  -H 'Content-Type: application/json' \
  -d @<the file export-otlp wrote>
```

against Langfuse's public OTLP ingestion route (Basic auth — verified live
2026-08-03 against v4.1.0). Because the operator's own `curl` is the only
thing that ever leaves the machine, the ruling that shipped this
(2026-08-12) needed no renegotiation of the Trust section at all: "nothing
is ever sent anywhere" by the Rhizomorph itself stays true word for word.

An **opt-in *live* forwarder** — the Rhizomorph itself relaying to Langfuse
or another sink as spans arrive, with no human act in between — is
deliberately still not built. prd9 ruling 9 keeps that kind of outbound
forwarding out until re-ruled, and unlike rung 3, building it would require
rewriting the Trust section to say exactly what leaves and when. `export-otlp`
becomes that forwarder's wire format if a live rung is ever ruled for later —
its OTLP serialisation, proven here, is the transport a "C" implementation
would sit around.

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
to a running Rhizomorph's `/v1/metrics` produced a stored `llm.usage` /
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

## The front door can relaunch a session wired (prd-20 waves 5–8, 2026-08-14)

The /connect page now enumerates uninstrumented sessions and can instrument
one: the server migrates the transcript home when it lives elsewhere (a
create-only copy, fenced — ADR-0020) and relaunches under the env envelope,
and because resume preserves the sessionId, telemetry books under the same
identity and the uninstrumented row clears itself as evidence arrives. The
copyable command remains the no-trust path and stays visible beside the
button. Physics unchanged: instrumentation attaches at launch, never
retroactively — proven, not assumed (research/2026-08-14-cross-host-resume.md,
CLI-version-pinned). Known gap on the record: the detached spawn needs a
prompt or TTY to survive (#532).
