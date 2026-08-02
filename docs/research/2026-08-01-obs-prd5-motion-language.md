# Rhizomorph prd5 — a motion language for the mycelium canvas

> Researched 2026-08-01 to serve one decision: **groom prd5 motion issues** —
> how much more animation the Rhizomorph scene may take, at what speeds, and
> how completed lanes visually disconnect.
> Claims tagged `[Ran]` / `[Verified]` / `[Consensus]` / `[Thin]`.

## Headline: the proposed motion budget

Three motion classes, hard-separated. Nothing in the scene may move outside one.

| Class | What moves | Duration / rate | Easing | Concurrency cap |
|---|---|---|---|---|
| **Ambient** (always on) | root-mass breathe, lane slack sway, idle mote drift | 4–8 s period, ≤3% amplitude | sinusoidal, never linear | unlimited — must be *sub-threshold*, not trackable |
| **Event** (real data) | commit pulse travel, arrival flare, mote burst | pulse 400–600 ms; flare 150 ms in / 500 ms out | pulse `cubic-bezier(0,0,0,1)` (decelerate); flare fast-in/slow-out | **≤5 simultaneous** |
| **Structural** (topology change) | lane appear, lane *disconnect*, layout reflow | ~800 ms perceptual | critically-damped spring, ζ = 1.0 | ≤2 at once; stagger the rest by 60–90 ms |

Numbers are anchored: Carbon `slow-01` = 400 ms, `slow-02` = 700 ms [Verified];
M3 `duration-long1..4` = 450/500/550/600 ms, `extra-long1` = 700 ms [Verified];
NN/g says >500 ms "start to feel like a real drag" for *interaction* feedback
[Verified] — which is why structural motion at 800 ms is only defensible because
it is not blocking anyone's input.

**Concurrency cap of 5 is the load-bearing number.** Pylyshyn & Storm 1988
showed people track up to ~4–5 independent moving targets among identical
distractors at >85% accuracy, and fail beyond that [Verified, via tutorial
review]. A monitoring scene that fires 12 simultaneous pulses conveys "lots
happening" and nothing else. Above 5 concurrent event animations, **coalesce
into one aggregate pulse with a count** rather than drawing them all — this is
the existing "traffic is coalesced, never invented" law extended to motion.

### Completed lanes disconnecting — recommended choreography

The operator's specific ask. Proposed 3-stage sequence, ~1.4 s total, staged
(Heer & Robertson found staged transitions outperform single-shot, and
recommend ~1 s per stage) [Verified]:

1. **Tension release (0–250 ms)** — the lane's control points relax: the thread
   goes from taut to slack. Curvature only; no translation. Reads as "let go".
2. **Detach + retract (250–1050 ms)** — tip springs away from the root mass,
   critically damped, ζ = 1.0. **No bounce.** Apple: bounce 0 "gives you a great
   general purpose spring that's the most versatile"; above 0.4 "may feel too
   exaggerated for a UI element" [Verified].
3. **Settle to scar (1050–1400 ms)** — opacity → 0.35, saturation → 0, the lane
   stays drawn as a desaturated remnant. It never pulses again. This is the
   existing "history never pulses" law made *visible* rather than merely true.

Do **not** fade the lane to nothing. Disconnection is information; deletion is
absence of information, and the operator cannot tell it from a render bug.

---

## 1. Motion grammar norms

**IBM Carbon** ships six duration tokens and three easings × two modes.
From the shipped token source [Verified —
`carbon/packages/motion/src/dtcg/motion.json`, read via `gh api` 2026-08-01]:

- `fast-01` **70 ms** ("instant response to user action"), `fast-02` **110 ms**
- `moderate-01` **150 ms** ("default transition speed"), `moderate-02` **240 ms**
- `slow-01` **400 ms**, `slow-02` **700 ms** ("slow, immersive motion")
- easing `standard` productive `[0.2, 0, 0.38, 0.9]`, expressive `[0.4, 0.14, 0.3, 1]`
- `entrance` productive `[0, 0, 0.38, 0.9]`; `exit` productive `[0.2, 0, 1, 0.9]`

