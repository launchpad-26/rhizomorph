# prd10 — the gorgeous round: decay, rings, tissue, air

**Date:** 2026-08-04 · **For:** grooming prd10 · **Method:** WebSearch/WebFetch (primary
sources preferred), source-reading of our own `scene/`, and a measured colour probe. Graded
`[Ran]` / `[Verified]` (primary source or our source, cited) / `[Consensus]` / `[Thin]`.

**North star, operator verbatim:** "A replay should look like a legitimate art piece, of
growth, life, flourishing and return." **Locked:** canvas 2D, 60fps, one ice hue at twelve
luminances, six status hues each meaning one thing, the three-class motion budget.

## Two findings that constrain everything below — read these first

**1. `glow` allocates a radial gradient per mark per frame.** `paint.ts:214` builds
`createRadialGradient` + two colour stops + an `arc()` fill for *every* glow mark, *every*
frame. That is the scene's only soft-light primitive and it is the exact primitive a mote
field would reach for. Gradient objects are the documented "cache it, don't rebuild it in
the loop" case, and radial is the one that leaks fastest in Firefox's GPU canvas path.
**Verdict: motes are NOT glow marks.** They need a new mark kind that blits a *pre-rendered
sprite* — one 32px offscreen canvas holding the radial falloff, drawn N times with
`drawImage` under a single `globalCompositeOperation='lighter'` block. [Verified — our
`paint.ts`; MDN "Optimizing canvas"; bugzilla 1697344]

**2. The motion law has no class that admits a mote field.** `motion.ts` grants: *ambient*
(unlimited count, but ≤3% amplitude, 4–8 s), *event* (**≤5 concurrent**, 400–600 ms),
*structural* (≤2, ~800 ms). A cord decomposing into 200 drifting motes is not ≤3% of
anything and it is not ≤5 of anything. **This is a ruling the operator has to make before
the lane starts**, not something an implementer can quietly widen. See Open questions.
[Verified — `packages/web/src/scene/motion.ts`]

## Track 1 — bioluminescent decay + the particle economy

**Verdict: pooled, sprite-stamped, hard-capped at ~240 live motes, spawned from the stored
ribbon spine with a per-sample birth delay. Never per-frame physics, never per-mote
gradients.**

- **Budget.** Canvas-2D sprite benchmarks put consumer hardware at ~1,100 sprites @60fps
  (Intel HD3000) and ~2,500 @60fps (GT330m) — 2013-era floors — and a modern 10,000-sprite
  harness still clears 47–60fps in the good runners. A 240-mote cap is ~10–20% of a decade-old
  floor: the margin we want, given the ribbons already own the frame. [Consensus — SitePoint
  sprite benchmark; Shirajuki/js-game-rendering-benchmark, MIT]
- **Sprite, not `arc()`.** Practitioners consistently report `drawImage` of a pre-rendered
  stamp beating `arc()+fill()`, and MDN's first tip is "pre-render similar primitives on an
  offscreen canvas". Pre-render ~4 tinted variants at load; never `filter`. [Verified — MDN;
  Consensus — Seb Lee-Delisle]
- **Pooling.** Pre-allocate at startup; `alive` flag + free-list, never `new` in the loop.
  The circulating figure — 200 particles/frame = 12,000 allocations/sec, pooling cuts GC
  amplitude ~90% — is directionally right on blog-grade sources. [Thin on the %, Consensus
  on the practice — Game Programming Patterns, "Object Pool"]
- **"Decompose along a path" — the recipe.** We already store the ribbon spine (`ribbon.ts`).
  On sever: sample the spine at fixed arc-length intervals; each sample becomes one mote whose
  **birth delay is proportional to its distance from the cut**, so the cord unravels from one
  end instead of puffing. Constant lifetime ⇒ staggered death for free. Seed each mote's drift
  from `hash(laneId, sampleIndex)` — replay determinism is non-negotiable, and `simplex-noise`
  + a seeded PRNG already ship. [Consensus — the Codrops dissolve/edge-emission pattern and
  Disintegrate.js both work this way; delay-by-position is the transferable half]
- **The hybrid, concretely.** Split the sample set: a minority drift outward on a slow noise
  field and die (bioluminescent decay); the majority advance *along the stored spine* to the
  root-mass and are absorbed (composting). **Absorption completing commits the growth ring** —
  motes transient, ring permanent, added on a structural event and never recomputed per frame.
