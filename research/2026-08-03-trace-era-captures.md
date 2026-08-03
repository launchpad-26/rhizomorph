# Trace-era captures — Claude Code beta traces, codex OTel, Langfuse rippage

> Researched 2026-08-03 for the GO/NO-GO on OTLP trace ingestion and the prd9
> cut of the handover week (cohort adoption; one week to industry-grade).
> Claims tagged [Ran] / [Verified] / [Consensus] / [Thin]. Raw fixtures:
> `~/rhizo-probe/capture-{a,b,c,codex}/` (WSL), pinned to the CLI versions
> below. Companion prior art: `research/2026-07-30-telemetry-capture-routes.md`
> (metrics/logs era — still accurate for those signals).

## The decision this serves

Should rhizomorph grow a `/v1/traces` receiver + additive span events + a
per-lane waterfall this week, and what exactly can be ripped from Langfuse
(MIT) and OpenTelemetry to get there fastest without breaking the laws
(read-only, additive schema, honest gaps, privacy-by-allowlist).

## Headline findings

1. **[Ran] Claude Code 2.1.220 — the version already installed — exports OTLP
   traces behind two env vars.** No CLI upgrade needed. Protocol http/json,
   POSTs to `$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces`. The prior note's "no
   traces observed" was an un-enabled beta, not an absent feature.
2. **[Ran] The span tree is product-shaped and complete**: one trace per
   prompt — `claude_code.interaction` (root) → `llm_request` / `tool` →
   `tool.blocked_on_user` + `tool.execution`. Subagents nest inside the Agent
   tool's `execution` span with `agent_id` and `llm_request.context=tool`.
3. **[Ran] Spans stream at export-interval after each span ENDS** — mid-run,
   not at exit. A lane's open (unfinished) span is invisible until it closes:
   the waiting-on-human instrument is retrospective-exact; LIVE waiting stays
   with the existing attention signals.
4. **[Ran] `user.email`, `user.account_*`, `organization.id` ride on every
   span.** The allowlist-of-construction parser is mandatory, not optional.
5. **[Ran] Codex 0.145.0 traces are an internal firehose** (~350 micro-spans
   per trivial run, 574KB bodies) posted to the **bare endpoint path**, not
   `/v1/traces`. Usable only with aggressive span-name allowlisting; carries
   token metrics but **no cost anywhere**.
6. **[Ran] Langfuse v4.1.0 ingests Claude Code's beta spans as-is** and
   auto-classifies them (`llm_request`→GENERATION, `tool.execution`→TOOL),
   proving the spans are semantically legible to standard tooling. Its
   pricing catalog did NOT match `claude-opus-5[1m]` (nulls) — model-pattern
   matching is where pricing rips get hard.

## §1 Claude Code beta traces [Ran]

Environment: WSL Ubuntu 24.04.3, claude 2.1.220, Team subscription OAuth.
Probes a/b/c = no-tools, two 4s Bash sleeps, one Task-tool subagent. Scratch
receiver logged raw bodies with arrival timestamps
(`~/rhizo-probe/receiver.mjs`).

