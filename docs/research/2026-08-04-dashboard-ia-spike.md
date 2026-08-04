# dashboard IA spike — what the layout steals from Grafana, and what it must not touch

**Date:** 2026-08-04 · **For:** the operator, who has never opened Grafana · **Method:**
grafana.com/docs, GitHub LICENSE files, the npm registry queried directly, Perses/CNCF,
practitioner writing; plus source-reading of our `app/`, `panels/`, `replay/`. Graded
`[Ran]` / `[Verified]` (primary source or our source, cited) / `[Consensus]` / `[Thin]`.

**Bottom line.** Grafana core is **AGPLv3** — read it, never vendor it; the Apache-2.0 packages
(`@grafana/ui`, `@grafana/scenes`) are legally vendorable and still must not be, for reasons
measured in §2. The highest-value pattern in the observability-UI world for us is the **state
timeline** (a swim-lane of state over time), and the way to ship it is **as the body of the
replay bar, not as a panel** — that keeps the scene the hero and turns a featureless slider into
a navigable recording. Everything else worth taking is small: an exemplar jump (spend spike → the
trace span that caused it), row-level drill-downs, a sparkline column in the fleet table,
panel-inspect re-read as an honesty instrument, and lazy collapse.

## 1. Primer — Grafana in plain language

**Dashboard**: one saved page holding visualizations, a time range, and dropdowns. Users make
hundreds; "dashboard sprawl" is a named problem in Grafana's *own* best-practices page, which
warns against "uncontrolled growth" and tells you to periodically delete. **Panel**: one
rectangle = one query + one visualization + its options. Everything on the page is a panel —
that uniformity is the product's strength and its flatness. **Row**: a horizontal group of
panels with a collapse toggle; the mechanic that matters is that a row saved collapsed **does not
run its panels' queries until expanded** — collapse is a performance control, not decoration.
[Consensus — Grafana community + grafana/grafana PR #77792, which exists to fix shared queries
under collapsed rows]

**Data source**: the connector to a backend (Prometheus, Loki, Tempo); each panel names one.
**Time range**: one global control at the top that every panel obeys at once, and drag-select on
any panel zooms *all* of them to that window — the most important idea in the product, and the
one most often missed by people copying its look. **Variables / templating**: dropdowns that
re-parameterize the page (pick `server=web-03`, every panel re-queries); eight types, and the
killer feature is **repeat** — one panel definition repeats once per selected value, so ten
servers yield ten panels from one definition ("single-source dashboards"). **Explore**: a
separate mode with no dashboard — type a query, look, iterate, discard; it exists because
dashboards answer questions you already knew to ask and incidents are made of the other kind.

**Data links / drill-down**: click a datum and go somewhere with context carried — series name,
field, value and **the current time range** interpolate into the target URL (`__url_time_range`,
`__value.raw`). **Panel inspect**: see the data behind the picture — Data, Stats (query
duration/volume), JSON, Query, plus an Error tab that appears only on failure; stated purpose,
"helps you understand and troubleshoot your panels". **Annotations**: event markers drawn across
time panels as lines or shaded regions, hand-placed or query-driven, rendered on time series,
**state timeline** and candlestick. [all Verified — grafana.com/docs]

| Grafana | rhizomorph today | gap |
|---|---|---|
| dashboard (many, sprawling) | one balcony page, curated order (prd3 r6) | none — we are structurally immune |
| panel | `PanelFrame` × 5 (scene, fleet, ledger, collisions, feed) | none |
| row + collapse | per-panel collapse via `panelPrefs`; the 3-up band is a row in all but name | not lazy — collapsed panels still mount |
| data source | collectors (git, tmux, sessionlog, OTel) named in `StatusBar` | none; ours is better — sources are fixed, so their *health* is the story |
| **time range** | the **replay bar** | **big.** Ours is a *transport* (play a recording), theirs a *filter* (query a window). No zoom-to-selection, no live window at all |
| variables / templating | lane selection → drawer + `/lane/:handle` | single-select, and only the drawer obeys it — no panel does |
| repeat over a variable | nothing | intentional (§3.10) |
| Explore | lane drawer + focus mode | none, and we should not build one (§3.9) |
| data links / drill-down | fleet row → drawer; drawer `FOCUS ↗` → trace | only two surfaces click through; ledger/collisions/feed rows are dead ends |
| panel inspect | **nothing** | real, and philosophically ours (law 12) |
| annotations | activity-feed events | they are text, not marks — we have no time axis to mark |

