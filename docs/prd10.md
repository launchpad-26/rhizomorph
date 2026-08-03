# prd10 — the gorgeous round: growth, life, flourishing and return

The instrument is correct; now it earns its keep as an object of beauty.
The operator's brief, verbatim north star: **"A replay should look like a
legitimate art piece, of growth, life, flourishing and return."** Decisions
from the scene-beauty interview, operator, 2026-08-04. Research companion:
`docs/research/2026-08-04-prd10-gorgeous-spike.md` (the spike this prd
commissioned).

## Rulings

1. **Replay-as-art is a requirement, not a vibe.** Every visual decision in
   this round is judged by how a full-session replay reads: emergence
   (lanes born), flourishing (work pulsing outward), and return (landed
   matter flowing home). If a choice looks good live but makes the replay
   read as clutter or amputation, it is wrong.
2. **Severed threads: the composting-decay hybrid.** A landed lane's cord
   no longer hangs cut off. On severance it does BOTH movements, one
   event-class act: the cord decomposes into bioluminescent motes along
   its own path while its matter visibly flows home — and the heart gains
   a permanent growth ring for it. No stubs persist; the scene may forget
   the thread's geometry because the LEDGER remembers the thread (operator:
   memory is accessible there; the scene owes beauty, not bookkeeping).
3. **The heart is mycorrhizal anatomy, not a blob.** Concentric growth
   rings — one per landed lane, the session's tree-ring memoir, ring
   contours irregular via the existing seeded noise — plus a fine hyphal
   lattice radiating toward the rim, breathing on the existing ambient
   cycle. The rings are data-honest: every ring is a real landing, and the
   composting act (ruling 2) is what deposits it.
4. **Tips: apical tufts, and law 9b is AMENDED within reason.** Growing
   thread ends taper into fine 2–3 branchlet growth-cones in vivid family
   hue; commits pulse through to the tip; a landing flares the tuft once
   (event class). The amendment: a WORKING lane's tip — only the tip, only
   while working — may carry a small steady glow above the calm ceiling.
   Bounds that keep the amendment "within reason": tip glow stays below
   alarm luminance, never wears the alarm grammar's other instruments
   (cartouche, fade exemption), and occupies a small radius — an alarm
   anywhere on screen must still dominate at a glance. The 9b test
   restates the law with the amendment, stricter in its bounds.
5. **Ruling 29 is AMENDED: one accent hue for living tissue.** A deep
   bioluminal undertone (violet-teal family; exact token chosen by the
   operator from the spike's candidates) is permitted for ORGANIC TISSUE
   ONLY — the heart's depths, thread underglow, spore motes. Never status,
   never data ink, never chrome. It gets a token and a law test: the
   accent class may appear only in scene tissue draws.
6. **Depth, texture, ambient life — within the motion budget.** Iridescent
   per-thread luminance shimmer (seeded, hue-less), radial depth fog,
   subtle grain, drifting spores riding the existing breath cycle, rim
   flora on the fold. All ambient-class; the budget's caps do not move.
7. **The frame budget holds.** 60fps median on the dev box, measured
   before/after like prd7; particle work is pooled and bounded (the spike
   names the budgets); no WebGL — canvas 2D remains the ruled medium.
8. **Laws restated stronger, never weakened**: hue-is-meaning survives the
   accent (status hues gain no new uses); glance-legibility (prd4's layman
   bar) is re-checked by the operator on the live scene AND a replay
   before this round closes.
9. **Subagents are buds on their parent's thread** (operator ruling,
   2026-08-04). A lane's live subagent renders as a side-branchlet budding
   from THAT lane's thread — never from MAIN's structure — and the
   conductor's subagents bud from MAIN's own anatomy. Spawn is one
   event-class act; completion absorbs the bud back into its parent
   (the same return grammar as ruling 2, in miniature). Data honesty:
   liveness comes from thread-marked sessionlog telemetry
   (`isSidechain` → `thread: subagent`), which exists for EVERY lane and
   for the tailed conductor — trace spans (`agentId`, `subagentType`)
   enrich the bud where the lane is instrumented, and buds are one level
   deep until nested-agent traces are observed in the wild
   (`parent_agent_id` remains uncaptured). A lane with no telemetry at
   all grows no buds and loses nothing else — the existing gap-honesty
   voice. This keeps prd2's "sub-rows are never a lane of their own":
   a bud is anatomy of its parent, not a lane.

## Implementation

One solo scene lane (opus — aesthetic judgment work), wide fence landing
alone behind the full gate: `packages/web/src/scene/**`, the accent token
in `theme/theme.css`, scene law tests, and the small core selector ruling
9 needs (`selectors/subagents.ts` — per-lane live subagent presence from
thread-marked telemetry recency, trace-enriched where available — plus its
barrel lines; dispatched only after the active-time lane frees the
barrels). The operator eyeballs live + replay before the round closes
(GATE: the art call is his). The spike's verdicts bind technique choices;
its accent candidates go to the operator with rendered swatches at review.