- **Coalescing.** The existing law (above the tracking limit, traffic becomes one aggregate
  carrying a count) applies unchanged: three lanes severing at once is **one** composting flow.

## Track 2 — the mycorrhizal heart: growth rings + hyphal lattice

**Verdict: rings are static baked geometry rebuilt only when a ring is added; the lattice is
a seeded radial fan baked once, stroked as ONE `Path2D`. No live growth simulation.**

- **Irregular ring contours.** Sample noise *around a circle in noise space* — for ring `i`,
  `r(θ) = R_i · (1 + a · noise2D(f·cos θ + ox_i, f·sin θ + oy_i))`. Walking a closed loop
  through the field guarantees the contour closes with no seam; a per-ring offset makes each
  ring its own irregularity while the family stays coherent. Keep `a` in 0.02–0.06 — above
  that, rings stop reading as rings. [Consensus — Coding Train #136 "Polar Noise Loops";
  alexcodesart's p5 walkthrough]
- **Ring-count legibility.** Rings are a *count* the viewer is meant to read. Past roughly
  7–9 concentric rings the outer ones compress and merge, and the scene already has an answer
  for this shape of problem: coalesce and carry a number. [Thin — no measurement found;
  reasoned from `pulses.ts`, which cites Pylyshyn & Storm]
- **Cost.** Ring geometry changes only on a structural event: build once into a `Path2D` (or
  an offscreen canvas the size of the heart) and blit. `contour.ts` already fills nested rings
  even-odd in one path — the same call takes a ring stack unchanged. [Verified — `paint.ts:179`]
- **Hyphae.** The literal prior art is Anders Hoff's **Hyphae**: grow circles adjacent such
  that no two overlap, producing root-like networks with no crossing edges. MIT, but
  **archived Python (read-only since 2019) — read it, do not vendor**. The non-overlap
  constraint is the transferable half. [Verified — github.com/inconvergent/hyphae]
- **But do not simulate.** prd7 already confined space colonization to offline authoring. The
  cheaper, equally convincing structure here is a **seeded radial fan**: N filaments from the
  heart, each a short noise-perturbed radial polyline, rejection-sampled against a coarse
  angular occupancy array so they don't collide. O(N), no kd-tree, baked once per topology
  change, stroked at low alpha as **one** path. [Verified — prd7 note; Consensus — Runions et al.]
- **Tarbell's transferable idea.** Substrate: lines grow out of *other* lines. Here: new
  filaments spawn from existing filaments, not all from the centre. That one rule is the
  difference between a mass that looks *grown* and one that looks *drawn*. [Consensus]

## Track 3 — the accent hue [Ran]

I computed OKLCH, WCAG contrast against the floor, and hue separation from every token, for
17 candidates (`hue.py`). Measured register, OKLCH hue: **ice-200 254.3 · ice-600 263.0 ·
necrotic 267.9 · notice-cyan 208.0 · broken-red 13.9 · working 156.5 · needs-you 82.7**.

**The finding that decides it: the "teal" side of violet is where the ice ramp already
lives** (H 254–268). Every indigo I tested landed on top of it — `#4f46e5` is **22.6°** from
ice-200, so it reads as "a brighter, bluer ice", not a new hue. "Violet-teal" therefore
cannot be resolved as *hue*; it resolves as **violet at H ≈ 292–296 kept cold by low
chroma**. The teal reading comes from the ice backdrop, not the pigment.

**Three candidates, all clear of every status hue:**

| # | name | hex | L / C / H | vs ice-200 | vs cyan | vs red | read |
|---|---|---|---|---|---|---|---|
| **1 (recommend)** | **myco-violet** | **`#6b4fa8`** | 0.500 / 0.138 / 295.5 | **41°** | 87° | 78° | mid-chroma, reads as tissue |
| 2 | iris | `#6f5ce0` | 0.565 / 0.193 / 285.0 | 31° | 77° | 89° | punchier, but crowds ice |
| 3 | orchid | `#9d4edd` | 0.588 / 0.212 / 306.3 | 52° | 98° | 68° | most separation from ice, drifts pink at the lit end |

**Recommend #1, `#6b4fa8`, as a five-step tissue ramp** (contrast-vs-floor in brackets — all
below the text threshold, which is correct: this hue is *never* text):

