# PRD 3 — The Instrument (visualization design study)

> **Status:** rulings taken 2026-07-31 via extended design interview (~27
> rulings, Lachlan); this document records them as the operating plan.
> Spikes fire next session. prd2 sealed the numbers; prd3 makes them
> glanceable and beautiful.

## One-liner

Make the Observatory a beautiful instrument: an operator glances at it and
knows, in one second, whether anything needs them — and can point at the
looping agent, the frozen one, the waiting one, the expensive one, and the
one that wandered off its fence, without reading a number.

## Why (the market thesis)

Ops tooling is aesthetically dead; "beautiful instrument" is a gap. The
Observatory already has an identity (neon-on-dark) and — since prd2 —
numbers that mean what they say. prd3 is the discipline pass: spend beauty
where it carries meaning, and make agent health legible at a glance.

## The frame (rulings 1–4)

1. **Primary viewer: the operator mid-run.** Second-monitor/background-tab
   usage; ties break toward glanceability. Reviewers and demo audiences are
   served by the same clarity.
2. **The first-second question is "anything need me?"** Attention leads the
   visual hierarchy; activity and cost read second.
3. **Identity: refine the neon-dark instrument.** No reinvention. Discipline:
   color demoted to semantics, contrast spent on data, one accent family.
4. **The scene is load-bearing** — it keeps its screen only by answering
   real questions faster than the tables.

## Structure (rulings 5–8)

5. **Attention strip** — thin, always-present top bar. Calm state: ALL
   CLEAR (with evidence, see ruling 14). Otherwise: "N need attention",
   items named (lane + why + how long), click-to-jump. Single source of
   truth for tab signals.
6. **Layout: curated hierarchy + collapse + focus.** One conductor-curated
   order (attention strip → fleet → burn → the rest); per-panel collapse
   stays; any panel can focus to fill the view (Esc restores). No
   drag/resize/custom layouts (deferred).
7. **Density: dense tables, calm chrome.** Compact rows, 10+ lanes without
   scrolling; hierarchy via size/contrast/position, whitespace lives
   BETWEEN panels. Bloomberg numbers in Linear bones.
8. **Alarm ladder: CALM → NOTICE → NEEDS-YOU → BROKEN.** At NEEDS-YOU and
   above: favicon badge + tab title flips ("● 2 need you"). No sound
   (deferred).

## Laws (rulings 9–12) — every surface obeys these

9. **Color law: status owns hue.** The ladder gets exclusive hues (calm =
   neutral, notice = cyan, needs-you = amber, broken = magenta/red), used
   for nothing else. Identity (roles, lanes) differentiates by lightness,
   shape, position, label — never the status hues. Color is never the sole
   carrier: every state also has an icon/glyph/text.
10. **Motion law: events move, states glow.** Motion is spent on events
    (landing streak, one attention pulse then steady, removal fold);
    ongoing states are static treatments. The scene's low-amplitude
    breathing is the only ambient motion. `prefers-reduced-motion`
    respected.
