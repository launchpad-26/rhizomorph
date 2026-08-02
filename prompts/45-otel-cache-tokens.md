You are a worker agent on The Rhizomorph (prd1).

FIRST read docs/prd1.md and research/2026-07-30-telemetry-capture-routes.md
(§S1 documents the real OTel payload shapes).

YOUR ISSUE — #45

**Fence (may touch ONLY):** `packages/server/src/collectors/otel/parse-metrics.ts`, `packages/server/src/collectors/otel/parse-metrics.test.ts`, `packages/server/src/collectors/otel/fixtures/` (add fixtures)
**Model:** sonnet

Found by running the live receiver against real Claude Code telemetry: the OTel
parser rejects two of the four token types, so **cache tokens are silently
dropped from the authoritative source**.

Real events emitted by our own receiver just now:

```
collector.error  otel  malformed claude_code.token.usage datapoint: unrecognised type "cacheRead"
collector.error  otel  malformed claude_code.token.usage datapoint: unrecognised type "cacheCreation"
```

Claude Code's `claude_code.token.usage` metric carries a `type` attribute whose
real value set includes **`cacheRead`** and **`cacheCreation`** as well as
`input`/`output`. The parser only accepts the latter two and raises
`collector.error` for the rest.

Why it matters: cache-read dominates real volume — one lane on the build day
read **13,065,329** cache tokens against 222,678 output tokens. Any per-lane
token total from the OTel path is therefore wrong by orders of magnitude. (The
sessionlog collector does capture all four tiers, which is why the discrepancy
is visible at all — cross-validation working as designed.)

Fix: accept all four token types and map them to the core event's existing
token tiers (`input`, `output`, `cacheRead`, `cacheCreation`). Keep raising
`collector.error` for genuinely unknown types, but do not lose a datapoint that
merely uses a type this parser hadn't met. Add a fixture containing all four
types taken from the shapes in `research/2026-07-30-telemetry-capture-routes.md`
plus the real values above.

**DoD:** a test that fails today, asserting all four tiers survive a metrics
POST; zero `collector.error` for a well-formed all-tier payload; root
`npm test` + `npm run typecheck` green. No NUL bytes; never push/merge; no git
in sibling worktrees.

RULES: stay in the fence; small conventional commits; never push, merge, or
run git in a sibling worktree; committing on YOUR branch is REQUIRED;
deterministic tests only; no NUL bytes; STOP with a summary.
