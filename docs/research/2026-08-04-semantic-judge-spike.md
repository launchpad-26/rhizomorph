# prd11 ruling 6b — the semantic judge: intent-collision detection spike

**Date:** 2026-08-04 · **For:** the semantic-judge prd (post-spike) · **Method:** source-reading of
our own `collisions.ts`/`architecture.md`, the Mission 04 evidence base
(`agenticlaunchpad/research/2026-07-29-human-seams-in-agentic-pipelines.md`), WebSearch on prior
art, current model pricing from the claude-api skill, and a probe of this box. Graded `[Ran]` /
`[Verified]` / `[Consensus]` / `[Thin]`.

**What exists today:** `selectCollisions` (`packages/core/src/selectors/collisions.ts`) maps
file → branches from `worktree.dirty`/`commit.landed` — purely FILE identity. Two lanes writing
the same helper in *different* files, or a lane drifting off its brief, are invisible until merge.
Available per lane: dispatch brief, session JSONL (the `sessionlog` collector already tails
`~/.claude/projects/*/*.jsonl`), `tool.activity` + `filePath` (ruling 2, landing now), trace
spans, git diffs. [Verified — our source]

## The verdict first

**Build two organs, in this order, and push back on one part of the commissioning hypothesis:**

1. **Structural intent signal (build this week, before any LLM):** extract added/changed
   symbol names (functions, exports, classes) from each lane's diff vs merge-base, plus
   pairwise speculative `git merge-tree` (three-way merge in memory, repo untouched — read-only
   law intact). Two lanes both adding `formatDuration` in different files is an intent
   collision no file matrix can see, and it is deterministic, free, and pure selector logic in
   the existing collector shape. This is also the **corroboration signal** the alert ladder
   needs (§3).
2. **Semantic layer:** per-lane intent digest (haiku-class, event-driven cadence) + **one
   batched judge call** comparing all digests pairwise and each digest against its own brief.
3. **Drop the embedding pre-filter at this fleet size.** The commissioned shape ("digest +
   pairwise embed pre-filter + LLM confirm") is the right cascade for large N — but at N≤10
   lanes there are ≤45 pairs, and a single batched call carrying all 8 digests (~150 tok each)
   is cheaper than the embedding infrastructure it would gate, and strictly cheaper than N²
   pairwise LLM calls. Anthropic ships no embeddings endpoint [Verified — claude-api skill], so
   embeddings mean a second local stack (ollama is NOT installed on this box [Ran]) for a cost
   problem we do not have. Revisit at ≥12 lanes; below that it is a moving part with no payoff.

Cost envelope ≈ **$0.25/hour at 8 lanes** (§2). One validating experiment before any UI (§6).

## 1. Signal design — value per token, ranked

- **Symbol extraction from diffs [best precision/$ — costs $0].** `git diff -U0 <base>...HEAD`
  per lane, regex the added `function`/`export`/`class` names, intersect pairwise. Pure text
  over command output — exactly the collector contract (`poll → events`, fixture-testable).
  Misses paraphrase collisions (`formatDuration` vs `humanizeTime`); that residue is what the
  LLM layer is *for*. [Verified — architecture.md collector shape]
- **Speculative merge (`git merge-tree --write-tree`).** Actually attempt the merge in memory
  between lane pairs; report conflicts before either lands. The pre-LLM literature's strongest
  result is exactly this move — *do* the integration speculatively instead of predicting it
  (Crystal, §5). Cheap, honest, zero false positives on the textual class. [Consensus —
  git docs; vendor writeups of the same pattern]
- **Intent digest (brief + transcript tail → ~150-token "current goal" summary).** The highest
  *semantic* signal per token: raw transcripts are 100k+ tokens and mostly tool noise; the
  brief alone is static and says nothing about drift. Digest = brief (~0.5k) + last ~2-3k
  transcript tokens in, 150 out. Cadence: event-driven — re-digest only when the lane's
  transcript grew ≥N events since last digest, floor 5 min, idle lanes cost zero.
- **Batched pairwise judge.** One call: all digests + one-line brief summaries; output per pair
  {overlap? verdict, evidence} and per lane {on-brief? verdict, evidence}. Judging digests
  instead of transcripts is the whole cost story; judging all pairs in one prompt beats both
  N² calls and the embed cascade at this N (verdict §3 above).
- **Rejected as primary signals:** raw transcript-vs-transcript comparison (token blowup);
  `tool.activity` file paths alone (that is the existing organ); trace spans (timing, not
  meaning — useful later as digest-window boundaries).

## 2. Model + cost budget

- **API haiku-class is the week-one engine.** `claude-haiku-4-5`: $1/MTok in, $5/MTok out
  [Verified — claude-api skill, cached 2026-06]. At 8 lanes, 10-min effective cadence:
  48 digest calls/hr (~144k in + 9k out ≈ $0.19) + 6 judge calls/hr (~18k in + 3k out ≈ $0.03)
  ≈ **$0.22/hr ≈ $1.10 per 5-hour session**. Prompt-cache the instructions + briefs and it
  drops further. Ceiling proposal: **$0.50/hr hard stop** — the judge disables itself past it
  and logs that it did.
- **The rate-limit trade, named.** "Dollars are notional on subscription" — but a judge run
  through the operator's `claude` CLI shares the Team-subscription rate window with the
  WORKERS. ~54 small calls/hr is roughly the burn of one light worker lane; at wave peak that
  is a real worker's headroom. Recommendation: **run the judge on an API key** (~$0.25/hr of
  real, trivial dollars) so it never competes with the fleet. This contradicts the
  course-runs-on-Team-subscription default and needs an operator ruling. [Thin — burn
  comparison is estimated, not measured]