Enablement (the two extra lines `rhizomorph env` must emit):

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # beta gate for traces
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json    # already emitted today
export OTEL_TRACES_EXPORT_INTERVAL=1000         # default 5000
```

Observed spans and the attributes that matter (full census in fixtures):

| Span | Key attributes |
|---|---|
| `claude_code.interaction` (root) | `user_prompt="<REDACTED>"` **by default**, `user_prompt_length`, `interaction.sequence`, `interaction.duration_ms` |
| `claude_code.llm_request` | `model`, `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_creation_tokens`, `duration_ms`, `ttft_ms`, **`request_id`** (joins sessionlog `requestId`), `stop_reason`, `success`, `attempt`, `speed`, `llm_request.context` ∈ `standalone\|interaction\|tool`, `agent_id` (subagent), partial `gen_ai.*` (`system`, `request.model`, `response.id`, `response.finish_reasons`) |
| `claude_code.tool` | `tool_name`, `tool_use_id`, `gen_ai.tool.call.id` |
| `claude_code.tool.blocked_on_user` | `decision` (`unknown` when pre-allowed), `duration_ms`, `source` |
| `claude_code.tool.execution` | `success`, `duration_ms` |

- [Ran] `OTEL_RESOURCE_ATTRIBUTES=lane=…,role=…` lands on the **resource AND
  every span's own attributes** — rhizomorph's existing lane/role/instance
  attribution carries over unchanged (probe used lane/role; `instance` is
  emitted by `rhizomorph env` and rides the same mechanism).
- [Ran] `session.id` is on every span → the sessionId join works for traces.
- [Ran] Only `llm_request` spans carry token counts. `interaction` and `tool`
  spans carry none — summing `llm_request` spans only is sufficient AND spans
  duplicate what `llm.usage` already counts → **the no-double-count law
  (spans never feed spend) is confirmed necessary and sufficient.**
- [Ran] Cross-trace links exist: `llm_request` spans carry
  `links[link.type=parent_of → other trace/span]`; background requests (a
  haiku `standalone` request) appear in their own traces. The waterfall must
  tolerate multi-trace sessions and links, or ignore links in v1.
- [Ran] Timing (probe b): each span's POST arrived ≈1 export-interval after
  that span's `endTimeUnixNano`; the root `interaction` span arrived last,
  at interaction end — while the process was still alive.
- [Verified, docs — not run] Hook spans exist behind
  `ENABLE_BETA_TRACING_DETAILED=1`; W3C `traceparent` is injected into Bash
  subprocesses; `parent_agent_id`/`workflow.run_id` attrs exist for nested
  agents. (code.claude.com/docs/en/monitoring-usage, accessed 2026-08-03.)

## §2 Codex OTel [Ran]

Environment: codex-cli 0.145.0, Windows, ChatGPT-plan auth. Config via `-c`
overrides (values parse as TOML — PowerShell 5.1 strips the inner quotes and
silently turns the table into a junk string; use Git Bash or a config file):

```toml
[otel]
exporter         = { otlp-http = { endpoint = "http://127.0.0.1:43210", protocol = "json" } }
trace_exporter   = { otlp-http = { endpoint = "http://127.0.0.1:43210", protocol = "json" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:43210", protocol = "json" } }
```

- [Ran] **All three signals POST to the configured endpoint's bare path
  (`/`)** — codex does not append `/v1/<signal>`. Ingesting codex therefore
  needs either body-shape routing (`resourceSpans`/`resourceMetrics`/
  `resourceLogs` key) or per-signal endpoints configured with full paths
  (untested — open question).
- [Ran] One trivial `codex exec` produced ~350 spans (574KB + 302KB bodies):
  Rust-tracing internals (`append_items`, `auth`, `plugins_for_config`…).
  Product-meaningful spans exist — `codex.exec` (root), `session_task.turn`
  (carries `model`), `run_sampling_request`, `turn/start`,
  `op.dispatch.user_input` — but a waterfall needs an aggressive name
  allowlist; this is a separate mapping profile, not a variant of Claude's.
- [Ran] Metrics include `codex.turn.token_usage`, `codex.turn.ttft.duration_ms`,
  `codex.turn.e2e_duration_ms`, `codex.turn.tool.call`,
  `codex.conversation.turn.count`. **No cost metric exists** → codex dollars
  require a pricing table (see §3) or stay an honest gap.
- [Ran] Log events include `codex.user_prompt` (has a `prompt` attribute —
  whether content is populated vs gated by `otel.log_user_prompt=false`
  default was not inspected this pass: open question),
  `codex.sse_event` (token counts incl. `reasoning_token_count`,
  `cache_write_token_count`), and `user.email`/`user.account_id` on events —
  same privacy posture required as Claude.
- Resource attrs seen: `service.name`, `service.version`, sdk fields, `env`.
  Whether codex honors `OTEL_RESOURCE_ATTRIBUTES` (for lane/role): untested.

## §3 Langfuse [Ran + Verified]

- [Ran] v4.1.0 self-hosted via their `docker-compose.yml` in WSL Docker: six
  services (web, worker, postgres, clickhouse, redis, minio), healthy;
  headless provisioning via `LANGFUSE_INIT_*` env vars works (compose passes
  them through) — no click-through required.
- [Ran] Claude Code beta spans pushed straight to
  `/api/public/otel/v1/traces` (http/json + Basic auth via
  `OTEL_EXPORTER_OTLP_HEADERS`) were accepted and **auto-classified**:
  `llm_request` → observation `type: GENERATION`, `tool.execution` →
  `type: TOOL`, hierarchy preserved as `parentObservationId`, `session.id` →
  `sessionId`, `user.id` → `userId`. The claude span vocabulary is already
  legible to standards-based tooling — evidence the same mapping is buildable
  in rhizomorph's parser.
- [Ran] v4 runs in "events_only mode": the v3 `GET /api/public/traces` read
  API is gone; reads go through `GET /api/public/v2/observations`. Their
  current data model: trace → observations (`SPAN`/`GENERATION`/`EVENT`/
  `TOOL`) with `latency`, `timeToFirstToken`, `inputPrice`/`outputPrice`/
  `totalPrice` per observation; scores are a separate object.
- [Ran] `modelId`/prices were **null** for `claude-opus-5[1m]` — their
  catalog match failed on the bracketed variant. Any vendored pricing table
  must treat model-id pattern matching as a first-class problem, and
  rhizomorph's "estimate, flagged as estimate; never invent dollars" rule
  already covers the miss case.
- [Verified] Licensing: MIT (Expat) core; only `ee/`, `web/src/ee/`,
  `worker/src/ee/` are commercial (repo LICENSE). Concepts, information
  design, and non-`ee` code/data are rippable with attribution.
- **The pricing-table rip is viable and better than expected** (delegated
  probe, clone at `cfac485` examined; findings file in session scratchpad):
  - [Verified] Canonical file `worker/src/constants/default-model-prices.json`
    (~135KB, 166 models, 32 Claude entries), **MIT** — `worker/src/constants/`
    is outside all three `ee/` dirs. Zod-validated by
    `worker/src/scripts/upsertDefaultModelPrices.ts`; schema in
    `packages/shared/src/features/model-pricing/validation.ts`.
  - [Verified] Modern Claude entries carry **distinct
    `input_cache_creation_5m` (1.25×), `input_cache_creation_1h` (2×) and
    `input_cache_read` (0.1×) USD-per-token prices** — 1:1 with the tiers the
    session log already splits (§S2 of the 2026-07-30 note) and with the
    no-unlabelled-total ruling. Trap: alias key `cache_creation_input_tokens`
    equals the 5m price — pricing an aggregate with it silently assumes
    all-5m; use only the split keys.
  - [Verified] `matchPattern` is a case-insensitive regex per model covering
    bare/`anthropic/`/Bedrock/Vertex id forms. Trap: patterns start with
    `(?i)`, which is **invalid in JS RegExp** — strip it and pass the `i`
    flag. (And the live `[1m]`-suffix miss above shows even this catalog's
    patterns have holes — the estimate path must survive a no-match as an
    honest gap, which rhizomorph's `authoritative:false` vocabulary already
    does.)
  - [Verified] Actively maintained: 2–8 commits/month; a nightly GitHub
    Actions price-audit (`model-price-audit.yml`) files correction PRs.
    No unauthenticated API export exists — snapshot the raw GitHub URL
    **pinned to a commit SHA**.
  - [Verified] Fallback: LiteLLM's `model_prices_and_context_window.json`
    (MIT, ~1.6MB, exact-name keys, cache-tier prices as suffixed keys) —
    broader provider coverage, cruder shape.
  - Attribution mechanics: vendor with Langfuse's LICENSE text verbatim
    (e.g. `vendor/langfuse-pricing/LICENSE`) + provenance note (URL, SHA,
    retrieval date) + a THIRD_PARTY_LICENSES entry. MIT→MIT, no interaction.
- **UI information-design study:** pending a connected Chrome this session
  (instance is up with one real trace loaded; login `probe@local.test` /
  `rhizo-probe-2026`, local-only throwaway).

## §4 OTel GenAI semantic conventions [Verified]

Still Development/experimental as of July 2026; moved out of the main
semconv repo into a dedicated GenAI repo at v1.42.0 (June 2026); no stable
1.0; names can churn. Claude Code already emits a partial sprinkle
(`gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.*`,
`gen_ai.tool.call.id`). Stance confirmed: **map gen_ai.* where present,
never adopt it as storage schema** — the additive envelope stays ours.

## §5 Junior clone+run audit [Ran, delegated]

Fresh local clone, README-only, bare no-workmux target (git + one worktree),
Node 22. Full findings file in session scratchpad; workspace preserved at
`~/junior-audit/`.

- **[Ran] The README's first command fails for every stranger.**
  `npx rhizomorph <path>` → npm 404 (`'rhizomorph@*' is not in this
  registry`), no pointer to the clone path. Since the operator ruling is
  clone-not-publish, the README must lead with the clone block.
- **[Ran] The clone path is already excellent**: all four README clone
  commands worked verbatim first try (`npm install` ~6s, `npm run build`
  ~1s, `npm start -- <path> --port…`); UI served; both worktrees of the bare
  target discovered within the first poll tick. **Time-to-first-signal ~15s,
  zero undocumented steps** — the junior-proof bones are there; the front
  door points at the wrong path.
- **[Ran] `doctor` FAILs against your own healthy server**: with rhizomorph
  running, `doctor` on the same port reports `[FAIL] port in use … fix these
  before rhizomorph can run`, exit 1 — misleading precisely when everything
  works. Fix: probe `/api/meta` and report "a rhizomorph is already serving
  this repo" as ok/info.
- [Ran] Six further stumbles, including: doctor's telemetry remedy names a
  `rhizomorph` binary a clone user doesn't have on PATH; server boot prints
  one line with no worktree-discovery signal; the session-recording write
  path (`~/.local/share/rhizomorph/<slug>/`) is absent from the Trust
  section, which itemizes reads and sends but not writes; a failed boot on a
  busy port still touches the session file first.
- [Ran] Credits: read-only claim held bit-identical; busy-port failure is a
  clean one-liner; `--help` accurate; degraded no-workmux output reads as
  absent-on-purpose, not broken — the honest-gap voice survives the bare
  case.

## What to avoid

- **Double-counting spend.** `llm_request` spans carry the same four token
  tiers `llm.usage` already records (sessionlog + OTel metrics). Spans must
  never feed spend selectors; test-stated law.
- **Storing spans verbatim.** `user.email`/`user.account_*`/
  `organization.id` are on every span from both CLIs. Only an attribute
  allowlist may cross the parser boundary.
- **Trusting beta names.** Pin fixtures to CLI versions (2.1.220 captured);
  unknown span names map to a stable `other` kind, never error.
- **Assuming path-routed OTLP.** Codex posts to `/`; only Claude appends
  `/v1/<signal>`.
- **PowerShell 5.1 for codex `-c` TOML values** — it strips inner quotes and
  the override degrades to a junk string that errors as an unknown variant.

## Open questions

1. `blocked_on_user` under a REAL human wait — `decision: accept|reject` and
   meaningful durations were not observable headless (pre-allowed tools show
   `decision: unknown`, ~ms durations). Verify during build-week dogfooding.
2. `parent_agent_id` / `workflow.run_id` — unobserved (single-level spawn);
   shape of nested-agent trees unknown.
3. Hook spans (`ENABLE_BETA_TRACING_DETAILED=1`) — unprobed.
4. Codex: does `OTEL_RESOURCE_ATTRIBUTES` reach its resource attrs? Can
   per-exporter endpoints carry full `/v1/traces` paths to restore path
   routing? Is `codex.user_prompt`'s `prompt` populated by default?
5. LiteLLM OTel v2 / OpenRouter / pi capture — deferred by plan; scope as a
   cohort issue (their OTLP-trace door is the same `/v1/traces` receiver).
6. Langfuse UI study — pending Chrome connection.
7. Whether Claude's trace exporter retries/re-delivers spans (fold must be
   idempotent on `(traceId, spanId)` regardless — cheap insurance).

## Verdict

**GO on trace ingestion, exactly as the campaign plan sketched.** The
evidence removes the two biggest unknowns: the beta works on the installed
CLI with the exact env mechanism `rhizomorph env` already owns, and the span
tree is product-shaped with lane/role/session attribution intact. Scope
blocked-on-human as retrospective from day one (export-on-end is confirmed).
Claude's profile is the first-class parser; codex trace parsing is a COULD
behind its own fixture and name-allowlist, its metrics are nearer-term than
its spans, and its dollars don't exist — which the pricing rip now covers.

**Evidence-backed prd9 cut proposal** (for the operator's blessing):

- **MUST — junior front door** (all three top audit fixes are small and the
  bones are proven good): README leads with the clone block (npx line goes,
  or moves behind a "when published" note); doctor recognizes a live
  rhizomorph via `/api/meta` instead of FAILing; boot line names discovered
  worktrees; Trust section gains the write path.
- **MUST — trace keystone + receiver + selectors + drawer waterfall** per
  the campaign plan (`trace.span` additive event, `kind` enum, attribute
  allowlist, no-spend-from-spans law, `/v1/traces` route + `resourceSpans`
  gate fix, fixtures pinned to 2.1.220); `rhizomorph env` emits the two beta
  lines.
- **SHOULD — pricing estimates**: vendor Langfuse's
  `default-model-prices.json` pinned to SHA with LICENSE + provenance;
  selector-side estimates for token-only lanes, flagged via the existing
  `authoritative:false`/`estimateSource` vocabulary; a no-match is an honest
  gap (the `[1m]` miss proves the case matters). This is also the only route
  to codex dollars.
- **COULD — codex profile**: metrics first (`codex.turn.token_usage` is
  usable spend data), spans later behind a name-allowlist fixture;
  body-shape routing for its bare-path OTLP posts.
- **Deliberately out**: LiteLLM/OpenRouter/pi captures (cohort issue), hook
  spans, GenAI-semconv storage, any outbound forwarding.

## Sources

- Live captures 2026-08-03: `~/rhizo-probe/capture-{a,b,c}` (claude 2.1.220,
  WSL), `~/rhizo-probe/capture-codex` (codex-cli 0.145.0, Windows), scratch
  receiver `~/rhizo-probe/receiver.mjs`, analyzers `analyze-{traces,codex}.mjs`.
- code.claude.com/docs/en/monitoring-usage (accessed 2026-08-03).
- learn.chatgpt.com/docs/config-file/config-reference (codex otel keys,
  accessed 2026-08-03).
- github.com/langfuse/langfuse LICENSE + docker-compose.yml (cloned
  `~/langfuse-probe/langfuse`, commit `cfac485`); live instance v4.1.0.
- langfuse.com/handbook/chapters/open-source; langfuse.com OTLP +
  observations API docs (accessed 2026-08-03).
- OTel GenAI semconv status: opentelemetry.io blog + dedicated GenAI repo
  move at semconv v1.42.0 (accessed 2026-08-03, search-verified secondary).