```
myco-1000 #1e1833  L 0.231  [1.19]   the undertone under the rings
myco-900  #322752  L 0.308  [1.49]   hyphal lattice at rest
myco-700  #4b3a7a  L 0.400  [2.11]   lattice, lit side
myco-500  #6b4fa8  L 0.500  [3.19]   the base token
myco-300  #8f6fd6  L 0.619  [5.22]   apical tuft glow — the ceiling, alarm-free
```

Why not #2: at 31°/22° from ice-200/ice-600, a dim iris filament and a bright ice filament
read as one family — which destroys the "new hue = organic tissue" signal. Why not #3: its
lit end (`#c07ff0`) starts reading pink, the one adjacency explicitly forbidden. `#6b4fa8`'s
deep steps land beside ice-850/800/700 in *lightness* while sitting 41° away in *hue* —
which is exactly what "undertone" means. Caveat: at C < 0.05 all hues converge toward grey,
so `myco-1000` is only weakly violet in isolation; it works *because* it sits against ice.

**The local tool, run [Ran]:** `ui-ux-pro-max --domain color` returned the same three
product palettes (E-commerce Luxury, Podcast Platform, Productivity Tool) for all three
colour queries — it indexes product palettes, not hue geometry, and was no help here. Its
`--domain style` **was** useful: "Biomimetic / Organic 2.0" (cellular/fluid, breathing,
generative growth, Canvas 10/10, perf flagged ⚠ Moderate) is the right checklist for this
prd, and "Vintage Analog / Retro Film" (Canvas 9/10) is the grain reference.

## Track 4 — depth, texture, ambient life

**Grain — one pre-rendered tile, `createPattern` cached, `fillRect` at alpha 0.02–0.04,
animated at ≤12fps or not at all.** Build a 128–256px noise tile once at startup into an
offscreen canvas; cache the pattern; never regenerate per frame — that is the documented
crash path ("computer-generated noise is processor taxing…can cause the browser to crash").
If the grain must live, hold 3–4 tiles and swap at 12Hz: film grain reads *more* filmic below
24Hz and costs 5× less. [Consensus — p5.grain (MIT), CSS-Script survey, CodePen implementations]

**Fog / vignette — two cached radial gradients, built on resize only, painted screen-space.**
`paint()` already has the seam: the picture goes through the camera, the chrome at device
scale. A vignette must be chrome-side or zoom magnifies it off-screen. Cache the
`CanvasGradient` — the one canvas object every source agrees you must not rebuild in a loop.
[Verified — `paint.ts:73–99`; MDN; Consensus on caching]

**Shimmer — luminance-only, phase-seeded per lane, already lawful.**
`L' = L · (1 + 0.03·sin(2πt/T + φ_lane))`, `φ_lane = hash(laneId)`, `T ∈ [4s, 8s]` — the
ambient class read literally. **No hue oscillation**: a hue that moves is a hue that means
something, and law 9a forbids it. For a richer read, travel one stop of the existing
linear-gradient paint along the ribbon — still one `fill()`. [Verified — `motion.ts`, `paint.ts`]

**Spores / rim flora — same pool, same sprite, same cap as the decay motes.** One particle
system, two spawn sources. Do not build a second.

**Reduced motion, off the repo's own mapping:** WCAG 2.3.3 excludes colour/blur/opacity from
"motion animation", so under `reduced` the motes must **not travel** — the cord fades and the
ring appears. Under `paused`, grain, shimmer and drift all stop. Design the decay so its
*meaning* survives with travel removed; if it doesn't, it is decoration. [Verified — `motion.ts`]

## Track 5 — replay-as-art: what transfers, what doesn't

- **Real hyphal growth is tip-only.** The body doesn't move; only apical tips advance and
  branch. That is the biology, the operator's apical-tuft ruling, and the cheapest possible
  animation all at once: per-frame work is O(active tips), not O(scene). Make it the
  organising principle of the round. [Consensus — mycology timelapse; Wikipedia "Mycelium"]
- **Anders Hoff / inconvergent** — Hyphae, Differential Line: rules in prose, the aesthetic
  closest to our metaphor. MIT but archived Python: **read, do not vendor.**
- **Jared Tarbell / Substrate** — growth begets growth (Track 2). Open-sourced Processing.
- **Tyler Hobbs** — flow fields, midpoint-displaced blobs (already technique-vendored in
  prd7). No licence stated → reimplement, never copy.
- **Refik Anadol — AVOID as a technique reference** [Verified]. GAN latent walks and GPU fluid
  sims over 300M-image datasets; none of it transfers to a canvas-2D frame budget, and chasing
  it produces exactly the unbounded-particle failure this note exists to prevent. Take only the
  presentational lesson: a data piece earns "art" by being one continuous surface with nothing
  competing at its edges.

