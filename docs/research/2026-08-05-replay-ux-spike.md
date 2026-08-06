# replay UX spike — how the timeline should navigate time, and who it is for

**Date:** 2026-08-05 · **For:** the operator, after first real use of the TIDE dock ·
**Question:** how should rhizomorph's replay timeline work, and why would a developer use it at all?
**Method:** source-reading of `packages/web/src/tide/` + `replay/` + prd13/prd12/vision;
web research on eight time-navigation UI families, primary docs fetched where they exist.

**Grading.** `[Ran]` — verified by direct inspection this session (repo file read, path cited; or a
document I fetched *and* the claim is mechanical, not editorial). `[Verified]` — primary vendor
doc/manual fetched and read, URL cited. `[Read]` — secondary source or search abstract, URL cited,
weaker. `[Hypothesis]` — falsifiable inference, no direct evidence yet.

**Bottom line.** The operator's five complaints are one complaint: **the dock has two surfaces doing
the same job badly instead of two jobs done by one surface each.** The strongest idiom in every
mature time-UI studied — DevTools, Resolve's Cut page, Audacity, YouTube — is *overview + detail
with distinct jobs*: one strip that always shows everything and one that shows the window, linked by
a drawn region. Rhizomorph already owns both strips (Scrubber = full range always; Tide = windowed
under zoom) but never draws the link, so under zoom the two x-axes silently disagree — the "one
x-axis" of ruling 1 is currently true only at zoom level 0 `[Ran]`. Meanwhile the jobs analysis
says the timeline's real customers are **mark-centric** (incident forensics, fork-point selection)
or **picture-centric** (absence review), not scrub-centric — which validates ruling 12 ("chapters
over tide") and says the next spend goes to marks: bigger targets, an instant styled hover card
that names lane/what/when, per-member seek inside a coalesced cluster, and prev/next-chapter keys.
Two concrete defects found in source: the zoom/x-axis divergence above, and the Scrubber's arrow
keys move the playhead **1 millisecond** per press (no `step` attribute; HTML default step is 1,
and the range's units are epoch-ms) — the "native keyboard behaviour kept by construction" of prd10
ruling 16 is nominally preserved and practically dead `[Ran]` + `[Verified]`.

---

## 0. What exists, and what the complaints attach to `[Ran — all from source]`

Files: `packages/web/src/tide/{TideDock,Tide,ChapterMarks}.tsx`, `chapters.ts`, `markCoalesce.ts`,
`scale.ts`, `tideWindow.ts`; `packages/web/src/replay/{Scrubber.tsx,usePlayback.ts,index.tsx}`.

- **Dock layout**: a `grid-cols-[auto_1fr_auto]` with three rows sharing the center column — mark
  lane (10px), Tide band row(s) (14px each), then transport (`«` · native `<input type=range>` ·
  `+ − »` · Expand). One `timeScale` backs marks, bands, playhead, click-to-seek (`TideDock.tsx`).
- **Three click targets for time** in ~40 vertical px: mark buttons (seek), the Tide track
  (click-to-seek, `cursor-pointer`), and the range input (drag). Two *position indicators*: the
  `w-px` playhead line over the Tide and the native thumb below it. → complaint 1, "two separate
  draggable things": the playhead line looks draggable and is not; the thumb is.
- **Zoom** (`tideWindow.ts`): 4 button-driven levels (1, ½, ¼, ⅛ of the range), window centered on
  the playhead at click time, floor exact at level 0. The window narrows **only** the Tide + mark
  rows; the Scrubber still maps the full range (`TideDock.tsx` module note says so deliberately).
  So at any zoom > 0 the playhead line and the thumb sit at *different x positions for the same
  instant*, and clicking the Tide track seeks in window-coordinates while dragging the thumb seeks
  in full-range coordinates. Ruling 1's "share one x-axis" holds only at level 0. → amplifies
  complaints 1 and 2; ⅛ max is shallow for complaint 4 (a 4h session at max zoom still shows 30m;
  at ~800px that is ~2.2s/px).
- **Marks** (`ChapterMarks.tsx`): a 9px text glyph `◆` / `◆(N)` in `text-ice-200` (the playhead's
  own ink), hover = the **native `title` attribute only** — OS-styled, ~1s delay, easily never
  discovered. The label content is already exactly what the operator asked for (`chapterLabel`:
  `"163 landed · 14:32:07"`, `"lane held on Bash · …"`), joined with `\n` for clusters. →
  complaints 3 and 5 are *presentation* failures, not data failures.
- **Cluster seeks are lossy**: `coalesceMarks` groups by single-link chaining under the 6px hover
  threshold, and a group's click seeks **the earliest member only**; the other members are
  reachable only by zooming until the cluster splits (`markCoalesce.ts` law: "seek target is its
  earliest member's ts"). Fine for "go roughly there"; wrong for fork-point selection (§3.3).
- **Keyboard**: the range input sets `min`/`max` in epoch-ms and **no `step`** (`Scrubber.tsx`)
  `[Ran]`; the HTML default step is 1 `[Verified — MDN]`
  (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/range: "The default
  stepping value for step inputs is 1"). One arrow press = 1ms. Home/End work. PageUp/Down step by
  a browser-chosen multiple that is still ms-scale `[Hypothesis — untested]`. There is no
  prev/next-mark key anywhere `[Ran]`.
- **Cross-panel sync already exists by construction**: in replay, `playback.currentTs` is the clock
  every panel folds against (`usePlayback.ts` #155 audit note: "currentTs is what
  ModeContext.useModeClock reads while replaying") `[Ran]`. Seeking *is* whole-dashboard
  navigation; the scene is the playhead's detail view. This matters for §3: the timeline never
  needs its own detail panel because the entire page is the detail panel.
- **Transport**: play/pause, speeds 1/4/16 only (`PLAYBACK_SPEEDS`, prd0), reset (`usePlayback.ts`).

---

## 1. Prior art, system by system

### 1.1 Chrome DevTools Performance panel `[Verified]`

Sources actually read: performance reference
(https://developer.chrome.com/docs/devtools/performance/reference) and the navigate-and-filter blog
(https://developer.chrome.com/blog/devtools-navigate-and-filter).

- **Overview + detail**: the Timeline overview ("minimap") of CPU/NET charts stays visible above
  the flamechart at every zoom. Hover in either surface marks the same instant in the other — "a
  corresponding vertical line appears in the flamechart", and "hovering over entries in the
  flamechart will now highlight the corresponding part of the CPU chart". Bidirectional hover link,
  zero clicks.
- **Breadcrumbs**: select a range in the overview, click zoom, "a chain of breadcrumbs starts
  building at top of the Timeline overview"; nest as deep as >5ms; click any crumb to jump back
  out. Zoom state is *declared and enumerable*, never silent.
- **Keyboard**: "use the W, A, S, D keys to zoom in, move left, zoom out, and move right". Two
  wheel modes because scroll-hijack is a real cost: classic (wheel zooms) vs modern (wheel scrolls,
  shift+wheel zooms).
- *Problem solved*: precision at 1000:1 scale without losing global position. *Cost*: vertical
  space for the overview; a mode toggle to avoid wheel hijack. *Fit*: high — the TIDE **is** an
  overview strip already; breadcrumbs are the honest-declared-zoom mechanic ruling 5 asks for, in
  chrome not a panel.

### 1.2 DaVinci Resolve Cut page — dual timeline `[Read]`

Sources: Blackmagic's Cut-page marketing/docs (https://www.blackmagicdesign.com/products/davinciresolve/cut),
Tella definition (https://www.tella.com/definition/dual-timeline), BMD forum on zoom
(https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=104266).

- "The upper timeline shows you the entire program while the lower timeline shows you a zoomed in
  area of where you're working" — **both fully interactive**, and notably **neither zoom level is
  user-adjustable**: the detail tier auto-zooms so "the trim tools work perfectly". Blackmagic's
  bet: eliminating zoom management beats offering zoom control.
- *Problem solved*: the constant zoom-in/zoom-out-to-reorient tax of single-timeline editors.
  *Cost*: a second permanent strip. *Fit*: high as a *reading* — rhizomorph's Scrubber row is the
  upper timeline (always full extent), the Tide is the lower (windowed). The dock already has both;
  it lacks only the drawn window-region that makes their relationship legible. No panel is added.

### 1.3 Audacity / audio editors `[Verified]`

Sources: manual pages on zooming (https://manual.audacityteam.org/man/zooming.html) and
scrubbing/seeking (https://manual.audacityteam.org/man/scrubbing_and_seeking.html).

- **Zoom vocabulary is complete and closed**: Zoom In/Out double/halve; **Zoom to Selection**
  ("zooms and scrolls so that the selection just fits"); **Fit Project** = whole-extent floor;
  **Zoom Toggle** flips between two preset levels. Wheel zoom is **cursor-anchored**: "if the mouse
  pointer is inside the selection, or if there is no selection, zoom is focused on the mouse
  pointer position."
- Scrub vs seek are named as different acts (continuous audition vs skipping) — a transport
  distinction rhizomorph's 1/4/16x + drag already covers.
- *Problem solved*: never losing the point you care about while changing magnification. *Cost*:
  wheel capture (Audacity hides it behind Ctrl). *Fit*: high — zoom-about-pointer on the Tide is
  strictly better than the current zoom-about-playhead-at-click-time, and "Fit" already exists as
  level 0.

### 1.4 YouTube chapters `[Verified]`

Source: Google's own viewer doc
(https://support.google.com/youtube/answer/12825599?hl=en&co=GENIE.Platform%3DDesktop).

- Chapters **segment the progress bar itself** — "marked by vertical lines in the progress bar" —
  rather than living in a separate lane; "the chapter title will appear as you move from section to
  section"; the hovered segment swells. Precise seeking shows a thumbnail strip on drag-up. "Most
  Replayed" draws an attention heatmap *above* the bar.
- The support doc lists **no desktop keyboard chapter-jump**; treat YouTube as a hover/pointer
  idiom, not a keyboard one. `[Verified — by absence in the doc]`
- *Problem solved*: mark legibility without a legend — the bar is self-describing under the
  pointer; marks cost zero pixels until hovered. *Cost*: hover cards need occlusion care; segment
  boundaries only work when marks partition time (rhizomorph's chapters are instants, not spans —
  boundary notches transfer; segment-swell does not, and swelling would also brush the motion law).
  *Fit*: the hover card transfers wholesale; the "title appears as you scrub" behavior transfers to
  the drag interaction (show nearest chapter while dragging).

### 1.5 Replay.io `[Verified]` and rrweb-player `[Verified]`

Sources: focus-window doc
(https://docs.replay.io/basics/replay-devtools/time-travel-devtools/focus-window), rrweb-player
README (https://github.com/rrweb-io/rrweb/blob/master/packages/rrweb-player/README.md), rrweb issue
#621 (https://github.com/rrweb-io/rrweb/issues/621).

- **Replay.io focus window**: a draggable window on the timeline that *filters other surfaces* —
  "all of the console logs that you add will only show messages from inside the window"; the window
  can be anchored to semantic instants (a console message, a user action, a test). This is prd13
  ruling 5's "scope to selection", shipped, with the same opt-in shape. **Comments are pins**: a
  first-class mark you drop at a point in time and later jump back to `[Read — blog.replay.io via
  search]`.
- **rrweb-player**: ships a controller with a progress bar where **custom events render as tagged
  marks** (`tags` option, "a key-value map" styling event types), **inactive periods get their own
  indicator** (`inactiveColor`, default #D4D4D4), and **skip-inactive** fast-forwards dead air
  (`toggleSkipInactive()`). Issue #621 is users asking for the inactive indicator — dead air on the
  bar is a felt need, not a nicety.
- *Problem solved*: session replays are mostly nothing happening; the bar must say where the
  something is, and playback must be able to skip the nothing. *Cost*: skip-inactive must be
  declared or it lies about time (an honesty-law concern rhizomorph already legislates). *Fit*:
  high — agent-fleet sessions are *also* mostly dead air (lanes WAITING, gaps); the Tide's bands
  already draw it, the transport just can't exploit it yet.

### 1.6 Game replays — Dota 2 / StarCraft II `[Read]`

Sources: Eloking overview (https://eloking.com/blog/dota-2-replay-feature-explained), tl.net custom
observer UI thread (https://tl.net/forum/starcraft-2/407771-custom-observer-and-replay-ui),
FluffyMaguro ReplayUI (https://github.com/FluffyMaguro/ReplayUI).

- Dota "automatically saves highlights of major moments and shows a timeline of everything that has
  happened in a match", and **players can drop their own markers** on the timeline. SC2's native
  replay bar is minimal enough that the community builds whole replacement observer UIs — evidence
  that a bare transport under a rich scene is a chronic under-serve, and that the fixes people
  build are *event*-based (jump to fight), not scrub-based.
- *Transferable*: auto-generated interest points = exactly `chaptersFor`; user-droppable pins are
  the one mark kind rhizomorph cannot derive (an operator's "look here later"). *Cost of pins*: a
  write path in a read-only product — pins would have to live client-side (URL or localStorage) to
  honor the vision's "launches nothing, decides nothing". *Fit*: chapters validated; pins deferred.

### 1.7 CI timelines — Buildkite / GitHub Actions `[Verified]` / `[Read]`

Sources: Buildkite waterfall docs (https://buildkite.com/docs/pipelines/insights/waterfall), GitHub
community discussion asking for a waterfall that does not exist
(https://github.com/orgs/community/discussions/51325), actions-timeline third-party action
(https://github.com/marketplace/actions/actions-timeline).

- Buildkite's waterfall: one row per step, bars segmented gray/yellow/green-red for
  waiting/dispatch/run, hover reveals the timing breakdown, parent rows aggregate children. **It is
  a report, not a transport** — "waterfall view only displays data for finished steps"; there is no
  playhead, no playback, no scrub. GitHub Actions has no native waterfall at all; users want one
  badly enough that a Marketplace action generates Gantt charts post-hoc.
- *The negative datum that matters*: post-hoc audit of a multi-lane run is served by a **static
  duration picture with hover facts** — the Tide's bands already are Buildkite's waterfall rotated
  into the dock. Audit does not demand playback (§3.5). *Fit*: confirms the Tide-as-picture is
  independently valuable even if the transport is never touched.

---

## 2. The transferable idioms, extracted

| Idiom | Solves | Costs | Fits "TIDE is the bar's body, never a panel"? |
|---|---|---|---|
| **Overview + detail, both visible, linked by a drawn window** (DevTools, Resolve, Audacity) | precision at scale without losing global position | one more strip of chrome; the link must be drawn or the axes lie | **Yes** — rhizomorph already has both strips; only the drawn window-region is missing. No panel appears. |
| **Zoom anchored to pointer/playhead, with a hard "fit" floor** (Audacity, Premiere `\` `[Read — filmora/apress via search]`) | reorientation tax after every zoom | wheel capture → hide behind modifier (DevTools grew two modes for exactly this) | Yes — pure mechanics inside the existing dock |
| **Declared, enumerable zoom state — breadcrumbs** (DevTools) | silent-window dishonesty (ruling 5's Grafana trauma) | a row of tiny chrome | Yes — text chrome in the button cluster, not a panel |
| **Marks as first-class clickables with instant hover cards** (YouTube, Replay.io pins, rrweb tags) | mark legibility + precise semantic seek without pixel-hunting | hover-card component, occlusion care | Yes — replaces the `title` attr; still, no hue |
| **Cluster disambiguation in the card, not only by zoom** (no single exemplar — YouTube avoids clusters by construction; rrweb just overlaps) | coalesced marks hiding N−1 seek targets | a list-in-card interaction | Yes — and it is the fork-affordance's future home (prd12 bridge) |
| **Prev/next semantic jump on keys** (NLE marker-jump idiom `[Read]`; DevTools WASD `[Verified]`) | stepping a story without aiming a 2s/px pointer | none material — unused keys | Yes — dock-level keys; native input untouched |
| **Inactive-aware playback (skip/compress dead air)** (rrweb) | replays are mostly nothing | must be declared while active or it lies about time | Yes, with a banner/label |
| **Attention heatmap on the bar** (YouTube Most Replayed) | where have *others* looked | needs usage data rhizomorph doesn't collect | No for now — no data, and it flirts with a second encoding on the bar |
| **Focus window filtering other surfaces** (Replay.io, Grafana) | scoped questions ("in this window, what did X cost") | scope-dishonesty risk | Already legislated as ruling 5, wave 4 (#170) — nothing new to decide |
| **Waterfall-as-report** (Buildkite) | post-hoc duration audit | none — it already exists here | The Tide *is* this; keep it excellent statically |

---

## 3. Jobs-to-be-done — why replay an agent swarm at all

Audience per `docs/vision.md`: solo developers and small cohorts running worktree fleets; the
product is read-only, zero-config, and the scene is the market thesis. The operator is the
archetype user; the JV cohort (whose own side project is agent capture-and-replay) is the second.

### 3.1 Absence review — "what did the fleet do while I was away" · **likelihood: highest (daily)**

- **Demands**: a compressed, honest *picture* first — bands for the shape of the day, chapters for
  the beats; hover cards that answer "what's this" in one motion; optionally a fast pass of
  playback that skips dead air. Precision seek barely matters; mark *scanning* is everything.
- **Served today**: the collapsed band + marks are exactly this picture; 1/4/16x playback exists.
- **Missing**: mark hover that actually surfaces (the `title` attr hides the answer); dead-air
  skipping (16x through four idle hours is still 15 minutes); a "next chapter" step so the review
  is chapter-to-chapter, not continuous.
- **Verdict**: this job needs the TIDE as a *readable still image* more than as a transport —
  ruling 12's "chapters over tide" is this job stated as law.

### 3.2 Incident forensics — "a lane broke; what led to it" · **likelihood: high (weekly, highest stakes)**

- **Demands**: find the lane (per-lane row or filter), land *just before* the break, then step
  finely; duration facts on hover (FROZEN's length is the diagnosis — ruling 6); cross-panel sync
  so the scene/feed/drawer show the moment (already free — §0); a deep link to the moment for an
  issue report.
- **Served today**: gate-held marks, expanded rows (top-8), band hovers, whole-page folding to
  `currentTs`.
- **Missing**: the broken lane may be inside `+N` (expand shows top-N by attention *now*, not the
  lane you're hunting — `/lane/:handle` partially covers this); fine stepping (arrows move 1ms —
  dead `[Ran]`); prev/next-chapter keys; playhead-ts deep link (ruling 9 covers the *window*;
  the *moment* also needs to survive the URL).
- **Verdict**: the timeline's most demanding real customer. Mark-centric plus one precision tool
  (real keyboard step), not a case for deep continuous zoom.

### 3.3 Fork-point selection — the laboratory (prd12/prd14) · **likelihood: medium now, high later; strategic weight highest**

- **Demands**: land on an *exact attested instant* (never an interpolated pixel — `fork.checkpoint`
  binds event index to session bytes); disambiguate a coalesced cluster to pick one member;
  preview-at-instant (the whole dashboard already is that once you seek); then the fork affordance
  on the mark itself.
- **Served today**: chapters *are* the checkpoint vocabulary by ruling 12's own bridge; clicks are
  exact (`markCoalesce` seeks an attested ts, never an average `[Ran]`).
- **Missing**: cluster clicks reach only the earliest member — under density, N−1 checkpoint
  moments are unpickable without zooming until the cluster splits `[Ran]`; the hover card with
  per-member rows is the missing disambiguator and the natural future home of the fork button.
- **Verdict**: the strongest argument that *marks, not the scrubber*, are the timeline's spine.

### 3.4 Audit / handover / demo — "show someone what happened" · **likelihood: medium (rare, but demo day is existential)**

- **Demands**: shareable positions (URL carrying moment + window); chapters as narrative beats
  ("here 163 landed, here the gate held it"); smooth playback for the theater of it. The vision's
  own demo is "the Rhizomorph replaying its own birth".
- **Served today**: replay itself; chapters as beats.
- **Missing**: the deep link (ruling 9, wave 4) extended to the playhead; nothing else — Buildkite
  (§1.7) shows the audit *report* half is already covered by the Tide as a still.

### 3.5 Cost forensics — "where did the spend go" · **likelihood: low-medium, and it mostly doesn't need the timeline**

- **Demands**: spend *over time* is a plot question and spend *by lane* is a table question; both
  are answered by the ledger + burn strip, scoped by a window. The one timeline affordance it
  wants is ruling 5's scope-to-selection feeding scoped totals — already legislated for #170.
- **Verdict**: **this job does not need playback, marks, or precision seek at all.** Do not grow
  timeline features for it; let the focus window feed the ledger and stop.

### Ranking and the shape it implies

1. Absence review (daily) → invest in mark legibility + hover cards + chapter stepping.
2. Incident forensics (weekly, highest stakes) → same investments + real keyboard step + moment
   deep link.
3. Fork-point selection (strategic) → same hover card grown per-member; exactness already law.
4. Audit/handover/demo → deep link + nothing new.
5. Cost forensics → ruling 5 only; explicitly no new timeline surface.

Every job above the fold is served by **marks and the picture**; none is served by deeper
continuous zoom alone; none needs a second panel. The current zoom (complaint 4) is real but it is
the *fourth* priority, and the fix is linking the tiers, not adding magnification for its own sake.

---

## 4. Ranked recommendations, mapped to surfaces

Constraints honored throughout: no new hue (ice tokens + existing state fills only), no legend
(self-legending labels/hover instead), marks never move (still glyphs; hover changes ink/weight,
not position), the scene stays the hero (everything below is dock chrome; nothing becomes a panel).

### R1 — Two tiers, two jobs, one drawn link *(dock layout — fixes complaints 1, 2, and the axis lie)*

Adopt the Resolve/DevTools reading of what already exists: the **Scrubber row is the overview**
(always full range, the only *draggable*), the **Tide+marks rows are the detail** (windowed under
zoom). Then draw the relationship: when `zoomLevel > 0`, render a still bracket/region over the
scrubber track spanning `[window.start, window.end]` in full-range coordinates (one more
`timeScale(start, end, width)` call at the *full* range — the mapping already exists in
`TideDock.tsx`), plus a small `figures`-voice label in the button cluster: `window ¼ · 14:02–14:31`
— ruling 5's "declare it visibly" applied to the local window. Keep click-to-seek on the Tide;
consider making the Tide playhead line a hairline distinct from the thumb (it already is `w-px`) and
*never* giving it a grab affordance — one draggable thing, one line, one bracket. Cost: ~one
component and one label; no new row, no panel.

### R2 — Marks become the primary navigation surface *(mark rendering + hover cards — fixes complaints 3, 5; serves jobs 1–3)*

- **Render**: replace the 9px `◆` text glyph with a full-height tick in the 10px mark lane (2px
  wide hit target grown to ≥12px via padding), still `text-ice-200`/`bg-ice-200` — no new hue, no
  per-kind color (that would be an implicit legend; ruling 7 extended to marks, as
  `ChapterMarks.tsx` already argues `[Ran]`). Clusters render the count beside the tick as now.
  Where a mark has room (the label-fits law from `label.ts`, applied to the mark lane), let it
  carry short text — `163 ▸` — so the lane is self-legending exactly the way bands are.
- **Hover card**: replace the `title` attribute with a styled, instant (~150ms) card in dock
  chrome: one line per member in the ruling-6 voice (`"163 landed · 14:32:07"` — the strings
  already exist in `chapterLabel` `[Ran]`), **each line its own seek button**. This one component
  discharges complaint 5, the YouTube hover idiom, and §3.3's cluster disambiguation — and it is
  the declared future home of the fork affordance (prd12 bridge: the card grows a `fork ⎇` row per
  member when the laboratory lands; no second timeline vocabulary).
- While *dragging* the scrubber, show the nearest chapter's label above the thumb (YouTube's
  "chapter title appears as you move" `[Verified]`) — scrubbing stops being blind even between
  marks.

### R3 — Keyboard: chapter stepping and a live arrow key *(keyboard — cheap, serves jobs 1–2)*

- Bind `[` / `]` (or `,` / `.`) at the dock level to prev/next chapter (seek to the neighboring
  `MarkGroup.ts`). Native-input law untouched: these keys mean nothing to a range input, so no
  `preventDefault` on any key the browser owns — the `Scrubber.test.tsx` assertion keeps holding.
- Give the range input a real `step` — e.g. `Math.max(1000, span/1000)` — so arrows move ~0.1% of
  the session instead of 1ms `[Ran — no step today]` `[Verified — default is 1]`. This *configures*
  native behavior rather than replacing it, the same way `min`/`max` already do.
- Document Home/End (already native) as "session start/end" in the transport's titles.

### R4 — Zoom mechanics: anchor, floor, wheel-behind-modifier, deeper levels *(zoom — fixes complaint 4 properly)*

Keep button zoom and the level-0 exact floor (already right, and already Audacity's "Fit Project"
`[Verified]`). Add: **Shift+wheel over the Tide zooms about the cursor's timestamp** (Audacity's
pointer-anchored law; modifier-gated per DevTools' two-mode lesson so page scroll is never
hijacked), drag-on-Tide pans when zoomed (click vs drag threshold ~4px), and extend
`ZOOM_FRACTIONS` geometrically (…1/16, 1/32, 1/64) with a stop when the window's
`hoverThresholdMs` reaches the log's median event spacing — zoom deep enough that clusters split,
which is the only zoom depth any §3 job actually asked for. If a "scope to selection" breadcrumb
chain arrives with #170, the R1 window label is its first crumb.

### R5 — Dead-air-aware playback *(transport — serves absence review)*

A "skip to next activity" affordance: when playing and every lane is idle/gap until ts X, offer
jump-to-X (rrweb's skip-inactive `[Verified]`, restated in rhizomorph's honesty voice: the jump is
*explicit* — a button or the R3 next-chapter key — never a silent time-lie during playback). The
band data to detect dead air already exists in `bandsFor`. Cheapest honest form: no auto-skip at
all; just make `]` (next chapter) discoverable and the job is 90% served.

### R6 — The moment joins the URL *(cheap, rides ruling 9's wave)*

When #170 puts the scoped window in the URL, put `t=<playhead-ts>` beside it. Incident forensics
and handover both end in "look at *this*"; a moment that survives reload is the difference between
a screenshot and a link. Composes with `/lane/:handle` per ruling 9; no new router.

### Explicit non-recommendations

- **No second timeline panel, ever** — every idiom above lives inside the existing dock; ruling 1
  is the law and §1 found no idiom that needs breaking it.
- **No per-kind mark colors and no legend** — self-legending labels + hover cards carry it.
- **No always-expanded per-lane replay default** — ruling 12 already corrected this; §3 found no
  job that wants it back (forensics wants *one* lane, which is `/lane/:handle` + expand, not 50 rows).
- **No timeline growth for cost forensics** — scoped ledger via ruling 5 is the whole answer.
- **No attention heatmap / Most-Replayed analog** — no data for it, and the bar already carries
  two encodings (bands + marks); a third competes with the scene's job of being looked at.

---

## Sources

Repo (read this session, UNC `\\wsl.localhost\Ubuntu\home\lachlan\worktrees-challenge`):
`docs/prd13.md` · `docs/vision.md` · `docs/prd12.md` (fork/checkpoint rulings) ·
`docs/research/2026-08-04-dashboard-ia-spike.md` ·
`packages/web/src/tide/{TideDock.tsx,Tide.tsx,ChapterMarks.tsx,chapters.ts,markCoalesce.ts,scale.ts,tideWindow.ts}` ·
`packages/web/src/replay/{Scrubber.tsx,usePlayback.ts,index.tsx}`

Web (fetched and read = `[Verified]`; search-abstract only = `[Read]`):

- https://developer.chrome.com/docs/devtools/performance/reference — minimap, breadcrumbs, WASD `[Verified]`
- https://developer.chrome.com/blog/devtools-navigate-and-filter — wheel modes, bidirectional hover `[Verified]`
- https://support.google.com/youtube/answer/12825599?hl=en&co=GENIE.Platform%3DDesktop — chapters, precise seeking, Most Replayed `[Verified]`
- https://docs.replay.io/basics/replay-devtools/time-travel-devtools/focus-window — focus window `[Verified]`
- https://github.com/rrweb-io/rrweb/blob/master/packages/rrweb-player/README.md — tags, inactiveColor, skip-inactive `[Verified]`
- https://github.com/rrweb-io/rrweb/issues/621 — inactive-indicator demand `[Read]`
- https://buildkite.com/docs/pipelines/insights/waterfall — waterfall mechanics `[Verified]`
- https://github.com/orgs/community/discussions/51325 — GitHub Actions has no waterfall `[Read]`
- https://github.com/marketplace/actions/actions-timeline — post-hoc Gantt for Actions `[Read]`
- https://manual.audacityteam.org/man/zooming.html — zoom vocabulary, pointer anchoring `[Verified]`
- https://manual.audacityteam.org/man/scrubbing_and_seeking.html — scrub vs seek `[Read]`
- https://www.blackmagicdesign.com/products/davinciresolve/cut · https://www.tella.com/definition/dual-timeline · https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=104266 — Cut-page dual timeline, fixed zoom `[Read]`
- https://filmora.wondershare.com/video-editing-tips/premiere-pro-how-to-zoom-in-on-timeline.html · https://www.apress.com/kr/blog/all-blog-posts/20-vital-keyboard-shortcuts-for-adobe-premiere-pro-editing/15208074 — Premiere `\` zoom-to-sequence, zoom-to-frame `[Read]`
- https://eloking.com/blog/dota-2-replay-feature-explained — Dota timeline, auto-highlights, player markers `[Read]`
- https://tl.net/forum/starcraft-2/407771-custom-observer-and-replay-ui · https://github.com/FluffyMaguro/ReplayUI — SC2 community replaces the native replay UI `[Read]`
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/range — default `step` is 1 `[Verified]`
