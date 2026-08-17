# 0025. A harness that exports OTLP natively gets a mapping profile, not a collector

- **Status:** accepted
- **Date:** 2026-08-18

## Context and Problem Statement

prd-26 carried an open question from the day it was written:

> Whether an OTLP file drop (gemini's `telemetry.outfile`) is a collector or a
> receiver, per ruling 1's ADR. **Open.**

ADR-0018 was scoped not to settle it and did not, recording only that a local
file drop "is a different ingestion shape entirely". #323 — the gemini harness —
declared itself possibly unstartable without the answer, and stayed parked.

The question was asked on two facts carried in from documentation: that
`gemini-cli` defaults to **gRPC on 4317**, and that it offers a
`telemetry.outfile` local file drop. Both are true. Neither, it turns out, is
the fact that decides the matter.

prd-26 **ruling 1** already states the rule this record applies:

> Where a harness exports its own OTLP the work is a **mapping profile plus an
> env recipe**, not a collector: the receiver already ends at the event union.

What was missing was evidence about which case gemini is in. That evidence now
exists, taken from `gemini-cli` 0.55.1 on a real machine rather than from docs,
per ruling 3.

**What the capture established.** Pointed at a throwaway HTTP listener using
**this instrument's own env recipe** — the block `rhizomorph env <handle>`
renders for a claude lane, applied unchanged — gemini sent seven requests:

| | |
|---|---|
| transport | HTTP, `application/json`, chunked |
| paths | `/v1/logs`, `/v1/traces`, `/v1/metrics` |
| bodies | `resourceLogs` / `resourceSpans` / `resourceMetrics` |

Those are the routes `api/otel.ts` already serves, in the encoding
`collectors/otel/parse-*.ts` already parse. Every export carried `lane`, `role`
and `instance` in its resource block — including the `instance` value the
receiver requires before it will accept an export at all — plus
`service.name: gemini-cli`. gemini honours `OTEL_RESOURCE_ATTRIBUTES` on every
record, unlike pi, whose capture found the variable had no effect.

The file drop was captured too, and is **not OTLP**: seventeen concatenated
pretty-printed JSON objects in the OpenTelemetry JS SDK's internal object shape
(`hrTime` as a `[seconds, nanos]` array, `resource._rawAttributes`), with zero
`resourceSpans`/`resourceLogs`/`resourceMetrics` markers. It is a debug
affordance, not a wire format.

So the honest framing of the question changed. It was never "which component
ingests the file drop" — it was "is there any reason to ingest the file drop at
all, when the same telemetry is available over the wire in the format this repo
already reads".

## Considered Options

- **A. A collector watches the file drop.** A gemini collector tails the
  outfile, parses it, and emits — reusing the poll loop, the `wrap()` resilience
  policy and the degraded/disabled vocabulary.
- **B. The receiver ingests the file drop.** The receiver grows a file-watching
  ingestion mode beside its routes, keeping all OTLP ingestion in one module.
- **C. Build a gRPC receiver.** Take gemini's documented default transport,
  which is native OTLP, and stand up a gRPC path on 4317.
- **D. A mapping profile over the existing HTTP path.** Configure gemini to
  export OTLP/HTTP to the receiver that already exists, and write a profile
  translating its record vocabulary into the event union.

## Decision Outcome

Chosen: **Option D**, because the transport work is already done and the only
missing piece is vocabulary.

gemini's log records are named `gemini_cli.api_request`,
`gemini_cli.api_response`, `gemini_cli.tool_call`, `gemini_cli.model_routing`
and `gen_ai.client.inference.operation.details`. The receiver dispatches on
`claude_code.*`. Same envelope, same transport, same attribution — different
names. That gap is a mapping profile and nothing more, and
`service.name: gemini-cli` is a clean key to discriminate on.

**Why A and B lost.** Both require owning a **reverse-engineered private
format**. The file drop is the JS SDK's internal serialisation, not a published
contract; Google can change its shape in a minor release without breaking
anything they consider public, and we would discover it as a silently
mis-parsed fixture. prd-26 ruling 3 refuses to merge a harness built from
documentation on the grounds that it validates our reading rather than the tool;
building on a debug dump is the same hazard one level down. Between them, B is
the weaker: it also hands a request-driven, stateless component a poll loop and
a failure model — absent, partial, rotated, permission-denied — that the
collector resilience policy already models properly.

**Why C lost.** It is unnecessary, not wrong. gRPC is gemini's default, but the
HTTP exporters (`@opentelemetry/exporter-{trace,logs,metrics}-otlp-http`) are
bundled in the binary and speak JSON, selectable with
`GEMINI_TELEMETRY_OTLP_PROTOCOL=http`. Standing up a gRPC path is materially
more work than a mapping profile and buys nothing gemini needs. It remains the
right answer for a future harness that exports **only** gRPC — this record does
not close that door, it declines to walk through it early.

**And the original question, answered as a corollary:** an OTLP file drop is
**neither a collector nor a receiver concern**. It is a fallback for a harness
with no network export, and gemini is not one. If a harness ever offers a file
drop and nothing else, this record does not decide that case; it decides that a
file drop is never preferred over a native export that already fits.

## Consequences

- **Good.** gemini needs no adapter, no new route, and no transport work. The
  env recipe written for claude works on it unchanged — verified, not argued —
  so lane/role/instance attribution and the `instance` acceptance check already
  function.
- **Good.** The receiver stays request-driven and stateless. No poll loop, no
  file-watching failure model, no second copy of the resilience policy.
- **Good.** The mapping profile is the smallest unit that can be wrong, and it
  is wrong loudly: an unmapped record name produces no event rather than a
  mis-attributed one.
- **Bad.** A profile per harness vocabulary is now the standing cost of every
  OTLP-native harness. `claude_code.*` and `gemini_cli.*` are two; a third
  harness means a third profile, and nothing here reduces that to configuration.
- **Bad.** gemini's export must be configured, not merely enabled — `TARGET`,
  `USE_COLLECTOR`, `OTLP_PROTOCOL` and `OTLP_ENDPOINT` all matter, and the
  default (gRPC to 4317) lands nowhere this instrument listens. The env recipe
  therefore grows harness-specific keys, which is exactly what ruling 1 means by
  "plus an env recipe" but is more than claude needs.
- **Bad.** This record is decided on an HTTP capture only. The gRPC path was
  never exercised. If a future harness forces gRPC, option C returns with its
  full cost and none of this evidence transfers.
- **Neutral.** `cost` is absent from gemini's telemetry entirely — no cost,
  price or currency field in any capture. A gemini organ must declare
  `cost: absent` with a reason, per prd-26 ruling 2 and prd-15 ruling 3's "no
  adapter may invent a cost". That is a fact about gemini, not a consequence of
  this decision, and it holds whichever option had been chosen.
- **Neutral.** The mapping profile does not exist yet. This record settles the
  shape so #323 can start; it does not claim the work is done. An end-to-end
  ingestion check against the real receiver remains owed, and the counter used
  in the first attempt could not discriminate a missing map from a missing
  export — so that check needs a better observable than `eventCount`.