**The line worth internalising:** Grafana's IA is *one global time range + N panels that obey
it*. Ours is *one global present + N panels that obey it*, with a recording parked beside it. §6
is really a proposal to close that difference.

**Signal frameworks, mapped.** Golden signals = latency/traffic/errors/saturation [Verified —
Google SRE book]; RED = rate/errors/duration [Verified — Wilkie]; USE is about machines and does
not apply to a read-only sidecar. For a swarm: **latency** = time blocked on a human, time to
first commit · **traffic** = tool calls/min, tokens/min · **errors** = BROKEN lanes, judge
findings, failed gates · **saturation** = collisions and rate-limit stalls. The finding: the burn
strip's four numbers (output tokens, dollars, burn rate, overhead ratio — prd3 r13) are *all
traffic and cost*. **Errors and latency are absent from the top dock.**

## 2. Licensing — [Verified], and the answer on the tempting part is LEARN ONLY

We ship MIT (`LICENSE`: "MIT License / Copyright (c) 2026 Lachlan Kelliher") as a clonable repo.

| artifact | licence | evidence |
|---|---|---|
| **grafana/grafana** (core Go + the dashboard frontend) | **AGPL-3.0** | repo `LICENSE` = "GNU AFFERO GENERAL PUBLIC LICENSE Version 3" [Verified] |
| the 2021 change | Apache-2.0 → AGPLv3, **21 Apr 2021**, with Loki + Tempo | grafana.com relicensing post [Verified] |
| **@grafana/ui** | **Apache-2.0** | npm registry `13.1.1`; repo `packages/grafana-ui/LICENSE_APACHE2` [Ran] |
| **@grafana/scenes** | **Apache-2.0** | npm registry `8.13.6` ("framework for building dynamic dashboards"); repo `LICENSE` [Ran] |
| **Perses** (CNCF sandbox) | **Apache-2.0** | GitHub API `spdx_id: Apache-2.0`; README names the sandbox status [Ran] |

**MUST NOT TOUCH — `grafana/grafana`.** AGPLv3 is copyleft with a network clause. Copying *any*
of it — a React component, the dashboard JSON schema, a token file, a layout algorithm
transcribed line-by-line — puts our MIT repo in a conflict we cannot ship. Reading it, running
it, and describing it in prose is fine, and is what this note did.

**MAY BE VENDORED, AND STILL MUST NOT BE — `@grafana/ui`.** Apache-2.0 permits it; two measured
facts kill it [Ran, npm registry]: it declares `peerDependencies: react ^18.0.0` while we ship
**React 19.2.8**, so it will not install without an override; and it carries **67 runtime
dependencies, 11.5 MB unpacked** — `jquery`, `slate`, `ol` (OpenLayers), `uplot`, `react-table`,
`react-select`. Our whole web package has **nine** dependencies. One import multiplies our
dependency surface by an order of magnitude and drags Grafana's theme object in to style
anything. **Verdict: learn only.** Same for `@grafana/scenes` — a dashboarding *framework*, i.e.
precisely the layer we deliberately do not have.

**READ THIS ONE — Perses.** Apache-2.0 throughout, CNCF sandbox, explicitly pursuing "an open
specification for dashboards" and shipping npm packages meant to be embedded in other people's
UIs. If we ever want licence-clean prior art for *how to model* a layout it is Perses, not
Grafana — and unlike Grafana, a targeted attributed borrowing would be permissible. We need
nothing from it today. **Screenshots and docs prose:** describing, measuring and paraphrasing is
research; do not paste their CSS, token names, or panel JSON into our repo.

## 3. Patterns, ranked by value to us

**TAKE — high.**

1. **State timeline / swim-lane.** One row per entity, colored bands per state, band length =
   dwell time, nulls *end* a region rather than being filled. Grafana's named use cases —
   "monitor the status of a server, application, or service", "identify operational trends",
   "spot recurring issues" [Verified] — map 1:1 to lane-state-over-time; it reuses our hues, and
   its null rule *is* our honest-gaps law. Verdict in §6.
2. **Global time range + zoom-to-selection.** We half-have it: replay re-folds every panel from
   the event log. Missing is selecting a window that every panel obeys, and any notion of a live
   window. Cheapest useful slice: drag on the timeline → scrub there.
