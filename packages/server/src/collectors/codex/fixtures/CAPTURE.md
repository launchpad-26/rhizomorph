# codex captures — provenance and recipe

Real captures from `codex-cli 0.146.0` (logged in via ChatGPT), taken 2026-08-14
from inside this worktree, per prd-26 ruling 3 ("verification-by-capture is the
merge gate") and issue #322's Phase 1. Six `codex exec` runs total across two
passes (four for the initial capture, two more after review — Finding 7's
pinned crash fixture and the task-error OTLP recapture, both below), each a
one-line prompt; both a rollout transcript (`~/.codex/sessions/`) and codex's
own OTLP export were captured for every run that produced one. No pre-existing
session history was read for content — only this directory's structure was
consulted beforehand to learn the rollout file's shape, per the issue's
instruction.

**`config.toml` was never touched.** Every OTel setting below was passed as a
one-shot `-c key=value` override on the `codex exec` command line, which layers
on top of `~/.codex/config.toml` for that invocation only. The operator's real
config file was read once (to confirm it carried no `[otel]` section already)
and never written.

## The six runs

| run | prompt | outcome | rollout fixture | OTLP fixture(s) |
|---|---|---|---|---|
| turn-complete | `Reply with exactly: ok` | success, no tool call | `codex-cli-0.146.0-rollout-turn-complete.jsonl` | `codex-cli-0.146.0-otlp-logs-turn.json`, `-otlp-traces-turn.json`, `-otlp-metrics-turn.json` |
| tool-call | `Run the shell command: echo capture-322-tool-check — then reply with exactly: done` | success, one shell tool call | `codex-cli-0.146.0-rollout-tool-call.jsonl` | (OTLP captured but not committed as a separate fixture — same shapes as turn-complete's, see below) |
| task-error (original) | `Reply with exactly: ok`, `-m definitely-not-a-real-model-xyz` | the failure/absence outcome, guessed attribute keys, no `instance` | `codex-cli-0.146.0-rollout-task-error.jsonl` | superseded by the task-error recapture below |
| identity | `Reply with exactly: ok`, real `rhizomorph env` attribute keys | success, used to verify `OTEL_RESOURCE_ATTRIBUTES` | (rollout not separately kept — same shape as turn-complete) | superseded turn-complete's OTLP fixtures once the correct attribute keys were confirmed |
| root-spans (review pass) | `Reply with exactly: ok`, real attribute keys | success, a fresh capture used only to pin Finding 7's crashing root spans | (not kept — only the trace export was needed) | `codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json` |
| task-error recapture (review pass) | `Reply with exactly: ok`, `-m definitely-not-a-real-model-xyz`, real attribute keys | **the failure/absence outcome** — real API rejection, now with correct `lane`/`role`/`instance` | (rollout not re-kept — same shape as the original task-error run, Finding 3) | `codex-cli-0.146.0-otlp-logs-task-error.json` (replaces the original) |

The "turn-complete" and "identity" runs converged: once the correct resource
attribute keys were confirmed (see below), the turn-complete run was redone
with them, so its own OTLP fixtures already carry proven-correct `lane`/
`role`/`instance` attribution — there is no separate "identity" fixture file.
Two more runs were added after review (below): one to pin Finding 7's
crashing root spans as their own fixture rather than silently trim them away,
and one to replace the task-error OTLP fixture with a correctly-attributed
capture (the original predated the `instance` key entirely — see Scrubbing).

## The capture recipe

A minimal capture sink, kept as a fixture-adjacent tool (not part of the
shipped organ): `fixtures/otlp-capture-sink.mjs`. It is a ~50-line Node HTTP
server that writes every POST body verbatim to `OUT_DIR` plus a
`manifest.jsonl` of method/url/headers/byte-length, and answers `200 {}` to
every request. Usage:

```
OUT_DIR=/tmp/codex-otlp-capture PORT=4319 node otlp-capture-sink.mjs
```

Each run, from inside this worktree:

```
export OTEL_RESOURCE_ATTRIBUTES="lane=<lane>,role=<role>,instance=<instance>"
codex exec \
  -c 'otel.environment="codex-capture-322"' \
  -c 'otel.log_user_prompt=false' \
  -c 'otel.exporter={otlp-http={endpoint="http://127.0.0.1:4319",protocol="json"}}' \
  -c 'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:4319",protocol="json"}}' \
  -c 'otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:4319",protocol="json"}}' \
  --skip-git-repo-check \
  "<one-line prompt>"
```

`otel.exporter`/`otel.trace_exporter`/`otel.metrics_exporter` are codex's three
independent OTel pipelines (logs, traces, metrics respectively — confirmed
from `developers.openai.com/codex/config-reference`, since `codex --help`
itself says nothing about the `[otel]` table). Each is configured with an
**endpoint carrying no path** (`http://127.0.0.1:4319`, no `/v1/...` suffix),
matching what `rhizomorph env` already does for claude
(`OTEL_EXPORTER_OTLP_ENDPOINT` is the bare base). The resulting rollout file
was found under `~/.codex/sessions/2026/08/14/rollout-<ts>-<session-id>.jsonl`
by session id, copied out, and only then redacted — never edited in place.

## Finding 1 — codex really does POST to the literal bare path, unconditionally

Every one of the three OTel pipelines POSTs to `http://127.0.0.1:4319/` — no
`/v1/logs`, `/v1/traces` or `/v1/metrics` suffix, ever, across all four runs
(8, 11, 2 and 8 requests respectively, all `POST /`, confirmed from the sink's
own `manifest.jsonl`). This is a direct, first-hand confirmation of ADR-0018's
central claim, which that ADR's own text says it could only treat as
second-hand ("the underlying capture is not itself inspectable in this repo").
It is now inspectable: this directory. The three payload shapes distinguish
themselves by their own top-level key exactly as ADR-0018 assumed —
`resourceLogs` / `resourceSpans` / `resourceMetrics`, one shape per POST, never
mixed — and every body observed was `application/json` (confirmed by the
sink's own `content-type` header capture and by every file parsing as JSON),
never protobuf, resolving that ADR's other open caveat for this binary version.

## Finding 2 — `OTEL_RESOURCE_ATTRIBUTES` is honored, with the exact keys `rhizomorph env` already emits

This was an open question in both the adapters spike and `OTEL_CAPABILITIES`'s
own doc comment ("untested for codex/gemini"). It is no longer open. First
attempt used a guessed `rhizomorph.lane`/`rhizomorph.role` prefix, which rode
the export verbatim (proving the mechanism works) but does not match what
`attribution.ts`'s `resolveLane`/`resolveRole` actually read (bare `lane` /
`role`, checked against `packages/server/src/cli/telemetry-env.ts:82`, which
also requires a third key, `instance`, or the receiver refuses the export
outright). The run was redone with
`OTEL_RESOURCE_ATTRIBUTES="lane=lane-capture-322,role=worker,instance=rhizomorph-capture-322-instance"`
— exactly `rhizomorph env`'s own recipe — and all three pipelines' resource
attributes carried `lane`, `role` and `instance` verbatim. **No codex-specific
identity code is needed**: `rhizomorph env`'s existing recipe already works for
codex, unchanged. (The task-error and tool-call fixtures were captured before
this was confirmed and used the guessed prefix; their resource attributes were
normalized to the correct bare keys during redaction — a correction of this
capture's own test setup, not a claim about codex's behavior changing between
runs.)

## Finding 3 — exit behaviour on failure

`codex exec -m definitely-not-a-real-model-xyz "..."` exits **1**, printing the
API's own JSON error to stderr twice (once as a bare `ERROR: {...}` line, once
duplicated — not investigated further, not this issue's fence). The rollout
file is **not empty and not silent**: it carries the full pre-turn bookkeeping
(`session_meta`, `developer`/`user` messages, `world_state`, `turn_context`),
then a `task_complete` event_msg with `last_agent_message: null` and a
structured `error: { message, codex_error_info }` field — never a truncated or
missing file. This is codex's real "absence" shape: no assistant `message`
response_item is ever written (the model never replied), but the *turn* still
completes, explicitly, with the reason why. The matching OTLP export for this
run carries **only `resourceLogs`** — no `resourceSpans`, no `resourceMetrics`
at all (confirmed against the sink's manifest: 2 requests total, both logs).
Codex does not export a trace or a token_usage metric for a turn that never
produced a model response — there is nothing to time or bill.

## Finding 4 — roles are distinguishable, but only in the rollout, never in OTLP

The rollout's `response_item` lines carry an explicit `role`: `developer`,
`user`, `assistant` (plus two roleless types, `reasoning` and, in a tool-call
turn, `custom_tool_call`/`custom_tool_call_output`). This is a stronger,
first-class signal than OTLP has ever offered for any harness: neither the
`resourceLogs` nor the `resourceSpans` export carries a role or conversation
content anywhere (confirmed: with `otel.log_user_prompt=false`, the one log
record that names a prompt — `codex.user_prompt` — carries
`prompt: "[REDACTED]"` verbatim, only `prompt_length` surviving; no other log
record or span attribute in any capture names a role, a message, or free
text). So: **role attribution is a rollout-only capability for codex** — an
OTLP-only observer of codex can see activity and (partial) identity, but never
who said what.

## Finding 5 — where usage and cost live, and whether per-turn or cumulative

Four independent places carry token counts, and the first three disagree in
scope on purpose:

1. **The rollout's `token_count` event_msg** names both explicitly:
   `info.total_token_usage` (cumulative across the whole session so far) and
   `info.last_token_usage` (just the most recent model completion) — verified,
   not inferred, by the tool-call run: after the first model completion,
   `total_token_usage.total_tokens == last_token_usage.total_tokens == 19269`
   (the first data point, so equal); after the second (the "done" reply),
   `last_token_usage.total_tokens == 19303` (just that completion) while
   `total_token_usage.total_tokens == 38572` (≈ 19269 + 19303, cumulative). No
   dollar field anywhere in this event — only a `rate_limits` block naming a
   plan-level `used_percent`, never a cost figure.
2. **The OTLP metrics export's `codex.turn.token_usage`** — a *histogram*
   metric, one data point per `token_type` (`input`, `output`, `cached_input`,
   `cache_write_input`, `reasoning_output`, `total`), `count: 1` per point —
   i.e. **per-turn**, not cumulative; each turn's own histogram export starts
   fresh. No cost datapoint exists alongside it, under any name, in any
   capture.
3. **The OTLP logs export's `codex.sse_event` / `event.kind:
   "response.completed"` log record** — the same six counts
   (`input_token_count`, `output_token_count`, `cached_token_count`,
   `cache_write_token_count`, `reasoning_token_count`, `tool_token_count`)
   restated as log attributes, also per-turn. Curiously, `tool_token_count`
   consistently equals `total_tokens`, not a "tokens spent on tool calls"
   figure — almost certainly a naming artefact upstream, noted here rather
   than silently relied on for anything.
4. **The trace spans themselves also carry standard GenAI-semconv usage
   attributes** — `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
   `gen_ai.usage.cache_read.input_tokens`,
   `gen_ai.usage.cache_write.input_tokens` — alongside the private `codex.*`
   names, confirmed present on real spans in
   `codex-cli-0.146.0-otlp-traces-turn.json`. This does **not** change
   `CODEX_CAPABILITIES`'s declared remedy for `telemetry`: `parseTracesExport`'s
   `extractTokens` reads different attribute names entirely
   (`input_tokens`/`cache_read_tokens`, no `gen_ai.` prefix, no `.input`/
   `.output` suffix split), so today neither reading is wired to
   `trace.span.tokens`, and even teaching `extractTokens` the `gen_ai.usage.*`
   names would only enrich `trace.span` — it mints no `llm.usage` event, which
   is what `telemetry` actually counts (`signal-evidence.ts`). Worth watching
   rather than acting on: if codex's export ever adds `gen_ai.*` span *naming*
   (not just usage attributes) to match the wider convention, this is the seam
   a future GenAI-semconv mapping profile would extend.

**No cost/dollar figure appears anywhere in any of the four** — rollout,
OTLP metrics, OTLP logs, or OTLP trace-span attributes, across every run this
issue captured. This matches the adapters spike's claim exactly and now rests
on first-hand evidence, not a citation.

## Finding 6 — what happens when the shared receiver reads a real codex OTLP body, unmodified

`packages/server/src/collectors/conformance/codex.test.ts` feeds these fixtures
through the *existing, unmodified* `parseTracesExport` / `parseMetricsExport` /
`validateLogsExport` (`packages/server/src/collectors/otel/index.ts`) — no
codex-specific parsing code exists or was added. The result, executed:

- **Traces**: every span is accepted and emitted as a `trace.span` event —
  `classify()`'s "any other name is `other`, never an error" already covers
  codex's entire private `codex.*` vocabulary. Lane/role resolve correctly
  (Finding 2), so **identity and activity both come through today, with zero
  new code**, once an operator points codex's `trace_exporter` at rhizomorph —
  with one real caveat, Finding 7 below.
- **Metrics**: `parseMetricsExport` only reacts to three literal names —
  `claude_code.token.usage`, `claude_code.cost.usage`,
  `claude_code.active_time.total` — and "a metric name that isn't [one of
  those] is ignored silently — not an error" (its own doc comment). Codex's
  `codex.turn.token_usage` matches none of them, so **today this path yields
  zero `llm.usage`/`llm.cost` events for codex** — not a bug, the documented
  honest-gap behaviour for an unrecognised metric name.
- **Logs**: `validateLogsExport` produces no events by design for any harness
  (its own doc comment: that is sessionlog's job, not the receiver's).

This is exactly the fence-widening question ruling 1/ADR-0018 anticipated
("if the captured OTLP export turns out to need a `codex.*` mapping profile
... record a fence widening on this issue BEFORE the change") — and this issue
does **not** take it. Telemetry/cost via the OTLP path stay `absent` in
`CODEX_CAPABILITIES` until that widening is deliberately proposed and recorded.

## Finding 7 — codex's real root spans crash the existing, unmodified trace parser (a receiver defect, reported not fixed)

Executed, not reasoned: feeding the real captured trace body through the
unmodified `parseTracesExport` throws an uncaught `ZodError` on three of the
59 kept spans (`auth` ×2, `session_loop` — codex's own root spans for that
trace). Root cause: codex's exporter writes an explicit
`parentSpanId: ""` for a span with no parent, rather than omitting the key.
`parse-traces.ts`'s `buildSpanEvent` does `span.parentSpanId ?? null`, which
only substitutes for `null`/`undefined` — an empty string passes straight
through — and the core event schema's `parentSpanId` is
`nonEmptyString.nullable()` (`packages/core/src/events/trace.ts:129`), which
rejects `""`. The throw is unguarded: `parseTracesExport`'s per-span loop has
no try/catch around `buildSpanEvent`, so **one such span crashes the parse of
the entire request**, not just that one span (contrast with the "malformed
span" cases the same function already handles gracefully — missing
`traceId`/`spanId`/`name`, or an unparseable timestamp — which return a
`collector.error` for that span alone and let the rest of the body through).

This was a real receiver-side defect, first exposed by codex's real bytes —
claude's own captured fixtures apparently never exercise a root span this way
(claude's own capture note never records one). Filed as **#510**.

Correction from review: in production this did not crash silently — `api/otel.ts`
registers a route-level error handler (`api/otel.ts:38-47`) that catches the
thrown error, answers the POST **`400`**, and records one `collector.error`
event naming the malformed body. So the honest framing was: **the whole
export's batch is refused and recorded as an error, not just the one
offending span** — a real, if coarse, failure mode, not a silent one.

**#510 is now fixed.** `anyValueToString` (`../otel/types.ts`) treats an empty
`stringValue` as absent rather than passing it through unchanged, which fixes
this case and its eleven siblings (every other `attrString(...)`-derived field
feeding a `nonEmptyString.nullable()` schema — `parse-traces.ts`'s `sessionId`,
`model`, `requestId`, `agentId`, `parentAgentId`, `toolName`, `toolUseId`,
`subagentType`, and `parse-metrics.ts`'s `sessionId` ×3); `parse-traces.ts`'s
`buildSpanEvent` separately reads `span.parentSpanId || null` instead of `??
null`, since that field comes straight off the span body rather than through
`attrString`. The per-span loop in `parseTracesExport` is also now wrapped in
a `try`/`catch` so an unforeseen future throw degrades to a single
`collector.error` rather than losing the rest of the request's spans, matching
the graceful-degradation pattern the missing-identity and unparseable-timestamp
cases already had.

The three affected real spans were excluded from the committed
`codex-cli-0.146.0-otlp-traces-turn.json` while this defect stood, so this
organ's conformance suite could prove what `CODEX_CAPABILITIES` claims
(`activity: provided`) rather than tripping this defect on every run — but the
exclusion was **pinned**, not silent: the same three real spans (a fresh
equivalent capture — same recipe, same real shapes, not byte-identical to the
excluded ones, per this file's own "Re-deriving" note) were committed
separately as `codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json`,
and `conformance/codex.test.ts` asserted `parseTracesExport` threw on that
fixture by name, citing #510.

Now that #510 is fixed, that pin is flipped: the same test asserts the fixture
parses cleanly into three `trace.span` events, each with `parentSpanId: null`.
The crash fixture's three spans have also been merged into
`codex-cli-0.146.0-otlp-traces-turn.json` (as an added `scopeSpans` entry
under the same resource, matching their real captured scope name
`codex_otel::trace_context` rather than folding them into the existing
`codex_exec`-scoped spans array), bringing the main fixture to 59 real spans,
not 56.

**Correction, provenance:** those 59 are not a reconstruction of the exact
spans originally excluded from this fixture — the three merged in are
byte-identical to the dedicated crash fixture's, i.e. from the *separate,
later* root-spans capture (their traceIds appear nowhere else in the file, and
their `startTimeUnixNano` sits ~62 minutes after the other 56 spans). The
originally-excluded spans were never separately preserved, so there was
nothing else to restore. What *is* true: both captures share identical
resource attributes (`lane`/`role`/`env`/`instance`), so lane/role attribution
in the merged fixture is unaffected either way, and every span kept is
byte-real from one of the two real captures — the fixture is still honest as
a capture, just not the specific one it might read as at a glance. 59 real
spans, three of which are from the later root-span capture, is the accurate
claim; "restored to its original 59" was not.

The crash fixture itself was **kept**, not folded away, as a dedicated
regression pin: it is real captured bytes proving the shape exists in the
wild, and keeping it separate means a future regression in this area fails on
a small, targeted fixture instead of only showing up as a subtle count change
in the 59-span main one. (Its own conformance case pins the failure shape
directly; it does not pin the main fixture's 59-span/3-root count — removing
the merged spans from the main fixture again would leave that case green.
Judged non-blocking: cheap to add, but the crash fixture already proves the
shape that matters.)

## What the rollout format could support, and why no `TurnGrammar` is registered

The rollout is far richer than OTLP (Finding 4), and a codex `TurnGrammar`
remains genuinely tempting — but two real captured facts stop it here rather
than in documentation:

1. **No pending-tool moment was ever captured.** The tool-call run's
   `custom_tool_call` line already carries `status: "completed"` by the time
   it is durably written, immediately followed by its
   `custom_tool_call_output` line — both appear together, in the same read.
   Nothing in these captures shows a call written *before* its result, the way
   claude's `-tail-pending-tool.jsonl` does. Classifying `custom_tool_call` as
   "opens a tool use" without ever having observed it un-closed would be
   inventing a state this capture cannot back — exactly what ruling 3 exists
   to prevent.
2. **Usage and model facts are split across three different line types**
   (`turn_context` carries `model`; the assistant `response_item` carries only
   text; the `token_count` event_msg carries usage — Finding 5) — never
   co-located on one line the way claude's assistant line carries
   `message.usage` inline. `TurnGrammar.extractFacts(rawLine)` is a pure
   function of *one* line by contract (`turn-grammar.ts`'s own doc: "read from
   the *same* raw line"); codex's real shape does not fit that contract
   without synthesizing facts across lines the interface was not built to
   join. Forcing it through (leaving `model` empty on the line that has tokens,
   or vice versa) would misrepresent a required field, not honestly degrade
   one.

Ruling 5 already names the second problem as an ADR owed ("Usage/model/tool
extraction is not seamed [...] left to an ADR"). This capture is first-hand
evidence for that ADR, not a reason to force a same-day answer: an honest
half-organ (capabilities only, no grammar) is what these fixtures actually
support today. `codex/index.ts` says this in one line; this file says it in
five.

## Scrubbing

Real slices, mechanically redacted by a one-off script (not committed — the
recipe is restated below so it's re-derivable):

- `cwd` and any embedded worktree path → `/repo-wt/codex-capture`; `git.branch`
  → `lane-a`; `session_id`/`id`/`conversation.id` → a fixed placeholder UUID.
  `repository_url` (this repo's own public GitHub URL) and `commit_hash` were
  left as-is — project metadata, not personal data.
- `user.email` → `lane@example.invalid`; `user.account_id` → a fixed
  placeholder UUID; `host.name` (the operator's real machine name) → a fixed
  placeholder string. These rode every OTLP log/span/metric resource or
  attribute by default, exactly as the adapters spike documented for claude —
  now confirmed identically true for codex.
- `base_instructions.text` (codex's own system prompt, several KB, identical
  for every session) and `encrypted_content` (an opaque reasoning blob) →
  fixed placeholders, for fixture-size hygiene, not privacy — neither is
  sensitive, both are just large and non-diagnostic.
- **Codex-injected environment context inside `user`/`developer` message
  content** — `<permissions instructions>`, `<apps_instructions>`,
  `<skills_instructions>` (a full local skill catalog, with real
  `/home/<user>/.codex/skills/...` and `/home/<user>/.agents/skills/...` file
  paths), this repo's own `AGENTS.md` text, `<environment_context>`,
  `<recommended_plugins>` — → a single generic placeholder per block. These
  are codex's own injected boilerplate (not authored by the operator, not part
  of the harness's conversational dialect), but they embed real local paths
  and tool inventory, so every content block longer than 200 characters or
  containing a `/home/`-style path or a recognisable injected-context tag was
  replaced wholesale. The one thing always kept verbatim: the actual one-line
  prompt this capture wrote (`"Reply with exactly: ok"`, etc.) — always short,
  never matching the redaction heuristic.
- A final blanket text-level pass replaced any remaining occurrence of the
  capturing operator's home-directory prefix (`$HOME`) with `/home/lane-user`,
  as a backstop for paths embedded in `world_state`'s file-system-sandbox
  snapshot (workspace roots, `agents_md.directory`, permission-profile
  entries) — too many distinct nested shapes to chase field-by-field with
  full confidence.
- OTLP resource attributes were normalized from an early guessed
  `rhizomorph.lane`/`rhizomorph.role` prefix to the verified-correct bare
  `lane`/`role` (Finding 2) in the tool-call run's OTLP capture (not committed
  as its own fixture). The task-error OTLP fixture was **recaptured** rather
  than normalized — the first capture used the guessed prefix and also
  predated adding `instance` at all, so a normalize-in-place would have left a
  fixture missing a key the real receiver route requires
  (`telemetry-env.ts`'s three-key contract); the committed
  `codex-cli-0.146.0-otlp-logs-task-error.json` is a second, independent real
  `-m definitely-not-a-real-model-xyz` run with the correct
  `lane`/`role`/`instance` triple from the start, reproducing the same real
  error (Finding 3) with honest attribution this time.
- `traceId`/`spanId`/`call_id`/tool-call ids were left byte-identical — opaque
  correlation ids, not identifying on their own, same treatment as claude's
  `requestId`/`tool_use_id` in `../../sessionlog/fixtures/CAPTURE.md`.
- The OTLP trace and metrics fixtures are **trimmed excerpts** of the real
  capture (~350 spans down to 59; ~45 metric names down to 5), not the full
  raw export — every span/metric kept is byte-real, only the *count* was
  reduced, documented here rather than silently shipped as if it were the
  whole body. The kept metric names: `codex.turn.token_usage`,
  `codex.turn.e2e_duration_ms`, `codex.turn.ttft.duration_ms`,
  `codex.conversation.turn.count`, `codex.process.start`. (While #510 stood,
  this fixture was temporarily trimmed to 56 by excluding the three
  `parentSpanId: ""` root spans — Finding 7 — with an equivalent real capture
  of those three pinned separately in
  `codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json`. Now that
  #510 is fixed, three spans — byte-identical to that separate pin's, not a
  reconstruction of the originally-excluded ones, which were never kept — are
  merged back in, bringing the fixture to 59 spans again; the separate pin
  survives as a dedicated regression fixture rather than being folded away —
  see Finding 7 for the full provenance correction.)
- **The trimmed trace fixture is a dangling forest, disclosed rather than
  hidden**: of the 59 kept spans, 3 are real roots (`parentSpanId: ""`) and
  51 more name a `parentSpanId` that does not appear as any other kept span's
  `spanId` — i.e. most parents were trimmed away along with everything else
  outside the `keep_names`/`max_other` budget, not just the three root spans.
  Harmless to `parseTracesExport` (which emits one flat `trace.span` event per
  span, no tree-building), but a future test that folds spans into a call
  tree would be asserting against a shape codex's binary never actually sent
  — worth knowing before writing one, not a defect in this fixture's current
  use.

## Re-deriving

1. Confirm `~/.codex/config.toml` carries no `[otel]` section (or accept that
   any `-c otel.*` override wins for that invocation regardless).
2. Start `otlp-capture-sink.mjs` on a free port.
3. Run `codex exec` with the `-c` overrides above, a trivial one-line prompt,
   from inside a worktree of this repo.
4. Find the new rollout file under `~/.codex/sessions/<y>/<m>/<d>/` by the
   session id codex prints at startup; copy it out (never edit in place).
5. Re-run the redaction rules above (or an equivalent script) over both the
   rollout copy and the sink's captured JSON bodies.
6. For the failure/absence outcome, pass `-m <a name codex will reject>`
   instead of changing the prompt.
7. For `codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json`:
   from any fresh trace export, pick a handful of real spans whose
   `parentSpanId` is `""` (root spans always have some) and keep only those,
   resource included, redacted the same way — no need to reproduce the exact
   names captured here, only the shape (#510).
