You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence) and
research/2026-07-31-prd2-live-baseline.md (what the dashboard showed
before wave A). Wave B goal: identity that cannot collide — declared
at the source, namespaced by instance, never inferred from strings.

YOUR ISSUE — #60 (60. Keystone B: instance identity; the receiver refuses foreign traffic, loudly)

**Fence (may touch ONLY):** `packages/server/src/api/otel.ts`, `packages/server/src/api/otel.test.ts`, `packages/core/src/events/telemetry.ts`, `packages/core/src/events/telemetry.test.ts`, `packages/core/src/events/index.ts`, `packages/server/src/cli/telemetry-env.ts`, `packages/server/src/cli/telemetry-env.test.ts`, `.workmux.yaml`
**Blocked by:** #56, #58. **Model:** opus. **Wave: B (keystone)**

The live baseline showed factory-workstream lanes (`factory-p1p2-conductor`,
`HEAD`) inside this repo's dashboard: `api/otel.ts:29-40` accepts any POST —
no auth, no instance check — and `.workmux.yaml` hard-codes the default port,
so whichever Rhizomorph is listening swallows every repo's exports.

**Operator ruling (Lachlan, 2026-07-31): refuse foreign traffic, loudly.**
One repo, one Rhizomorph; a foreign post is a misconfiguration surfaced as a
setup gap, never silently merged and never silently dropped.

- **Every run has an instance id.** Minted when a session starts, persisted
  with the session so a resumed run (#58) keeps its id across server
  restarts. Exposed on `/api/meta`.
- **Agents carry it.** `rhizomorph env <lane>` includes
  `instance=<id>` in `OTEL_RESOURCE_ATTRIBUTES`, reading the id from the
  running server's `/api/meta` on the given `--port` (document that the
  server must be up when generating env — it always is at dispatch time).
  Update `.workmux.yaml`'s per-lane wiring the same way.
- **The receiver refuses everything else.** A POST whose resource attributes
  are missing the instance id, or carry a different one, is rejected (403)
  and recorded as a new `telemetry.refused` event (add it to the union in
  `events/index.ts`): the foreign instance id (or "none") and a count —
  emitted at most once per offender per minute, not per post, so a
  misconfigured fleet cannot flood the log. The refusal is data the UI will
  surface (#62); your job ends at recording it.
- **Schema: role gains `unattributed`.** Extend `agentRoleSchema` with
  `'unattributed'` — the value #62 books undeclared repo-root sessions under
  and #63 surfaces as a setup-gap bucket. Nothing in your fence needs to use
  it beyond the schema and its test; adding it here keeps the schema change
  in one keystone.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: matching
instance accepted; missing and mismatched instance each refused with 403 plus
a recorded `telemetry.refused`; refusal events are throttled per offender;
`rhizomorph env` output carries the live server's instance id. Never push,
merge, or run git in a sibling worktree — committing on YOUR branch is
required. Finish with a short summary including any live evidence the issue
asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