3. **Exemplars** — a mark on a metric that jumps to the trace that caused the spike [Verified].
   **We have both ends and no bridge**: per-lane spend, and OTel spans with timestamps. Highest
   data-already-there ratio in this note. Ledger row → the interaction → the prd9 B1 waterfall.
4. **Drill-down from every row.** We click through from the fleet table and the drawer only. A
   ledger row, a collision cell and a feed line should each open the drawer at the moment in
   question — cheap, and it converts three dead-end panels into entry points.

**TAKE — medium.** 5. **Legend-as-table + sparklines in cells** — Grafana's table does sparkline,
gauge, colored-background, pill and data-link cells plus nested expandable rows [Verified]; our
fleet table is already the legend (graft g1) with columns `lane · state · out · $ · req · tool ·
thr/sub · age/active · fence` [Ran], and one sparkline column (tool calls/min over 30m) gives
nine present-tense numbers a past — RED's *rate* in 60 pixels. 6. **Lazy collapse** — ours is
cosmetic, theirs skips the query; the 3-up band should collapse to one header row **and stop
computing**. 7. **Panel inspect, re-read as honesty** — theirs is a debugger, ours would be law
12 generalised: for any number, show measured-vs-estimated, which collector, how old. We have
exactly the culture for it and no surface for it. 8. **Annotations on the time axis** — landings,
gate runs, collisions, judge findings as marks; only possible once §6 ships, then nearly free,
and Grafana draws annotations on state timelines natively [Verified].

**SKIP.** 9. **Explore as a mode** — we have two modes, and prd3 r16 makes replay a *full* shift
precisely so past can never read as present; a third mode is the needs-a-manual failure, and the
drawer plus focus already serves investigation. 10. **Panel repeat over a variable** — repeat
exists because Grafana has no hero visualization, so N servers become N identical rectangles;
we have a scene whose whole job is the N-lanes view, and repeat is the anti-scene. 11.
**Node-graph panel** — the scene *is* our node graph and it is better; for confidence, theirs
shows "up to 200 visible nodes by default" and its layered layout "can be slow… more than 500
nodes" [Verified], so our render-everything ruling (r22) with a ~30–35-lane label-collision
trigger (r31) is the saner budget. 12. **Heatmaps** — no dense numeric×time surface worth
binning; the collisions matrix already owns our one two-dimensional fact. 13. **Stat panels with
thresholds** — the burn strip already is this; the only take-away is §1's missing-signals finding.

## 4. Proposed layout