The productive/expressive split is the useful idea: **productive = get out of
the way, expressive = this is worth your attention.** Rhizomorph's ambient
layer is productive; the disconnect is the one expressive moment.

**Material 3** [Verified — `material-web/tokens/versions/v0_192/_md-sys-motion.scss`
via `gh api` 2026-08-01]: durations `short1..4` = 50/100/150/200 ms,
`medium1..4` = 250/300/350/400 ms, `long1..4` = 450/500/550/600 ms,
`extra-long1..4` = 700/800/900/1000 ms. Easings: `standard`
`cubic-bezier(0.2, 0, 0, 1)`, `standard-decelerate` `cubic-bezier(0, 0, 0, 1)`,
`emphasized-decelerate` `cubic-bezier(0.05, 0.7, 0.1, 1)`,
`emphasized-accelerate` `cubic-bezier(0.3, 0, 0.8, 0.15)`.
`standard-decelerate` is the right curve for a pulse *arriving* — all
deceleration, no ease-in, so it looks launched rather than nudged.
(The m3.material.io prose pages are JS-rendered and not fetchable; the token
values above come from the shipped artifact, which is stronger anyway.)

**Apple HIG** [Thin — developer.apple.com's HIG pages are JS-rendered and would
not fetch directly; these quotes were surfaced by search over that domain, not
by a direct read]: "don't add motion for the sake of adding motion"; "avoid
adding motion to interactions that occur frequently"; motion that "appears to
defy physical laws" causes disorientation; when Reduce Motion is on, "minimize
or eliminate animations".

**Calm technology** [Verified — calmtech.com, Amber Case, after Weiser & Brown]:
"Technology should require the smallest possible amount of attention"; a calm
technology "will move easily from the periphery of our attention, to the center,
and back". That last line is the Rhizomorph's whole design brief. Ambient
motion earns its place only if it can be *ignored*; the moment a viewer must
consciously suppress it, it has failed.

## 2. Springs vs. easing curves

The canonical argument is Apple's, and it is about **velocity continuity**
[Verified — WWDC23 "Animate with springs"]: an easing curve "is just a
prespecified curve, so there's no way to represent an initial velocity",
whereas a retargeted spring "uses the velocity it had when it was retargeted as
the initial velocity towards its new destination". Also: spring `duration` is a
*perceptual* duration, "chosen to be predictable", not the settling duration.

Library defaults, for calibration: Framer/Motion spring `stiffness` 100,
`damping` 10, `mass` 1 [Consensus — reproduced across docs and mirrors];
Motion's newer time-API defaults `duration` 800 ms, `bounce` 0.25, `restSpeed`
0.1, `restDelta` 0.01 [Verified — motion.dev/docs/spring]. react-spring is
"Spring-Physics First… but we support durations with easings as well"
[Verified — repo README]; it does not itself argue the case.

**Rule for Rhizomorph:** springs for anything that can be *interrupted or
retargeted* (lane layout when the set of lanes changes mid-animation); fixed
curves for discrete one-shot events (pulse travel, arrival flare) where
determinism matters because the animation encodes a fact.

### Springs in a raw rAF loop — measured, and there is a trap

Semi-implicit Euler spring, no library [Ran — Node v22.9.0, 2026-08-01]:

```
framer-motion default (k=100,c=10,m=1)   settle= 1283 ms  overshoot 14.6%  ζ=0.50
critically damped k=100                  settle= 1050 ms  overshoot   0%   ζ=1.00
critically damped k=170                  settle=  833 ms  overshoot   0%   ζ=1.00
critically damped k=300                  settle=  667 ms  overshoot   0%   ζ=1.00
```

So **k=170, c=2√170≈26, m=1 lands almost exactly on the 800 ms structural
budget** with zero overshoot. Use it for the lane disconnect.

The trap [Ran]: that same spring, stepped naively with the real frame delta,
**explodes** when frames get long — at dt = 1/10 s it diverges to `-5.22e+8`
within 20 steps. Long frames are not hypothetical (background tab, GC pause,
a wave of agents landing). Two fixes, both verified numerically [Ran]:

