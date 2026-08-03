# Provenance — `default-model-prices.json`

- **Source**: https://github.com/langfuse/langfuse/blob/cfac485243654f54ebae942a556d2b92ec81df56/worker/src/constants/default-model-prices.json
- **Pinned commit SHA**: `cfac485243654f54ebae942a556d2b92ec81df56`
- **Retrieved**: 2026-08-03
- **License**: MIT (Expat) — `worker/src/constants/` sits outside every `ee/`
  directory in the Langfuse repo, so this file is unambiguously MIT. See
  `LICENSE` in this directory (Langfuse's root license text, verbatim).

## Why this file, why this SHA

Researched for prd9 wave B (`research/2026-08-03-trace-era-captures.md` §3):
166 models, 32 Claude entries, actively maintained (2-8 commits/month, a
nightly GitHub Actions price-audit files correction PRs). No unauthenticated
API export exists, so the only reproducible route is a raw snapshot pinned to
a commit — never a live fetch.

## Shape this repo relies on

Per entry: `id`, `modelName`, `matchPattern` (case-insensitive regex, prefixed
`(?i)` — invalid in JS `RegExp`, our loader strips it and applies the `i`
flag instead), `pricingTiers[]` (we use only the tier with `isDefault: true`),
each tier's `prices` map keyed by USD-per-token:

- `input`, `output`
- `input_cache_read` — cache hits
- `input_cache_creation_5m`, `input_cache_creation_1h` — the two cache-write
  tiers, priced apart
- `cache_creation_input_tokens` — an ALIAS equal to the 5m price. Our loader
  never reads it: pricing an aggregate cache-creation count with it silently
  assumes every write was 5m, which the split keys make an explicit choice
  instead of an accident.

## Update procedure

1. Re-fetch the same path at a new commit SHA from the Langfuse repo.
2. Verify the new file still validates against `prices.ts`'s parse (run
   `npm test -w @rhizomorph/core` — the loader test suite fails loudly on a
   shape change).
3. Replace `default-model-prices.json` verbatim (no reformatting — byte-for-
   byte, so a diff against upstream stays meaningful).
4. Update the SHA and retrieval date in this file and in
   `THIRD_PARTY_LICENSES.md`.
5. Re-copy `LICENSE` only if Langfuse's root license text itself changed.
