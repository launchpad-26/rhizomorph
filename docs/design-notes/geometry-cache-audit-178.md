# The layout-cache audit (#178, measured by #175's `perf.test.ts`)

`packages/web/src/scene/geometry.ts` — `ThreadSpine`, `retiredSpineCache`, the
`world` signature, `hideable`/`settled` gating in `layoutScene`.

## The finding

#178 was the audit's P2 scene finding: laying out a lane — the waypoints, the
centripetal Catmull-Rom fit, the release deformation, the filaments grown off
it — is the whole expensive half of `layoutScene`, and a settled retired lane
was paying that cost every frame for a picture that never changes. prd10
ruling 14 ("a completed strand stays visible as a thin, still, luminous
filament") makes stillness a law, not just an optimization opportunity: once a
lane's return is over, calling `layoutSpine` again can only ever reproduce the
same points. `heart.ts` caches the mass's own growth rings on the same
argument, on a different clock (a landing's roster instead of the world
frame).

## Hide-finished had to skip layout, not just painting

The toggle originally worked by having `persistentMarks` refuse to paint a
settled lane — but `layoutScene` had already built its spine, released it and
sampled its filaments before that check ever ran, so hiding a lane bought
nothing. Fixed by skipping layout itself (`EMPTY_PATH`/`EMPTY_FILAMENTS`) for
any hideable lane: `rim` is the only position such a lane gets, and every mark
builder that touches a retired thread checks `cut.hidden` before touching
`path` or `node` (`marks/thread.ts`, `marks/node.ts`, `marks/dissolve.ts`), so
an unbuilt spine is exactly as invisible as an unpainted one.

## Why `settled` is gated on `dissolve >= 1`, not `stage === 'persistent'`

`retire.ts`'s dissolve outlives the three-stage settle by design, so a lane
can already be `persistent` for a second or more while its motes are still
visibly travelling home. Past `dissolve >= 1` (`returnAt`'s literal terminal
state), `tension`/`withdraw`/`drift`/`stilled` are pinned at 1 for the rest of
the session — which is what makes `layoutSpine`'s output a pure function of
the world frame from that point on, even though a fresh `cut` object (a new
`elapsedMs`) still arrives every frame.

## What belongs in the `world` signature, and what doesn't

`world` is everything *outside a single lane* that a cached spine is a
function of — get this wrong and either a stale spine survives a change that
should have invalidated it, or every lane's cache is invalidated needlessly
every frame:

- `width`/`height` — catch a resize (they set `centre`, `rx`, `ry`).
- `rootRadius` — catches the mass growing as *other* lanes land (#118); a
  settled lane's `root` point is measured off it forever.
- `spacing` — catches a new dispatch re-spacing the ring.

A lane's own `angle`/`bundleAngle` move with `spacing` too, but are folded
into the *per-lane* cache key instead, since they differ lane to lane. The
sideways wander's amplitude depends on `spacing` but not on angle, so it needs
`spacing` in the world term even though angle is already covered elsewhere.
Almost nothing about the lane's own `cut` belongs in either key: `tension`,
`withdraw` and `stilled` are pinned by the time a lane is cacheable, but
`drift` is the one field that still varies at the settled boundary (reduced
motion's `SETTLED_IN_PLACE` reaches `dissolve >= 1` exactly as a normal return
does, but pins `drift` at 0 instead of 1 — the swap-in-place that keeps a
cut's node from travelling at all), so it is the one field of `cut` folded
into the per-lane key.

## The living extension (professionalisation loop 14)

The growth choreography's note deferred "the living-spine cache — with the
measurement that justifies it". The measurement, on the dev box, 160 lanes:

| model-side cost, per frame     | before  | after (warm) |
| ------------------------------ | ------- | ------------ |
| `layoutScene`                  | 1.33ms  | (in warm)    |
| `sceneMarks`                   | 16.7ms  | (in warm)    |
| — of which `threadMarks`       | 9.75ms  | —            |
| layout + marks together        | ~18.1ms | **7.7ms**    |
| same, at the 20-lane demo      | ~3.8ms  | **2.2ms**    |

And the fact that makes it lawful: at rest, a living spine differs from the
previous frame by at most **0.0004px** (the lifecycle creep in `lifeFrac`,
via `rim`), reaching 0.12px only after five seconds. Nothing else in a living
spine is a function of the raw clock — the wander is seeded, the variation is
seeded, and the bud (which IS on the clock) was pulled out of `layoutSpine`
so it is recomputed fresh on the cached path every frame.

So: `livingSpineCache`, one slot per lane, keyed by every real input (world
signature, angles, `sizeFrac`, `growth`, travel gate, variation seed, the cut
stage fields) plus the clock bucketed by `LIFECYCLE_TICK_MS` (1s — a ≤0.024px
step, forty times under a pixel). Within a tick the first computation wins and
every later frame reuses its arrays byte-for-byte; any real change (a growth
step, a thicken step, a cut stage, a resize, a handle appearing) changes the
key and rebuilds that lane alone. At a pinned clock every distinct instant a
test asserts recomputes exactly, which is why the whole existing suite —
choreography, parity, geometry pins — passed unchanged.

Downstream, `ribbon.ts` gained the marks-stage half: `ribbonOutline` caches
per spine-identity (a WeakMap, the same key `PERSIST_RIBBON_CACHE` uses) with
a digest of every other input `getStroke`'s output is a function of.
`modulate` is deliberately absent from the digest — a spine identity belongs
to one lane and a lane's width jitter is seeded, so the same spine can never
arrive with a different modulation; both `modulate` call sites were audited
time-free before landing.

Laws in `scene/livingCache.test.ts`: identity stability inside a tick,
sub-0.05px steps across one, honest invalidation on a growth step, cached
values byte-equal to a fresh build, the bud never cached, and the outline
cache's identity/value contract.
