# prd14 — the experiment console

> **Outcome:** blessed 2026-08-06, partially landed — the console ships; the remaining waves do not. See `docs/roadmap.md`.

**Status:** BLESSED 2026-08-06 (four rulings below).
**Predecessor:** prd12 (the laboratory — engine, constitution, checkpoints).

## Direction

The laboratory engine exists, is gated green, and is **invisible**.
`packages/server/src/lab/` can checkpoint a moment, fork a lane from it, run the
arms, restore, and compare; `packages/core/src/events/lab.ts` carries its
events. There is no `packages/web/src/lab/` and no lab route. #148 and #153
built an engine nothing can reach.

prd14 builds the part a human uses. In one sentence, the thing the console must
make possible:

> *"Take this lane, back it up to twenty minutes ago, and try three different
> approaches from that point. Show me how they went — honestly."*

**Structure, ruled 2026-08-04:** the lab is a **separate tab** from the
observatory, on the existing hand-rolled router
(`packages/web/src/app/router.ts`, mounted in `App.tsx` — verified; it is *not*
in `lane-page/`). A tab per constitutional hand makes the read-only/write
boundary visible in the UI instead of leaving it a documentation claim.

The dashboard-IA spike's "sprawl starts with the second overview" warning does
not bite here: it forbids a second view of *the same data*. The lab is a
different **mode** — a different hand. What *would* make it sprawl is the lab
tab re-rendering live fleet state. It must show forked realities and nothing
else, and that is a law below.

---

## Success

> *Proposed 2026-08-06 as part of adopting the PRD standard; **not** blessed with
> the four rulings below, which were ruled 2026-08-06 on their own terms.*

The operator can, from the browser and without touching the CLI, take a running
lane, restore it to a checkpoint twenty minutes old, dispatch three arms from
that point, and read back a comparison that reports **spread across runs, never a
single point** — with the estimate shown and confirmed before any money is spent.

Not met while the engine is reachable only from `rhizomorph lab`.

## Ruling 1 — the branching picture: new layout, shared primitives

The observatory's scene is a growth metaphor: strands off a root mass, aging,
decay, return. That is a story about **one** timeline. An experiment is one
moment splitting into several parallel realities, and the garden vocabulary
cannot say that honestly — "withering" means something else on an abandoned arm
than it does on a finished lane.

**The lab gets its own layout grammar, built on the observatory's existing
rendering primitives.** A trunk running to a fork point, then arms diverging:

```
        ┌──── arm A ──────▶
        │
──trunk─┼──── arm B ──────▶
   ▲    │
   │    └──── arm C ──▶ (dead)
fork point
```

- **Reuse, do not fork:** canvas 2D rendering, the palette, the retire/aging
  machinery, the frame-budget discipline and its measurement tests.
- **New:** the layout grammar only. No second renderer, no new hue, no new
  motion class, no `@grafana/ui` (React 18 peer against our 19).
- An arm that was abandoned reads as **dead**, distinctly from a lane that
  finished. Death and completion are different facts.

Deliberately given up: a single unified picture of live work and forked work.
They are different modes and get different pictures.

## Ruling 2 — free-form arms; the *reporting* carries the rigour

**Amended 2026-08-06, same session.** This ruling was first blessed as "one knob
per experiment" and the operator immediately challenged it. The challenge was
right and the original was wrong; the reasoning is kept here because it is the
substance of the ruling.

**The error:** the console was designed as a *comparison* tool. But the thing an
operator reaches for most is *"try three approaches from this checkpoint and see
how they go"* — that is **exploration**, not comparison. Forcing one knob made
the common case awkward in order to serve the rigorous case.

**The ruling:** each arm is configured **independently** — its own model, its own
brief, freely.

```
arm A  opus    brief X
arm B  sonnet  brief Y
arm C  opus    brief Y
```

The constraint moves out of the launcher and into the results surface, which
**tells the truth about what it can conclude**:

- Arms differing in **exactly one** dimension → compared properly, spread shown,
  the full ruling 3 treatment. (Above: A vs C differ in model only.)
- Arms differing in **more than one** → shown side by side, with an explicit
  voice naming why: *"these arms differ in model and brief, so a difference
  cannot be attributed to either."* (Above: A vs B.)