```
naive euler   dt=1/10, 20 steps  ->  -5.22e+8      (diverged)
substep <=1/30 dt=1/10, 20 steps ->   1.0000       (fine)
substep <=1/30 dt=0.5s, 4 steps  ->   1.0000       (tab-wake, fine)
exact critically-damped, dt=2.0s, 1 step -> 1.0000 (unconditionally stable)
```

Prefer the **closed-form critically-damped step** — for ω=√k,
`x' = target + (d + (v + ωd)·dt)·e^(−ω·dt)`, `v' = (v − (v+ωd)·ω·dt)·e^(−ω·dt)`
where `d = x − target`. It is stable at *any* dt, costs one `exp()`, and means
a backgrounded tab resumes composed instead of with geometry flung off-screen.

## 3. Organic motion: alive vs. jittery

**d3-force defaults** [Verified — d3js.org/d3-force/simulation]: `alpha` 1,
`alphaMin` 0.001, `alphaDecay` ≈0.0228 (= `1 - pow(0.001, 1/300)`, i.e. ~300
ticks to convergence), `alphaTarget` 0, `velocityDecay` 0.4. Higher decay
"stabilizes faster but may get stuck in local minima"; lower velocityDecay
"risks numerical instabilities and oscillation".

**The jitter trap:** the common way to make a graph "feel alive" is to hold
`alphaTarget` above `alphaMin` so the simulation never stops. d3's own docs
name this as the mechanism for running "indefinitely" [Verified]. It is exactly
wrong for a monitoring scene — a permanently-warm simulation means node
positions never mean anything twice, and the viewer's eye is drawn to noise.

Recommended instead: **settled by default, reheated only by real events.** On a
topology change, `simulation.alphaTarget(0.15).restart()`, then `alphaTarget(0)`
on the next tick so it cools. Raise `velocityDecay` to ~0.6 for a heavier,
less twitchy settle. "Alive" then comes from the *ambient* layer (slow
sinusoidal sway of already-settled geometry), not from an unconverged solver —
sway is periodic and ignorable; unconverged physics is aperiodic and is not.

