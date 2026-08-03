You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (the rulings bind you),
then research/2026-08-03-trace-era-captures.md (the captured shapes are
your source of truth, not memory). The #123 keystone is LANDED on main:
packages/core/src/events/trace.ts is the contract — import from
@rhizomorph/core, never redefine its types.

YOUR ISSUE — #124:

## Direction

prd9 wave A — the `/v1/traces` receiver and the claude-profile parser.
Evidence and attribute census: `research/2026-08-03-trace-era-captures.md` §1.
Raw capture bodies to become fixtures: `~/rhizo-probe/capture-b/` files
`004-*_v1_traces.json`, `008-*`, `013-*`, `017-*` and
`~/rhizo-probe/capture-c/010-*_v1_traces.json` (subagent shape). The
keystone (#123, landed) gives you `traceSpanPayloadSchema`, `spanKindSchema`
and the `trace.span` envelope — import from `@rhizomorph/core`, never
redefine.

1. **Pure parser** — new `collectors/otel/parse-traces.ts`, mirroring
   `parse-metrics.ts`'s shape (pure, injected emit, per-datapoint
   `collector.error` on malformed spans, request still 200).
   - Name→kind mapping (claude profile): `claude_code.interaction` →
     `interaction`; `claude_code.llm_request` → `llm_request`;
     `claude_code.tool` → `tool`; `claude_code.tool.blocked_on_user` →
     `tool_blocked`; `claude_code.tool.execution` → `tool_execution`;
     `claude_code.hook` → `hook`; ANY other name → `other`, never an error.
     The raw `name` is stored verbatim either way.
   - Attribute allowlist, and nothing else crosses: `model`;
     `input_tokens`/`output_tokens`/`cache_read_tokens`/
     `cache_creation_tokens` → the four-tier `tokens`; `ttft_ms` → `ttftMs`;
     `request_id` → `requestId`; `agent_id`/`parent_agent_id`; `tool_name`;
     `tool_use_id` (fall back to `gen_ai.tool.call.id`); `subagent_type`;
     `decision`; `session.id` → `sessionId`. Resource/span attrs `lane`,
     `role`, `instance` flow through the existing `attribution.ts` helpers —
     reuse them as-is; if reuse forces a reconciliation in
     `parse-metrics.test.ts`, keep it minimal and on the record.
     `user.email`, `user.account_*`, `organization.id`, `user_prompt` have
     NO path into an emitted event.
   - Time: `startTimeUnixNano`/`endTimeUnixNano` are STRING nanoseconds —
     convert with BigInt division to epoch ms; `Number(nanoString)` loses
     precision and is a bug. OTLP `status.code`: 0 → `unset`, 1 → `ok`,
     2 → `error`.
2. **Route** — `POST /v1/traces` in `api/otel.ts`, inside the same
   encapsulated context as metrics/logs: same 400 error net, same
   all-or-nothing foreign-instance 403 + throttled `telemetry.refused` —
   and add `resourceSpans` to `declaredInstances()` (without it every
   correctly-tagged trace POST is refused; research note "What to avoid").
   `/v1/metrics` and `/v1/logs` behavior unchanged.
3. **Fixtures** — copy the five capture bodies VERBATIM into
   `collectors/otel/fixtures/` named
   `claude-code-2.1.220-traces-<shape>.json` (llm-request, tool-pair-a,
   tool-pair-b, interaction-root, subagent). Tests parse the real bodies
   and assert: kinds and tree ids; tokens present only on `llm_request`
   spans; `<REDACTED>` prompt text and `user.email` appear NOWHERE in any
   emitted event (assert on the serialized events); lane/role/sessionId
   attribution; nanos→ms exactness; a mutated unknown name maps to `other`.

## Fence (may touch ONLY)

- `packages/server/src/collectors/otel/parse-traces.ts` (new)
- `packages/server/src/collectors/otel/parse-traces.test.ts` (new)
- `packages/server/src/collectors/otel/fixtures/` (new files only)
- `packages/server/src/collectors/otel/types.ts`
- `packages/server/src/collectors/otel/attribution.ts`
- `packages/server/src/collectors/otel/attribution.test.ts`
- `packages/server/src/collectors/otel/index.ts`
- `packages/server/src/collectors/otel/parse-metrics.test.ts` (minimal reconciliation only)
- `packages/server/src/api/otel.ts`
- `packages/server/src/api/otel.test.ts`
- `packages/server/src/api/index.ts`

## Blocked by

#123 (landed). **Model:** sonnet. **Wave:** A.

## Definition of done

- All fixture assertions above green; foreign-instance refusal proven for
  `/v1/traces` by test; unknown-name→`other` proven by test; no
  email/prompt material in any emitted event, proven by test.
- Fixture filenames pin the CLI version (2.1.220).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (the gate audits every touched
path); small conventional commits (committing is REQUIRED — review
happens from your branch); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests must be deterministic
(no waitFor racing async work — stub or await the boundary; a flaky
test blocks the gate); build for a stranger's machine (no personal
paths, 127.0.0.1 not [::1], degrade loudly never silently); if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
