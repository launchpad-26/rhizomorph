# Telemetry capture routes for Observatory prd1 (cost/token tracking)

> Researched 2026-07-30 for **one decision: which capture route(s) power
> prd1's cost/token telemetry.** Claims tagged [Ran] / [Verified] / [Thin].
> All [Ran] captures executed on this machine (WSL Ubuntu 24.04, Claude Code
> 2.1.220 on a course **Team subscription**, i.e. OAuth — no API key).

## The decision in one line

prd1 needs per-lane token/cost data flowing into the Observatory's event log.
Three candidate routes (per the JV call, treated as spikes, not gospel):
Claude Code OpenTelemetry, session-JSONL mining, LiteLLM proxy.

## Headline findings

1. **Claude Code emits real dollar costs on subscription auth.** [Ran]
   With only env vars set, `claude -p` produced `claude_code.cost.usage`
   datapoints with `cost_usd: 0.0588372` (sonnet) and `0.000591` (an
   auxiliary haiku call). Cost is computed client-side; no API key needed.
2. **Session JSONL is the richest source and attribution is free.** [Ran]
   One project dir per worktree; every line carries `sessionId`, `cwd`,
   `gitBranch`. Per-message usage includes input/output/cache-read/
   cache-creation (with 1h/5m ephemeral split), `model`, `requestId`,
   `durationMs`. No cost field — cost must be derived or joined from OTel.
3. **Subscription OAuth passes through a LiteLLM proxy.** [Ran] — and this
   **falsified the spike's hypothesis**, which predicted it wouldn't.
   `ANTHROPIC_BASE_URL=http://localhost:4500/anthropic` (passthrough route)
   → `POST /anthropic/v1/messages 200 OK`, agent replied normally. The
   *routed* path (bare base URL) fails as predicted:
   `ProxyModelNotFoundError` (proxy wants its own model+key config).
4. **Codex has native OTel too.** [Verified] `~/.codex/config.toml`:
   `otel.exporter` / `otel.metrics_exporter` / `otel.trace_exporter`
   (`otlp-http`/`otlp-grpc`), `otel.environment`, `otel.log_user_prompt`
   (learn.chatgpt.com config reference, accessed 2026-07-30). So OTel is not
   a Claude-only route. Exact codex metric names not enumerated in docs —
   needs its own capture before building against it.

## Spike S1 — Claude Code OpenTelemetry [Ran]

Command (from the repo root, Team subscription):

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=console \
OTEL_LOGS_EXPORTER=console OTEL_METRIC_EXPORT_INTERVAL=3000 \
OTEL_LOGS_EXPORT_INTERVAL=1000 \
claude -p "Reply with exactly: OTEL SPIKE OK" --model sonnet
```

Arrived in one short `-p` run (flush-on-exit works; 950 lines captured):
`session.count`, `cost.usage`, `token.usage`, `active_time.total`, plus log
events `api_request`, `user_prompt`, `assistant_response`, hook events.

`token.usage` datapoint attributes (real capture):
`session.id`, `model` (`claude-haiku-4-5-20251001` for the auxiliary call —
the metric separates models), `query_source` (`auxiliary`; docs say
main/subagent/auxiliary), `type` (`input`/`output`), `user.id`,
`user.email`, `organization.id`, `terminal.type`.

**Gap:** no cwd/branch attribute → lane attribution needs either a
`session.id → lane` join (the session JSONL provides it) or
`OTEL_RESOURCE_ATTRIBUTES=lane=<handle>` injected at dispatch (workmux sets
env per pane command). Both are cheap. [Verified: OTEL_RESOURCE_ATTRIBUTES
supported per docs; not yet run with a custom attribute.]

**Privacy note for open-sourcing:** `user.email` rides along by default;
cardinality controls exist (`OTEL_METRICS_INCLUDE_*`). [Verified]

## Spike S2 — session-JSONL mining [Ran]

Parsed the Opus keystone lane from the build day
(`~/.claude/projects/-home-operator-worktrees-challenge--worktrees-2-core/…jsonl`,
353 lines, 20.5 min span):

- 131 assistant messages, every one carrying `message.usage`: totals
  input 249, output 222,678, cache_read 13,065,329, cache_creation 247,684
  — cache detail the OTel metrics do not break out per message.
- `model: claude-opus-5` per message; tool calls countable
  (Bash 36, Write 32, Edit 17, Read 5) → a real per-lane activity timeline.
- Top-level fields per line include `sessionId`, `cwd`, `gitBranch`,
  `requestId`, `promptId`, `durationMs`, `isSidechain`, `version` —
  **attribution is structural**, one project dir per worktree.
- **TodoWrite: 0 uses; Task (subagent): 0 uses** in this lane — our fenced
  single-issue workers don't produce task-list metrics. JV's task-size/growth
  metric needs lanes that actually keep todo lists (or beads). Honest limit.
- No cost field anywhere in the JSONL → cost must be (a) joined from OTel's
  `cost.usage` by session, or (b) derived tokens×pricing table (LiteLLM's
  community `model_prices_and_context_window.json` is the standard source
  [Thin — widely used, not evaluated here]).

## Spike S3 — LiteLLM proxy vs subscription OAuth [Ran]

LiteLLM 1.94.0 in a venv, proxy on :4500 with **no** Anthropic key
configured.

- Routed path: `ANTHROPIC_BASE_URL=http://localhost:4500` →
  `400 ProxyModelNotFoundError` ("Invalid model name … claude-sonnet-5") —
  the proxy insists on its own model registry + credentials. As hypothesised.
