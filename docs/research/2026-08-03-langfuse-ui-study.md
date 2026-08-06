# Langfuse UI study — information design for the rhizomorph waterfall (B1)

> Studied 2026-08-03 on self-hosted Langfuse v4.1.0 holding a REAL claude
> 2.1.220 beta trace (pushed via OTLP the same day — see
> `research/2026-08-03-trace-era-captures.md` §3). All observations [Ran]
> against the live instance. Decision served: the layout and information
> design of rhizomorph's lane-drawer waterfall, groomed as B1 after the
> operator's layout blessing.

## What their trace surface does (and what to steal)

1. **Tree with duration-under-name.** Left rail: indented span names, each
   with its duration directly beneath; type conveyed by a small colored
   glyph (GENERATION/TOOL/SPAN). Scan-reads instantly. STEAL: name+duration
   stacking and kind-glyphs — map to our existing glyph alphabet rather
   than their icon set.
2. **Wall vs Σ at the root.** The root shows `17.40s  Σ 19.69s` — wall time
   AND summed child time, distinguished. Honest about concurrency. STEAL
   verbatim; it matches our no-invented-numbers voice.
3. **Tree ⇄ Timeline toggle.** Same data, two views: nested list, or gantt
   bars against a time ruler with duration labels at bar ends. The timeline
   makes the two 4s tool sleeps legible at a glance. STEAL the toggle idea;
   our v1 can ship tree-first and add the gantt only if it stays in B1's
   budget (the tree alone already answers "what happened").
4. **Session as a first-class clickable chip** on the trace header; the
   Sessions table groups traces by `session.id` (our 20s probe = 1 session,
   2 traces) with duration/token/cost filters. For us: the drawer IS the
   session context already — the chip becomes "this interaction belongs to
   lane X," free from existing attribution.
5. **Aggregated/Expanded mini-graph** (node-link) of the span tree — pretty,
   but redundant with the tree for our audience. SKIP (scene already owns
   the organic view; a second graph competes with it).
6. **Detail panel per span**: chips (latency/session/user/env/version),
   Preview (Input/Output), Metadata table of resource attrs, Scores,
   Log View, annotation affordances (Add to datasets / Annotate /
   Corrected Output). SKIP the annotation/eval surface entirely (not our
   product); KEEP a lean metadata read-out — our allowlisted span fields
   are small enough to show whole.

## Where their design starves on agent-CLI data (our openings)

- **Input/Output are `null`/`undefined`** for claude beta spans — prompts
  are redacted at source, and their layout gives the empty payload panes
  the biggest area on screen. Rhizomorph's drawer pairs the waterfall with
  the TRANSCRIPT (sessionlog), so the conversation lives beside the spans
  instead of a void. This is the single biggest layout divergence to make
  deliberately.
- **Token counts read 0 and costs $0.00** — their OTLP mapping did not
  recognize claude's `input_tokens`-style span attributes (they expect
  `gen_ai.usage.*`), and their price catalog missed `claude-opus-5[1m]`.
  Our parser reads the real attributes ([Ran], wave A) and B2's estimates
  flag the `[1m]` miss honestly. Worth one line in the cohort pitch:
  point-the-same-stream at both and compare.
- **No swarm context**: the trace floats free — no lane, branch, worktree,
  or collision context on any surface. Ours lands inside the lane drawer
  where all of that already surrounds it.

## Live-dashboard gaps inventory (operator raised; for B1 grooming)

Seen on rhizomorph's own dashboard during the same session:

1. **`GAP: CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable`** (burn
   strip). Sessionlog-side conductor wiring now EXISTS (`--extra-sessions`
   across the /mnt/c mount — fable-5 tokens visible on MAIN within
   minutes). The remaining gap is the COST-based headline: it needs the
   conductor's own `claude` relaunched with the OTel env block (attach at
   launch — operator act, instructions in the journal/session).
2. **`$` column `—` on every lane** — no per-lane authoritative cost on
   subscription lanes; B2's flagged estimates are the designed fix.
3. **Ignored OTel metrics** (`claude_code.session.count`,
   `active_time.total`, `lines_of_code.count`, `commit.count`,
   `pull_request.count`) and the discarded `/v1/logs` events — candidates
   to wire during/after B1 where a surface actually wants them (active
   time is the strongest: the fleet table has AGE but not active time).
   Grooming rule: wire a metric only when a surface reads it; no
   data-hoarding.
4. No trace surface exists yet anywhere in the UI — B1 is greenfield in
   the drawer.

## Verdict for B1

Tree-first waterfall inside the lane drawer, below the transcript
(prd4: conversation stays lead): name+duration rows with kind-glyphs,
wall-vs-Σ on interaction roots, blocked-on-human rows carrying their
decision badge, llm_request rows carrying model + output-led token
annotation, gantt toggle only if budget allows. Skip payload panes, skip
the graph, skip annotations. The session chip becomes lane attribution we
already have. Operator blesses the layout before grooming.
