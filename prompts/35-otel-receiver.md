You are a worker agent building The Observatory (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #35 (35. otel collector — OTLP/HTTP receiver (authoritative cost))

**Fence (may touch ONLY):** `packages/server/src/collectors/otel/**`, `packages/server/src/api/otel.ts` (new), `packages/server/src/api/index.ts` (registration line ONLY)
**Blocked by:** #33. **Model:** sonnet. **Wave:** 2

OTLP/HTTP receiver per docs/prd1.md + research note §S1 (real payload shapes
captured there).

- Fastify routes `POST /v1/metrics` and `POST /v1/logs` accepting OTLP
  http/json (protobuf out of scope; docs say http/json is supported by both
  claude and codex exporters).
- Parse `claude_code.token.usage` and `claude_code.cost.usage` datapoints →
  `llm.usage` / `llm.cost` events (`authoritative: true`); `lane` from the
  resource attribute `lane` (fallback: `session.id` short-hash); `role` from
  resource attr `role` or lane==conductor; `query_source: auxiliary` maps to
  role auxiliary.
- Unknown metrics ignored silently; malformed body → 400 + one
  `collector.error` event, never a crash.
- Drop/ignore `user.email`-bearing attributes from stored events (privacy
  note in roadmap).
- Fixtures: build OTLP JSON bodies matching the research capture shapes.

**DoD:** green root test+typecheck incl. an injected-request integration
test; fence respected (api/index.ts diff = one registration line); summary.
No NUL bytes; never push/merge; no git in sibling worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