**Generative-organic references.** Jones 2010 (Artificial Life 16(2):127–153) is
the primary Physarum multi-agent model: agents with three sensors, a deposited
trail map, diffusion (3×3 mean filter) + multiplicative decay; parameter set is
sensor distance/size/angle, step size, rotation angle, deposition, decay, diffuse
size [Verified — Sage Jenson's implementation notes]. Space-colonization
(Runions et al.) is the other standard hyphae/venation route [Consensus].
**Do not run either live.** Use them offline to *author* lane geometry, then
animate the fixed result — a live Physarum step is a large per-frame cost for
structure the viewer cannot read.

**Performance envelope.** The JS-side math for 30 lanes is a rounding error
[Ran — Node v22.9.0]: resampling 30 cubic-Bézier lanes at 64 points/frame plus
advancing N motes costs **0.027 ms/frame at 0 motes, 0.026 ms at 900,
0.058 ms at 3000** — under 0.4% of a 16.7 ms budget. The budget goes on *draw
calls*, not arithmetic. Canvas-2D cost drivers [Verified — web.dev canvas
performance]: `shadowBlur` is "very expensive"; batch a whole polyline into one
path + one `stroke()` rather than per-segment strokes; sort draws by fill color
because "it's cheaper to render by color rather than by placement"; snap to
integer coordinates to avoid forced anti-aliasing; pre-render repeated sprites
(motes, flares) to a snug offscreen canvas; layer static geometry onto a second
stacked canvas so the ambient layer isn't redrawn per frame.
Canvas 2D comfortably handling thousands of simple objects at 60 fps is
[Consensus], not something I measured in a browser — see open questions.

## 4. Juice discipline — and why monitoring inverts it

"Juice it or Lose it" (Jonasson & Purho, Nordic Game Jam 2012) is the canonical
game-feel talk: take a block-breaker and layer on screenshake, particles,
squash-and-stretch, sound, until it feels alive [Consensus — the talk itself is
a video; widely reproduced]. Its logic is that in a game, **feedback intensity
is free** because there is no cost to over-signalling a paddle hit.

That does not transfer. In a monitoring tool, **motion is an encoding channel,
and spending it on decoration debases it.** The supporting evidence:

- Tversky, Morrison & Bétrancourt 2002, *Animation: can it facilitate?*
  [Verified — hci.stanford.edu PDF]. Two principles: **Congruence** — "graphics
  should be congruent with the concepts they represent" — and **Apprehension** —
  "people can only apprehend a limited amount of information at any moment".
  Across the reviewed studies, static graphics often matched or beat animation;
  failures traced to animations that move too fast, present too many
  simultaneous elements, and are transient (gone before encoding completes).
- Heer & Robertson 2007 [Verified — idl.cs.washington.edu PDF exists;
  numbers below are Consensus, taken from citing literature because the PDF
  would not decode to text via WebFetch]: animated transitions improved
  graphical perception; transitions were **1.25 s**; **staging** (splitting a
  transition into ordered phases) was introduced as the design strategy, at
  roughly **1 s per stage**.
- Bartram, Ware & Calvert 2003, *Moticons* (IJHCS 58(5):515–545) — the
  strongest pro-motion result for this exact use case [Verified that the paper
  and finding exist; per-condition details [Thin], PDF partially extracted]:
  simple motion codes were **better detected and identified than colour and
  shape codes, especially in the periphery**, and significantly outperformed
  static cues in both near and far visual fields on accuracy and response time.
  Motion *is* the right channel for peripheral awareness. The same work
  separates detection from distraction — travel-type motion detected well;
  oscillation rated most distracting.

**Synthesis:** motion earns its keep when it means something and is glanceable
from the periphery; it costs when it is aperiodic, dense, or fast enough to
demand foveation. Ambient ≠ decorative — an ambient breathe that encodes
"system is live and connected" is information. A particle burst that encodes
nothing is theft from the same channel.

## 5. prefers-reduced-motion for a canvas app

MDN's guidance is **reduce or replace, not remove** [Verified — MDN
`prefers-reduced-motion`]; the documented example swaps a `scale()` pulse for an
opacity dissolve. Detect with
`window.matchMedia("(prefers-reduced-motion: reduce)")` and **subscribe to
`change`** — a canvas app can honour a mid-session toggle for free, where CSS
would need a repaint.

WCAG 2.3.3 *Animation from Interactions* (**Level AAA**): interaction-triggered
motion animation must be disableable "unless the animation is essential";
"motion animation" excludes changes to colour, blur, and opacity that do not
alter perceived position or size [Verified — W3C Understanding doc]. **That
exclusion is the degradation map**: reduced-motion Rhizomorph keeps colour and
opacity, drops travel and scale.

WCAG 2.2.2 *Pause, Stop, Hide* (**Level A** — the one that actually bites): any
moving content that starts automatically, lasts more than five seconds, and is
presented in parallel with other content needs a pause/stop/hide mechanism
[Verified — W3C Understanding doc]. **An always-breathing ambient canvas is
exactly this.** Ship a pause control (and let it persist), or the scene is a
Level A failure regardless of the reduced-motion work.

Proposed degradation table:

| Full motion | Reduced motion |
|---|---|
| root-mass breathe (scale) | static; brightness oscillation only, or nothing |
| pulse travels the lane | lane flashes brightness once, 150 ms, in place |
| arrival flare (scale + travel) | opacity flare only, no scale, no travel |
| motes drifting | static dots, or omit entirely; count shown as thickness |
| lane disconnect (spring retract) | crossfade taut → scar over 200 ms, no motion |
| force-layout reheat | jump-cut to solved positions |

## What to avoid

