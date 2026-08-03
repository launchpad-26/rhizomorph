You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (the rulings bind you),
then research/2026-08-03-trace-era-captures.md (the captured shapes are
your source of truth, not memory). The #123 keystone is LANDED on main:
packages/core/src/events/trace.ts is the contract — import from
@rhizomorph/core, never redefine its types.

YOUR ISSUE — #127:

## Direction

prd9 wave A — docs de-staleing. Three documents carry known lies or gaps;
fix them from the sources named here. Facts come from `docs/prd8.md`,
`docs/prd9.md`, `research/2026-08-03-trace-era-captures.md`, and the code —
never invent; where the docs cite issues, keep citing them.

1. **`docs/architecture.md`**:
   - Add a prd8 section (the publishing round: the `rhizomorph` rename,
     package `files` allowlist verified via `npm pack`, README as trust
     document, CHANGELOG/semver policy, tag-gated release workflow —
     summarize from `docs/prd8.md`).
   - Add a prd9 section (the trace era so far: the `trace.span` additive
     event and its four test-stated laws incl. no-spend-from-spans; the
     `/v1/traces` receiver and claude-profile parser with pinned fixtures;
     retrospective blocked-on-human per ruling 6).
   - Kill the stale three.js claims (the scene is canvas 2D since prd7 —
     fix the narrative mentions AND the pinned-versions table).
2. **`docs/telemetry.md`**:
   - The "Threads" section still says issue #65 is pending and every
     record reads `null` — false. Rewrite to the shipped behavior: OTel
     `query_source` → `resolveThread`, sessionlog `isSidechain` →
     `subagent`, `LaneSpend.threads` sub-rows under the parent lane.
   - Add an "Enabling beta traces" section: the exact env block including
     `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_TRACES_EXPORTER=otlp`,
     `OTEL_TRACES_EXPORT_INTERVAL=1000`; spans export when they END
     (retrospective — live waiting stays with the attention signals); beta
     names can churn and land as `other` (fixtures pinned to 2.1.220).
   - Add a "Coexisting with Langfuse" section: rhizomorph is a pure sink —
     the OTel exporter/collector on the EMITTING side can fan the same
     OTLP stream out to an org's Langfuse and a local rhizomorph
     simultaneously; nothing ever leaves the machine through rhizomorph;
     an opt-in forwarder exists only as a filed future issue gated on a
     trust-section re-ruling (cite the issue number the conductor gives
     you in the lane prompt's postscript, if any).
3. **`docs/roadmap.md`** — re-cut: mark the old prd3–prd6 slot text as
   superseded by what actually shipped (one line each pointing at
   `docs/prd3.md`…`prd8.md`); prd9 IN FLIGHT (handover week, kill-order:
   junior-proof flow first, trace waterfall centerpiece); list the
   unclaimed candidates as cohort-facing (catch-up brief as the flagship
   first milestone; task graphs; LiteLLM/OpenRouter/pi capture; Langfuse
   forwarder behind its re-ruling; dispatch-policy optimization standing);
   note the npm decision superseded — no publish, clonable repo is the
   story, the scoped-name question is moot while unpublished.

## Fence (may touch ONLY)

- `docs/architecture.md`
- `docs/telemetry.md`
- `docs/roadmap.md`

## Blocked by

#123 (landed). **Model:** sonnet. **Wave:** A.

## Definition of done

- No three.js claim anywhere in `architecture.md`; the threads section
  matches the code; the beta-traces and Langfuse-coexistence sections
  exist; the roadmap names prd9 in flight and the cohort items.
- No new promises beyond the rulings; every factual claim traceable to a
  named source doc.
- Root `npm test` + `npm run typecheck` green (docs-only change — the
  gate stays uniform).

RULES: stay strictly inside the FENCE (the gate audits every touched
path); small conventional commits (committing is REQUIRED — review
happens from your branch); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests must be deterministic
(no waitFor racing async work — stub or await the boundary; a flaky
test blocks the gate); build for a stranger's machine (no personal
paths, 127.0.0.1 not [::1], degrade loudly never silently); if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
