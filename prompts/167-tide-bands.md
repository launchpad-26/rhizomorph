You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

You are building the KEYSTONE of prd13 — the contract three later waves
render from. docs/prd13.md binds you; its rulings are quoted by number in
your issue. Purity is the whole point of this lane: if you find yourself
importing React or reading the DOM, you have left the issue.

YOUR ISSUE — #167:

## Direction

prd13 wave 1 of 4 — **the keystone**. Read `docs/prd13.md` IN FULL first; its
eleven rulings bind every TIDE lane. This lane builds the contract everything
else renders from: the pure band selector.

**What it is.** A lane's history is a sequence of state bands: `ke5 was WORKING
14:00–14:38, WAITING 14:38–14:52, …`. The TIDE (prd13 ruling 1: the replay
bar's body, never a panel) renders those bands; this lane computes them.

1. **`bandsFor(events)` — pure, single pass, O(n).** Walks the event log once
   and emits per-lane bands: `{ lane, state, startTs, endTs, durationMs }`,
   with `endTs` open for the final band of a live lane. State vocabulary is the
   existing activity-state ladder (prd4 law 9a/9b — working / waiting / broken
   / parked) — import it, never redefine it. No new states invented here.
2. **Gaps are absence, not a state** (prd13 ruling 8). Where telemetry coverage
   stops, emit an explicit `{ kind: 'gap' }` band, distinct in type from state
   bands. An uninstrumented lane must be *representable* as unknown — it must
   never come out of this selector looking idle.
3. **`coalesce(bands, minSpanMs)`** — merges bands shorter than a caller-given
   span into their neighbours (prd13 ruling 4: sub-pixel slivers are a measured
   failure mode; the felt-evidence pass watched 1–2px bands be unhoverable).
   Pure; the pixel scale is the caller's business.
4. **`rowPlan(lanes, topN)`** — stable-for-the-session ordering (prd13 ruling
   3: first-seen order, never re-sorted by attention) with the remainder
   coalesced into a `+N` descriptor carrying its count (the existing coalescing
   law on a new surface).

Laws, test-stated — these are the lane's real deliverable:

- **Bands per lane are contiguous and non-overlapping**, and every band's
  duration sums to the lane's observed span. Coalescing preserves total
  duration exactly — merging never invents or loses time.
- **A gap never becomes a state**: no input sequence can produce a state band
  covering a region the events do not attest.
- **Same selector, live and replay** (the product's core law): `bandsFor` over
  a prefix equals the truncation of `bandsFor` over the whole — prove it
  property-style over generated event sequences, not just fixtures.
- Determinism: same events, same bands, byte-equal.

Import event types from `@rhizomorph/core`; derive states via the existing
fleet/activity selectors' vocabulary rather than duplicating their mapping —
if the mapping you need is not exported, print `BLOCKED: <need>` rather than
copying it (a copy is drift-by-construction).

## Fence (may touch ONLY)

- `packages/web/src/tide/` (new directory — all files yours)

## Blocked by

Nothing. **Model:** opus (it is the contract; #123 precedent). **Wave:** TIDE
wave 1. Waves 2–4 (#168 body, #169 dock, #170 scoped window) build on this —
their issues exist; do not read their scope into yours.

## Definition of done

- The three functions above, exported with law-stating tests as described.
- Zero rendering, zero DOM, zero imports from React — this module is pure.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
