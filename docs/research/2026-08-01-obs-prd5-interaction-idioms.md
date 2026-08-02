# Rhizomorph prd5: canvas/node-graph interaction idioms

> Researched 2026-08-01 to groom prd5 interaction issues (pannable/zoomable
> mycelium canvas, fit affordances, COMPLETED-lane disconnection). Claims
> tagged [Ran] / [Verified] / [Consensus] / [Thin]. Nothing here was
> executable locally — these are UI conventions and library APIs; grades top
> out at [Verified] against primary docs.

## Headline recommendations (the steal-list)

1. **Use d3-zoom as the camera engine, even on raw canvas 2D.** It ships the
   exact gesture bundle we need (wheel zoom, drag pan, pinch, double-click),
   emits a single `{k, x, y}` transform you apply as
   `context.translate(t.x, t.y); context.scale(t.k, t.k)`, and enforces
   bounds via `scaleExtent` / `translateExtent`. [Verified —
   https://d3js.org/d3-zoom shows the canvas snippet and both extents]
2. **Gesture set (the cross-tool consensus):** drag empty background = pan;
   `Ctrl/Cmd + wheel` = zoom **at cursor**; pinch = zoom (arrives as a wheel
   event with `ctrlKey: true`); `Space + drag` = pan-anywhere override;
   middle-mouse drag = pan. This is Figma/FigJam, n8n, tldraw, and
   React Flow's "Figma-like" preset almost verbatim. [Verified per-tool below]
3. **Bare wheel: pan, don't zoom, if lanes are clickable.** tldraw's default
   `wheelBehavior: 'pan'` and React Flow's Figma-preset (`panOnScroll: true`)
   both treat two-finger scroll as pan; zoom stays behind Ctrl/pinch.
   [Verified — tldraw camera docs; reactflow viewport docs] For a
   full-viewport app canvas, wheel-zoom (React Flow's slippy-map default) is
   also defensible — but only with cursor-focal zoom. [Verified — reactflow
   defaults `zoomOnScroll: true`]
4. **Zoom bounds:** React Flow defaults `minZoom 0.5` / `maxZoom 2`; tldraw
   uses `zoomSteps [0.1, 0.25, 0.5, 1, 2, 4, 8]`. Something in the 0.1–4
   range with a hard floor/ceiling is the norm; unbounded zoom is not.
   [Verified — reactflow API ref; tldraw camera docs]
5. **Fit affordances — the 90% set:** keyboard zoom-to-fit (`1` in n8n,
   `Shift+1` in Figma/FigJam), reset-to-100% (`0` / `Ctrl+0`), `+`/`-` zoom,
   on-canvas zoom buttons, and a **"Recenter" button that appears only when
   scrolled far from content** (FigJam does exactly this). [Verified per-tool
   below] Animate programmatic moves with d3's `interpolateZoom`
   (van Wijk & Nuij smooth zoom-and-pan) rather than jump-cutting.
   [Verified — d3-zoom docs]
6. **Culling:** render only what intersects the viewport, via a spatial
   index; exempt selected/hovered items so the user never loses what they're
   working with (tldraw: R-tree + `getCulledShapes()` which excludes
   selected/editing shapes). [Verified — https://tldraw.dev/sdk-features/culling]
7. **Lifecycle:** no mainstream tool physically detaches finished nodes —
   "cut the cord" is genuinely novel for Rhizomorph (a feature, not a
   violation). Precedent supports: status restyle + fade + *removal from the
   live simulation* with an exit animation, plus a way to still find retired
   items (Obsidian's "Orphans" toggle; CI graphs keep completed jobs
   inspectable). See §Lifecycle.

## Per-tool findings

**Figma / FigJam** — `Space` hold = temporary hand tool (`H` = persistent);
click-drag pans only with hand tool; mouse wheel scrolls the canvas
(`Shift+wheel` = horizontal); `Ctrl/Cmd + wheel` zooms; trackpad pinch zooms;
`Shift+1` zoom-to-fit, `Shift+2` zoom-to-selection, zoom presets 50/100/200%;
optional right-click-drag pan; **Recenter button appears when scrolled far
from the starting point**; arrow keys pan when nothing is selected. [Verified
— help.figma.com "Pan and zoom in FigJam" + "Use Figma products with a
keyboard"]

**React Flow (xyflow)** — defaults: `panOnDrag: true`, `zoomOnScroll: true`,
`zoomOnPinch: true`, `zoomOnDoubleClick: true`, `panOnScroll: false`,
`minZoom 0.5`, `maxZoom 2`, `preventScrolling: true`,
`panActivationKeyCode: 'Space'`, `zoomActivationKeyCode: Meta/Ctrl`,
`translateExtent: [[-∞,-∞],[+∞,+∞]]`. Documented "Figma-like" preset:
`panOnScroll: true, selectionOnDrag: true, panOnDrag: false` → pan via
"scroll, middle / right mouse drag, space + pointer drag", zoom via "pinch or
cmd + scroll", pointer drag = selection. This is the cleanest documented
resolution of the drag-vs-select conflict. [Verified —
reactflow.dev/learn/concepts/the-viewport; reactflow.dev/api-reference/react-flow]
MiniMap component: `pannable` and `zoomable` both default `false` (display
only unless opted in), mask over the non-visible region
(`maskColor rgba(240,240,240,0.6)`). [Verified —
reactflow.dev/api-reference/components/minimap]

**tldraw** — `TLCameraOptions`: `wheelBehavior: 'pan' | 'zoom' | 'none'`
(pan is the shipped default), `panSpeed`, `zoomSpeed`,
`zoomSteps [0.1…8]`, `isLocked`, optional `constraints` (bounds, padding,
origin, initialZoom, baseZoom). Methods: `editor.zoomToFit()`,
`zoomToSelection()`, `zoomToBounds(bounds, { inset: 100 })`, `resetZoom()`,
`setCamera(..., { animation })`, and `slideCamera()` for **momentum/inertia**
moves. `Z` opens a quick-zoom overview with a viewport brush. [Verified —
tldraw.dev/sdk-features/camera]

**n8n** — `+`/`=` zoom in, `-` zoom out, `0` reset zoom, **`1` zoom-to-fit**,
`Ctrl/Cmd + wheel` zoom; pan via `Space+drag`, middle-mouse drag,
`Ctrl+LMB drag`, `Ctrl+MMB drag`, or two fingers on a touch screen; plus
on-canvas fit/zoom/reset/tidy-up buttons. [Verified —
docs.n8n.io/build/keyboard-shortcuts]

**Node-RED** — `Ctrl+=` / `Ctrl+-` zoom, `Ctrl+0` reset, footer zoom buttons,
and a **"view navigator" minimap**: "a scaled down view of the entire
workspace, highlighting the area currently visible"; drag inside it to jump.
[Verified — nodered.org/docs/user-guide/editor/workspace/]

**Obsidian graph view** — drag to pan (or arrow keys, `Shift` to
accelerate), scroll wheel or `+`/`-` to zoom. Forces exposed as settings:
"Center force" (pull toward center — note: this is Rhizomorph's root-mass
physics as a user-facing knob), "Repel force", "Link force", "Link distance".
Display: "Text fade threshold" (labels fade with zoom level), "Node size",
"Animate" (chronological time-lapse). Filters include an **"Orphans" toggle**
— disconnected notes are first-class, filterable citizens. [Verified —
obsidian.md/help/plugins/graph]

**d3-zoom** — default gestures: wheel zoom, drag pan, touch pinch,
double-click/double-tap zoom (removable via `.on("dblclick.zoom", null)`).
`scaleBy`/`scaleTo` default their focal point `p` to viewport center — pass
the pointer to get zoom-to-cursor. Transform is the matrix
`[k 0 tx / 0 k ty / 0 0 1]`. Programmatic transitions:
`selection.transition().duration(750).call(zoom.transform, …)` using
`interpolateZoom`. No built-in inertia appears anywhere in the API docs
(tldraw's `slideCamera` is the ready-made reference if we want drift).
[Verified — d3js.org/d3-zoom]

## Lifecycle / disconnection: prior art

- **CI graphs keep completed nodes attached.** GitHub Actions renders "a
  real-time graph that illustrates the run progress"; a status icon by each
  job changes, "lines between jobs indicate dependencies" persist, and
  completed jobs stay clickable for logs. Retirement = restyle, never
  removal. [Verified — docs.github.com "Using the visualization graph"]
- **Obsidian treats disconnection as a filter state** ("Orphans" toggle) and
  fades labels by zoom — precedent for retired lanes staying findable rather
  than deleted. [Verified — obsidian.md/help/plugins/graph]
- **Force-graph node removal has a canonical mechanism:** re-join
  nodes/links data with a key function, give the exit selection a transition
  (fade/shrink) before `.remove()`, update `simulation.nodes()`/links, then
  `simulation.alpha(1).restart()` so the survivors re-settle. The re-settle
  wobble is the visual signal that the network has changed. [Verified —
  observablehq.com/@d3/modifying-a-force-directed-graph; corroborating gists]
- **No tool found does "detach and drift away" (gravity-well/falling-off).**
  Nothing in Figma, n8n, Node-RED, Obsidian, GitHub Actions, or the xyflow
  docs retires nodes by severing their edge and letting physics carry them
  off. [Consensus — absence across every primary source in this note; absence
  is hard to prove, so treat as "no prior art found," not "none exists"]
- **Recommended synthesis** (design suggestion, not a sourced claim): staged
  retirement — (1) status restyle on COMPLETE, (2) brief severance animation
  on the link (the cord visibly cut = exit transition on the link before
  removing it from the sim), (3) lane drifts outward as the center force no
  longer applies, then fades/culls, (4) retired lanes remain reachable via a
  toggle or tray (Obsidian-orphans / CI-log pattern) so "done" never means
  "unauditable."

## Pitfalls (what NOT to do)

- **Scroll hijack:** bare-wheel zoom is only acceptable when the canvas is
  the whole app; embedded canvases must gate zoom behind Ctrl/pinch so page
  scroll survives. React Flow's `preventScrolling: true` default assumes the
  app-canvas case. [Verified — reactflow API ref] Gating on `ctrlKey` also
  captures trackpad pinch for free: "zooming actions fire wheel events with
  ctrlKey set to true." [Verified — MDN wheel_event]
- **Zoom without a focal point:** d3's scale methods default to viewport
  center; zoom that ignores the cursor feels broken. Always keep the point
  under the cursor fixed. [Verified default — d3-zoom docs; norm —
  Consensus: Mappedin blog, tigerabrodi blog, excalidraw #5515]
- **Drag/click-select conflict:** if background-drag pans and lanes are
  clickable, you need either a pixel drag-threshold or the React Flow split
  (drag = select, Space/middle-mouse = pan). Excalidraw's years-long
  discussion #5515 is the cautionary tale of shipping only one mode.
  [Verified — reactflow viewport docs; Consensus — excalidraw discussion]
- **Trackpad vs mouse is undetectable:** "The events emitted when using a
  trackpad do not differ from a mouse" — don't build heuristics on it; pick
  behavior per modifier, not per device. macOS momentum keeps emitting wheel
  events after release, breaking naive gesture-end detection. [Thin —
  Mappedin engineering blog, single traced source, but consistent with MDN's
  device-agnostic wheel model]
- **Wheel listeners must be non-passive to `preventDefault()`** (MDN: if not
  canceled, browser scroll/zoom proceeds; `passive: true` makes cancel
  impossible). Chrome makes window/document wheel listeners passive by
  default, so attach the handler to the canvas element with
  `{ passive: false }`. [Verified — MDN wheel_event; Chrome-default claim
  Consensus]
- **Touch traps:** set `touch-action: none` on the canvas or pinch/drag
  fight browser pan-zoom and edge back-swipe (Google Maps' left-swipe pan
  colliding with back-navigation is the classic example). [Consensus —
  Mappedin blog; standard PointerEvents guidance]
- **Double-click-to-zoom conflicts with node interaction** — d3 binds it by
  default; disable (`.on("dblclick.zoom", null)`) if double-click ever means
  "open lane." [Verified that it's a default — d3-zoom docs; conflict is
  design inference]

## Open questions

- Inertia: is momentum panning worth it for a monitoring view, or does it
  fight the "live sim already moves" aesthetic? tldraw `slideCamera` is the
  reference implementation if yes. Untested here.
- Does zoom-to-fit fight a *live* force layout (bounds change every tick)?
  Likely needs debounced or on-demand fit, not continuous. No prior art found
  for fit-to-moving-content; needs a spike.
- Minimap: is one warranted at Rhizomorph's node counts (~tens of lanes)?
  Node-RED/React Flow ship one for large flows; below ~50 visible items the
  fit-shortcut + recenter button may cover it. Judgment call, not sourced.
- Culling payoff at our scale is unmeasured — profile before building the
  R-tree; tldraw's is for thousands of shapes.

## Sources (all accessed 2026-08-01)

- https://d3js.org/d3-zoom — d3-zoom API (gestures, canvas transform, extents, interpolateZoom)
- https://reactflow.dev/learn/concepts/the-viewport — defaults + Figma-like preset
- https://reactflow.dev/api-reference/react-flow — prop defaults
- https://reactflow.dev/api-reference/components/minimap — MiniMap defaults
- https://tldraw.dev/sdk-features/camera — TLCameraOptions, zoomToFit, slideCamera
- https://tldraw.dev/sdk-features/culling — getCulledShapes, R-tree
- https://help.figma.com/hc/en-us/articles/1500004414582-Pan-and-zoom-in-FigJam — FigJam gestures, Recenter
- https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard — Shift+1 etc.
- https://docs.n8n.io/build/keyboard-shortcuts — n8n canvas shortcuts
- https://nodered.org/docs/user-guide/editor/workspace/ — zoom shortcuts, view navigator
- https://obsidian.md/help/plugins/graph — graph view forces, Orphans, fade
- https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/using-the-visualization-graph — CI run graph semantics
- https://observablehq.com/@d3/modifying-a-force-directed-graph — node add/remove pattern
- https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event — ctrlKey pinch, cancelable/passive
- https://www.mappedin.com/resources/blog/why-panning-and-zooming-in-a-web-app-cant-be-perfect/ — trackpad/momentum pitfalls [Thin]
- https://github.com/excalidraw/excalidraw/discussions/5515 — pan/zoom mode-conflict cautionary tale
- https://tigerabrodi.blog/how-to-handle-trackpad-pinch-to-zoom-vs-two-finger-scroll-in-javascript-canvas-apps — ctrlKey-gated zoom pattern

## Verdict

Adopt: d3-zoom on the existing canvas 2D (transform + extents + animated
fit), the Figma/n8n gesture bundle with wheel=pan and Ctrl/pinch=zoom, `1` /
`Shift+1` fit + `0` reset + auto-appearing Recenter, and staged lane
retirement (restyle → link-severance exit transition → drift + fade → orphan
toggle). Defer: minimap and culling until lane counts demand them. The
disconnection animation has no prior art — budget it as a design spike, not a
copy job.
