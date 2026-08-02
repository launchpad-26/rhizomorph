You are a worker agent building The Observatory (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #80 (80. Burn strip; the spend ticker dissolves into it (ruling 13))

## Direction

Four numbers, no chrome, docked with the attention strip (the keystone's
slot): **output tokens** (the headline, output-led per the prd2
token-semantics ruling), **dollars** (only when authoritative — the cost
feed), **burn rate** (out tok/min; $/hr when dollars are authoritative),
**overhead ratio** (conductor OUTPUT ÷ worker OUTPUT).

- All formatting through the shared formatter (`lib/format`) — SI
  abbreviations, full precision on hover (ruling 11).
- **Gap voice** (ruling 12), one terse line each, exactly when true:
  `NO COST FEED (OTel) — dollars unavailable — run: eval "$(observatory
  env <lane>)"` and `CONDUCTOR NOT INSTRUMENTED — overhead ratio
  unknowable`. Never `$0.00` for a missing feed; never an unlabelled
  total (prd2 law).
- Reads the keystone's fleet object / existing core spend selectors only.
- **Delete `packages/web/src/panels/spend/**`** — the ticker panel
  dissolves (ruling 13). Its registration is already gone (keystone). Keep
  anything still useful by moving it INTO the burn strip's own files; the
  ledger panel is NOT yours and keeps its deep-table role.

Improve on: `spike-c-mycelium` → spike `ui/` burn strip; A's four-numbers
discipline. Ice-neon register.

## Fence (may touch ONLY)

- `packages/web/src/panels/burn/**` (the keystone's stub becomes yours)
- `packages/web/src/panels/spend/**` (delete)

## Blocked by

#75. **Model:** sonnet. **Wave:** 2.

## Definition of done

- Tests: four numbers render from fixture state; dollars absent →
  gap-voice line, never $0.00; conductor gap line; hover precision;
  overhead ratio is output÷output (assert against a fixture where token
  tiers differ).
- `panels/spend/` gone; no dangling imports anywhere (root suite proves it).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