**Why this is better than either extreme:** a confounded comparison is not
prevented by refusing to run it — it is prevented by refusing to *draw a
conclusion from it*. Putting the guardrail in the launcher blocked legitimate
exploration; putting it in the reporting blocks only the false inference. This is
the same discipline the rest of the instrument already follows: report
uncertainty precisely rather than imply knowledge.

The dimensions that differ are **computed from the arms**, not declared by the
operator — a declared intent can be wrong, the configuration cannot.

Considered and declined: free-form with no guardrail at all (never comparing).
It is simpler, but it throws away a valid conclusion in the cleanly-controlled
case, which is the case worth being rigorous about.

## Ruling 3 — runs and spread, never a point; saved as an artifact

Inherits prd12 ruling 4 and makes it concrete.

```
arm A (opus)   n=4
  ●  ●   ●    ●     spread ├──┤
arm B (sonnet) n=4
   ● ●●  ●          spread ├─┤
arm C (haiku)  n=2
  ● ●   — too few runs to summarise
```

- Every **individual run** is shown. Always.
- **Spread** across runs is shown — never a single collapsed number standing in
  for an arm.
- **Below n≥3 an arm shows its runs and no summary at all**, and says why in
  words. Not a greyed-out number; an explicit voice.
- **No winner, no leading marker, no ranking.** Considered and declined: a
  "leading" flag reads as a verdict the moment it is screenshotted, and a
  verdict is exactly what this data cannot support.
- A finished comparison **saves as a reopenable artifact** and inherits prd16's
  recording machinery — it can be reopened later and put in front of someone.

## Ruling 4 — estimate and confirm before spending

Forking n arms multiplies real spend by roughly n.

```
Launch 3 arms × 2 runs from 14:22?

  est. spend  ~$4.80
  (based on this lane's recent rate)

     [ cancel ]   [ launch ]
```

- The estimate is derived from **the forked lane's own recent rate**, and says
  so. An estimate presented without its basis is a guess wearing a suit.
- One confirmation. Launching an expensive experiment is always deliberate.
- **A fork's spend is real spend and says so** (prd12 ruling 3) — it appears in
  the ledger as spend, never hidden or discounted as "just an experiment".
- Considered and declined for now: a hard spend cap. A ceiling that stops arms
  mid-flight produces partial data, and partial data would need its own honesty
  voice in the comparison surface. Revisit once the console is real.

---

## Inherited constraints — already test-enforced, non-negotiable

- **prd12 ruling 1 — the observer stays absolutely read-only.** The lab writes
  only under `refs/rhizomorph/*`, its own worktrees, and artifacts outside the
  watched repo. `packages/server/src/lab/namespace-law.test.ts` polices this and
  stays green. A UI button is an explicit human invocation and is permitted;
  **no background process of the observer may invoke the lab.**
- **prd12 ruling 3 — forks render as visibly synthetic everywhere**, with
  lineage as a verifiable prefix commitment into the record's hash chain.
- **prd12 ruling 2 — checkpoints are captured live, never synthesized.**
- **The lab tab shows forked realities only.** A law test asserts the lab
  surface renders no live fleet state — the same shape as #206's
  `no-live-fleet-law.test.ts`.
- Frame budget 16.67 ms, measured under matched load, attributed honestly
  (scene vs swarm) — the #157 lesson.

## Wave plan

1. **The seam and the route** — lab tab on the existing router, server routes
   over `packages/server/src/lab/*` (routes, not new engine code), empty state
   that names what the lab is for. The no-live-fleet law lands here.
2. **Launch** — checkpoint selection, one-knob arm configuration, the
   estimate-and-confirm dialog, spend into the ledger as real spend.
3. **The branching layout** — ruling 1's grammar on the shared primitives, with
   its own frame-budget measurement test and dead-vs-finished distinction.
4. **Comparison** — ruling 3's surface and the saved artifact, reusing prd16's
   recording machinery.

Lab events extend `packages/core/src/events/lab.ts` **additively** — prd17's
lenient-parse and `upcast()` chokepoint apply, so an old recording containing
lab events from an earlier era still reads.

## Open, not ruled

- Whether the checkpoint timeline scrubs the *whole instrument* back to a moment
  or only the lab's own view. Deferred to wave 1's eyeball.
- Free-form per-arm variation (ruling 2's deliberate deferral).
- Hard spend cap (ruling 4's deliberate deferral).
- **#205 fold-order remains UNRULED** and the lab must not assume a resolution.