- **Local model, graded honestly.** Box: WSL, 31GB RAM, 20 cores, **no GPU, no ollama
  installed** [Ran]. A 3–4B q4 model on 20 CPU threads should prefill a 3k-token digest prompt
  in ~15–60s — viable at this cadence *on paper*, but (a) unbenchmarked here, (b) digest
  quality of 3B models on "state this agent's current goal" is unproven, and a hallucinated
  digest poisons every downstream judgment. [Thin] Verdict: not the week-one path; a
  local-digest experiment is a fine follow-up once the API pipeline has a quality baseline to
  compare against.

## 3. False-positive discipline — the Mission 04 evidence applied

The constraint set, from our own note [Verified — human-seams §1, §3, §7]:

- **Rarity degrades detection**: miss rate 0.20 → 0.46 as prevalence falls 50% → 2% (Wolfe);
  radiologists miss 30% at clinical prevalence vs 12% of the *same* cancers at 50% (Evans).
  Real intent collisions are rare ⇒ an operator asked to review every judge murmur becomes a
  1%-prevalence searcher and misses the real one.
- **A better judge makes oversight worse**: omission errors rose 32.4% → 48.3% as aid
  reliability rose 0.87 → 0.98 (Bailey & Scerbo). A judge that cries wolf trains the operator
  to ignore it; a judge that is usually right trains the operator to stop checking.
- **The strongest positive result is our architecture**: independent second reader **with
  arbitration** raised detection 8.89% while *lowering* false recalls 4.76% → 4.08% across
  805,206 screenings (CO-OPS). The semantic judge is the second reader over the file-collision
  first reader — and **independence is the active ingredient**, which is why the structural
  signal (§1) and the LLM signal must stay separately computed, corroborating only at the
  ladder.
- Alert-budget numbers: acceptance drops 30% per additional alert per encounter (Ancker);
  attention collapses fast and recovers slowly — 100% → 8.4% in, 9.1% → 12.7% back (Wright);
  high override rate means the gate is wrong, not the human — 97.9% of overrides were correct
  (Weingart); "are you sure" friction is measured useless (Van Wert).

**The ladder (maps onto the existing CALM → NOTICE → NEEDS-YOU → BROKEN):**

1. **Silent log — every finding, always.** Judge findings are events (`judge.finding` with
   digests, pair, verdict, evidence) in the append-only log: replayable, visible in a drawer
   history, part of the record. A finding is a fact ("the judge said X at T") — consistent
   with the event-sourced core. Never surfaced on first fire.
2. **NOTICE (cyan)** only on persistence or agreement: the same pair flagged on **2
   consecutive judge cycles**, OR intent-flag + symbol-overlap agreeing. Full evidence strings
   (§4) attached.
3. **NEEDS-YOU** only on **cross-organ corroboration**: intent-collision + file-collision on
   the same pair, or drift-flag + fence violation on the same lane. The judge alone can never
   summon.
