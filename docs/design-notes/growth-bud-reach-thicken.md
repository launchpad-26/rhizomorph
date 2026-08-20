# Growth is a class: bud → reach (→ thicken) — prd-33 ruling 9, first half

Landed 2026-08-21 (the professionalisation loop, loop 2). Cited from
`scene/motion.ts`'s `GROWTH` block, `geometry/layout.ts`'s truncation, and the
mark layer's growth-awareness in `marks/{thread,node,root}.ts`.

## What this replaces

Grow-in was one line — `truncate(full, easeOut(growth))` over 900 ms — outside
every motion class, ungated under reduced motion, and invisible to the mark
layer: the lens, tail, label and widths were full-size from frame one, and the
mass did nothing at a birth while it swelled at a landing. prd-33's own problem
statement: *"a new thread pops into existence at full length and stretches;
nothing grows."*

## The choreography

One scalar still drives everything (the registry's map shape never changed);
`growthEnvelope(progress)` in `motion.ts` turns it into the stages, so a pinned
clock is a still image at a known stage and the whole thing is table-testable:

- **Bud (0–350 ms)** — the mass swells at the exit bearing (`emergence:`
  falloffs in `rootFalloffs`, struck over the bud, melting through the reach,
  radius ≤ `swellMax 0.18` — strictly under the arrival swell's 0.26). The
  spine is a nub: ≤ 8% of its final curve.
- **Reach (350–1750 ms)** — tip-led extension along the *final* curve (the
  spine's shape never depends on growth — that is what keeps the future
  living-spine cache lawful). The growth cone — the apical tuft, brighter
  early — rides the truncated tip for any growing lane; the 9b glow stays
  scoped to working tips.
- **Arrive (the reach's last 20%)** — the lens, tail and label scale in.
  Before the window opens, a growing lane has no terminal furniture at all.
- **Envelopes** — width runs `youngWidth 0.55 → 1` and ink alpha
  `warmFloor 0.6 → 1` across the reach. Width is the LOCKED work-size
  channel, so the envelope may only ever *understate* — and every multiplier
  is **exactly 1 at rest**, which is what lets the entire existing suite stand
  as the convergence proof (a settled fleet is byte-identical to one that
  never grew; `marks.test.ts` also states it directly).

## The class

`MotionClass` gains `'growth'`. Deliberately **no concurrency cap on growth
itself**: a queued retire briefly delays a true fact; a queued birth hides an
existing lane — a lie about the fleet. The budget is amplitude and cost:
`swellMax` bounds each bulge, and `maxSwells 8` bounds only the mass-field
cost — past it a bud grows on schedule without its individual swell. The four
older budgets are asserted byte-identical in `motion.test.ts`.

Allowance rows: `full` = FULL; `reduced` = NO_MOVEMENT — the thread appears at
full length and encoded width immediately and **warms in**, carrying "new
lane" on WCAG 2.3.3's own excluded channels (this also closed an existing
gap: grow-in travel previously animated under reduced motion, ungated);
`paused` = FULL, by structural's own argument — a half-grown thread is a
topology that does not exist, so it settles and then stops
(`useFrameLoop` already kept growth on the real clock for exactly this).

`SETTLE_MS` is now the class's own budget (350 + 1400 = 1750 ms), kept as a
literal in `geometry/scale.ts` because importing `motion.ts` there is an init
cycle (motion → geometry barrel → scale); `motion.test.ts` ties the sum to the
constant so the two cannot drift. `--duration-settle` moved with it.

## Deferred, deliberately

- **Thicken while alive** (the ruling's third verb) — the next loop: drawn
  width low-passing toward encoded width as work accumulates, with its own
  `thickenTau`/`maxRatePerS` numbers and the typed `'work'` cause.
- **Typed growth causes** — deferred with thicken: until a second cause
  genuinely exists, a one-value enum is ceremony. (Germination already
  differs where it matters — the seat, in `geometry/ring.ts`.)
- **The living-spine cache** — the perf loop's, with the measurement that
  justifies it; the shape-is-never-a-function-of-growth invariant this
  choreography keeps is what makes it possible.
- The exact numbers are operator-tunable on the Germination Bench spike; the
  defaults above are the bench's own openers, adopted for the unmonitored
  loop and journaled as such.