11. **Type & number law.** Sans for labels/copy; monospace with tabular
    numerals for ALL data (numbers, branches, ids, timestamps); display
    face for the wordmark only. SI abbreviations everywhere with full
    precision on hover, through the one shared formatter (#70).
12. **Gap voice law.** Every gap state speaks in one terse line: WHAT is
    missing → WHY it matters → THE command that fixes it. ("NO COST FEED
    (OTel) — dollars unavailable — run: `eval "$(observatory env <lane>)"`.)
    Applies to: conductor-not-instrumented, unattributed spend, refused
    posts, dead collectors, empty panels. This resolves the prd2-noted
    banner contradiction.

## Surfaces (rulings 13–17)

13. **Money = burn strip + forensic ledger.** A compact BURN STRIP docked
    with the attention strip: output tokens, dollars (when authoritative),
    burn rate, overhead ratio — four numbers, no chrome. The LEDGER stays
    as the deep per-branch/thread table. The spend ticker panel dissolves
    into these two.
14. **Collisions: attention-integrated, evidence-bearing.** A real
    collision is a ladder item (click expands the matrix). Empty state is
    one ambient line WITH EVIDENCE: "collisions: 0 — checked N branches /
    M files" (never bare reassurance — the absence-of-flag research).
15. **Event chrome: unified activity feed + provenance bar.** The commit
    ticker grows into one quiet feed (commits, landings, lane starts/stops,
    collector events; filterable). The bottom collector/source bar stays as
    ambient provenance; broken collectors also escalate to the strip.
16. **Replay: full mode shift.** Distinct frame + tint; the attention strip
    is replaced by a REPLAY banner (timestamp, session, exit-to-live).
    Scrubber redesigned as chrome. No new replay features.
17. **Chat at a click — view + copy-to-attach.** The read-only constitution
    stands: the Observatory never sends keys. Click a lane → right-side
    DRAWER (fleet stays visible): vitals on top, ACTIVITY view (tool calls,
    files, commits) as the default reading, expandable full transcript
    below, live-tailing. An ATTACH button copies the exact tmux/workmux
    command for interaction in YOUR terminal. (Transcript data already
    flows through the sessionlog collector.)

## Agent health & lane geography (rulings 18–20)

18. **Five pathologies, each visually unmistakable:** LOOPING (repeating
    tool-call cycles, no progress — derived from tool.activity + git
    events), FROZEN (no events — liveness flatline, stronger visual),
    WAITING (stopped, hand raised — distinct from frozen; detection
    honesty: flagged if pane-state signal is needed), EXPENSIVE (burn
    outlier vs fleet median — spend selectors), OFF-FENCE (touching files
    outside its lane — needs ruling 19).
19. **Lane geography — the prd's one data addition.** At dispatch, the
    conductor writes `.swarm/lanes.json` (handle → fence globs → issue →
    model); dispatch.sh gains this as a contract. The Observatory ingests
    it; "where is this agent" = recently-touched files vs fence globs;
    off-fence detection falls out. No other new collectors.
20. **Subagent visibility.** Worker nodes sprout second-generation
    filaments for their subagent threads (thread data landed in prd2,
    #64/#65) — generations rendered, sized by output.

## The scene (rulings 21–23)

21. **Contract fixed; spikes propose encodings.** The scene must: make a
    needs-you/stuck lane the single most salient object; make relative work
    size (output tokens) readable; make recency readable; render all five
    pathologies distinguishably; be learnable in <30s with no text legend.
22. **Scale ruling (operator, overriding the conductor's recommendation —
    recorded):** render everything, always — every lane tendriled, every
    subagent filamented, at any count; trust the force physics and design.
    The spike review includes a 20-lane synthetic fixture so this ruling is
    tested against the glance test; if it fails there, that is a recorded
    falsifiable outcome to re-rule on, not a silent one.
23. **Flair register: cyber-sigilism, no literal creature.** Sharp tapered
    strokes, thorn-curl terminals, glyph marks that carry meaning (a lane's
    sigil IS its state glyph). Ornament must read as language.

## The spike round (rulings 24–27)

24. **Three disposable opus builds**, each in its own worktree against the
    real event stream (plus the 20-lane fixture and a staged-pathology
    fixture), one page each covering: attention strip, fleet table, burn
    strip, and the scene. Branches are never merged; review is side-by-side
    live tabs + screenshots. Committed briefs:
    - **SPIKE A — CONSTELLATION REFINED** (`prompts/spike-a-constellation.md`):
      today's beads perfected under the new laws; the baseline the others
      must beat.
    - **SPIKE B — THE SIGIL ORGANISM** (`prompts/spike-b-sigil-organism.md`):
      Obsidian-like floaty force-graph; central sigil-core (main); tendrils
      of sigilist linework reaching to every lane (ruling 22); subagent
      filaments as second growth; pathologies as limb-and-glyph behavior
      (coil, stiffen, raise, burn, trespass).
    - **SPIKE C — MYCELIUM PULSE-NETWORK** (`prompts/spike-c-mycelium.md`):
      root-mass and threads where pulses (commits, tokens, events) travel
      as light — flow made visible; looping = a pulse orbiting a knot,
      frozen = a dark thread, expensive = a white-hot one.
    Lachlan picks ONE; specific stealable details from the losers are named
    in the pick ruling; the winner is rebuilt properly in fenced waves.
25. **Definition of demo (falsifiable):** (1) GLANCE — from a 3-second look
    at a busy fleet, answer "anything need me? / how many lanes working? /
    rough cost?" — passed by Lachlan AND ideally one non-Lachlan viewer;
    (2) PATHOLOGY — on the staged fixture, point at the looping, frozen,
    waiting, expensive, and off-fence lanes within seconds; (3) SCENE —
    a first-time viewer explains the encoding within 30s, no legend;
    (4) MODE — shown a replay mid-scrub, the viewer says "this is the
    past" unprompted.
26. **Budget: ~3 sessions.** One: spike round + pick. One-to-1.5: fenced
    implementation waves (laws/tokens keystone first; behavior-encoding
    tests fenced up front per the new grooming rule). Half: verification +
    retro. **Deferred:** composable layouts, sound, data-viz heat ramps,
    mobile, light theme, zoom/LOD, any new collectors beyond the lane
    manifest.
27. **Sequencing:** groomed now (this document + briefs committed); spikes
    fire at the start of the next session.

## Non-goals

New data features beyond ruling 19; replay features; publishing (name
`@kelliherl/observatory` recorded, publish deferred past prd3 per roadmap);
anything the factory GUI should own (full interaction with agents).

## Pick ruling (2026-07-31 evening — rulings 28–32, operator)

The spike round ran same-day: three opus builds reviewed side-by-side in
live tabs (A :5183 / B :5199 / C :5188) plus fresh fixture screenshots.
All three committed `spike-artifacts/NOTES.md`; branches stay unmerged as
reference material.

28. **Winner: DIRECTION C — MYCELIUM PULSE-NETWORK**, rebuilt properly in
    fenced waves. Operator's clause: **improve what the spike developed —
    no straight rip; implement it cleanly, intuitively, beautifully.**
29. **Palette: the ice-neon register.** The calm world (threads,
    root-mass, chrome) lives in cold blue-white / near-black-blue
    *luminance* — B's proof that neon is luminance, not saturation — while
    the four ladder hues stay exclusive (ruling 9 intact): saturated cyan
    = NOTICE only, amber = NEEDS-YOU, magenta-red = BROKEN. C's bone-grey
    is out: law-pure, but it isn't the Observatory.
30. **Named grafts from the losers** (all blessed by the operator):
    - **g1 (B)** — the fleet table's STATE column renders the scene's own
      glyphs at row scale; the table IS the legend.
    - **g2 (B)** — alarm marks are exempt from *every* fade: recency and
      salience dimming never touch a needs-you/broken sigil.
    - **g3 (B)** — the settle: a new lane's thread GROWS IN on
      `worktree.discovered` (event-lawful; B cut it only for screenshot
      determinism).
    - **g4 (both, ratified as law)** — hue = severity, form = kind; and
      attention chips carry evidence strings (`Read→Edit→Bash ×6, no
      commit`), never bare labels.
    - **g5 (A)** — the ladder floor: ALL CLEAR is structurally incapable
      of rendering beside a non-zero collision count — enforced in the
      derived model, never remembered by the view.
    - **g6 (A)** — the EXPENSIVE-recede scar: a white-hot thread must
      never outshine a summons; the staged fixture asserts it.
    - **g7 (A)** — pointability: a lane's angular position is stable for
      the session, pinned by test, so recency-as-distance never costs
      "72 lives at four o'clock".
    Explicitly not grafted: A's retracting recency wire (C's
    recency-as-distance already owns that fact on a stronger channel).
31. **Render-everything re-rule trigger (ruling 22 addendum):** B and C
    independently predicted *label collisions* near ~30–35 lanes, well
    before geometry fails. Recorded as the falsifiable trigger; the named
    cheap retreat is labels-on-hover past a count threshold. Hiding lanes
    stays off the table.
32. **Motion-law amendments (ruling 10 addendum):** the WAITING throb and
    the slow recency glide are blessed as lawful (the scene contract's
    side taken, on the record), each keeping its reduced-motion
    degradation (static bright dot + raised-hand glyph; the glide stays a
    glide). C's three pulse-as-event enforcement rules are adopted as law
    wherever anything animates: history never pulses; traffic is
    coalesced, never invented; an arrival flare is the end of a real
    journey.

## Implementation waves (groomed 2026-07-31, issues #75–#86)

Wave 1: **#75** instrument keystone (opus — tokens, derived fleet object,
glyph alphabet, shell reorder, ladder floor) ∥ **#76** lane manifest
served (`.swarm/lanes.json` → `/api/lanes`). Wave 2, after #75: **#77**
attention strip + tab signals · **#78** fleet table (worktrees panel
dissolves) · **#79** activity feed + provenance bar (ticker dissolves) ·
**#80** burn strip (spend panel dissolves) · **#81** the scene (opus —
mycelium, ice-neon) · **#82** collisions attention-integration. Wave 3:
**#83** replay mode shift · **#84** chat drawer (opus, + transcript tail
endpoint) · **#85** panel focus. Wave 4: **#86** docs/demo refresh.
(#78–#80 ordering reflects a GitHub API outage mid-filing; recorded on
the issues.) Verification per ruling 25 runs conductor-side after wave 3,
then retro.