## What to avoid

1. Motes as `glow` marks (per-frame gradient per particle) — the single biggest trap.
2. Uncapped particle spawning; a replay scrub can fire fifty severances in one second.
3. Per-frame growth simulation of any kind — space colonization, differential growth,
   Physarum, collision-resolved particles. Bake offline, animate along the bake.
4. `shadowBlur` (prd7: not affected by the transform matrix, so it breaks zoom) and WebGL
   (prd7: jsdom returns `null` for `webgl`, so the painter would be untestable).
5. Regenerating the grain field per frame via `putImageData`.
6. Any **hue** oscillation for iridescence; the accent on anything carrying status; any
   accent below H≈285, which collides with the ice ramp.
7. Rounding mote coordinates to integers (stepping at sub-pixel drift speeds).
8. **CC BY-NC-SA traps:** jasonwebb's `space-colonization-algorithm` and `differential-growth`
   are non-commercial — never vendor. `thebookofshaders` repo is All Rights Reserved.

## Open questions for the operator

1. **Which motion class owns a mote field?** The law admits nothing between "unlimited but
   ≤3% amplitude" and "≤5 concurrent". A fourth class (*dissolution*: one-shot, bounded
   population, per-particle contrast below the calm ceiling) looks like the honest answer —
   but that is an amendment to a law, and needs a ruling rather than an implementation.
2. **Is the accent allowed on the decay motes?** They are emitted by a *severed* lane, so
   they are arguably status-bearing, which the ruling forbids. Cleanest reading: motes wear
   necrotic grey (the corpse); the accent appears only on *composted* matter and the living
   tissue it becomes. Confirm.
3. **Do growth rings survive a backwards replay scrub?** Either a ring is a function of time
   (scrubbing removes it — honest) or of the session (it stays — prettier). Pick one.
4. **The ring cap.** What does the heart do at lane 20, 40, 100 — compress, coalesce with a
   count, or grow?
5. **Unmeasured.** No browser probe this session: the browser tool requires a user-facing
   confirmation a subagent cannot issue. **First task of the implementing lane: measure
   sprite-blit vs gradient-glow at N=240 in a real browser**, the way prd7 measured its
   180-frame profile. Every particle number above is literature, not our stack.

## Sources — all accessed 2026-08-04

**Perf:** MDN *Optimizing canvas* — https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
· MDN *createRadialGradient* — https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/createRadialGradient
· Bugzilla 1697344 — https://bugzilla.mozilla.org/show_bug.cgi?id=1697344
· js-game-rendering-benchmark (MIT) — https://github.com/Shirajuki/js-game-rendering-benchmark
· Seb Lee-Delisle (carries its own "from 2011" caveat) — https://seblee.me/2011/02/html5-canvas-sprite-optimisation/
· Nystrom, *Object Pool* — https://gameprogrammingpatterns.com/object-pool.html
**Decay/dissolve:** Codrops — https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/
· ZachSaucier/Disintegrate — https://github.com/ZachSaucier/Disintegrate
**Rings/hyphae:** Coding Train #136 — https://thecodingtrain.com/challenges/136-polar-noise-loops
· alexcodesart — https://alexcodesart.com/drawing-noisy-circles-with-p5-js-a-deep-dive-into-polar-coordinates-and-perlin-noise/
· inconvergent/hyphae (MIT, archived 2019-05-21, Python) — https://github.com/inconvergent/hyphae · https://inconvergent.net/generative/
**Grain:** meezwhite/p5.grain (MIT) — https://github.com/meezwhite/p5.grain
· CSS-Script survey — https://www.cssscript.com/film-grain-noise-texture/
**Art references:** Artnome on Tarbell — https://www.artnome.com/news/2020/8/24/interview-with-generative-artist-jared-tarbell
· Waelder on Anadol — https://www.niio.com/blog/refik-anadol-art-in-a-latent-space-2/
· Wikipedia *Mycelium* — https://en.wikipedia.org/wiki/Mycelium
**Our own source, read this session:** `packages/web/src/scene/{paint,motion,palette,contour,ribbon}.ts`,
`packages/web/src/theme/theme.css`. **Colour probe [Ran]:** OKLab/OKLCH + WCAG script over 17
candidates (scratchpad `hue.py` / `ramp.py`); output quoted in Track 3.
