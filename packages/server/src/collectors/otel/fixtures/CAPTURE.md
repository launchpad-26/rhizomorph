# gemini captures — provenance and recipe

Real captures from `gemini-cli 0.55.1`, taken for #635/ADR-0025 and reused
here for #323 per prd-26 ruling 3 ("verification-by-capture is the merge
gate"). Seven OTLP/HTTP JSON bodies: three `resourceLogs`, two
`resourceMetrics`, two `resourceSpans`, captured by pointing gemini at a
throwaway HTTP listener with this instrument's own env recipe
(`rhizomorph env <handle> --port <port>`) applied unchanged.

## Recipe

```
GEMINI_TELEMETRY_ENABLED=true
GEMINI_TELEMETRY_TARGET=local
GEMINI_TELEMETRY_LOG_PROMPTS=false
GEMINI_TELEMETRY_USE_COLLECTOR=true
GEMINI_TELEMETRY_OTLP_PROTOCOL=http
GEMINI_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:<port>
OTEL_RESOURCE_ATTRIBUTES=lane=gemini-probe,role=worker,instance=<instance>
```

plus `rhizomorph env`'s own block, unchanged. No `settings.json` was written —
every value above is an env override for one invocation.

## Files

| file | signal | contents |
|---|---|---|
| `gemini-cli-0.55.1-otlp-3-logs.json` | logs | startup/config/user_prompt/api_request records from one turn |
| `gemini-cli-0.55.1-otlp-5-logs.json` | logs | api_response/model_routing/tool_call records — the largest capture, includes a real tool call |
| `gemini-cli-0.55.1-otlp-7-logs.json` | logs | api_response plus a `plan.approval_mode_duration` record |
| `gemini-cli-0.55.1-otlp-4-metrics.json` | metrics | `gemini_cli.token.usage` for one model, plus 7 sibling metric names this receiver doesn't read |
| `gemini-cli-0.55.1-otlp-9-metrics.json` | metrics | `gemini_cli.token.usage` across two models (one with nonzero `cache`), plus `tool.call.count`/`tool.call.latency` |
| `gemini-cli-0.55.1-otlp-6-traces.json` | traces | `llm_call`, `tool_call`, `schedule_tool_calls` spans — a real tool-call trace |
| `gemini-cli-0.55.1-otlp-8-traces.json` | traces | `llm_call` only |

`success.log` and `resattr.log` (the `telemetry.outfile` local file drop,
captured for the same sessions) are **not committed** — ADR-0025 already
established they are not OTLP (the OpenTelemetry JS SDK's private object
shape, not `resourceSpans`/`resourceLogs`/`resourceMetrics`), so they prove
nothing about this receiver and would only be dead weight in this directory.

## Finding — the vocabulary gap is real, and it is exactly three metric names wide

`gemini_cli.token.usage` (a `sum` metric) carries a `type` attribute with five
values per turn: `input`, `output`, `cache`, `thought`, `tool`. Three have an
obvious home in `TokenUsagePayload` (`cache` maps to `cacheRead` — gemini
does not distinguish a separate cache-write tier the way claude's
`cacheCreation` does). Two do not: `thought` (thinking tokens) and `tool`
(tool-definition tokens) name real per-turn quantities with no tier to hold
them. Both were observed nonzero in these captures (`thought`: 256 and 379
tokens across the two metrics fixtures; `tool`: 0 in both, but the type is
structurally present regardless of value).

No cost, price or currency field appears anywhere in any of the seven
captures — confirms ADR-0025's own finding, now against the OTLP bodies
specifically rather than the file drop. `gemini_cli.token.usage` is the only
metric name gemini exports that this receiver's profile now reads; the
other 6–8 metric names per capture (`gemini_cli.api.request.count`,
`.session.count`, `.api.request.latency`, `.model_routing.latency`,
`.tool.call.count`, `.tool.call.latency`, `.startup.duration`,
`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`) are real
telemetry this receiver still doesn't read — surfaced now as a counted,
coalesced `collector.error` per export instead of silent absence.

## Finding — traces and logs needed no profile at all

`parse-traces.ts`'s `classify()` already maps any span name it doesn't
recognise to `kind: 'other'`, never dropping the span — the same fallback
that already makes codex's entirely different `codex.*` span vocabulary land
as real `trace.span` events with zero code written for codex. gemini's
`llm_call`/`tool_call`/`schedule_tool_calls` spans go through the same door,
unmodified, and the fixtures above parse cleanly with no `collector.error`.

`validateLogsExport` never dispatches on a log record's name for any
harness — turning a record into an event is the `sessionlog` collector's
job, over the transcript file, not this route's. So gemini's log records
(`gemini_cli.api_request`, `.api_response`, `.tool_call`, `.model_routing`,
`gen_ai.client.inference.operation.details`, …) were never going to be
"silently dropped" by this route any more than claude's own log records are
— the route's whole contract is "is this valid OTLP, yes or no," and the
fixtures above answer yes.

## Scrubbing

Applied by the operator before handoff, verified here: `host.name` →
`HOST-REDACTED`; the operator's real username and home-directory prefix →
`operator` / `/home/operator`, in `process.owner`, `process.command`,
`process.executable.{name,path}` and `process.command_args`. No API key
appears in any capture (checked: 0 hits). No `user.email`, `user.id`,
`user.account_*` or `organization.id` attribute appears anywhere (checked
against `fixture-hygiene-law.test.ts`'s own identity-field list — this
capture simply never emits those fields, gemini's resource/attribute
vocabulary doesn't carry them). `session.id`/`installation.id` are left as
the real UUIDs gemini minted for this throwaway run — opaque correlation
ids, not identifying on their own, same treatment prior captures give
`traceId`/`spanId`.

## Re-deriving

1. `gemini --version` — confirm `0.55.1` or note the new version.
2. Start a throwaway HTTP listener that writes every POST body verbatim (the
   `otlp-capture-sink.mjs` pattern in the codex fixtures' `CAPTURE.md`
   applies unchanged — gemini's HTTP exporter needs no protobuf handling).
3. Run `gemini -p "<one-line prompt>"` (add a prompt that names a tool, e.g.
   "list files in this directory", to reproduce the `tool_call` span/log) with
   the env block above, `GEMINI_TELEMETRY_OTLP_ENDPOINT` pointed at the
   listener.
4. Redact `host.name`, the real username/home prefix, and confirm no API key
   or identity-field attribute rode along, before committing.