4. **Budget: ≤3 NOTICE surfacings per organ per session**; beyond that, coalesce into one
   aggregate carrying a count (the scene's existing law). If the judge wants more than 3, the
   thresholds are wrong — raise them, don't add friction.
5. **Calibration, the one measured mitigation** (Wolfe 2007): periodically replay a session
   with a known collision and check the operator-visible pipeline catches it — the §6
   experiment doubles as the first seeded-defect replay, and re-running it is the ongoing
   health check. Do NOT measure judge health by how rarely it fires.

## 4. Honest evidence strings

A surfaced flag must render, verbatim and inspectable (operators cannot recall what they
checked — Reichenbach; the flag must *show* the check):

- the **two intent digests side by side**, each with its digest timestamp and the transcript
  window it summarizes (event ids — this joins ruling 1's causal chain for free);
- the **overlapping symbols/files** from the structural signal, or the explicit honest gap:
  *"no file or symbol overlap — semantic signal only"*;
- the **brief lines in tension**, quoted from each dispatch brief;
- the judge's **one-sentence reason** and which cycle(s) fired it.

Never a bare "lanes 3 and 5 may conflict". A flag whose evidence can't be rendered is not
surfaced — it stays a log event.

## 5. Prior art, graded hard

- **MAST — "Why Do Multi-Agent LLM Systems Fail?"** (Cemri et al., arXiv:2503.13657):
  1,600+ annotated failure traces across 7 frameworks, κ=0.88; **inter-agent misalignment is
  36.9% of failures** (conflicting outputs, context loss, duplicated roles). Best available
  evidence that the problem class is real and large; no detection mechanism offered.
  [Verified — arXiv abstract]
- **Crystal — "Proactive detection of collaboration conflicts"** (Brun, Holmes, Ernst,
  Notkin, ESEC/FSE 2011): speculatively merge/build/test collaborators' code in the
  background; "textually clean but fails build/test" reported as conflicts. 9 systems, 3.4M
  LOC, 550k dev versions. The transferable idea: **attempt the integration, don't predict
  it** — our `merge-tree` signal is Crystal's cheapest slice. [Verified — ACM; I did not
  re-verify the paper's specific percentages and quote none]
- **SAM — "Detecting Semantic Conflicts with Unit Tests"** (arXiv:2310.02395 / JSS 2024):
  best configuration caught **9 of 28** known semantic conflicts *post-merge with full code
  and generated tests*. Calibrating: if post-hoc semantic detection is this hard, a live
  transcript-level judge will have modest recall — which is exactly why it must never summon
  alone. [Verified — abstract]
- **The agent-swarm-specific space is hype.** Vendor guides (Augment, Medium et al., 2026)
  describe worktree isolation and merge-time deferral; one concrete technique recurs —
  pairwise `git merge-tree` between worktrees ("Clash") — nothing measured on *intent*-level
  detection. Cite the technique, not the claims. [Thin — vendor blogs, no evaluations]

## 6. The one experiment before any UI

**Replay a real recorded session through the pipeline, offline.** We already store full
session JSONLs and have replay machinery. Pick a historical wave with a known merge pain
(the journal records the day file-collisions became "the day's own failure mode"). Run digests
+ batched judge over the recorded transcripts *at the recorded timestamps*; run the symbol
extractor over the reconstructed diffs. Measure: (a) is the known collision flagged ≥1 judge
cycle before the merge-pain moment? (b) how many false NOTICEs across the rest of the session
under the §3 ladder? (c) actual token cost vs the $0.25/hr estimate. **Pass: known collision
flagged early with ≤2 false NOTICEs and cost within 2× estimate.** Fail on (b) ⇒ tune
thresholds and rerun — before a single pixel is drawn.

## What to avoid

1. Per-pair LLM calls (N² cost) and the embedding pre-filter at ≤10 lanes — one batched call.
2. Summons on first fire; any alert path that skips the silent-log rung.
3. Judging raw transcripts — digest first, always.
4. Fixed per-minute cadence (cost + alert flood); digest on transcript delta.
5. The judge writing anything into the watched repo (read-only law; `merge-tree` is in-memory).
6. Trusting the judge's self-reported confidence as a severity axis — corroboration is the
   only escalator.
7. Local 3B digests without a measured quality baseline against the API digests.
8. Bare flags — no evidence strings, no surfacing.
9. Measuring judge health by silence (a quiet gate is indistinguishable from an ignored one).

## Open questions for the operator

1. **Judge budget source:** API key (real ~$0.25/hr, workers untouched) vs Team subscription
   (notional dollars, competes with workers)? Needs a ruling — it contradicts the
   course-subscription default.
2. **Do `judge.finding` events enter the portable record?** They are facts about the judge,
   so ruling 3 says yes by construction — but they embed transcript-derived digests; confirm
   the privacy-allowlist carry-through covers them.
3. **Is drift-from-brief its own organ or the same judge?** Same batched call is cheapest;
   separate ladder budgets may still be right.
4. **Where does it run** — inside the server as a (first-ever) non-deterministic collector, or
   a sidecar process emitting into the same log? The "collectors emit raw facts" law bends
   either way; name it before the prd.

## Sources — accessed 2026-08-04

MAST — https://arxiv.org/abs/2503.13657 · Crystal — https://dl.acm.org/doi/10.1145/2025113.2025139
· SAM — https://arxiv.org/abs/2310.02395 · Mission 04 evidence —
`agenticlaunchpad/research/2026-07-29-human-seams-in-agentic-pipelines.md` (Wolfe 2005/2007,
Evans 2013, Bailey & Scerbo 2007, CO-OPS 2018, Ancker 2017, Wright 2018, Weingart 2003, Van
Wert 2009, Reichenbach 2010 — all graded there) · Pricing — claude-api skill (cached
2026-06-24): `claude-haiku-4-5` $1/$5 per MTok; no Anthropic embeddings endpoint · Vendor
worktree guides (graded [Thin]) — augmentcode.com/guides, medium.com/@jsmanifest · **Box probe
[Ran]:** `wsl -- sh -c "which ollama; free -g; nproc"` → no ollama, 31GB RAM, 20 cores. **Our
source, read this session:** `packages/core/src/selectors/collisions.ts`, `docs/architecture.md`,
`docs/prd11.md`, `docs/prd3.md` (ladder), `docs/research/2026-08-04-prd10-gorgeous-spike.md`
(house style).
