# prd9 — the trace era: one week to handover

> **Outcome:** shipped.

The audience changed. The cohort will likely adopt rhizomorph for their
six-week open-source project, and there is one week to make it something a
stranger inherits rather than something an author explains. Two thrusts, in
kill-order: a junior-proof front door, and a trace layer ripped-with-evidence
from OpenTelemetry and Langfuse. Decisions from the research-day gate,
operator, 2026-08-03. Evidence: `research/2026-08-03-trace-era-captures.md` [never committed]
(all load-bearing claims [Ran], fixtures pinned to claude 2.1.220 /
codex-cli 0.145.0).

## Rulings

1. **Handover-grade, defined.** A total junior clones the repo, runs it, and
   understands their swarm within a minute — on a Mac, in a plain terminal,
   with no workmux. The degraded path is the common path and must read as
   absent-on-purpose, never broken.
2. **No npm publish.** The cohort inherits a clonable repo, so the clone
   block IS the install story and the README leads with it. The `npx` line —
   which 404s for every stranger today — moves behind a "when published"
   note. This supersedes prd8 ruling 2's install story while unpublished;
   the release machinery stays dormant, not deleted.
3. **The trace layer is built on captures, not docs.** Claude Code's beta
   trace export is enabled by exactly two env vars on the already-installed
   CLI and streams a product-shaped span tree over OTLP http/json. Fixtures
   pin the CLI version; the parser stores the raw span `name` and derives a
   stable `kind` (`interaction | llm_request | tool | tool_blocked |
   tool_execution | hook | other`); unknown names map to `other` and are
   never an error. Beta churn is a fixture update, not a schema migration.
4. **Spans never feed spend.** `llm_request` spans carry the same four token
   tiers the money layer already counts — so `trace.span` events are
   waterfall annotation only. Test-stated law: a state built from only
   `trace.span` events yields zero tokens and zero dollars. The span
   `request_id` may JOIN spend records for enrichment; it may never create
   them.
5. **Privacy by allowlist-of-construction extends to spans.** `user.email`,
   `user.account_*` and `organization.id` ride on every span both CLIs
   emit; the parser's fixed attribute allowlist means they are structurally
   never stored. Prompt text has no field to land in, and `rhizomorph env`
   never sets `OTEL_LOG_USER_PROMPTS`.
6. **Blocked-on-human is retrospective-exact.** Spans export when they end
   ([Ran]); an open permission wait is invisible until answered. The trace
   instrument reports how long lanes SAT waiting and what was decided; LIVE
   waiting remains the attention strip's job. No surface may imply
   otherwise.
7. **Dollars are vendored, flagged, or absent — never invented.** Langfuse's
   MIT `default-model-prices.json` (5m/1h cache-creation and cache-read
   prices per model, match-pattern regexes) is vendored pinned to a commit
   SHA with LICENSE text and a provenance note. Estimates ride the existing
   `authoritative: false` / `estimateSource` vocabulary; a model-pattern
   miss is an honest gap. This is also the only route to codex dollars,
   which do not exist in its telemetry at all ([Ran]).
8. **Doctor must recognize its own kind.** A healthy rhizomorph already
   serving the checked port is an `ok`, not a `[FAIL] port in use` — the
   audit's worst stumble was doctor condemning a working system. And the
   Trust section gains the one thing it omits: WHERE the instrument writes
   (`~/.local/share/rhizomorph/<slug>/`).
9. **Out, this week and until re-ruled:** outbound forwarding of any kind
   ("nothing leaves the machine" stands), GenAI semconv as storage schema
   (mapping only), protobuf/grpc content types, hook spans, and
   LiteLLM/OpenRouter/pi capture — the last three are groomed as cohort
   issues, not built now.

## Implementation waves

Day 1 — **the keystone, one lane, not a fleet**: `trace.span` additive event
(schema + state slice + idempotent fold on `(traceId, spanId)` + laws tests).
Everything else builds against this contract. Operator blesses the payload
shape before wave A.

Day 2 — wave A, fenced and parallel: the `/v1/traces` receiver + pure parser
+ pinned fixtures (including the `resourceSpans` instance-gate fix) · span
selectors (trees, waiting-on-human, interaction summaries; token sums from
`llm_request` spans only) · `rhizomorph env` + doctor (two beta lines, trace
reachability, fixture-vs-CLI drift) · docs de-staleing (architecture prd8/9
sections, telemetry threads, roadmap re-cut).

Day 3 — wave B: the lane-drawer waterfall (operator blesses layout first;
transcript stays lead per prd4) · pricing vendoring + selector-side
estimates · README clone-first rewrite + junior fixes (ruling 8).

Days 4–5 — handover train (email scrub, repo-home decision, macOS leg) ·
dogfooding the fleet under its own trace layer · good-first-issues +
contribution guide; the catch-up brief is deliberately left as the cohort's
flagship first milestone, with the trace layer as its enabler.