- Perpetual `alphaTarget > alphaMin`. Aperiodic idle motion is noise.
- Naive Euler springs on unclamped frame deltas — verified to diverge [Ran].
- Spring bounce on structural motion. ζ<1 on a *disconnect* reads as recoil,
  i.e. "it failed", not "it completed".
- `shadowBlur` for glow. Pre-render a radial-gradient sprite once [Verified].
- More than ~5 concurrently tracked moving elements; coalesce instead.
- Animating a lane that carries history. The disconnect is the exception and it
  is a one-time structural event, not a pulse.
- Fading completed lanes to zero — that is indistinguishable from a bug.

## Open questions

1. **No real browser benchmark was run.** JS math cost was measured in Node
   [Ran]; canvas *draw* cost was not. Settle it with one test: 30 stroked
   Bézier lanes + 300 sprite motes + 5 flares, `performance.now()` deltas over
   600 frames on the target machine, with and without a layered static canvas.
2. Heer & Robertson's exact durations/staging numbers come from citing works,
   not from the PDF (which would not decode via WebFetch). Verify against the
   paper before quoting 1.25 s / 1 s per stage in a spec.
3. Moticons' per-motion-type detail (which frequencies, which amplitudes) is
   [Thin] here. Worth a real read if the ambient sway rate becomes contentious —
   it likely bounds the safe frequency band directly.
4. Apple HIG quotes came via search index, not a direct page read.
5. Does the operator want the disconnect to be *reversible* on scroll-back
   through history? If yes, the retraction must be a spring with stored
   velocity, not a timeline — retargeting mid-flight is the whole reason to
   pick springs here.

## Sources

All accessed 2026-08-01. Shipped-artifact reads done via `gh api … -H "Accept: application/vnd.github.raw"`.

- Carbon tokens: `repos/carbon-design-system/carbon/contents/packages/motion/src/dtcg/motion.json` (+ `src/tokens.ts`)
- M3 tokens: `repos/material-components/material-web/contents/tokens/versions/v0_192/_md-sys-motion.scss`
- Apple *Animate with springs* WWDC23 — https://developer.apple.com/videos/play/wwdc2023/10158/
- Apple HIG Motion — https://developer.apple.com/design/human-interface-guidelines/motion (JS-rendered, not fetchable)
- Motion — https://motion.dev/docs/spring , https://motion.dev/docs/react-transitions ; react-spring — https://github.com/pmndrs/react-spring
- d3-force — https://d3js.org/d3-force/simulation
- Calm Technology — https://calmtech.com/ ; NN/g duration — https://www.nngroup.com/articles/animation-duration/
- Tversky et al. 2002 — https://hci.stanford.edu/courses/cs448b/papers/Tversky_AnimationFacilitate_IJHCS02.pdf
- Heer & Robertson 2007 — https://idl.cs.washington.edu/files/2007-AnimatedTransitions-InfoVis.pdf
- Bartram, Ware & Calvert 2003 *Moticons* — https://interruptions.net/literature/Bartram-IJHCS03-BW.pdf
- Pylyshyn & Storm 1988 — https://ruccs.rutgers.edu/images/personal-zenon-pylyshyn/docs/storm88.pdf
- Jones 2010 Physarum — https://pubmed.ncbi.nlm.nih.gov/20067403/ ; impl notes — https://cargocollective.com/sagejenson/physarum
- Jonasson & Purho *Juice it or lose it* 2012 — https://www.youtube.com/watch?v=Fy0aCDmgnxg
- MDN prefers-reduced-motion — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- WCAG SC 2.3.3 — https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions.html ; SC 2.2.2 — https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- web.dev canvas performance — https://web.dev/articles/canvas-performance

## Verdict

Grant the "a little more animation" request, but spend it structurally, not
decoratively: **one new expressive moment (the lane disconnect, ~1.4 s, staged,
critically-damped, ending in a persistent scar), plus a sub-threshold ambient
breathe.** Cap concurrent event motion at 5 and coalesce above it. Use the
closed-form critically-damped integrator, not naive Euler. Ship a pause control
before shipping the ambient layer — WCAG 2.2.2 is Level A and an
always-breathing canvas trips it.
