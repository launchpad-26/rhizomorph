You are a worker agent building The Rhizomorph (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #81 (81. The scene: mycelium pulse-network, ice-neon, rebuilt clean (rulings 21–23, 29; grafts g2, g3, g6, g7))

## Direction

The load-bearing rebuild. Direction C won the spike round — **improve what
the spike developed; no straight rip; clean, intuitive, beautiful**
(operator's words, ruling 28). Canvas 2D, no three.js (remove the
`three`/`@react-three/*` dependencies from `packages/web/package.json`).

**Anatomy** (C's, refined): main as the **root-mass** (its resting glow =
the conductor's own burn; an un-instrumented conductor keeps the gap
honest — dimmer, with the gap voice elsewhere owning the words). Lanes as
**threads** rim→node, tapered like hyphae, width = output tokens
(log-scaled vs busiest). **Recency = distance from the root-mass** (C's
highest-ranked idea) — BUT angular position per lane is **stable for the
session** (g7, pinned by test: same lanes, same angles, any event order).
Neighbours bundle off the rim. Subagent threads = second-growth filaments
off the parent thread; strand count = request volume, honestly NOT a
subagent count (C's honesty note stands until the log names threads).

**Flow — every pulse IS an event** (ruling 32, law): commits are packets
of light running home (arrival flare = the journey's end, size from file
count); landings are a bigger packet + brighter surge; `llm.usage` motes
drift outward root→tip, coalescing into thread glow past the in-flight
cap; `tool.activity` is a tick at the tip; `pane.activity` and `llm.cost`
move clocks, light nothing. **History never pulses** — the keystone's
news-vs-history tag is your gate. If nothing is happening, the network is
still; stillness is information.

**The five pathologies** (scene contract, ruling 21 — encodings are C's,
improved): LOOPING = knot + orbiting pulse advancing one notch per real
tool call; FROZEN = thread gone dark, dashed, two magenta-red cut strokes,
hollow node; WAITING = held amber pulse breathing at the node + raised
hand, thread stays lit (throb blessed, ruling 32); EXPENSIVE = white-hot
thread + cyan rising chevrons — white is luminance ceiling, not a fifth
hue — **and it must never outshine a summons (g6): staged fixture asserts
the needs-you lane wins the salience comparison**; OFF-FENCE = barbed
rogue filament through a dashed amber fence arc at the victim's node
(manifest-driven only; without `/api/lanes` the pathology is declared
unavailable, never guessed).

**Salience:** spotlight, not shouting — at NEEDS-YOU+ the worst lane keeps
100%, everything else drops to ~30%; alarm sigils are exempt from every
fade, recency or salience (g2). FROZEN-vs-WAITING stay separated on three
axes minimum (dark/light, broken/continuous, cut/raised) — keep C's test.

**The settle (g3):** a new lane's thread GROWS IN on
`worktree.discovered` — event-lawful, sized to feel grown not teleported.
Make it deterministic under test (fake clock), the reason B cut it.

**Register:** ice-neon (ruling 29) — the calm world in cold blue-white /
near-black-blue luminance from theme tokens; saturated cyan = NOTICE only;
pulses colourless light. Cyber-sigilist stroke quality (ruling 23):
tapered filled polygons, thorn-curl terminals, marks that read as
language, no literal creature. Root-mass breath ±small is the ONE ambient
motion; `prefers-reduced-motion` → standing brightness gradients for
travel, static dot + raised hand for waiting, breath off (C's shipped
behaviour, keep it).

**Render everything, always** (ruling 22): all lanes threaded, all
subagents filamented, at any count — the 20-lane fixture proves it. Label
placement must respect the recorded re-rule trigger (ruling 31): if you
must retreat, labels-on-hover past a threshold, NEVER hidden lanes — but
at 20, all labels render.

Improve on: branch `spike-c-mycelium` → `packages/web/src/spike/scene/`
(geometry, pulses, render, palette rationale) — read it, then build it
cleaner: real module seams, deterministic pulse scheduling under test,
no dead code, comments only where a law constrains the code.

## Fence (may touch ONLY)

- `packages/web/src/scene/**` (full rewrite; delete what the old scene no longer needs)
- `packages/web/package.json` (dependency removal only — lockfile hygiene handled at landing)

## Blocked by

#75. **Model:** opus. **Wave:** 2.

## Definition of done

- Tests (deterministic, fake clocks): pointability (stable angles); the
  five pathologies found-and-rendered from the staged fixture; expensive
  never outshines a summons (salience comparison asserted); history-never-
  pulses (replay burst produces zero pulses); coalescing cap; settle
  grow-in fires once per discovery; reduced-motion swaps.
- No three.js in the bundle; `npm ls three` fails in packages/web.
- Scene renders all three fixtures via keys 1/2/3; verified in your
  summary with what you looked at.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
