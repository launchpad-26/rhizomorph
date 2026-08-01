# Observatory prd5 — implementation vehicles that WORK

> Researched + **run** 2026-08-01, for the decision: which skills, libraries
> and repos the prd5 issues name as their implementation vehicles — "if
> we're going to be novel, we can be novel, but we can at least find
> something that WORKS" (operator). Claims tagged [Ran] / [Verified] /
> [Consensus]. Companion to
> `2026-08-01-observatory-prd5-design-inspiration.md`.

## Headline verdict

**Camera: adopt d3-zoom + d3-interpolate; hand-roll nothing.** Proven by
live probe in the Observatory's own test conditions (canvas 2D, headless
jsdom), ISC-licensed, ≤23 kB gz worst-case against a 61.8 kB bundle.
**Springs/cord-cut: hand-roll the 15-line closed-form critically-damped
step; adopt no animation library** — the motion note's [Ran] stability
tests already picked the algorithm, and every candidate library targets
DOM/React, not a raw canvas rAF loop. **Polish: the build workers load the
locally-installed design skills** (`emil-design-eng`, `frontend-design`)
— they encode exactly the animation-decision and production-polish taste
prd5 needs, and workers share `~/.claude/skills`.

## The probes ([Ran], scratch dir `~/prd5-verify`, node 22.23.2)

1. **d3-zoom drives a canvas headlessly.** jsdom canvas + `zoom()` +
   programmatic `scaleTo`/`translateBy`/focal-point zoom → transform
   events fire, and the result maps 1:1 onto
   `ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y)`:
   `after scaleTo(4, focal [100,100]): translate(60,-20) scale(4)` →
   `ctx.setTransform receives: 4, 0, 0, 4, 60, -20`. This means the
   repo's vitest+jsdom suite **can pin camera behavior in tests** — no
   real browser needed for the laws.
   - Harness scar worth keeping: d3-zoom's `defaultExtent` reads the bare
     global `SVGElement`; vitest's jsdom env installs it, a hand-rolled
     harness must add `global.SVGElement = dom.window.SVGElement` or every
     gesture throws. First probe run failed exactly there.
2. **Zoom-to-fit is free.** `interpolateZoom([400,300,800],[120,80,240])`
   produces the van Wijk path (arcs out through a 531-wide view at t=0.5,
   then in) plus a suggested duration (1280, rho-scaled) — drivable from
   the scene's existing rAF loop; **d3-transition is not required**.
3. **Cost.** All ISC (compatible). Worst-case full transitive stack
   (incl. d3-transition/d3-color we likely won't import) gzips to
   **23.0 kB** vs the current 61.8 kB bundle; vite tree-shaking lands
   lower. d3-zoom 3.0.0 / d3-selection 3.0.0 / d3-interpolate 3.0.1.

## Springs: no library ([Ran] evidence in the motion note)

The motion note measured: naive semi-implicit Euler **diverges on long
frames** (dt=1/10 → −5.2e8 in 20 steps); the closed-form critically-damped
step is stable at dt=2 s and k=170/c≈26 settles in 833 ms with zero
overshoot — exactly the structural-motion budget. Framer Motion /
react-spring / Motion One are DOM/React-oriented [Verified — their docs
target elements/components, not 2D contexts]; importing one for a canvas
rAF loop buys nothing over 15 lines we can test directly. **Verdict:
hand-roll the closed-form step as `scene/spring.ts` with the stability
test from the note pinned.**

## Skills roster for the build waves (all installed at ~/.claude/skills,
visible to every worker)

| Skill | Use in prd5 | When |
|---|---|---|
| `emil-design-eng` | Animation decisions + polish review (ease-out over ease-in, specific transition properties, :active states, transform-origin discipline) — its required Before/After review table is a ready-made verification format | Load in every motion/polish lane brief; conductor loads it to review landed UI diffs |
| `frontend-design` | The register: bold intentional aesthetic, anti-generic discipline — guards the "sleek, beautiful application" bar | Load in the layout/polish lanes |
| `web-perf` | Core-Web-Vitals/canvas perf audit via Chrome DevTools | Conductor-side, once, before prd5 closes |
| `dataviz` | Chart/color rules if the ledger/burn panels get touched | Only those lanes |
| `ui-ux-pro-max` | Palette/typography lookups | Optional reference |

## Repos worth reading (not adopting) during the cord-cut spike

- **xyflow (React Flow)** — MIT [Verified, github.com/xyflow/xyflow] —
  the Figma-preset interaction config (drag-vs-select resolution).
- **tldraw** — license is custom (tldraw license, watermark clause)
  [Verified, github.com/tldraw/tldraw] — read for canvas-engine
  architecture only; do not vendor code.
- **d3-force** — ISC — only if the cord-cut retract wants a brief force
  rejoin; the interaction note's staged-retirement pattern may not need
  it at all.

## What NOT to adopt (each considered and rejected)

- **pixi-viewport / WebGL viewports** — wrong renderer; the scene is
  canvas 2D by ruling (three.js was deliberately removed in prd3 #81).
- **Framer Motion et al.** — DOM-targeted; see springs verdict.
- **A force simulation running live** — the motion note's
  "alphaTarget jitter" trap; geometry stays authored, motion stays lawful.

## Open questions

- Exact tree-shaken bundle delta once d3-zoom lands in vite (measure at
  the gate; expect well under the 23 kB worst case).
- Does `translateExtent` bounds behavior feel right with the hero-sized
  scene, or does the camera want soft rubber-band edges (hand-rolled)?
  Decide in the spike, in a real browser.
- Touch: pinch arrives as ctrlKey-wheel per the interaction note
  [Consensus]; verify on a real trackpad during the layman pass.

## Sources

- Probes: `~/prd5-verify/probe-a.cjs`, `probe-b.cjs` (this note records
  their verbatim output; scratch dir is disposable, the note is not).
- d3-zoom / d3-selection / d3-interpolate package.json (ISC, versions
  above), node_modules dist gzip measurement, 2026-08-01.
- Companion notes of the same date for all design-side citations.
