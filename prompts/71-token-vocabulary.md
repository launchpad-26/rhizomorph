You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue — documentation. Fact-check every claim
against the code as it exists NOW (post-#70): read the spend, ledger,
worktrees and replay components before describing them.

YOUR ISSUE — #71 (71. Docs: a token is not a unit — vocabulary, ratios, and what each surface shows)

**Fence (may touch ONLY):** `docs/telemetry.md`, `README.md` (Dashboard section only)
**Blocked by:** #70. **Model:** sonnet. **Wave: E (token semantics ruling)**

The product now refuses to show an unlabelled token total; the docs must
carry the vocabulary that justifies it, so a stranger reading the dashboard
understands what each number means.

Add a "What is a token (not a unit)" section to `docs/telemetry.md`:
- The four tiers (input, output, cacheRead, cacheCreation) and what each
  measures; output = work produced, input = fresh context, cache read =
  re-read context, cache write = newly cached context.
- The price ratios that motivate the ruling — output ≈ 5x input, cache read
  ≈ 0.1x, cache write ≈ 1.25x — with an as-of date (2026-07) and a note
  that these are ratios across current Claude models, checked against the
  provider's published pricing, and can drift.
- Which number each dashboard surface shows and why (output-led headline,
  four-tier split, cost-with-provenance where OTel exists), and the standing
  rule: no unlabelled all-tier totals.
- Rate limits: cache reads dominate subscription rate-limit consumption even
  though they are cheap in dollars — this is why the tiers stay visible.
- The overhead ratio's definition (conductor OUTPUT ÷ worker OUTPUT) and the
  note that prd1's earlier all-tier definition was retired by ruling.

Update the README Dashboard section to match what the panels now show.
Fact-check every claim against the code and the live `--help`; do not
document behaviour you have not verified in the source.

**DoD:** root `npm test` + `npm run typecheck` green (docs-only change —
suite proves nothing broke); no NUL bytes. Never push, merge, or run git in
a sibling worktree — committing on YOUR branch is required.


RULES: stay strictly inside the FENCE (other agents work in parallel);
build for a stranger machine — no personal paths or names; small
conventional commits; committing on YOUR branch is REQUIRED; never
push, merge, or run git in a sibling worktree; no NUL bytes; STOP when
done.