**Proposal A — the sandwich: state on top, the scene in the middle, time at the bottom.** One
structural move: the replay bar **grows a body**. The swim-lane docks directly above the transport
so they share one x-axis and read as a single TIME dock. Nothing displaces the scene (prd4 r2
intact), no page row is added, no new hue appears.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ THE OBSERVATORY ●live │ ⚠ 2 NEED YOU ▸ pr9 waiting 14m · ke5 frozen 31m      │ attention (unchanged)
│ 1.2M out · $18.40 · 4.1k/min · ovh 1.8× │ ✗1 broken · ⧗ blocked 14m          │ burn + errors + latency (§1)
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                          T H E   S C E N E                                   │ HERO, min-h 55vh, untouched
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ FLEET  lane   state      out    $   req  tool  thr/sub  age/active   ~30m    │ + one sparkline column
│        ke5  ▰ WORKING   412k   —    88  Edit    3/1     2h / 47m   ▁▂▅▇▅▂▁▁  │
│        pr9  ▲ WAITING   120k   —    31  Bash    1/0     2h / 12m   ▇▅▂▁▁▁▁▁  │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▸ LEDGER · COLLISIONS 0 · ACTIVITY 41            (collapsed by default)      │ ←—— the fold ——→
├──────────────────────────────────────────────────────────────────────────────┤
│ TIDE ────────────────────────────────────────────────────────  [◱ expand]    │ ONE 28px band when live
│  ke5 ████████████░░░░░████████████████████▓▓▓▓████████████                   │ expanded: 14px per lane
│  pr9 ██████░░░░░░░░████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒     ▓ = no data   │ hatch = honest gap
│  +6  ▒▒▒░░░████████████████████████████░░░░░░░░████████████                  │ coalesced, carries a count
│      ├─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤                       │
│      14:00 14:10 14:20 14:30 14:40 14:50 15:00 15:10 ▮                       │ playhead
│ ◀◀ ▶ ▶▶ ×1 │ 15:07:22 · session 3f2a · ⤺ EXIT TO LIVE                        │ transport (replay only)
├──────────────────────────────────────────────────────────────────────────────┤
│ git ✓ · tmux ✓ · sessionlog ✓ · otel 4/5 lanes · collisions 0 (7br / 312f)   │ provenance (unchanged)
└──────────────────────────────────────────────────────────────────────────────┘
```

**Above the fold** (1080p): attention, burn, scene, the fleet header plus ~4 rows, TIDE band
pinned — so "does anything need me" is answered twice before the fold, in words by the strip and
in shape by the scene (prd3 r2). **Collapsed by default:** the 3-up band, to one header row that
also stops computing (§3.6); and the TIDE, to one merged density band in live. **Density rule:**
14px rows, top-N by attention, remainder coalesced into a `+N` row — the existing coalescing law
on a new surface, not a new law.

**Alternative B — timeline directly under the scene; transport stays bare at the bottom.** Space
and time become one reading: the scene shows *where* the swarm is, the swim-lane immediately shows
*how it got there*, both above the fold. **Trade-off:** the timeline is divorced from its own
transport, so the playhead must be duplicated as a second ruler or drawn as a page-spanning
vertical rule (noisy, and law 10 reserves motion for events); and in live mode prime pixels go to
history rather than to "anything need me". **Recommend A**; take B only if the operator's honest
answer to "what do I look at most" is the past rather than the present.

## 5. What to avoid

1. **Wall of graphs.** Brazil reports ~600 graphs on one dashboard, having heard of 1,000+, and
   prescribes a *hierarchy* — an overview carrying only rate/errors/latency/CPU/memory, then
   per-subsystem pages — measured by "how quickly someone can correctly triage", never by graph
   count [Verified]. We are at five panels; **our growth edge is the 3-up band.** Make prd3's own
   habit a law: *a new panel must dissolve an existing one* (worktrees→fleet, ticker→feed,
   spend→burn+ledger already did it three times).
2. **Dashboards that need a manual — the sin we are closest to, and it is not the tables, it is
   the scene.** prd3 r25 leg 3 (a first-time viewer explains the encoding in 30s, no legend) is
   exactly this test, and prd10 adds growth rings, apical tufts, subagent buds, decay motes, a
   hyphal lattice and a new accent hue. Each defensible alone; together, a private language
   accumulating faster than the legend. **Re-run every prd10 addition against r25 leg 3 with a lay
   viewer, not only against the "is it beautiful" gate.**
3. **Config-first complexity.** Grafana's power is that everything is configurable; the price is a
   blank page and a learning curve users name as its top drawback [Consensus — vendor-comparison
   writing, graded down for bias]. Our zero-config curated order is the antidote, and the specific
   temptation is drag/resize/custom layouts, deferred in prd3 r6 — **keep them deferred
   permanently, not just this round.** The curated order *is* the product.
4. **Alert fatigue.** Grafana's 2025 survey puts complexity/overhead top at 39% and names alert
   fatigue "the No. 1 obstacle to faster incident response" [Verified — vendor-published]. Our
   attention strip is one cheap NOTICE away from the same. Enforce graft g4 mechanically: **an
   item with no evidence string does not render.**
5. **Panel soup / uniform rectangles.** Every-panel-is-the-same-rectangle is why Grafana pages read
   as inventory rather than narrative. Our strips are deliberately *not* panels — do not normalise
   them into `PanelFrame`s for tidiness.
6. **Stacking.** Grafana's own best practices warn it "can be misleading, and hide important data"
   [Verified]. If the TIDE is ever tempted into a stacked area of lanes: no. Bands per lane, never
   summed.
7. **A second dashboard page.** `/lane/:handle` is a detail view. Sprawl starts with the second
   *overview*.
8. **`@grafana/ui`.** §2 — React 18 peer against our React 19, 67 deps, 11.5 MB.

## 6. The state-timeline question — verdict

**For.** It answers the one question no current surface answers: *what happened while I was away.*
Attention, burn, scene and fleet are present-tense; the ledger is totals; the feed is a text log
that is neither per-lane nor duration-shaped. Three of prd3 r18's five pathologies are **duration
facts** and therefore natively swim-lane-shaped: FROZEN is a long unbroken band, LOOPING a fast
repeating stripe, WAITING an amber band *whose length is the insult*. It costs no new collector,
no new hue (fills are the four ladder hues plus parked), no new motion class, and its null-gap
semantics restate our honest-gaps law in a third party's docs. And it repairs a live defect:
`Scrubber.tsx` is a bare `<input type=range>` [Ran] — today you scrub a recording **blind**.
Giving it a body makes the recording navigable: the largest UX gain per pixel in the product.

**Against.** It competes with the scene for the scene's own job. prd4 r2 made the scene the
centerpiece because it answers "what is the fleet doing"; a swim-lane answers that faster, more
legibly, and with none of the charm. The real risk is not that it fails — it is that it **wins**,
and rhizomorph's market thesis (prd3: "ops tooling is aesthetically dead") *is* the scene. A
second time axis on a page that already has a replay bar is also textbook manual-required. And it
lands mid-prd10, pulling attention from the round whose job is to make the replay an art piece.

**Verdict: yes — as the body of the replay bar, never as a panel.** Framing it as a panel is
exactly what makes it compete with the scene; framing it as *the scrubber grew a body* makes it
navigation rather than visualization. Zero rows added to the curated order, hero untouched, and
the weakest control in the product becomes its most useful one. Ship it collapsed to one merged
band in live, expanded to per-lane rows in replay and on demand. **It is the highest-value single
addition to the layout** — but it is worth roughly what §3 items 3+4+5 are worth *combined*, and
each of those costs a fraction. If the round is short: exemplar jump and row-level drill-downs
first, then land the TIDE whole rather than half.

## Open questions

1. **Does the burn strip gain a fifth and sixth number** (errors, blocked-latency) per §1's
   golden-signal finding, or is "errors live in the attention strip" the deliberate answer? Either
   is defensible; today's silence is not.
2. **Live-mode window.** Does the TIDE show a rolling 30m, a session-to-now compression, or not
   render live at all (replay-only)? That decides navigation-vs-monitoring, and they want
   different heights.
3. **Lane ordering in the swim-lane.** Stable-for-the-session (graft g7's pointability argument
   applied to y instead of θ) or sorted by attention? They conflict; pick one.
4. **Does zoom-to-selection drive the other panels**, or only the playhead? Driving everything is
   the Grafana idea and it is powerful — but the ledger could then silently show a window instead
   of a total, a law-12 honesty problem needing its own label.
5. **Unmeasured.** No browser probe this session and no live Grafana instance run: every claim
   about Grafana's *feel* comes from docs and practitioner writing, not from use. If the operator
   wants felt evidence before ruling, 20 minutes on `play.grafana.org` or `demo.perses.dev` beats
   this section.

## Sources — all accessed 2026-08-04

**Licence [Verified/Ran]:** https://github.com/grafana/grafana/blob/main/LICENSE ·
`packages/grafana-ui/LICENSE_APACHE2` · https://github.com/grafana/scenes/blob/main/LICENSE ·
https://grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/ · npm registry
queried directly for `@grafana/ui@13.1.1`, `@grafana/scenes@8.13.6` ·
https://github.com/perses/perses (Apache-2.0, CNCF sandbox) · https://perses.dev
**Grafana docs**, all read under https://grafana.com/docs/grafana/latest/ : *Best practices* ·
*Variables* · *Explore* · *Configure data links* · *Exemplars* · *Panel inspector* · *Annotate
visualizations* · and *State timeline*, *Node graph*, *Table* under
/panels-visualizations/visualizations/ · plus https://grafana.com/blog/dynamic-dashboards-grafana-12/
**Practice:** https://www.robustperception.io/avoid-the-wall-of-graphs/ ·
https://sre.google/sre-book/monitoring-distributed-systems/ ·
https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/ ·
https://grafana.com/observability-survey/2025/ (vendor-published)
**Our own source, read this session [Ran]:** `docs/prd{0,3,4,10}.md`,
`packages/web/src/app/{Shell,PanelGrid}.tsx`, `packages/web/src/panels/fleet/index.tsx`,
`packages/web/src/replay/Scrubber.tsx`, `packages/web/package.json`, `LICENSE`.
