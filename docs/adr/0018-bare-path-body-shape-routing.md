# 0018. The OTLP receiver adds one bare-path route, dispatched by body shape

- **Status:** proposed
- **Date:** 2026-08-13

## Context and Problem Statement

prd-26 ruling 1 — *"native OTLP first; an adapter is the fallback, never the
default"* — makes receiver-side routing wave 3's job, before any harness
mapping (wave 4, #322): *"codex's first task is receiver-side — bare-path
body-shape routing, since its export reaches `/v1/*` never. Route shape is
architectural: an ADR is owed."*

`packages/server/src/api/otel.ts` serves exactly three routes —
`/v1/metrics`, `/v1/logs`, `/v1/traces` — and nothing else. `rhizomorph env`
(`cli/telemetry-env.ts`) sets `OTEL_EXPORTER_OTLP_ENDPOINT` to the *base*
endpoint alone, `http://127.0.0.1:<port>`, on the documented assumption that
the exporting SDK appends `/v1/<signal>` itself, per the OTLP/HTTP spec's own
append rule. claude's beta OTLP export does exactly that, so it reaches these
three routes unaided.

codex does not — on the evidence this repo actually has, labelled honestly.
The research spike (`docs/research/2026-08-05-agnostic-adapters-spike.md`)
marks the claim **[Ran — repo capture]** and says codex "posts all three
signals to the bare endpoint path (no `/v1/<signal>`)". But prd-26 itself
flags the note that fact traces to
(`research/2026-08-03-trace-era-captures.md`) as *"[never committed]"* every
one of the seventeen times it cites it, and says plainly that both claude's
and codex's captures *"reach us second-hand only"* — the underlying capture
is not itself inspectable in this repo, only cited by documents that are.
So this ADR treats the claim as the best evidence available, not a verified
one: codex's exporter is *reported* to POST every signal to its configured
base endpoint unchanged, which — since that base endpoint carries no path at
all — means the literal bare `/`. Today that is a 404.

That citation also establishes the **path** only, not the **encoding**. It
says nothing about whether codex's exporter sends OTLP/HTTP JSON or
OTLP/HTTP protobuf; if it is the latter, this ADR's fix does not help it —
`server/mutation-guard.ts`'s global Content-Type check refuses any mutating
request whose body isn't `application/json` before it reaches any OTLP route
at all, so a protobuf export still lands nowhere, just at a 415 instead of a
404. Confirming (or ruling out) protobuf is a capture question for whoever
next verifies codex's export, not something this route-shape decision can
settle from citations alone.

The fix must not become harness mapping. prd-26 scopes codex's dialect
(parsing its private `codex.*` span/metric namespace) to wave 4 (#322)
deliberately; this issue settles only where a bare-path body *lands*, not
what its fields *mean*.

## Considered Options

- **A — One or more guessed alternate paths per signal** (e.g. register
  `/v1` as a fourth alias for metrics, a fifth for logs, …). Rejected below.
- **B — One bare-path route, `POST /`, dispatched to the existing three
  parsers by inspecting the body's own top-level shape**
  (`resourceMetrics` / `resourceLogs` / `resourceSpans`).
- **C — Make the three existing routes shape-agnostic** (accept any of the
  three body shapes at any of the three URLs).
- **D — A generic catch-all** (`app.post('/*', ...)`) that treats *any*
  otherwise-unmatched `POST` as a candidate OTLP body.

## Decision Outcome

Chosen: **B**.

A single new route, `POST /`, registered inside `otel.ts`'s existing
encapsulated plugin, after the three native routes. Its handler reads the
body's own shape — exactly one of `resourceMetrics`, `resourceLogs`,
`resourceSpans` named as a key at all (present, whatever its value; JSON has
no `undefined`, so presence is unambiguous) — and calls the identical handler
the matching native route already uses: same instance-identity refusal
(`foreignInstance`), same malformed-body handling, same event union. A named
key whose value is the wrong shape (e.g. `resourceLogs: "not-an-array"`)
still routes to that signal's handler, which then refuses it exactly as
`/v1/logs` would for the same body — no new leniency, no silent pass-through
via the metrics schema's `.passthrough()` picking up a sibling key by
accident. Zero or more than one of those three keys present is refused
outright, by name, via a `collector.error` naming which case it was (none
named, or which several) — never a silent guess at which one to parse. No
new parsing exists anywhere:
`parseMetricsExport`, `validateLogsExport` and `parseTracesExport` are called
unchanged, and their own existing honest-gap handling for a name they don't
recognize (e.g. `parse-traces.ts`'s `classify()` mapping any unrecognized
span name to `kind: 'other'` rather than an error) is exactly what receives a
codex span today — a shape that routes correctly but carries an unrecognized
dialect lands as an honestly-labeled `other`/absent event, not a half-parsed
one and not a new per-harness table. That is deliberate: this ADR settles
where the bytes land, wave 4 settles what codex's fields mean.

**A is rejected** because it does not generalize and is not actually known to
be correct: nothing in the evidence says codex's exporter would hit `/v1`
specifically rather than the literal bare `/`, and guessing a path per
harness multiplies without bound as more non-compliant exporters show up —
exactly the harness-specific table this issue is scoped to avoid building.

**C is rejected** because it does not solve the problem it's aimed at: codex
never requests `/v1/metrics`, `/v1/logs` or `/v1/traces` at all, so making
those three routes more lenient about *which* shape they'll accept changes
nothing about whether codex's request ever reaches them.

**D is rejected.** A catch-all matching every unmatched `POST` turns "the
OTLP inbox is three (now four) named routes" into "any POST this app doesn't
otherwise recognize might be telemetry" — a far larger commitment than the
PRD's ruling asks for, and one that would silently absorb a future gated
mutation route's typo'd URL as an OTLP attempt instead of a 404 telling its
author they mistyped it. A named, single bare path is the narrower claim the
evidence actually supports.

**The native-first ordering the ruling asks for** is visible in the shapes
themselves: the three signal-specific routes are unconditional and
registered first; the bare-path route is documented in its own source as the
fallback, exists only because a compliant exporter never reaches it, and
carries no privileged treatment of any one signal over the others once it
does run — it dispatches to the exact same handler the native path would
have used.

## Consequences

- **Good.** codex's reported export (the [Ran — repo capture]-labelled claim,
  itself citing a note this repo does not have committed — see Context) now
  has somewhere to land instead of 404ing, with no dialect-specific code
  anywhere in this change — the "no harness mapping in this issue" fence
  holds structurally (the parsers are literally the same three functions,
  called from a fourth call site), not only by discipline. This is
  conditional on the export actually being OTLP/HTTP JSON, per the Context
  section's protobuf caveat — unverified either way.
- **Good, with real conditions.** A second future non-compliant harness costs
  nothing new *only if* its export shares three things codex's reported
  export does: `application/json` (the global mutation guard refuses
  anything else before any OTLP route runs), the proto3-JSON lowerCamelCase
  key names (`resourceMetrics` / `resourceLogs` / `resourceSpans` — not, say,
  snake_case or a differently-named wrapper), and each present key actually
  carrying an array (a present-but-wrong-shaped key still routes correctly
  under Fix 1's presence check, but its own native schema then refuses it, so
  "costs nothing new" means "routes correctly," not "is guaranteed to be
  accepted"). A harness violating any of the three needs its own look, not an
  assumption that this route shape already covers it.
- **Bad — a genuinely new registered route widens the fence.** ADR-0014's
  route-class law requires every registered route to carry a row in
  `api/index.ts`'s `ROUTE_CLASSES`, checked against the real running app with
  a pinned count. `POST /` needed that row (classed `ungated-mutation`, same
  as the other three OTLP routes — an exporter has no channel to learn a
  capability token) and the pinned count moved from 17 to 18. Recorded as a
  fence widening on #321 before the change, per this repo's own discipline —
  not a file this issue's fence originally named.
- **Neutral — ambiguous bodies are refused, not proven necessary yet.** A
  body naming more than one of the three shapes at once is refused outright.
  No captured exporter currently produces that shape (each signal is its own
  POST in every capture this repo has); this is a defensive choice for a case
  not yet observed, made now because "refuse an unhandled shape by name"
  costs nothing today and is the harder failure mode to retrofit safely
  later, versus a silent partial parse that would need un-inventing.
- **Neutral.** Whether gemini's `telemetry.outfile` (a local file drop, not
  an HTTP POST at all) is a collector's job or a receiver's is untouched
  here — a different ingestion shape entirely, and still the PRD's own open
  question.
