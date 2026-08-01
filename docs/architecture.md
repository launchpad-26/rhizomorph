# Architecture — The Observatory

> **Living document.** Blessed by Lachlan 2026-07-30 before any code. Real
> decisions made during the build get appended, not rewritten.

## Platform

- Node 22, TypeScript strict mode.
- npm-workspaces monorepo:
  - `packages/core` — event schema + pure logic (reducer, selectors)
  - `packages/server` — collectors + API + CLI
  - `packages/web` — Vite + React + Tailwind 4 + react-three-fiber
- Vitest everywhere.
- Exact versions are pinned at scaffold time (issue #1) and recorded here by
  the scaffold worker, not remembered.

## The one structural decision that matters: event-sourced core

Every fact is an event in one append-only log; every consumer reads the same
stream. `packages/core` owns the event envelope and types — zod schemas,
runtime-validated at the collector boundary, inferred TS types everywhere
else:

```ts
{ id, ts, source: 'git' | 'tmux' | 'workmux' | 'system', type, payload }
```

v0 event types:

- **git:** `worktree.discovered/removed` · `branch.updated` (head moved) ·
  `commit.landed` (message, author, diffstat, files) · `worktree.dirty`
  (uncommitted changed-file set — what makes collision warnings *early*,
  before commits exist)
- **tmux:** `pane.discovered/closed` · `pane.activity` (content-hash delta
  per poll)
- **workmux:** `agent.status` (working/waiting/done)
- **system:** `session.started` · `collector.error/disabled`

`core` also owns the **`Collector` interface**, so collectors and the server
loop build against the same contract without touching each other's files.

## Collectors emit raw facts only

Flatline, collisions, "ahead of main" — all *derived* downstream by pure
selectors in `core`, shared by server and web. Collectors stay dumb and
testable; the interesting logic lives where the dense unit tests are; the
same selectors serve live view and replay identically.

## Collector shape

Each collector is `poll(prevSnapshot) → { nextSnapshot, events[] }` — pure
logic over the *output text* of shell commands (`git worktree list
--porcelain`, `git diff --name-status`, `tmux capture-pane`, `workmux
status`), with a thin exec wrapper. Unit tests run the pure part against
captured fixture outputs — no git/tmux needed to test. Poll every 2s; emit
only diffs (snapshot comparison, no tick spam). A missing binary (no workmux,
no tmux) → one `collector.disabled` event; everything else keeps working.

## The log lives outside the watched repo

`~/.local/share/observatory/<repo-slug>/session-<ts>.jsonl`. The read-only
promise means we don't even add a gitignored directory to the target repo.

## Server

Fastify:

- `GET /api/stream` — SSE: replays the session so far from offset, then
  live-tails.
- `GET /api/sessions`, `GET /api/sessions/:id/events` — history for replay.
- `GET /api/meta` — repo name, session info.
- `GET /api/lanes` — the lane manifest (see below).
- Serves the built web app statically — one origin, no CORS.

### Lane manifest (prd3 ruling 19)

The conductor's dispatch tooling writes `<repo>/.swarm/lanes.json` on every
dispatch wave — one lane per worker, its handle, its branch, and the fence
globs it may touch:

```json
{
  "version": 1,
  "lanes": [
    {
      "handle": "77-attention-strip",
      "branch": "77-attention-strip",
      "fence": ["packages/web/src/panels/attention/**"],
      "issue": "77",
      "model": "sonnet",
      "dispatchedAt": "2026-07-31T20:30:00Z"
    },
    {
      "handle": "60-shelved-idea",
      "branch": "60-shelved-idea",
      "fence": ["packages/web/src/panels/shelved/**"],
      "parked": true
    }
  ]
}
```

`handle`, `branch`, and `fence` (a string array) are required per lane;
`issue`, `model`, and `dispatchedAt` are dispatch metadata the Observatory
doesn't need for its own derivation. `parked` (boolean, prd4 ruling 5) is the
one optional field the Observatory *does* read: an operator's own declaration
that a lane is parked, absent meaning `false`. It is written only by
whatever wrote `.swarm/lanes.json` in the first place — this read-only
instrument never sets it — and it is not dispatch metadata like the rest:
`buildFleet` (`packages/web/src/fleet/buildFleet.ts`) uses it to exempt a
parked lane from the FROZEN and inferred-WAITING alarms and to keep it off
the ladder, while leaving every other fact about the lane (its output, its
age, its fence compliance) exactly as true as it would be unparked — parked
is a visible, dimmed `PARKED` state in the fleet table, never a mute. `GET
/api/lanes`
(`packages/server/src/api/lanes.ts`) reads and validates this file against
the watched repo root — the server's existing target-repo context, not a new
flag — fresh on every request; the file is tiny and changes at every
dispatch, so caching would only risk staleness for no gain. Downstream, "where
is this agent" is derived by comparing an agent's recently-touched files
against its lane's fence globs — off-fence detection falls out of this one
data addition with no other new collector.

The response is never a silent empty list. A missing file is an honest,
expected state before the first dispatch:
`{ "available": false, "reason": "no lane manifest — dispatch has not written .swarm/lanes.json" }`.
A present-but-unparseable-or-invalid file is a loud degradation carrying the
parse or schema detail: `{ "available": false, "reason": "<detail>" }`. Only a
structurally valid file serves `{ "available": true, "version": 1, "lanes": [...] }`.
This is exactly the shape the web gap voice (ruling 12) consumes. `observatory
doctor` reuses the same read/validate path for a `lane-manifest` check, in the
existing three-state vocabulary (#73): present-and-valid is `ok`; absent and
present-but-broken are both `warn` (an optional capability, not something the
app needs to run) distinguished only by message.

CLI entry `observatory [path]` boots collectors + server, prints the URL.

## Web

One SSE hook feeds one reducer (imported from `core`) into React context —
no state library (one tree, one store). **Live and replay are the same
reducer**: live folds the stream as it arrives; replay folds a history slice
under a scrubber clock. That one property is why replay is free.

Panels are sibling directories (`panels/attention`, `panels/burn`,
`panels/fleet`, `panels/ledger`, `panels/collisions`, `panels/feed`, plus
`drawer/` and `replay/` outside the panel hierarchy proper), each consuming
selectors — or, since prd3, the derived fleet object below — only. The shell
pre-creates lazy-loaded slots and stub directories for every panel, so panel
workers only ever edit their own directory — that is the file-disjointness
that let multiple agents build multiple panels simultaneously, in both prd1
and prd3's fenced waves.

## The scene

react-three-fiber, lazy-loaded behind an error boundary, consuming the same
selectors — no bespoke data path. If it breaks, the panel grid stands alone;
the demo survives.

## The instrument (prd3)

prd3 (`docs/prd3.md`) is the "beautiful instrument" design pass, rebuilt in
fenced waves (issues #75–#86) after a same-day spike round chose **Direction
C — Mycelium Pulse-Network** ([ruling 28](prd3.md)) over the two other spike
builds. What follows is the shape it took in code; ruling numbers are cited
so the wording here can be checked against the rulings that required it.

### The derived fleet object — one object, four surfaces

`buildFleet` (`packages/web/src/fleet/buildFleet.ts`) is the single function
the attention strip, fleet table, burn strip, and scene all read — and read
*only*, never re-deriving their own count of "how many lanes are working" or
their own collision total. Its own doc comment states the reason directly:
four surfaces each re-deriving the same fact would eventually disagree by
one, in public, on the one screen whose job is to be trusted at a glance.

`buildFleet(state, { now, manifest, windowMs })` takes core's `SessionState`
plus the optional lane manifest (below) and returns a `Fleet`: `{ now, root,
lanes, ladder, rank, burn, collisions, gaps, hasLaneManifest, eventCount }`.
Every field is built from core selectors that already exist
(`selectSessionSpend`, `selectLaneSpend`, `selectRoleSpend`,
`selectWorktreeViews`, `selectTouchesByBranch`, `selectCollisions`, …) — the
fleet object composes and diagnoses, it does not re-sum.

**The ladder floor is structural, not remembered ([graft g5](prd3.md)).** The
`Ladder` type is a discriminated union: the calm branch's evidence type pins
`collisions` to the literal `0`, so "ALL CLEAR beside a nonzero collision
count" has no value that type-checks — `buildFleet.test.ts` asserts this with
a `@ts-expect-error` on the calm branch's evidence field. `buildLadder` folds
every collision into a ladder item *before* deciding calm vs. non-calm, so the
floor lives in the derivation the view reads, never in a rule the view has to
remember to apply.

**The `ageMs`/`workAgeMs` split.** Both spikes shared a bug where a pane's own
heartbeat (its content-hash repaint) kept a WAITING inference permanently
"alive," because liveness and work were read off the same clock. The keystone
(#75) fixed it with a test by splitting the clock in two:

- `ageMs` — time since the newest fact of *any* kind about a lane, pane
  repaints included. **FROZEN** reads this: total silence, including the
  pane, is what FROZEN means.
- `workAgeMs` — time since the newest sign the agent was actually *working*;
  pane activity is deliberately excluded from it. **WAITING** reads this
  (plus a separately-fresh pane signal): the inference is "stopped working
  while its terminal kept moving," so a pane repaint must never be allowed to
  refresh the very silence being measured. `diagnose()` enforces the two are
  mutually exclusive per lane (`buildFleet.test.ts`: "never calls the same
  silence both frozen and waiting").

### The glyph alphabet — two scales, one alphabet

`packages/web/src/fleet/sigils.tsx` is "the glyph alphabet" ([ruling
23](prd3.md)'s cyber-sigilist register): every pathology/state mark is
authored once, in a unit square, as `Path2D` code, then drawn at two named
scales — `SIGIL_ROW_SIZE = 15` (the fleet table's row) and `SIGIL_SCENE_SIZE
= 64` (the scene's node). Same code, same silhouette, just more room for the
curl at the larger size. Because the fleet table draws the identical glyph the
scene does, [graft g1](prd3.md) falls out for free: **the table is the
scene's legend** — a reader who has learned to name a pathology in the table
already knows what it looks like in the scene, with no separate key to teach.
Two laws are encoded alongside the marks themselves: hue is severity, form is
kind ([graft g4](prd3.md)), and color is never the sole carrier of a state
([law 9](prd3.md)) — FROZEN and WAITING, for instance, are built to differ on
shape and fill as well as hue.

### The pulse-as-event laws

`packages/web/src/scene/pulses.ts` (`PulseField`) is where the scene's motion
lives, and it is built directly against [ruling 32](prd3.md)'s three adopted
rules, each with its own enforcing test:

1. **History never pulses.** The field only ever ingests through
   `takeNews()`, which reads the stream's `news`/`newsCount` slice — a replay
   fold of the past has nothing there, so scrubbing never lights a pulse for
   an event that already happened (`pulses.test.ts`, "rule 1 — history never
   pulses").
2. **Traffic is coalesced, never invented.** A burst of `llm.usage` events
   spawns at most a capped number of light-motes per lane per request; any
   surplus tokens accumulate into a lane's `coalesced` count instead of being
   dropped silently or spawning one mote per token (`pulses.test.ts`, "rule 2
   — traffic is coalesced, never invented").
3. **An arrival flare is the end of a real journey.** The field's surge
   level rises only when a homeward-bound pulse's life ends at its
   destination, never at spawn — an arrival is something that traveled, not
   something the field decided to celebrate (`pulses.test.ts`, "rule 3 — an
   arrival flare is the end of a real journey").

These three rules are why the scene can be read honestly during MODE (replay
mid-scrub reads as "the past," never as fresh activity) and why a busy fleet's
scene never turns into uncapped light spam.

### Lane geography and the manifest (prd3 ruling 19)

The wire contract — `.swarm/lanes.json`, served at `GET /api/lanes` — is
specified once, under [Server](#lane-manifest-prd3-ruling-19) above; this is
where the web side of that contract is reconciled, not re-specified.
`packages/web/src/fleet/fences.ts` owns the consumer: `parseLaneManifest`
turns whatever `/api/lanes` served into a `LaneManifest` (`handle →
LaneFence`), or `null` on anything malformed — a fence is an accusation, so a
half-parsed manifest (fencing some lanes, silently un-fencing others) is
treated as no manifest at all, never a best effort.

**The `lanes` field is canonically an array** (`{ lanes: [{ handle, fence,
... }, ...] }` — the shape `.swarm/lanes.json` and dispatch actually produce),
**not an object keyed by handle.** `parseLaneManifest` folds array entries
into its internal handle-keyed map itself; it also still accepts a bare
object or an object-keyed `{ lanes: {...} }` envelope, so a shape decision on
either side of the wire doesn't strand the other. #91 fixed a period where the
array shape was rejected outright — a live manifest read as absent even
though both the server and the consumer's own tests were green, because the
consumer's test had hand-rolled an object-shaped approximation of the payload
instead of copying the real one. The regression test
(`packages/web/src/fleet/fences.test.ts`) now pins the exact envelope
`packages/server/src/api/lanes.test.ts` asserts the server serves, so the two
sides of the contract can't drift apart silently again.

Off-fence detection is the one thing this data addition buys: a lane's
recently-touched files (`selectTouchesByBranch`) are matched against its own
fence, and a match against *someone else's* fence instead is a trespass with
a named victim (`findTrespasses`) — no new collector, per ruling 19.

**Parked is a state, not a mute (prd4 ruling 5).** A `LaneFence` may carry an
optional `parked: true`, operator-declared and never written back by this
read-only instrument. `parseLaneManifest` carries it through unchanged
(absent, or anything other than the literal `true`, reads as not-parked —
the same soft fallback `issue`/`model` get, rather than the flat-refusal
treatment a malformed `fence` gets, since a bad `parked` only ever softens
an accusation). `buildFleet` reads it onto `Lane.parked` and gives it three
consequences, all in `packages/web/src/fleet/buildFleet.ts`: `detectFrozen`
and the inferred half of `detectWaiting` exempt a parked lane by
construction, alongside the exemptions those detectors already had; a
parked lane never reaches `buildLadder`'s attention list, however many
pathologies it still carries; and the fleet table
(`packages/web/src/panels/fleet/index.tsx`) renders a dimmed `PARKED` in
the STATE column in place of the usual glyph and word, while every other
cell — output, age, cost, fence compliance — keeps reading the lane's real
telemetry untouched. Parked mutes the alarm, never the evidence.

*Two gaps this change leaves for a follow-up, both outside its own fence:*
`packages/server/src/api/lanes.ts`'s `laneSchema` is a `zod` object with no
`.passthrough()`, so a live `.swarm/lanes.json` carrying `parked` has it
silently stripped before `GET /api/lanes` ever serves it — the schema needs
its own `parked: z.boolean().optional()` for a real dispatch (as opposed to
a fixture, which hands `buildFleet` a manifest directly) to carry the field
at all. And the scene has no visual language for "parked" of its own: it
reads `Lane.activity`, whose `Record<LaneActivity, …>` maps
(`scene/palette.ts`'s `ACTIVITY_HUE`/`ACTIVITY_TINT`, `sigils.tsx`'s
`ACTIVITY_TEXT_CLASS`) are exhaustive and outside this change's fence, so
`parked` was deliberately kept off the `LaneActivity` union rather than
adding a member those maps don't yet have a key for. See issue #96.

### Recent panel landings

Three more prd3 waves are worth naming here since they complete the panel
list the sections above assume:

- **The lane drawer (#84)** — `packages/web/src/drawer/`, opened by clicking
  any fleet row. Vitals on top (reusing the fleet table's own cell
  formatters, so the drawer can't disagree with the row that opened it),
  an activity view as the default reading, an expandable live-tailing
  transcript below it (`GET /api/transcript/:lane`,
  `packages/server/src/api/transcript.ts`), and an ATTACH button that copies
  a `tmux`/`workmux` command to the clipboard and never executes anything —
  enforced structurally by `packages/web/src/drawer/readonly.test.ts`, which
  greps the drawer's own source for any exec/spawn/websocket/HTTP-mutation
  capability and asserts none exists.
- **Panel focus (#85)** — `usePanelFocus` (`packages/web/src/app/panelPrefs.ts`)
  lets any `PanelFrame` fill the view; **Esc** restores it, but only once
  nothing is selected — `escapeShouldExitFocus(selectedId)` returns `true`
  only when `selectedId === null`, so a lane drawer left open consumes the
  keystroke first. This is shell-level precedence, not a per-panel decision:
  the drawer's own global `Escape` handler (`fleet/selection.tsx`) and the
  focus hook are two independent listeners ordered by that one predicate,
  proven by `panelPrefs.test.ts`'s "escapeShouldExitFocus (ruling 6 — Esc
  precedence)" cases.
- **Replay's mode shift (#83)** — per [ruling 16](prd3.md), replay is a full
  frame change, not a tinted live view: `Shell.tsx`'s top dock renders either
  the attention strip or a `ReplayBanner` (`packages/web/src/replay/Banner.tsx`),
  never both, so a live summons can never be read off a recording. The banner
  states the mode in words ("viewing a recorded past — not the live fleet"),
  not color — an ice-register frame/tint only, deliberately avoiding every
  ladder hue (law 9), since a mode is not a status.

## Testing

Mass on core selectors/reducers and collector parsers (fixtures captured
from real command output). Light render tests on panels. The scene is
verified by eyes, not units — said honestly. Merge gate: `npm test` +
`npm run typecheck` green, enforced mechanically by a workmux `pre_merge`
hook.

## Decisions log

- 2026-07-30 — zod at the collector boundary: runtime validation costs a
  dependency but makes bad parser output loud instead of silent. (Blessed.)
- 2026-07-30 — session logs outside the repo: purist read-only, slightly
  less discoverable. (Blessed.)
- 2026-07-30 — Tailwind 4 for panels: daily fluency, faster worker output,
  one more scaffold dep. (Blessed.)
- 2026-07-30 — Collector loading must be static, not dynamic: a variable
  dynamic import (`../collectors/${slug}/index.js`) can't be statically
  analysed by Vite/Rollup, so every collector silently failed to load while
  the server booted happily and emitted only `session.started`. Collectors
  are now imported explicitly. (issue #14)
- 2026-07-30 — SSE frames are named, and the client must subscribe by name:
  the server writes `event: <type>`, but a client using only `onmessage`
  receives every frame and drops it — `onmessage` fires only for unnamed
  frames. Both packages were green in isolation because the web test double
  called `onmessage` directly instead of imitating the real wire format; test
  doubles must match the real protocol, not the convenient one. (issue #17)
- 2026-07-30 — Panels must distinguish "connected but idle" from "not
  connected": otherwise the dashboard's own empty state is indistinguishable
  from the failure it exists to reveal. (issue #18)
- 2026-07-30 — Source files must be plain UTF-8: one stray NUL byte made
  `selectors/collisions.ts` binary to git — undiffable and unmergeable —
  while it still compiled and passed tests.
- 2026-07-30 — Fences must cover every file a change can orphan: core
  removed the scaffold's placeholder export as part of landing the real
  event schema, but the server's and web's still-scaffolded entry points
  imported it and sat outside core's fence, so the root gate would have gone
  red for every branch at once. The export was kept alive, deprecated, until
  the files that depended on it were replaced by their own issues.
- 2026-07-30 — prd1: `role` (`worker | conductor | auxiliary`,
  `agentRoleSchema` in `packages/core/src/events/telemetry.ts`) is attributed
  at the collector boundary, never guessed from a lane name. A conductor
  commonsensically doesn't run inside a workmux-managed worktree, so nothing
  about its lane name would ever say "conductor" — the only sources of truth
  are the OTel dispatch's own `role=<role>` resource attribute and the
  hardcoded `role: conductor` the `sessionlog` collector applies to every
  session under `--extra-sessions`.
- 2026-07-30 — prd1: the orchestration overhead ratio (conductor tokens ÷
  worker tokens) is a first-class selector (`selectRoleSpend` /
  `selectOverheadRatio`, `packages/core/src/selectors/spend.ts`), not a
  downstream derivation, because orchestrated setups undercount by omitting
  the conductor's own spend — plausibly the largest single consumer in this
  build day. `overhead()` returns `null`, never `0`, unless both conductor
  and worker tokens are measured and non-zero, so a conductor that hasn't
  sent telemetry yet reads as "unknown," not "free."
- 2026-07-30 — prd1: two telemetry collectors by design, not redundancy.
  `otel` (`packages/server/src/collectors/otel`) is the sole source of
  authoritative `cost_usd` — real dollars, no pricing table; the one unrun
  claim from `research/2026-07-30-telemetry-capture-routes.md`
  (`OTEL_RESOURCE_ATTRIBUTES` lane tagging) was proven live in issue #36.
  `sessionlog` tails `~/.claude/projects/*/*.jsonl` for free structural
  attribution and per-message cache-tier token depth OTel's own metrics never
  break out, but is documented "No dollars" (`packages/core/src/events/
  telemetry.ts`) rather than estimate them from a pricing table. Either
  degrades to `collector.disabled` alone; together they cross-validate.
- 2026-07-30 — prd1: `user.email` rides along on Claude Code's own OTel
  resource attributes by default (per the research spike), and there is no
  explicit redaction step that strips it. Instead the otel collector's event
  builders (`buildUsageEvent` / `buildCostEvent`,
  `packages/server/src/collectors/otel/parse-metrics.ts`) only read a fixed
  allowlist of attributes by name off the wire payload, so `user.email` is
  structurally never copied into a stored event — allowlist-by-construction,
  not scrub-after-the-fact. Verified by test, not merely assumed from the
  code's shape (`parse-metrics.test.ts`: "never copies user.email … into the
  stored payload").
- 2026-07-30 — prd1 (issue #47): **design for the correctly-configured case;
  surface incomplete configuration as a gap, never as a second-class metric.**
  The spend ticker previously rendered `OVERHEAD 0.14×` from the token-based
  `overheadRatio` in `selectRoleSpend` (`packages/core/src/selectors/
  spend.ts`, unchanged by this issue and still correct for what it measures)
  while the actual conductor had sent zero `llm.cost` events — the ratio came
  from `sessionlog --extra-sessions` tagging an unrelated probe session
  `role: conductor`, tokens with no dollars attached. That number was worse
  than absent: it looked like a real measurement of orchestration overhead
  and was not one. `SpendPanel` (`packages/web/src/panels/spend/`) now
  computes its own cost-only overhead (`selectCostOverhead`/
  `formatCostOverhead`, `packages/web/src/panels/spend/format.ts`) straight
  from `RoleSpend.costUsd`/`costEventCount` — fields `selectRoleSpend` already
  exposed — and renders `conductor not instrumented — see docs/telemetry.md`
  whenever `conductor.costEventCount === 0`, regardless of what its tokens
  say. **Rejected alternative:** keeping the token-based ratio alive as a
  fallback so historical, un-instrumented sessions (this project's own build
  day) would still produce a number. Rejected because that fallback fits one
  accident of this project's own history — a conductor that was, in fact,
  never wired for cost — onto every future user's un-instrumented setup,
  training them to read a token ratio as a dollar figure. Cost is the one
  metric; provenance (`authoritative` vs. estimated) is shown on it; a gap in
  it is shown as a gap.

## Platform — pinned versions (issue #1, 2026-07-30)

| Package | Version |
| --- | --- |
| node (engine) | 22 |
| typescript | 7.0.2 |
| vitest | 4.1.10 |
| zod | 4.4.3 |
| fastify | 5.10.0 |
| vite | 8.1.5 |
| @vitejs/plugin-react | 6.0.4 |
| react | 19.2.8 |
| react-dom | 19.2.8 |
| @types/react | 19.2.17 |
| @types/react-dom | 19.2.3 |
| tailwindcss | 4.3.3 |
| @tailwindcss/vite | 4.3.3 |
| @react-three/fiber | 9.6.1 |
| @react-three/drei | 10.7.7 |
| three | 0.185.1 |
| @types/three | 0.185.1 |
| jsdom | 30.0.1 |
| @testing-library/react | 16.3.2 |
| @testing-library/jest-dom | 7.0.0 |
| tsx | 4.23.1 |
| @types/node | 22.20.1 |

- 2026-07-31 — **prd1 (the money layer) complete.** Two native collectors
  shipped: `sessionlog` (depth — per-message tokens by tier, tool timeline,
  lane attribution from cwd/branch) and `otel` (authority — an OTLP/HTTP
  receiver yielding `costUsd` with `authoritative: true`). Spend is keyed by
  **branch**, so a lane's cost survives the worktree's removal. `role`
  (worker | conductor | auxiliary) is first-class; the overhead ratio is
  defined on cost. `--extra-sessions <dir>[:<lane>]` is **dir-first** — the
  session-log directory is the input, no slug inference, no platform
  assumption — which is what makes a conductor on another OS countable.
  Verified live end to end: 4,989 `role: conductor` events from a Windows-side
  conductor's log dir, per-lane dollars in the ticker and worktree table, the
  per-branch ledger, and replay reporting `$0.02 as of scrub time` through the
  same reducer as the live view.
- 2026-07-31 — prd3 (issue #75, the keystone): **`ageMs` and `workAgeMs` are
  two different clocks, not one.** Both prd3 spikes independently shipped the
  same bug: a WAITING inference read a lane's liveness age, so a pane's own
  heartbeat (its content-hash repaint) kept refreshing the very silence the
  inference was measuring, and a genuinely stuck-and-waiting lane never
  tripped it. `ageMs` (time since any fact at all, pane repaints included) is
  what FROZEN reads, because total silence — pane included — is what FROZEN
  means; `workAgeMs` (time since the newest sign of actual work, pane
  activity excluded on purpose) is what WAITING reads, because "stopped
  working while the terminal kept moving" is the whole shape of that
  inference. `buildFleet.ts`'s `diagnose()` keeps the two mutually exclusive
  per lane, proven by test ("never calls the same silence both frozen and
  waiting"). See [The instrument (prd3)](#the-instrument-prd3) above for
  where this lives in code.
- 2026-07-31 — prd3 (issue #75): **the ladder floor (ALL CLEAR structurally
  incapable of coexisting with a nonzero collision count) lives in
  `buildFleet`, not the view** ([graft g5](prd3.md)). The calm branch of the
  `Ladder` union types its evidence's `collisions` field as the literal `0`,
  so the disallowed state has no representable value rather than being a
  convention a view author has to remember to check.
- 2026-08-01 — prd3 (issue #91): fixed `parseLaneManifest` rejecting the
  live `/api/lanes` payload outright, because `.swarm/lanes.json`'s `lanes`
  field is **canonically an array** of entries (one per lane, each carrying
  its own `handle`) and the parser only accepted an object keyed by handle —
  a live manifest read as absent even though both the server and the
  consumer's own test suites were green, because the consumer's test had
  hand-rolled an object-shaped approximation of the wire payload instead of
  copying the real one. Both shapes are accepted now; see [Lane geography and
  the manifest](#lane-geography-and-the-manifest-prd3-ruling-19) above for
  the reconciled contract, and the regression test that closes the gap by
  pinning the exact server-side payload rather than an approximation of it.
- 2026-08-01 — prd3 (issue #88): **`buildFleet` folds `llm.cost` events on an
  unfiltered role split, separately from the token-origin-filtered split its
  overhead ratio uses.** `otel` is the only collector that ever emits
  `llm.cost` (sessionlog carries no dollars), so gating "is the conductor
  instrumented at all" on the same token-origin allowlist used to dedup
  token aggregation meant a real conductor cost feed always read as `CONDUCTOR
  NOT INSTRUMENTED`. Any surface describing cost provenance describes it
  through `Fleet.burn.conductorInstrumented` and the fleet object generally —
  never a separate re-derivation off raw events, for the same one-object-four-
  surfaces reason the fleet object exists at all.
- 2026-08-01 — prd3 waves 3–4 landed: the **lane drawer** (#84 — vitals,
  activity, live-tailing transcript, an ATTACH button that copies a
  `tmux`/`workmux` command and never executes it), **panel focus** (#85 —
  any panel fills the view; Esc restores it, yielding to an open lane drawer
  first per shell-level precedence), and **replay's mode shift** (#83 — the
  attention strip and the REPLAY banner are mutually exclusive in the shell,
  never stacked). Documented in full under [The instrument
  (prd3)](#the-instrument-prd3) above.

