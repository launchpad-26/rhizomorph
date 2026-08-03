You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (the rulings bind you),
then research/2026-08-03-trace-era-captures.md (evidence for your
issue). Wave A is LANDED on main — import from @rhizomorph/core and
the existing modules, never redefine.

YOUR ISSUE — #129:

## Direction

prd9 wave B — the pricing rip (prd9 ruling 7): vendored MIT price data →
selector-side ESTIMATES for lanes that have tokens but no authoritative
cost. Evidence: `research/2026-08-03-trace-era-captures.md` §3. Core-side
only — the web already renders the estimate vocabulary
(`authoritative:false` / `estimateSource`, the `est.` flags from #47) and
must not be touched.

1. **Vendor the table** — new `packages/core/src/pricing/`:
   - Copy `default-model-prices.json` VERBATIM from the local clone
     `~/langfuse-probe/langfuse/worker/src/constants/default-model-prices.json`
     (that clone is at commit `cfac485243654f54ebae942a556d2b92ec81df56`).
   - Beside it: `LICENSE` (Langfuse's root MIT license text verbatim) and
     `PROVENANCE.md` (source URL, the pinned SHA above, retrieval date
     2026-08-03, and the update procedure: re-fetch pinned to a new SHA).
   - Root `THIRD_PARTY_LICENSES.md` (new): one entry for this file.
2. **Loader** — parse/validate what we use of the shape (id, modelName,
   matchPattern, pricingTiers → prices). Two documented traps from the
   research: `matchPattern` strings start with `(?i)` which is INVALID in
   JS RegExp — strip it and use the `i` flag; and the alias key
   `cache_creation_input_tokens` silently prices all cache-creation as 5m —
   use ONLY the split keys (`input_cache_creation_5m`,
   `input_cache_creation_1h`, `input_cache_read`, plus plain
   input/output). Our `TokenTotals` does not split 5m/1h cache creation —
   price `cacheCreation` at the 5m rate and NAME that assumption in the
   estimate provenance (it is the cheaper bound of the two by 1.6x... no:
   5m = 1.25x input, 1h = 2x input, so 5m is the LOWER price — the
   estimate is a floor on that tier; say so).
3. **Estimates in the spend selectors** — `selectors/spend.ts`: where a
   lane/model has `llm.usage` tokens but NO authoritative `llm.cost`,
   derive an estimated cost from the table. Laws:
   - An estimate is ALWAYS flagged: it flows through the existing
     `authoritative: false` + `estimateSource` vocabulary (source names
     the table + SHA, e.g. `langfuse-prices@cfac485`), never a bare
     number.
   - Authoritative dollars and estimates are NEVER silently summed: any
     total that mixes them carries the existing `incl. estimate` marker
     the UI already renders.
   - A model the matchPatterns don't hit gets NO estimate — an honest gap,
     never a guess (the research note's live `[1m]`-suffix miss is the
     canonical case: add a test for exactly that model id, expecting no
     match against the vendored table's real patterns unless they cover
     it).
   - Derivation on read, in selectors — nothing new stored in the fold,
     no event shape changes.

## Fence (may touch ONLY)

- `packages/core/src/pricing/` (new)
- `packages/core/src/selectors/spend.ts`
- `packages/core/src/selectors/spend.test.ts`
- `packages/core/src/selectors/index.ts`
- `packages/core/src/index.ts`
- `THIRD_PARTY_LICENSES.md` (new, repo root)

## Blocked by

Nothing (wave A landed). **Model:** sonnet. **Wave:** B.

## Definition of done

- Vendored file byte-identical to the pinned source; LICENSE + PROVENANCE
  + THIRD_PARTY_LICENSES present.
- Loader tests cover the `(?i)` strip and refuse the 5m-alias key; the
  cacheCreation-priced-as-5m assumption is named in `estimateSource`
  provenance or docs-comment.
- Estimate laws tested: flagged always; never silently mixed; no-match →
  no estimate (with the `[1m]` case); tokens-only lane gains a flagged
  estimate; a lane with real `llm.cost` is UNCHANGED.
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