- **Passthrough path**: `ANTHROPIC_BASE_URL=http://localhost:4500/anthropic`
  → exit 0, agent replied `PROXY OK`, proxy logged
  `POST /anthropic/v1/messages?beta=true 200 OK` twice.

> ⚠️ CORRECTION (to this research's own brief): the spike was framed with
> the hypothesis "proxy fights subscription auth — expect a clean negative."
> The passthrough route disproves it. Recorded per the research skill: the
> premise being wrong is the finding.

**Still open:** whether LiteLLM's spend/usage logging parses passthrough
traffic (its cost tracking is documented for routed calls; passthrough
logging needs config + a DB and was outside the timebox). Not load-bearing
for prd1 since both target CLIs emit OTel natively.

## Langfuse — feed it or stay self-contained? [Verified, docs only]

Langfuse (open-source, self-hostable) ingests via SDKs, OTLP, and LiteLLM;
UI covers traces/cost/session views. It is a *platform*; the Observatory's
identity is a zero-config sidecar with its own append-only event log.
Stance: **Observatory remains the sink and source of truth for prd1**; an
"export OTLP onward" option (so a user's Langfuse can receive the same
stream) is a roadmap item, informed by JV's upcoming course coverage.

## Competitive scan (light) [Thin]

CrewAI/Groq mission dashboards, agent-swarm monitor UIs, SWARM safety
dashboards exist; none found that are git-worktree/tmux-native, replayable,
and tool-agnostic-by-signals. The niche (watch ANY worktree swarm via
git/tmux + native CLI telemetry) still looks unoccupied. Sources: GitHub
topic scan 2026-07-30; not exhaustive.

## Verdict — what prd1 should build

**Two native collectors, no proxy:**
1. **`sessionlog` collector** (primary depth): tail `~/.claude/projects/*`
   JSONL for the watched repo's worktrees → per-message token/tool/timeline
   events with built-in lane attribution. Zero worker config. Codex session
   logs later (same collector family).
2. **`otel` collector** (primary cost): minimal OTLP/HTTP receiver inside
   the Observatory server; lanes dispatched with the env vars (+
   `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>`). Authoritative `cost_usd`
   without a pricing table, and it generalises to codex.

They cross-validate; either alone degrades gracefully (the house collector
pattern). **Proxy route: deferred to roadmap** — viable (passthrough+OAuth
proven) but adds per-user infra, attribution work, and is redundant while
every target CLI emits OTel. **Langfuse: sink-not-master; optional forward
later.**

## Open questions

- Codex OTel: exact metric/event names and whether cost is computed
  client-side like Claude's — needs a capture before codex lanes get cost.
- OTel `query_source="subagent"` granularity: does spend attribute to the
  parent session id? (Our lanes spawned no subagents to observe.)
- LiteLLM passthrough spend logging: parses or not? (Deferred with the
  route.)
- `OTEL_RESOURCE_ATTRIBUTES` per-lane injection: verified in docs, not yet
  run — first prd1 issue should prove it live.
- Pricing-table derivation for JSONL-only cost: vendor LiteLLM's price JSON
  or always require the OTel join?

## Sources

- Live captures, this machine, 2026-07-30: `/tmp/otel-capture.txt`,
  `/tmp/proxy-t1.txt`, `/tmp/proxy-t2.txt`, `/tmp/litellm.log`, session
  JSONL parse of lane 2-core (commands recorded inline above).
- code.claude.com/docs/en/monitoring-usage (accessed 2026-07-30).
- learn.chatgpt.com/docs/config-file/config-reference (accessed 2026-07-30,
  via developers.openai.com redirect).
- litellm.ai + docs.litellm.ai/blog/litellm-rust-launch (accessed
  2026-07-30) — Rust rewrite perf claims are vendor benchmarks [Thin].
- langfuse.com/docs (accessed 2026-07-30).
- github.com/steveyegge/beads (accessed 2026-07-30) — roadmap candidate for
  task-graph collection, not prd1.
