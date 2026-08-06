# Architecture — The Rhizomorph

> **Living document.** Blessed by Lachlan 2026-07-30 before any code. Real
> decisions made during the build get appended, not rewritten.

## Platform

- Node 22, TypeScript strict mode.
- npm-workspaces monorepo:
  - `packages/core` — event schema + pure logic (reducer, selectors)
  - `packages/server` — collectors + API + CLI
  - `packages/web` — Vite + React + Tailwind 4; the scene is hand-rolled
    canvas 2D, no 3D library (prd7 ruling 1)
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

`~/.local/share/rhizomorph/<repo-slug>/session-<ts>.jsonl`. The read-only
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
`issue`, `model`, and `dispatchedAt` are dispatch metadata the Rhizomorph
doesn't need for its own derivation. `parked` (boolean, prd4 ruling 5) is the
one optional field the Rhizomorph *does* read: an operator's own declaration
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
This is exactly the shape the web gap voice (ruling 12) consumes. `rhizomorph
doctor` reuses the same read/validate path for a `lane-manifest` check, in the
existing three-state vocabulary (#73): present-and-valid is `ok`; absent and
present-but-broken are both `warn` (an optional capability, not something the
app needs to run) distinguished only by message.

CLI entry `rhizomorph [path]` boots collectors + server, prints the URL.

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

A hand-rolled canvas 2D painter, lazy-loaded behind an error boundary,
consuming the same selectors — no bespoke data path. If it breaks, the panel
grid stands alone; the demo survives. **This was originally scaffolded on
react-three-fiber; prd7 ruling 1 confirmed canvas 2D over WebGL by
measurement** (a live profile found the running scene already locked to
60fps with zero `shadowBlur` calls — "janky" was the form language, not the
renderer) **and the dependency is gone from the tree.** See [prd7 — procedural
form](#prd7--procedural-form) below.

## The instrument (prd3)

prd3 (`docs/prds/prd3.md`) is the "beautiful instrument" design pass, rebuilt in
fenced waves (issues #75–#86) after a same-day spike round chose **Direction
C — Mycelium Pulse-Network** ([ruling 28](prds/prd3.md)) over the two other spike
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

**The ladder floor is structural, not remembered ([graft g5](prds/prd3.md)).** The
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
23](prds/prd3.md)'s cyber-sigilist register): every pathology/state mark is
authored once, in a unit square, as `Path2D` code, then drawn at two named
scales — `SIGIL_ROW_SIZE = 15` (the fleet table's row) and `SIGIL_SCENE_SIZE
= 64` (the scene's node). Same code, same silhouette, just more room for the
curl at the larger size. Because the fleet table draws the identical glyph the
scene does, [graft g1](prds/prd3.md) falls out for free: **the table is the
scene's legend** — a reader who has learned to name a pathology in the table
already knows what it looks like in the scene, with no separate key to teach.
Two laws are encoded alongside the marks themselves: hue is severity, form is
kind ([graft g4](prds/prd3.md)), and color is never the sole carrier of a state
([law 9](prds/prd3.md)) — FROZEN and WAITING, for instance, are built to differ on
shape and fill as well as hue.

### The pulse-as-event laws

`packages/web/src/scene/pulses.ts` (`PulseField`) is where the scene's motion
lives, and it is built directly against [ruling 32](prds/prd3.md)'s three adopted
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
  formatters, so the drawer can't disagree with the row that opened it), an
  activity view as the default reading, an expandable live-tailing
  transcript below it (`GET /api/transcript/:lane`,
  `packages/server/src/api/transcript.ts`), and an ATTACH button that copies
  a `tmux`/`workmux` command to the clipboard and never executes anything —
  enforced structurally by `packages/web/src/drawer/readonly.test.ts`, which
  greps the drawer's own source for any exec/spawn/websocket/HTTP-mutation
  capability and asserts none exists. **The "activity view as the default
  reading" half of this is superseded by prd4 #94** — see [The layman bar
  (prd4)](#the-layman-bar-prd4) below; the transcript endpoint and the
  ATTACH button, described here, are unchanged.
- **Panel focus (#85)** — `usePanelFocus` (`packages/web/src/app/panelPrefs.ts`)
  lets any `PanelFrame` fill the view; **Esc** restores it, but only once
  nothing is selected — `escapeShouldExitFocus(selectedId)` returns `true`
  only when `selectedId === null`, so a lane drawer left open consumes the
  keystroke first. This is shell-level precedence, not a per-panel decision:
  the drawer's own global `Escape` handler (`fleet/selection.tsx`) and the
  focus hook are two independent listeners ordered by that one predicate,
  proven by `panelPrefs.test.ts`'s "escapeShouldExitFocus (ruling 6 — Esc
  precedence)" cases.
- **Replay's mode shift (#83)** — per [ruling 16](prds/prd3.md), replay is a full
  frame change, not a tinted live view: `Shell.tsx`'s top dock renders either
  the attention strip or a `ReplayBanner` (`packages/web/src/replay/Banner.tsx`),
  never both, so a live summons can never be read off a recording. The banner
  states the mode in words ("viewing a recorded past — not the live fleet"),
  not color — an ice-register frame/tint only, deliberately avoiding every
  ladder hue (law 9), since a mode is not a status.

## The layman bar (prd4)

prd4 (`docs/prds/prd4.md`) is the operator-review pass that followed prd3: the
instrument worked but read as built for the person who already knew what
every mark meant, and ruling 1 (a standing ruling) re-aims every surface at a
first-time viewer instead. Issues #92–#96 landed it in fenced waves — #92
(the palette keystone) and #94 (the conversation drawer) in parallel, then
#93 (the scene-centerpiece layout) and #95 (parked) once #92 landed, then
this docs pass (#96). What follows is the shape it took in code.

### Law 9a/9b — hue is meaning, brightness is attention

prd3's law 9 ("color is never the sole carrier of a state") is unchanged,
but prd4 ruling 3 splits what it forbade in two, because the old rule had
quietly grown into "the calm world carries no hue at all," which is what
the operator's "too dark, too pale" complaint was actually describing:

- **Law 9a — hue is meaning, and each hue means one thing.** Six hues, one
  vocabulary, for every state in the app: green is productive, amber is
  blocked on a human, red is dead, cyan is a notice, ice is structure and
  nothing-to-say. The activity states and the alarm rungs are no longer two
  separate palettes — they're one scale read at two brightnesses. `WORKING`
  and `DONE` are the same green, dim and bright; `WAITING_BENIGN` and
  `NEEDS_YOU` are the same amber. `packages/web/src/scene/palette.ts` is the
  one chokepoint this is enforced at: `ACTIVITY_HUE` (a `Record<LaneActivity,
  Rgb>`) is the only place a lane's activity becomes a colour, so `marks/`
  and `sigils.tsx` never name a hue of their own — they ask the chokepoint.
  Re-aiming the whole scene at a new semantic map is therefore an edit to one
  record, not a sweep through five files. Hue distance between adjacent
  states is measured in OKLCH in `palette.test.ts`, not HSL — HSL put `done`
  and `notice` 29° apart, close enough to pass a "these must differ" test on
  a pair no eye actually confuses.
- **Law 9b — the brightness band and alarm grammar own attention, not hue
  exclusivity.** A calm mark may wear its family's hue at a healthy
  brightness now; what it may never do is reach the luminance band alarms
  own, wear a glow, or wear a cartouche. `packages/web/src/scene/salience.ts`
  is where the band is enforced, arithmetically, against real fixtures
  rather than tuned by eye:
  - `CALM_CEILING = 0.78` — the luminance ceiling every non-alarm mark is
    held under (`spend()`'s `capLuminance`). Raised from prd3's `0.70`
    because the calm world now carries hue as well as lightness, and the
    old ceiling read as murky once it did.
  - `ALARM_FLOOR = 0.84` — the luminance floor a needs-you lane's brightest
    mark must clear, so a summons is always the single brightest thing on
    the page. **`BROKEN` is exempt.** `#ff3d68` pushed to `0.84` is two-thirds
    of the way to white — pink, not dead. A frozen lane instead buys its
    dominance the three other ways the grammar allows: it takes the
    spotlight (every other lane recedes to `RECEDE = 0.3` around it), it is
    the only mark wearing a cartouche, and it is exempt from every fade —
    `marks.test.ts` pins this as dominance-under-recession rather than as a
    raw brightness number.
  - `CALM_FLOOR = 0.15` — the floor under a *living* lane's thread on a calm
    fleet, pinning the regression the operator's review opened with (an
    alpha floor of `0.22` read as "too dark and pale to read"). Checked by
    sweeping `activityInk`'s alpha ramp across every activity and every
    freshness/heat the twenty-lane fixture produces
    (`marks.test.ts`), not just the values that fixture happens to hit. A
    frozen lane's thread is deliberately *below* this floor — absence of
    light is what FROZEN encodes, so the pin only ever applies to a *living*
    thread.

  These four numbers (`RECEDE`, `CALM_CEILING`, `ALARM_FLOOR`, `CALM_FLOOR`)
  are the whole contrast budget, and none of them is a tuning knob left to
  taste: each is pinned by a test against a real fixture, because a
  brightness you can only re-find by looking at the screen is a brightness
  that drifts dark again.

**The fleet table teaches the palette, not just the glyphs.**
`stateTextClass(rank, activity)` (`packages/web/src/fleet/sigils.tsx`) is
the panel-side twin of `activityInk`: a rung above calm wins outright (full
rung colour is alarm grammar, law 9b — a looping lane must not be softened
into green by also, technically, being "working"), and below that the
activity's own hue speaks. Since the STATE column already drew the scene's
own glyph at row scale (prd3's graft g1), it now draws the scene's own hue
there too — a reader learns "green means getting on with it" beside the
plain-English word, then reads the scene's picture with no separate legend.

### The scene as centerpiece (#93, ruling 2)

`packages/web/src/app/PanelGrid.tsx` is the panel registry and the one file
that knows the curated order; prd4 reorders it so the scene renders first,
directly beneath the attention/burn dock, hero-sized (`min-h-[55vh]`-ish,
raised from a `h-64` box), with the fleet table right after it as the
legend/detail surface and the rest (ledger, collisions, feed) below that.
`Shell.tsx`'s own doc comment states the reasoning: the screen now answers
*what is the fleet doing* before *who is doing what*, because the scene is
"big, bright and self-explanatory" on the #92 palette and no longer needs
the table to make sense of it first. `SceneView`'s zero-rect mount fallback
was resized alongside it (`320×180` → `640×420`, named as a constant) since
it was tuned for the old, smaller box.

### The conversation, not the transcript (#94, ruling 4)

Two changes land this, one on each side of the wire:

- **The endpoint hands back records, not a rendered string.**
  `GET /api/transcript/:lane` (`packages/server/src/api/transcript.ts`) used
  to emit one pre-formatted `▌ assistant\n…`-style string; `parseTranscript`
  now emits `entries: TranscriptEntry[]`, each `{ ts?, role, blocks }` where
  `role` is `user | assistant | subagent | system` and a block is
  `{ kind: 'text' }`, `{ kind: 'tool_use', name, hint }`, or
  `{ kind: 'tool_result', text, dropped }`. Shipping a pre-formatted string
  forced every presentation decision — which face, how quiet, how truncated
  — into a file a stylesheet cannot reach; handing back records lets the
  client decide what a tool call *looks* like. `subagent` is the same
  `isSidechain` mapping prd3's flat renderer used to spell
  `assistant · subagent`; `system` is not a voice from the log at all — it's
  this parser saying a line was unreadable (`⟨unreadable line⟩`), the one
  thing it ever says. Tool results are truncated at
  `TOOL_RESULT_MAX_CHARS` (400) and *declare* the cut via `dropped` rather
  than silently trimming — a 2,000-line `Read` result is a legitimate
  result and a useless payload, but a reader who can't see it was cut is
  being told the tool said less than it did. Thinking blocks are still
  never emitted, unchanged from prd3.
- **The drawer's main view is the conversation, CLI-style.**
  `packages/web/src/drawer/Conversation.tsx` (renamed from `Transcript.tsx`)
  is now default-open, `flex-1`, and polls the whole time the drawer is
  open — no fold in front of it. This **supersedes prd3 #84's
  collapsed-by-default ruling**: that ruling put the activity ledger first
  on the theory that it tells you whether the transcript is worth reading,
  and the operator's review found the opposite in practice — the
  conversation *is* the reading. Section order in the drawer is now Vitals
  → Conversation → Activity → Attach. User turns render prompt-like (a `›`
  marker, the brightest ink); assistant prose renders in the page's own
  sans face rather than inside a `<pre>` (law 11) — a wall of monospace was
  the loudest "this is for machines" signal in the panel it replaces — and
  monospace is kept for figures only: tool names, hints, and results
  (`● Name — hint`, `⎿ result`). The existing `isAtTail` follow-the-tail
  behavior is unchanged: scroll up and it pauses and says `paused ▴`;
  scrolling back down resumes following.

### Parked is a state, not a mute (#95, ruling 5)

Documented in full where the wire contract lives — see [Lane geography and
the manifest](#lane-geography-and-the-manifest-prd3-ruling-19) above for the
manifest's `parked` field and its consequences in `buildFleet`/the fleet
table, and the two open gaps (`laneSchema`'s missing `.passthrough()`/schema
field, and the scene's `LaneActivity` union having no member for "parked")
that #96 (this issue) inherits rather than fixes, since both sit outside a
docs-only fence.

## prd5 — the finished application

prd5 (`docs/prds/prd5.md`) is the "sleek, well formed, beautiful application"
pass that followed prd4, set by the operator's close-out on issue #99:
"drag around the scene, completed paths should not still be connected, a
little more animation … not just a tool … production ready." Four issues
landed it in fenced waves — #100 (camera) ∥ #103 (amber aging) ∥ #104
(orientation extras) together, then #101 (motion budget) once #100 landed,
then #102 (the cord-cut) once #101 landed — followed by this docs pass
(#105). What follows is the shape it took in code, cited against prd5's
six rulings.

### The camera (#100, ruling 2)

`packages/web/src/scene/camera.ts` is pure arithmetic over a plain `{ k, x,
y }` — no canvas, no DOM, no d3-zoom import — because "zooming at the
pointer leaves the thing under the pointer where it was" and "fit frames
the whole network" are laws a test can pin in one line, and `Camera` is
structurally d3-zoom's own `ZoomTransform` so nothing has to be adapted at
the boundary. `SceneView.tsx` wires the two together: d3-zoom
(`d3-zoom`/`d3-interpolate`, ISC, probed live in
[the vehicles note](research/2026-08-01-obs-prd5-implementation-vehicles.md))
owns pointer and wheel handling and hands back a transform; `camera.ts`
owns every law about what that transform means.

- **Gestures.** Drag (left or middle button) pans; Ctrl/Cmd+wheel zooms at
  the pointer (`scaleAbout`) — trackpad pinch arrives as the same
  ctrlKey-wheel stream, so no separate pinch handler exists.
  `gestureFilter` is adapted from `@xyflow/system`'s `createFilter` (MIT):
  the allowed-button list instead of d3's `!event.button`, and a **plain
  wheel is deliberately not claimed** — the scene sits in a scrolling page,
  and a canvas that eats every wheel event is a canvas you cannot scroll
  past. `wheelDelta` keeps d3's own ctrlKey-boost logic but drops its
  user-agent sniff for macOS in favour of the thing that actually tells a
  pinch from a mouse notch: the size of the delta (`MOUSE_NOTCH_DELTA`).
  `CLICK_DISTANCE` (4px, d3-zoom's `clickDistance`, the same knob React
  Flow tunes for the same conflict) is what stops drag-to-pan from eating
  click-to-select — nobody presses a mouse button without moving it a
  pixel or two.
- **Affordances.** Keys `1` (fit), `0` (reset), `+`/`-` (step by
  `ZOOM_STEP` = 1.4), two on-canvas step buttons, a **Fit**/**Reset**
  button pair, and an auto-appearing **Recenter** button
  (`isContentVisible`, a `VISIBLE_SLIVER` = 24px floor in either axis)
  that fades in rather than mounting, so it cannot pop into view at the
  exact moment an operator's eye is elsewhere. `SCALE_EXTENT` is `[0.4,
  6]` — below 0.4 the threads go sub-pixel and every label collides;
  above 6 a ribbon is just a gradient. No minimap (deferred, ruling 1).
- **The key collision, resolved by focus.** `1` already means "switch to
  the live stream" page-wide (`StreamContext`'s fixture keys); the camera
  claims the same key but only once the scene itself has DOM focus
  (`onKeyDown` on the scene's own host div, which calls
  `stopPropagation` on every key it claims). Click the scene, or tab to
  it, and `1`/`0`/`+`/`-` mean camera; anywhere else on the page they mean
  what they already meant. `app/keyboard.ts`'s own doc comment states the
  three-way split this created across #100/#101/#104: scene-scoped camera
  keys, page-global idle-worker jump (below), and table-scoped fleet
  verbs (below) are three separate registers, not one keymap.
- **The flight home.** `flight()` uses `d3-interpolate`'s `interpolateZoom`
  (van Wijk & Nuij's smooth-zoom arc — the same arc a d3-zoom transition
  would take) but caps its suggested duration at `FIT_DURATION_MAX_MS`
  (420ms): the suggestion is proportional to arc length and comes out
  around 2.5s from a far corner, which is the right shape and the wrong
  length for something bound to a keypress. Reduced motion, a paused
  scene, and a pinned test clock all skip the flight and jump straight to
  the destination (`goTo`'s `jump` predicate).

### The motion budget, as law (#101, ruling 4)

`packages/web/src/scene/motion.ts` turns "a little more animation" into
three hard-separated, test-pinned classes — nothing in the picture may
move outside one of them:

| class | what moves | budget |
|---|---|---|
| **ambient** | root-mass breath, idle life | 4–8s period, ≤3% amplitude, unlimited |
| **event** | pulse travel, arrival flare, alarm throb | 400–600ms; flare 150ms in / 500ms out; **≤5 concurrent** |
| **structural** | a lane appearing, reflowing, disconnecting | ~800ms critically damped; ≤2 at once, 60–90ms stagger |

Two numbers are load-bearing rather than tuned: **≤3% ambient amplitude**
(calm technology's claim that a display earns the periphery only if it
can be ignored — the moment a viewer has to consciously suppress the
motion, it has failed) and **the event cap of 5** (Pylyshyn & Storm's
measured human object-tracking limit — a scene fires at most five
concurrent pulses and coalesces any surplus into one aggregate pulse
carrying a count, which is "traffic is coalesced, never invented" (prd3's
pulse law 2, `pulses.ts`) extended from traffic to motion itself).

- **The spring is hand-rolled and closed-form, not integrated.**
  `packages/web/src/scene/spring.ts` is the exact solution of the
  critically-damped case (ζ=1 only — there is no parameter to ask for
  bounce, because a structural change that recoils reads as "it failed"),
  sampled at whatever `dt` a frame actually took rather than marched
  toward with semi-implicit Euler. The reason is measured, not aesthetic:
  Euler at k=170 (this budget's stiffness) reaches −5.2e8 within twenty
  10ms-nominal steps once a frame runs long (a backgrounded tab, a GC
  pause, twenty lanes landing at once), while the closed form agrees with
  itself whether it is stepped once at 2s or as two hundred 10ms frames —
  `spring.test.ts` pins both the divergence being avoided and the
  stability being bought. `STRUCTURAL_DAMPING = criticalDamping(170) ≈
  26` is exported so the ruling's own numbers are checkable, not just
  claimed.
- **Two motion modes, not one.** `reduced` (`prefers-reduced-motion`) is
  WCAG 2.3.3's exclusion made literal: colour and opacity stay, travel and
  scale drop (`NO_MOVEMENT`). `paused` — the operator pressing the scene's
  own pause button — is WCAG 2.2.2 (Level A: any content that moves on
  its own past five seconds needs a stop, and an always-breathing canvas
  is exactly that), and it is stricter: everything freezes, brightness
  included (`FROZEN`), **except** structural motion, which is allowed to
  finish what it started (`allowance()`'s one exception) because a
  topology change frozen mid-flight would show a fleet that does not
  exist. The mechanism is one line: `SceneView.tsx`'s frame loop holds a
  `pausedAtRef` instant and feeds every mark builder that instant instead
  of the real clock, so freezing is a property of the clock every
  animation already reads from, not a flag each one has to check.
- **The alarm pulse ages** (ruling 5's scene half, `alarmPulse()`): an
  unanswered summons pulses slower and brighter the older it gets
  (`ALARM.freshPeriodMs` = 800ms down to `agedPeriodMs` = 2,600ms,
  `freshIntensity` 0.62 up to `maxIntensity` 1, over the same recency span
  the geometry already drifts nodes outward on), with the phase
  integrated over the lane's own age (a closed-form logarithm) rather than
  sampled from wall time — `sin(now / period)` jumps by hundreds of
  cycles the instant a lengthening period moves by a hair, because `now`
  is an epoch and the phase scales with it.

### The cord-cut (#102, ruling 3)

`packages/web/src/scene/retire.ts` is the Rhizomorph's own idiom for a
finished lane: every graph tool surveyed (GitHub Actions, Obsidian, React
Flow) restyles a finished node and leaves it wired in, so "is this fleet
still working" stays a colour question. This instrument disconnects the
edge instead, so the answer is structural — a lane that has landed is no
longer part of the mass, full stop.

A **staged** retirement (Heer & Robertson measured staged transitions
beating single-shot ones at exactly this job — a topology change the
viewer has to follow), three stages, one channel each, ~1.4s total:

| stage | ms | channel |
|---|---|---|
| `tension` | 150 | curvature only — the thread goes slack at the root |
| `retract` | 800 (= `STRUCTURAL.durationMs`) | position only — the freed end springs back, ζ=1, via `spring.ts`'s closed form |
| `settle` | 450 | colour only — the remnant desaturates into a scar |
| `scar` | ∞ | the resting state, drawn forever, never re-lit |

Four laws, each enforced in code rather than trusted:

1. **Never fades to nothing** (`SCAR_FLOOR` = 0.05, well under
   `CALM_FLOOR`'s 0.15 and well clear of zero) — invisible completion is
   indistinguishable from a render bug, so a scar stays on the canvas at
   reduced ink, carrying the lane's name and its output figure. The scar's
   ink is a mix of `ICE_600` (nothing-to-say) and `DONE` green at 0.18 —
   deliberately not the fully-desaturated grey the research suggested,
   because "this lane finished its work" and "the log never mentioned
   this lane" are opposite facts that must not share a colour, and
   deliberately not `NECROTIC` either, since landing is not dying (the
   prd4 done/frozen separation this would otherwise contradict).
2. **Fires once per lane, on news only.** `RetireRegistry.note()` is fed
   from the same news tail `pulses.ts` reads, so a replayed session (or a
   scrub across a landing) builds every scar and animates none of them —
   the same "history never pulses" law extended to the cut. A lane
   already retired the first time it is seen scars outright, with no
   journey; a lane the registry watched retire live animates from that
   instant; a collector re-reporting a worktree removal never re-fires
   the cut for a lane that already has one scheduled.
3. **Respects the structural cap, as a queue, not a throttle.**
   `RetireRegistry`'s `schedule()` walks forward to the first instant that
   clears both `STRUCTURAL.maxConcurrent` (2) and the 75ms stagger, so a
   wave of a dozen landings retires in pairs rather than cutting twelve
   cords at once — and every cut still happens; a lane waiting its turn
   is drawn as the living thread it still visibly is.
4. **Reduced motion swaps in place.** WCAG 2.3.3 excludes colour and
   opacity from "motion animation", so under `reduced` the cut collapses
   straight to `SETTLED_IN_PLACE` — severed and desaturated with no
   travel, read off `allowance('structural', mode).travel` rather than
   re-decided in `retire.ts`, so the whole scene degrades by the one rule
   in `motion.ts`.

`isRetired()` treats **done** (`agent.status: done`, or `worktree.removed`
— the two events that mean a lane finished) and **parked** (prd4 ruling 5)
as the same structural fact with different histories: done is a moment in
the log and gets a cut to watch; parked is a standing declaration with no
arrival event, so a parked lane scars from the first frame the manifest is
read, and un-scars the instant an operator unparks it.

**The hide-finished toggle** (`ScarControl` in `SceneView.tsx`,
`useScenePref('hideFinished')`, persisted in `app/panelPrefs.ts` beside
the other panel prefs) is the operator's own override on a default of
*visible*: scars are shown by default, and this is the only thing that
changes that. It carries its own count (`Hide finished · N` /
`Show finished · N`) even while collapsed, because a filter that hides
its own effect is a filter that quietly makes the picture a lie — the
same law 12 the gap voice answers to elsewhere. Fully hidden lanes still
count in the fleet table; the toggle only ever touches the scene.

A geometry-side fix landed after the first pass (issue #102, `fix`
commit): a scar's size initially held a fixed *fraction* of a thread's
length back from the node, which put a three-o'clock lane's scar three
times the size of a twelve-o'clock one's on the wide ellipse a landscape
panel produces. `SCAR_LENGTH_PX` now walks a fixed arc length back over
the sampled polyline instead, so every scar is the same size object, like
the sigil beside it — and the remnant keeps the whole thread's gathered
taper rather than being sliced out of it, so it reads as a wedge with its
work-size still in it rather than evaporating on the way in.

### Amber ages with the strip (#103, ruling 5)

`packages/web/src/panels/attention/ageBands.ts` pins three bands so the
chip (`AttentionStripView.tsx`) and the tab title (`useTabSignal.ts`)
can't drift onto two different ideas of "old": **quiet** (<2min, the
amber family's muted end — the same ink a benign wait already wears),
**ink** (2–10min, full needs-you brightness, no motion — where a summons
spends most of its life), and **pulse** (≥10min, a slow calm-authority
pulse layered on the full ink, with the age figure itself emphasized).
The ladder rung is still the only severity axis — `agingClass()` confines
all of this to the `needs-you` rank; `broken` (already maximal) and
`notice` (deliberately a heads-up, not a summons) never escalate or mute
regardless of age. `useTabSignal`'s title carries the oldest summons's age
too, once it crosses the same top band, so the signal survives a
backgrounded tab.

**An open seam, deliberately left rather than closed.** The chip's own
pulse animation (`attention.css`'s `attention-chip-age-pulse`, a 6,800ms
opacity breath) was landed as "a conservative literal chosen
independently of #101's motion budget (same prd, disjoint fence)" — its
own comment names `#101`'s alarm/event class constants as the thing that
"may absorb it later." #101 landed afterward and did wire an aged alarm
pulse (`motion.ts`'s `alarmPulse`, `agedPeriodMs` = 2,600ms) into the
**scene's** node and light marks (`marks/node.ts`, `marks/light.ts`), but
never touched `attention.css` — the two numbers (6,800ms vs. 2,600ms)
still disagree, and the strip's pulse duration remains its own literal.
Both readings independently satisfy ruling 5 (insistence within the rung,
never across it) and the seam is cosmetic rather than a correctness bug,
but a future pass reconciling the two durations under one motion-budget
constant, the way the scene's half already is, remains open.

### Orientation extras (#104, ruling 1+6)

`app/keyboard.ts`'s own doc comment names the three keyboard registers
this issue's split produced, so a fourth one doesn't get invented by
accident later:

- **Scene-scoped** (#100): `0`/`1`/`+`/`-`, live only while the canvas has
  focus — documented above.
- **Page-global** (#104): `n` / `Shift+n`, the SC2-style idle-worker jump.
  `useIdleWorkerJump()` cycles the shared selection through
  `needsYouLaneIds` — worst rung, then oldest, first, the same order the
  ladder already presents — via the very `select`/`jump` path a click
  already calls, so jumping opens the drawer, spotlights the scene and
  highlights the table row exactly as a click would. When there is
  nowhere to jump, the selection is left alone and the attention strip's
  own DOM region flashes once (`flashAllClear`, 220ms), rather than
  nothing visibly happening at all.
- **Table-scoped** (#104): `f` (focus the fleet panel) / `a` (copy that
  lane's `tmux`/`workmux` attach command, reusing the drawer's own
  `attachPlan`/`copyToClipboard` rather than a second copy of either), a
  k9s-style verb pair that acts on whichever lane is in hand — the DOM's
  own focused row, or the shared selection, whichever names one
  (`focusedLaneId`). A footer key hint (`n next needs-you · shift+n prev
  · f focus · a attach · esc close`) is rendered in the fleet table
  itself so the verbs are discoverable without reading this file.

All three registers share the same typing guard (`isTypingTarget`) and
ignore any keystroke held with a modifier, so a page whose single-letter
verbs hijack a text field, or steal a browser shortcut, is not a page this
issue shipped.

### Vehicles and taste (ruling 6)

No animation library was adopted — every motion in the scene is DOM/canvas
arithmetic, and the spring itself is 15 tested lines
(`spring.ts`), which is the whole of the case against reaching for one.
d3-zoom + d3-interpolate (ISC) are the one exception, adopted for the
camera's *gestures* only, proven live rather than assumed
(`docs/research/2026-08-01-obs-prd5-implementation-vehicles.md`'s headless-
on-canvas probe). `@xyflow/system` (MIT, xyflow/React Flow) was read for
its drag-vs-select `clickDistance` preset and its gesture-filter shape,
both cited in `camera.ts`'s own comments rather than vendored; tldraw was
read for prior art only — its custom license means no code from it is in
this tree. Build lanes loaded the installed `emil-design-eng` (animation
decisions) and `frontend-design` (production register) skills per the
ruling and said so in their own commit messages.

## prd6 — the living cycle

prd6 (`docs/prds/prd6.md`) followed the operator's close-out review of prd5: the
scene's *end state* read as lifeless (a scar was a dead end) and two of its
channels didn't read as intuitively as the others ("as output grows the
seeds should grow too"; "the distance from the node should mean something
more intuitive"). Two issues landed it in one wave — **#106** (the scene:
absolute sizing, lifecycle distance, the way home, root-mass growth,
germinating seeds) and **#107** (the main node: conductor transcript
resolution, the root-mass as a hit target, MAIN's own vitals) — followed by
this docs pass (**#108**). What follows is the shape it took in code,
cited against prd6's five rulings.

### Absolute seeds, and the whale problem (#106, ruling 1)

`seedSize(outputTokens)` (`packages/web/src/scene/geometry.ts`) replaced a
relative reading — `log1p(output) / log1p(maxOutput)` — that shrank every
lane's seed the moment the fleet's own busiest lane worked harder, so
growth (the one thing the operator asked to see) never read at all.
`seedSize` never looks at another lane: it logs a lane's own output between
two *fixed* references (`SEED_TOKENS` = 1,000, `SEED_FULL_TOKENS` =
100,000 — chosen so the log does its compressing between where real lanes
actually sit, not below the first thousand tokens no lane produces),
floored at `SEED_FLOOR` (0.08, so a fresh lane is small and present rather
than invisible) and capped at `SEED_CEILING` (1 — "nothing balloons" as a
number, not a hope).

**This overrules #102's "a scar is a mark, so it is the same size for every
lane."** `scarLengthPx(sizeFrac)` (still in px of arc length, keeping
#102's aspect-ratio fix) now scales between `SCAR_LENGTH_MIN_PX` (22) and
`SCAR_LENGTH_MAX_PX` (46) by the lane's own `sizeFrac`, because the rim is
where a session's finished work is on display and a rim of nine identical
stubs has thrown away the only thing it had to say about them. A
germinated lane's `sizeFrac` is `Math.max(seedSize(lane.outputTokens),
seedSize(seedLane.outputTokens))` — floored by whatever the seed it grew
from had already accomplished, so a returning worker never starts over
from nothing.

### Distance is the lifecycle (#106, ruling 4)

`lifecycleFrac(sizeFrac, sinceFirstSeenMs, homecoming)` blends two monotone
terms — a radius that could go backwards would be a lane un-living part of
its life, which doesn't happen: work done (`seedSize`, `WORK_SHARE` = 0.65
of the blend — the dominant term, because a lane's life is measured in
what it produced) and age since first sighting (`now - lane.firstSeenAt`
over `LIFE_SPAN_MS` = 1 hour, the rest of the blend — what keeps the
journey moving between snapshots for a lane with little output yet). A
terminal pin closes whatever distance is left over the cut's own retract
(`RetireState.drift`, not the retract itself — the one place they
differ, since `drift` reads zero when the mode forbids travel, so reduced
motion's existing law — sever in place, nothing crosses the picture — falls
out for free). **This replaces prd3 graft g6's distance-as-recency**,
which needed explaining and therefore failed the layman bar; recency keeps
the channel it already shared, thread lightness (`ThreadGeometry.ageFrac`
off `RECENCY_SPAN_MS`, `thread.ts`'s `freshness`) — no fact was dropped
when the radius changed hands. Angle (graft g7) is untouched.

A same-issue fix (`fix(#106)`) caught a newborn lane rendering *inside* the
root-mass on a cramped panel: `RADIAL_BORN` (0.42) is a fraction of the
rim, and at 240×90 the rim closes in on a mass that doesn't shrink with it.
`bornRadial(rootRadius, rx, ry)` pushes the birth radius out far enough to
clear the mass, measured against the *smaller* half-axis — the direction
the rim runs closest to the mass in.

### The way home (#106, ruling 2)

`RetireGeometry.homeward` (`homewardFlow()` in `geometry.ts`) is a
`HOMEWARD_LENGTH_PX` (30px) stretch of the thread's own centreline,
travelling on the retract's own clock — the same 800ms structural stage
the cord is parting over, under the same concurrency cap, so nothing new
is animated and nothing new is budgeted. It grows out of the node when the
retract begins and is absorbed into the mass when it ends (null outside
that open interval), and is null for every scar nobody watched leave
(history, replay, reduced motion) — a journey nobody saw start didn't
happen on this screen.

`rootGirth(landedOutputTokens)` (`packages/web/src/scene/marks/root.ts`) was
originally the same two-reference, log-scaled, hard-capped discipline
`seedSize` uses (`ROOT_GROWTH.seedTokens` = 10,000, `.fullTokens` = 500,000,
`.maxGirth` = 0.3 — the mass thickened by up to 30% over a session, never
more), applied as a multiplier on top of a fixed radius. `landedTokens()`
sums `lane.outputTokens * homecoming(thread.retire)` over the **drawn**
scene rather than off `isRetired`, so the mass grows exactly as each cord
parts — a wave of a dozen landings reads as twelve arrivals over the
structural queue, never one lurch — and a scar the operator has hidden
still counts, since hiding is about clutter, not a claim the work was
undone. Both girth and halo are recomputed from state, never animated on
their own clock — the mass never *moves*, it's simply bigger the next time
you look.

**Superseded by #118** — the 30%-of-resting-size cap read as a wreath after
a long session (a ring of retired lanes around a large empty middle with a
barely-bigger blob); see "Beyond prd7 — the fold, and a mass that grows with
the scene" below for the growth law that replaced it.

### Germinating seeds (#106, ruling 3)

`germination(lanes, retire)` (`geometry.ts`) maps a living lane id to the
retired lane whose seat and size it inherits, matched on shared
`Lane.handles` rather than `Lane.id` — a re-dispatch that reuses the branch
is already the same lane to `buildFleet` and needs nothing here; the case
that needs it is the one where identity moved (new worktree, new branch)
and the handle workmux launched it under is the only thread of continuity
left. Matched only against lanes the retire *registry* has actually
scarred, not `isRetired` — a lane whose cut is still queued behind the
structural cap is visibly a living thread and is not a seed anyone can
grow out of yet. At most one sprout per seed (earliest slot first), so two
returning lanes can't claim the same ground. `layoutScene`'s `seatKey`
routes a germinated lane onto its seed's angle via the seat map, so the
ring is never re-spaced by a return — the one honest exception to graft
g7's "angle never moves," which g7 itself anticipates (a re-dispatched
handle is the same worker returning to the same ground, not a new lane
appearing).

### MAIN's own drawer (#107, ruling 5)

`MAIN_SELECTION = 'main'` (`packages/web/src/fleet/selection.tsx`) is a
**pseudo-lane**: a value the one selection slot can hold and deliberately
*not* a `Lane` in the derived fleet. Fabricating one would have been the
shorter diff and the wrong model — main is not a worker, has no fence, no
pathologies, no rung on the ladder. Keeping it out of `fleet.lanes` means
the fleet table, the ladder, and the scene's own thread list skip it by
construction: `selection.test.tsx` pins that no lane is ever built with
this id and that selecting it renders the real fleet table with none of
its rows highlighted. `isMainSelected(selectedId)` is the one predicate the
three surfaces that *do* need to know branch on — the scene (hit-tests the
mass, and `salienceOf` spotlights it for free since no lane matches the
selection), the drawer (branches to the conductor's view), and the feed
(reads "Nothing matches this filter" honestly, since no feed kind is
conductor-attributed today).

`packages/web/src/scene/SceneView.tsx` hit-tests the root-mass in the same
world coordinates `marks/root.ts` draws it in, at a tolerance divided by
the camera's own scale exactly like a lane node's — a lane still wins a
contested pixel, being the smaller, more specific target — and shows the
pointer cursor on hover, the canvas's only way to advertise a target since
it can't put one in markup.

`GET /api/transcript/main` (`packages/server/src/api/transcript.ts`,
`CONDUCTOR_LANE = 'main'`) resolves by **role**, never by name:
`findConductorAttribution` walks the event log backward for the newest
`role: 'conductor'` attribution, because `--extra-sessions <dir>:<lane>`
lets an operator call the conductor anything — a lane literally named
`conductor` proves nothing, `role: 'conductor'` proves everything. Two
different gaps get two different fixes (`conductorGap()`, the same law-12
discipline the worker lanes already had): nothing instrumented at all
names the flag to pass; telemetry with no session id attributed names
`rhizomorph doctor`.

`LaneDrawer` (`packages/web/src/drawer/index.tsx`) branches on
`isMainSelected(selectedId)` before it looks up a `Lane` at all, and
renders through the same `DrawerFrame` a lane's drawer does — same width,
same hairline, same Esc — because the conductor is another agent working
in this repo and the operator has already learned where to read one; a
second panel would have taught them a second place. `MainVitals`
(`drawer/Vitals.tsx`) reuses the burn strip's own formatters
(`formatDollarsOrGap`, `formatOverheadOrGap`, `outputHoverTitle`, …) for
its `$`/output/overhead cells rather than computing its own, so a drawer
that could disagree with the strip four inches to its left never gets
written; `root.landings` and `root.commitsHome` are the derived fleet's own
counts, not re-summed. `conductorAttachPlan` (`drawer/attach.ts`) finds the
conductor's pane by the main worktree or a window named `conductor`, and
returns `null` rather than fabricate a `workmux open main` that would
create a worktree nobody asked for — ATTACH shows the reason and the
command that puts a pane on record instead of a button that would act.

## prd7 — procedural form

prd7 (`docs/prds/prd7.md`) followed the operator's close-out review of prd6: "the
function should remain the same, that's locked in, but now that we've got the
shape of it sorted, we can make it more procedurally generated, smooth,
unique, less janky, less shapes." Research ran before any code
(`docs/research/2026-08-02-obs-prd7-*.md`) and its measurement **reframed the
prd**: a live Chrome profile of the running scene found it already locked to
60fps (180 frames, median 16.70 ms, p95 16.80 ms, one dropped frame) with
**zero `shadowBlur` calls**. "Janky" was therefore never the renderer — it
was the form language itself: stroked centre-lines, hard edges, discrete
glyph shapes. Three issues landed it, serial by necessity (the scene is one
module and each wave rewrites what the next builds on): **#112** (semantic
roles, no visual change) → **#113** (ribbons, the keystone) → **#114** (the
root-mass contour) — followed by this docs pass (**#115**). What follows is
the shape it took in code, cited against prd7's six rulings.

### Ruling 1 — a form prd, not a renderer prd (stay canvas 2D)

The profile above is the ruling's whole evidence: nothing measured pointed at
the renderer, so nothing was spent on one. WebGL was rejected on two
independent grounds rather than one, per `docs/research/2026-08-02-obs-prd7-renderer.md`:
it cures nothing measured (every named cause of canvas-2D jank — DPR, blur,
per-frame allocation — is a painter bug, not a fill-rate wall), and it costs
real coverage — `[Ran]` jsdom 27.0.1 returns `null` for `getContext('webgl')`
and `('webgl2')`, so a WebGL painter is one this suite could never execute,
where today's display list at least stays queryable under any painter. The
`shadowBlur` ban (prd3) gained a second, independent reason: MDN states its
value "is not affected by the current transformation matrix," so a glow built
on it would not scale under the prd5 camera even if its cost were free. The
display list stays plain data as a *guarded* property rather than a hope:
`marks.test.ts`'s `structuredClone` conformance test (#112) round-trips every
mark kind through the same boundary `postMessage` uses and hand-walks the
result naming the exact offending field, which is what keeps the painter
swappable if a later prd ever earns a shader layer.

### Ruling 2 — semantic roles before any visual change (#112)

The prerequisite, landed with **zero visual diff** and proved rather than
asserted: the serialized display list over 33 frames × 6,072 marks — every
fixture, every cut stage, storm, reduced motion, pause, spotlight,
no-manifest — is byte-identical with roles stripped (md5 `fe774758…`, two
runs each side). The laws in `marks.test.ts` had been pinned to shape-named
roles — `chevron ×3`, `cut ×2`, `raised-hand`, `cartouche`, `rogue-barb` — 31
assertions across 9 names, 51 usages in source, and those names *were* the
shapes ruling 3 removes next: a law written in the drawing's own vocabulary
cannot survive the drawing changing. Roles were renamed to what they mean:

| shape-named (before) | meaning-named (after) |
|---|---|
| `knot` | `looping-mark` |
| `cut` | `severed` |
| `raised-hand` | `summons` |
| `chevron` | `expensive-mark` |
| `cartouche` | `rank-enclosure` |
| `rogue` | `off-fence-reach` |
| `rogue-barb` | `off-fence-grasp` |
| `fence` | `off-fence-victim` |
| `node-seal` | `done-mark` |
| `node-thorn` | `node-tip` / `off-fence-mark` (split) |
| `filament-thorn` | `filament-tip` |

`node-thorn` was two meanings sharing one word — every node's terminal hook,
and the barb an off-fence offender wears — and splitting them is what lets
the off-fence family name all four of its parts (reach, grasp, victim, and
now the offender's own mark) instead of leaving one invisible to the laws.
Kept, deliberately, because they are meaning and not silhouette: `orbit`,
`tick`, `scar*`, `heat`, `held`, and the substance roles (`thread`, `node`,
`label`, `pulse`, `root-*`, `homeward`, `filament`). All 70 laws were
restated at equal or greater strength, none deleted — FROZEN keeps
`toHaveLength(2)`, LOOPING now asserts the circuit is *closed* (2π) rather
than merely an arc, and OFF-FENCE names all four marks on both parties where
before only one was assertable. `glyphs.ts` and `paint.ts` still name shapes
(`CARTOUCHE`, `NODE_LENS`, `THORN_OUT`) — naming the form is their job; what
no longer exists is a shape name in the channel the laws read.

### Ruling 3 — stop stroking lines, start filling ribbons (#113, the keystone)

`packages/web/src/scene/ribbon.ts` turns a spine and a width profile into
closed polygons the painter fills, built from three libraries each proven
live first (`docs/research/2026-08-02-observatory-prd7-procedural-form.md`):
**`perfect-freehand`** (MIT) builds one outline for the whole stroke with a
real rounded cap at every turn sharper than 90°, fed the encoded width as
per-point pressure with `simulatePressure: false` (its own velocity
simulation is exactly the nondeterminism this scene cannot have); **`d3-shape`'s**
centripetal Catmull-Rom (α = 0.5) smooths the spine and *interpolates* its
waypoints, so a data-meaningful position survives smoothing bit for bit
(`curveBasis` approximates and is banned here for exactly that reason); and
**`simplex-noise`** seeds the per-lane wander (ruling 4). Probed cost: a
24-point spine → an 88-point closed outline at 0.172 ms/frame for 30 ribbons,
byte-identical across repeated calls.

Six substitutions, per the ruling, **each spending zero new objects** — the
meaning moves into the form of a mark that was already being drawn:

| today | replaces | where |
|---|---|---|
| asymmetric needle taper + three tapered "licks" | the chevrons (direction/urgency) | `marks/thread.ts`'s `HEAT_TAPER`, `marks/node.ts`'s `expensiveMarks` |
| a width pinch to zero, twice | the two cut strokes (FROZEN) | `marks/thread.ts`'s `severedStops`/`severedMarks` |
| a midpoint-displaced blob behind the lane's name | the cartouche ring | `marks/node.ts`'s `enclosureMark`, `variation.ts`'s `blobRing` |
| a hue-only knot (superseded — see "Beyond prd7" below) | the seal bar (DONE) | `marks/node.ts`'s `knotMark` (removed; see `sealMark`) |
| a travelling width swell | the commit dot + its wake glows (9 objects → 2) | `marks/light.ts`'s `swellMarks` |
| ribbon length | the progress arc | nothing to do — distance has meant lifecycle since prd6 ruling 4 |

Every thread is a filled ribbon now (`threadMarks`), narrowing from
`widthRoot` at the mass to `widthTip` at the node in proportion to the same
lane's own `sizeFrac` (`geometry.ts`) — the natural taper of a hypha, and the
same absolute, capped work-size encoding prd6 ruling 1 fixed, just told as
form rather than as a constant-width stroke. Two real bugs surfaced by
building a throwaway, uncommitted software rasterizer to actually *look* at
the display list rather than infer it (`fix(#113)`, "the ribbons were
faceted under the camera"): resampling every ribbon to a constant sample
count threw away half a thread's own spine resolution, invisible at 1× but a
17px chord becoming a 100px straight edge at the prd5 camera's 6× — fixed by
defaulting to the spine's own resolution, bounded to
[`RIBBON_SAMPLES_MIN`=6, `RIBBON_SAMPLES_MAX`=48]; and the heat licks'
alternating sides read as a zigzag — a chevron by another name, quietly
undoing the substitution — fixed to splay one way on the lane's own free
curl phase. `caps: false` on sub-pixel filament strands measured 66 → 34
vertices, a 26% build saving, width unchanged to seven places.

**Cost, measured in three passes as the geometry firmed up:** an early
wall-clock assertion (4× the measured cost) flaked three times in twelve
concurrent runs — 3.6 ms measured as 17.1 ms on a loaded box — because
under `--maxWorkers=5` a timing assertion measures the machine, not the
code. It was replaced with a **ratio guard**: building the display list
costs a bounded multiple of laying the scene out, since both dilate
together under load (measured 5.4× quiescent, 5.2–5.7× across four
concurrent runs, against a bound of 10), plus a deterministic vertex cap
(`< 140` vertices/ribbon, `< 40,000` total at 30 lanes) that catches a
regression a loaded CI box would otherwise hide. The settled frame cost is
**3.265 ms/frame** for layout + display list at 30 lanes, against roughly a
4 ms allowance inside the 16.7 ms budget — one 24-sample ribbon outline
costs 10.1 µs, so thirty of them are 0.30 ms, the same order as the prd7
probe's own 0.172 ms. Bundle delta, base (#112) → landed (#113): the
lazily-loaded scene chunk went from 93,466 → 110,428 B raw (32,357 → 38,441 B
gzipped, +18.8%); the whole app grew 3.9% gzipped, entirely inside that one
lazy chunk. A rebuild against this issue's own tree (`npm run build`, run
for this docs pass) measures the scene chunk at **113.65 kB raw / 40.22 kB
gzipped** after #114's contour landed on top — the whole app **≈174.0 kB
gzipped** across every chunk.

### Ruling 4 — bounded uniqueness, seeded from identity

`packages/web/src/scene/variation.ts` is a permission system exported as
data, not a bag of jitter — `CHANNELS`, pinned by `variation.test.ts`:

| channel | carries | permission |
|---|---|---|
| position along life (radial) | the lifecycle (prd6 ruling 4) | **locked** |
| hue | state (law 9a/9b) | **locked** |
| encoded width | work size (prd6 ruling 1) | **locked**, as the baseline |
| width jitter | nothing | ±10% (`WIDTH_JITTER_MAX`), low-frequency only |
| sideways wander | nothing | ≤ 0.3× lane spacing (`WANDER_MAX_SPACING`) |
| curl phase | nothing | free |

Two properties make this safe inside a live instrument. First, **the wander
is exactly zero at both ends of a thread**: `ends(t)` returns the literal `0`
at `t = 0`/`t = 1` rather than computing it (`Math.sin(Math.PI)` is `1.2e-16`,
not zero, and "the encoded endpoints do not move" is not a claim that
survives being only approximately true), so a lane's radius, angle and
label anchor come out of the noise field bit-identical —
`geometry.test.ts` recomputes both from the fleet to prove it. Second, **the
seed is the lane's own identity, never the clock**: `variationSeed` hashes
the lexicographically-smallest of a lane's `handles` (never `Lane.id`, which
is the branch and can change on a re-dispatch) with bryc's `cyrb128` into
four 32-bit words, feeding `mulberry32` — a hash rather than a character sum
because adjacent lane names (`113-ribbons`, `114-contour`) must not produce
adjacent noise fields, verified live: `docs/research/2026-08-02-observatory-prd7-procedural-form.md`
probed the same lane id returning identical samples from a **fresh**
`simplex-noise` instance, which is the property that makes a replay recorded
on someone else's machine redraw the same picture rather than a new random
one. `blobRing` (Tyler Hobbs' midpoint-displaced watercolour subdivision,
reimplemented from his prose — his writing carries no stated licence, ruling
6) is the same seeded-noise discipline spent on the enclosure blob instead of
the wander.

### Ruling 5 — the root-mass as one surface (#114)

`packages/web/src/scene/contour.ts` replaces the root-mass's concentric
rings with a scalar field — a handful of smooth circular falloffs blended by
Inigo Quilez's polynomial `smin` and walked into closed rings by marching
squares on a ~6px-pitch grid, then softened with two Chaikin corner-cutting
passes. Two measurements made the call, per
`docs/research/2026-08-02-obs-prd7-renderer.md`'s `[Ran]` probes at
1200×800/12 balls: **marching squares at 1.28 ms/frame** against **42.8
ms/frame** for a per-pixel metaball evaluation (108.5 ms once that per-pixel
version carries SDFs and a smooth minimum) — 2.5× the entire frame budget
before a pixel is drawn. The second reason mattered as much as the first:
marching squares emits a **contour polygon**, so the root-mass stays one
typed mark (`role: 'contour'`) with geometry `marks.test.ts` can query,
where a pixel buffer would have made every law about it a screenshot
comparison. `smin` is **not associative** — `smin(smin(a,b),c) ≠
smin(a,smin(b,c))` — so `orderFalloffs` sorts every falloff by a stable id
(the lane handle, for an arrival) before any folding happens; an unsorted
fold would flap the mass's own shape frame to frame with no event behind it,
which `contour.test.ts` pins by asserting the same state, shuffled input,
gives byte-identical rings. The grid walk itself never compares a
coordinate to stitch segments — every crossing is named by the grid edge it
lives on, so two cells sharing an edge are talking about the same vertex by
construction and a ring comes out closed structurally rather than by
tolerance.

`marks/root.ts`'s `girthOf` reads whatever geometry a mark carries rather
than assuming `mark.kind === 'stroke'`, which is the same move ruling 2 made
for names, applied to geometry — "the mass thickens with landed work" (prd6
ruling 2) is a law about a fact, not about strokes, and it now reads the
contour's own points unchanged. A same-issue fix (`fix(#114)`, "the arrivals
were faceting the mass, and I could see it") corrected an arrival's own
falloff, found by rendering the display list to a PNG and looking at it:
three arrivals at full swell turned the root-mass into a visible crystal,
flat facets where each bulge met the body — caused by a large falloff
parked deep inside the body, whose contribution is nearly flat at that
scale, so what reached the silhouette was a facet rather than a curve.
Moving the falloff smaller and further out (0.9 of the radius at 0.26,
instead of 0.72 at 0.42 — the same peak reach to within a hundredth) fixed
it and bought two properties kept on purpose: a bulge cannot appear out of
nothing (below half swell the falloff sits entirely inside the body, so it
*emerges* from the surface over the retract's last third), and the body's
own fill alpha went up, because at the old alpha the mass read as fog with
threads behind it rather than as the thing they are threaded into. This is
also what replaced `root-arrival` — the expanding ring drawn on top of the
mass whenever work landed, a concentric ring being the exact form the
ruling removes, with no direction in it. The role and the ring are both
gone; the surface itself carries the fact now, by swelling toward the lane
substance arriving.

### Ruling 6 — read for technique, never vendor

Workers loaded `ui-ux-pro-max` (its "Biomimetic / Organic 2.0" style card as
a checklist), `emil-design-eng` and `frontend-design`, per the ruling.
Reading list: inconvergent's (Anders Hoff) *Hyphae* and *Differential Line*
essays, the published art form closest to this scene's own metaphor, read
for growth rules stated in prose; Tyler Hobbs on flow fields and the
midpoint-displacement technique `blobRing` reimplements; Inigo Quilez on
`smin` and 2D distance functions; Sighack's Chaikin corner-cutting (MIT,
ported directly, used in both `variation.ts`'s wander envelope and
`contour.ts`'s ring smoothing). **Licence traps, carried into every prd7
brief rather than discovered per-issue:** jasonwebb's differential-growth
and space-colonization repos are **CC BY-NC-SA** (non-commercial — read the
README, never vendor the code); `thebookofshaders`' own repository is **All
Rights Reserved** (the site is readable, the GLSL is not copyable); `p5.js`
is **LGPL-2.1** (prototypes only, never a app dependency). Every growth
algorithm surveyed (space colonization, differential growth, Physarum) was
accepted only as **offline geometry authoring on topology change** —
`contour.ts` runs its field-and-march every time the display list is built,
never live per animation frame in the sense those algorithms mean it, and
none of their code shipped: `perfect-freehand`, `d3-shape` and
`simplex-noise` are the only new runtime dependencies, all MIT or ISC.

## Beyond prd7 — the fold, and a mass that grows with the scene (#117, #118)

A post-prd7 visual review ("beautification pass," operator, 2026-08-02) found
two things prd7 had shipped but not yet gotten right at real fleet scale, and
landed both without a numbered prd of their own.

### The fold replaces the knot (#117)

prd7 ruling 3's DONE mark was a **knot**: the seal was pinned as
`turning > 2π`, and a full turn is definitionally a ring with an eye in it.
At 2x, on a fleet of thirty-eight retired lanes, every one of them wore the
same pretzel — the single most repeated shape in the picture, because the
one number every landed lane was checked against was also the thing forcing
them all into one stamp.

The seal is a **fold** now (`sealMark`, `marks/node.ts`): the cord runs past
the tip, turns at a radius near its own width — so the two runs lie against
each other and no eye is left over — and comes back down into the lens,
where the taper has already taken it to nothing. Reach, tightness, overturn,
bow and hand all come off the lane's own two free phases, which is why the
tips no longer rhyme. `marks.test.ts` restates the law in four clauses where
it had one:

1. **it turns back on itself** (≥ π) — the surviving half of the old claim,
   at the amount a fold needs. A bar has none.
2. **it comes home** — the spine ends inside the lens having reached
   outside it. The old test only *said* this in a comment; it's asserted
   now, and it's what tells a seal from the tail beside it.
3. **it is the cord, not a mark laid on it** — a ribbon, drawn to nothing.
4. **there is no mould** — over a fleet of identical work, the spread of
   shapes is measured three ways, and all three read exactly zero under the
   knot. This is the clause that would have caught the original bug.

Only clause 1 is laxer than what it replaced, on precisely the axis that
forced the badge. Honest about its limit: this is not "no two are alike" —
the fold is a function of two hashes of the lane's handle, so two lanes can
draw phases close enough to fold alike, and no identity-seeded mapping can
promise otherwise. What is forbidden is a shape the whole fleet *shares*.

`knotMark` (the mark this replaced) no longer exists in source — see the
prd7 ruling 3 table above, which is left as the historical record of what
prd7 shipped, with a pointer here to what it became.

### A mass that grows with the scene, not with itself (#118)

Also superseded here: prd6 ruling 2's `rootGirth`, a multiplier on a fixed
radius worth up to 30% at the ceiling ("The way home" above). After
thirty-eight landings and 2.5M output tokens in this project's own build
session, the scene read as a **wreath** — a ring of retired lanes around a
large, mostly empty middle with a small blob in it. The encoding was already
there; it was simply too weak to see against the picture it sits in.

Two things changed together, both in `geometry.ts` (`ROOT_GROWTH`,
`rootRadiusFor`, `rootFullness`):

1. **The ceiling is a fraction of the scene, not of the mass.** "+30% of its
   own resting size" is a claim about the mass and says nothing about the
   picture around it. The cap (`ROOT_GROWTH.maxReach` = 0.5) is now half the
   distance from the centre to the nearest point of the retirement band —
   the direction the rim runs closest, measured the same way `bornRadial`
   already measured it — so the mass can never crowd the rim or the lane
   labels on a letterbox panel, a square one, or at any zoom, since the
   camera magnifies the ceiling and the rim by the same factor. The
   reference tokens moved too (`seedTokens` = 10,000 unchanged,
   `fullTokens` = 2,000,000 — this project's own build session had already
   landed 2.5M by the time the ruling was written).
2. **Everything inside the rim makes room for it.** The newborn radius, the
   bundle trunk, and the point each thread leaves the surface at are now
   placed against `rootRadius` — a geometry fact computed before any mark
   builder runs — rather than against a resting size, so a full mass can't
   grow into ground a newborn node already occupies.

A follow-up finding (`marks/root.ts`'s `DEPTH`) split what "grown" actually
means: growing the *silhouette* alone just re-photographs the same shape
larger, so the growth is carried entirely by **interior resolution** instead
— the shell count that paints the mass's depth goes from 18 (resting) to 26
(a full mass), each one thinner in proportion, so a full mass gains visible
internal structure rather than a bigger outline of the same likeness. The
reach the shells sample to (`DEPTH.reach` = 0.62, in units of the radius)
does **not** grow with fullness — a first attempt at deepening it bought
shells that enclosed nothing at all, since the underlying field bottoms out
around 0.58 of the radius regardless of size — and the rind (the mass's lit
skin) stays a fixed few pixels rather than scaling with girth, since a skin
is a material fact about how far light travels through this stuff, not a
proportion of how big the stuff is.

## prd8 — from private project to published software

prd8 (`docs/prds/prd8.md`) is the publishing round: turning a private,
`private: true` scaffold into something a stranger can find, trust, install
and run. Four issues landed it in fenced waves — **#119** (the rename,
mechanical and everywhere, landed alone since every other wave depends on the
name being settled) then **#120** (the publishable package) ∥ **#121** (the
stranger's documentation) together, then **#122** (release engineering).

- **The rename (#119).** The app and the npm package, bin, and command are
  all `rhizomorph` — in mycology, the root-like cord of bundled hyphae that
  transports nutrients across distance to the colony, the thing this app
  draws.
- **The publishable package (#120).** `package.json` had `private: true`, no
  `files`, and no `.npmignore` — a publish would have shipped `.claude/`,
  `.swarm/`, `prompts/`, `docs/research/` and the whole conductor toolkit to
  the registry. A `files` allowlist now bounds what ships, verified by
  inspecting `npm pack`'s actual output rather than assumed; the server CLI
  is bundled with esbuild for publishing, and CI guards the pack allowlist so
  it can't regress silently.
- **The stranger's documentation (#121).** The README was rewritten for
  users and gained a Trust section: WHAT this tool reads (`~/.claude/projects`
  — the operator's own agent conversations), WHERE it listens (127.0.0.1
  only), and that nothing is ever sent anywhere — behaviour that already
  existed but had never been stated. CONTRIBUTING and SECURITY were added,
  alongside a pass on prd7's docs staleness. The licence question was
  settled by investigation, not permission (ruling 4): four upstream-authored
  paths were removed from the published tree rather than relicensed;
  everything else is Lachlan Kelliher's own work, MIT.
- **Release engineering (#122).** Semver 0.1.0, a CHANGELOG, a `--version`
  flag, and a tag-gated release workflow that stays dormant until a tag is
  pushed rather than running on every merge.
- **The support matrix, claimed only where verified (ruling 7):** Linux is
  CI-verified on every push; WSL is the daily development platform; macOS is
  unverified and labelled as such.

prd8 ruling 2's install story (`npx rhizomorph <path>`) is itself superseded
one prd later — see [prd9](#prd9--the-trace-era) below and
[docs/roadmap.md](roadmap.md).

## prd9 — the trace era

prd9 (`docs/prds/prd9.md`) was the one-week handover push: a junior-proof front
door, and a trace layer built on live captures
(`research/2026-08-03-trace-era-captures.md`), not documentation — a research
day probed Claude Code 2.1.220's beta OTLP trace export and Langfuse's
ingestion of it before any ruling was written. Landed in full: wave A
(receiver, selectors, CLI/doctor, #124–#126) and wave B (the drawer's own
TRACE section, #132; the vendored, SHA-pinned Langfuse pricing table, #129)
both shipped, and the drawer's TRACE tab described in the README's Dashboard
section is this prd's waterfall. prd9 ruling 2's clone-first install story
is itself superseded one prd later by prd15's system-agnosticism direction —
see [prd15 — the anywhere instrument](#prd15--the-anywhere-instrument-system-agnosticism)
below and the README's ["When this is published to npm"](../README.md#when-this-is-published-to-npm).

### The trace keystone (#123, landed)

`packages/core/src/events/trace.ts` is the whole of the trace layer's
contract so far: one event type, `trace.span`, sourced only from `otel` — the
same `/v1/traces` door prd1's metrics use. The payload's `name` field is the
raw span name string, never an enum (ruling 3 — beta churn is data, not
schema); the parser-derived `kind` is the stable classification every
surface reads: `interaction | llm_request | tool | tool_blocked |
tool_execution | hook | other`, with an unrecognised name landing on `other`,
never erroring. A `decision` field (`accept | reject | unknown`) captures
what a human decided about a blocked tool call — `unknown` is a real,
observed value (a pre-allowed tool), not an absence.

`trace.test.ts` states four laws, so the keystone is asserted rather than
assumed:

1. **No spend from spans** (ruling 4) — a state built from only `trace.span`
   events is indistinguishable from an empty one through every spend
   selector, and adding spans to a log that already has spend moves no
   number. `llm_request` spans carry the same four token tiers `llm.usage`
   already counts; the tokens on a span are waterfall annotation only, never
   a source of dollars. A span's `requestId` may JOIN a spend record for
   enrichment; it may never create one.
2. **Idempotent re-delivery** — the fold keys on `(traceId, spanId)`; the
   same pair delivered twice folds to one record, first delivery wins, and
   the event still counts in the envelope.
3. **JSONL roundtrip** — stringify → parse → reduce folds identically, and a
   line whose payload smuggles an attributes map reads back without it.
4. **The allowlist is structural** — the payload's field list IS the privacy
   allowlist (ruling 5): there is no attributes map, so `user.email`,
   `user.account_*` and `organization.id` — present on every span both CLIs
   emit — have no field to land in.

### Wave A: receiver, selectors, CLI/doctor (#124–#126, building in parallel)

Fenced and parallel per the plan: the `/v1/traces` receiver plus a pure
Claude-profile parser plus fixtures pinned to claude 2.1.220 (including the
`resourceSpans` instance-gate fix); span selectors (trees, waiting-on-human,
interaction summaries — token sums from `llm_request` spans only);
`rhizomorph env` emitting the two beta env lines and `doctor` checking trace
reachability and fixture-vs-CLI drift. See
[docs/telemetry.md](telemetry.md#enabling-beta-traces) for the env block.

### Blocked-on-human is retrospective-exact (ruling 6)

The capture confirmed spans export only once they end — a lane's open,
unfinished span is invisible until it closes. So the trace instrument
reports how long a lane SAT waiting and what was decided, always after the
fact; LIVE waiting stays the attention strip's own job, unchanged. No surface
built on `trace.span` may imply it knows about an open wait.

### What shipped after (both landed)

The lane-drawer waterfall (#132, prd9 ruling B1a) reads `traceViews`
(`packages/web/src/drawer/index.tsx`) into the drawer's own **TRACE** tab —
one of the four tabs #163/#164 later reorganized the drawer around (see
[The layman bar (prd4)](#the-layman-bar-prd4) for the tab mechanics and
[prd16](#prd16--the-session-is-a-thing-you-can-hold) below for why ACTIVITY,
not TRACE or CONVERSATION, opens by default). Pricing vendored from
Langfuse's MIT `default-model-prices.json`, pinned to commit SHA `cfac485`
(#129), backs every `est.`-flagged dollar figure this doc and
`docs/telemetry.md` describe for a non-OTLP CLI. Everything from this point
in the doc downstream — recordings, the TIDE, agnosticism, sessions, the
complete record — landed after prd9 and is documented in the sections that
follow.

## Recordings as first-class artefacts (#156)

The operator's ask (2026-08-04): "when do we record, how do we record, and
we need some kind of recording naming system for easy finding." Every server
run has always auto-recorded (see [The log lives outside the watched
repo](#the-log-lives-outside-the-watched-repo) above for WHEN/WHERE/WHAT);
what was missing was a way to tell twenty session files apart without
opening each one. This issue adds a name to a recording, never a new kind of
one — the log's own shape (`docs/record-format.md`) is unchanged.

### Auto-titles, derived and never invented

`packages/server/src/log/title.ts`'s `computeSessionMeta` folds a session's
events through the core reducer and reads three facts straight off
`selectSpendByBranch` (branch is this app's existing "lane" identity — every
worktree carries one): **lanes** (branches other than main the log ever
mentioned), **landed** (`BranchSpend.landed` — the same "its worktree is
gone" definition the ledger already uses, not a new liveness source), and
**issues** (`BranchSpend.issue` — the fenced-issue convention's leading
digits, e.g. `144` for `144-something`, deduped and sorted ascending).
`autoTitle` turns that into `2026-08-04 · 6 lanes · 5 landed · #144 #148
#152` — date first (UTC, so the same recording reads identically on a
stranger's machine), issue numbers capped at three with a named `+N`
overflow rather than a silent truncation. Zero lanes is its own honest
sentence, `2026-08-04 · no activity recorded`, never a blank or a
placeholder. Nothing here is a guess: every word in a title traces back to a
real event, and `title.test.ts` pins the empty case alongside the populated
one.

### A label wins, and it never touches the log

`rhizomorph label <sessionId> "<text>"` (`packages/server/src/cli/label.ts`)
writes a sidecar, `session-<id>.label.json`, beside the log — never inside
it. This is the same append-only law the log format itself already keeps
(`docs/record-format.md`'s law 1): a recording is evidence, and evidence
that can be silently rewritten stops being evidence. `readSessionLabel`
(`packages/server/src/log/label.ts`) treats a missing, unreadable or
malformed sidecar as "unlabelled" rather than an error — the auto-title is
always a safe fallback, never a crash. `label` refuses a session id nothing
was actually recorded under (the same loud, exact refusal `export-record`
already gives for the identical mistake) rather than writing an orphaned
sidecar for a session that doesn't exist.

### One listing, shared by the API and the CLI

`packages/server/src/log/listing.ts`'s `listSessionListings` composes a
session's summary (id, filename, start time, file size — unchanged), its
auto-title, its label, and its lane/landing/spend counts into one
`SessionListing` row, and both new surfaces read the exact same function:

- **`GET /api/sessions`** (`packages/server/src/api/sessions.ts`) now
  returns this shape instead of the bare summary, so the replay picker
  (`packages/web/src/replay/index.tsx`) can render a title instead of a raw
  timestamp — a label wins when set, else the auto-title, else (for a server
  that hasn't grown these fields yet) the timestamp it always showed. That
  fallback chain lives in the web package alone: `packages/web/src/replay/
  api.ts` and `useReplaySession.ts` sit outside this issue's fence, so
  `index.tsx` reads the extra fields off the same fetched objects through a
  local, all-optional type extension rather than widening `SessionSummary`
  itself — the JSON already carries them; only the type needed catching up.
- **`rhizomorph sessions [path]`** (`packages/server/src/cli/sessions.ts`)
  renders the same rows as a newest-first table — id, title, when, duration,
  lanes, landed, output tokens, cost (flagged `(est.)` exactly when
  `costIsAuthoritative` is `false`, and `—` rather than a fabricated
  `$0.00` when it's `null`), file size. This is the "find the one where the
  scene landed" command the operator asked for.

Both call sites do a **full parse** of every session's events, not a bounded
head/tail sample. This is a deliberate choice, not an oversight: a lane's
landing can occur anywhere in a session's timeline, and sampling only the
head or tail would silently miss a landing that happened in the middle of a
long session — exactly the fact this feature exists to surface. The cost is
acceptable because neither call site repeats often enough for it to matter:
the replay picker fetches `/api/sessions` once per mount, not on a poll, and
`rhizomorph sessions` is a one-shot CLI invocation. The live session is a
special case either way — `listSessionListings` reads it from the
recorder's own in-memory buffer (`ctx.recorder.eventsSoFar()`) instead of
its file on disk, the same race-avoidance rule `GET /api/sessions/:id/events`
already followed before this issue.

## prd10 — the gorgeous round: growth, life, flourishing and return

prd10 (`docs/prds/prd10.md`) is a scene-beauty pass on top of prd7's procedural
form — thread underglow, a tissue-density ramp toward the root-mass, and
further contour refinement — landed on the operator's brief that "a replay
should look like a legitimate art piece." It changes rendering detail inside
`packages/web/src/scene/` without touching any law prd3–prd9 established
about what a colour, shape, or motion class *means*; nothing here is
reachable from outside the scene module, so it earns no dedicated ruling
walkthrough in this doc beyond naming it as the source of the current visual
finish.

## prd11 — the causal record: provenance and the portable session record

prd11 (`docs/prds/prd11.md`), ruled 2026-08-04 toward "the forest" (a future,
multiplayer instrument with persistent knowledge of every coworker's
swarm) — everything in it is built so that goal is a merge later, not a
rewrite. Two do-now pieces:

- **Provenance at file granularity.** `tool.activity` gained optional
  `filePath`/`toolUseId` fields (from the sessionlog's own tool_use blocks —
  Edit/Write/Read carry a path, Bash does not and stays `null`), completing
  the chain transcript-moment → tool call → file touched →
  `commit.landed.files` → branch. Hunk-level attribution is named future
  work rather than faked by proximity — this prd stops at the file.
- **The portable record — federation-first from its first field.**
  `packages/core/src/record/` (build, hash, merge, verify, schema) is one
  file: a manifest (schema version, repo slug, actor identity, time range,
  event count), the event log's own lines verbatim, and a per-line hash
  chain closing in the manifest's digest — integrity-checked now,
  signature-ready (the manifest reserves the field). `rhizomorph
  export-record` writes it; `rhizomorph replay <record>` serves a foreign
  record read-only through the existing replay machinery. The wire shape
  itself is specified in [`docs/record-format.md`](record-format.md); prd16
  (below) is what makes a recording worth exporting in the first place, and
  prd17 (below) is what keeps this format honest as new event families
  arrive.

## prd12 — the laboratory: a second hand, under an amended constitution

prd12 (`docs/prds/prd12.md`) is the constitutional amendment the README's Trust
section documents in full — see
[The laboratory](../README.md#the-laboratory--opt-in-explicitly-invoked-and-separate-prd12-ruling-1)
there for what it reads, what it may write, and the two independent
enforcement mechanisms (`assertInsideLabWorktrees` at runtime,
`packages/server/src/lab/namespace-law.test.ts` over the source tree).
Ruling 1's own framing, worth restating here because prd16 amends it again:
*"The read-only constitution is AMENDED, not dissolved. Two hands"* — the
observer, untouched; the laboratory, a second, explicitly-invoked actor
confined to `refs/rhizomorph/` and artefacts outside the watched repo. prd16
below adds a third.

## prd13 — the TIDE: the scrubber grows a body, then sheds most of it

The dashboard-IA spike (`docs/research/2026-08-04-dashboard-ia-spike.md`)
named the weakest control in the app: `Scrubber.tsx` was a bare
`<input type=range>`, so replay was navigated blind. prd13 (`docs/prds/prd13.md`)
answers that — but its own history is the clearest live example in this repo
of prd3 ruling 25's standing protocol, *"every failing mark gets an
affordance or is CUT"*: a swim-lane density band was built, given three
rounds of affordances, and still failed with the one person using it, so it
was cut outright. What survives is smaller than what shipped first, and
that is the point, not a regression.

### Ruling 1 — the TIDE is the replay bar's body, never a panel

The dock renders inside the same bottom transport bar in both live and
replay (`packages/web/src/app/ReplayBar.tsx` → `packages/web/src/replay/
index.tsx`, which mounts `TideDock` — `packages/web/src/tide/TideDock.tsx`),
never as a row in the curated panel order: zero rows added, the scene's
hero status (prd4 ruling 2) untouched, no new hue, no new motion class. If a
future round is ever tempted to promote it to a panel of its own, prd13
states plainly that this is the moment it starts competing with the scene,
and the answer is no.

### Ruling 12 (2026-08-05) — chapters over a per-lane band

The first shipped shape (rulings 2–11) was a per-lane density band — state-
fill strips, one row per lane, coalescing into a `+N` chip under density,
zoom, a deep-linkable window. The operator caught its failure on the first
real session: expanded per-lane rows against a 50-lane recording read as
noise, not navigation. Ruling 12 amended it to a sparse **chapter-mark
lane** above the band instead — one mark per lane-born/landed/gate-held/
attention-summons/session-boundary moment, click-to-seek, hover carrying
who/what/when, coalescing under density by the same law marks everywhere
else in this app already follow. This is also stated as "one vocabulary with
prd12": the moments this lane marks are exactly the moments prd12 ruling 2
names as checkpoint moments (dispatch, gate entry, operator command), so
when the laboratory lands, forkable marks gain a fork affordance rather than
the app growing a second timeline vocabulary.

### Ruling 13 (operator amendment, 2026-08-06) — the band is CUT

*"Honestly? Get rid of the working green strips entirely."* — the operator,
after living with the dock through three rounds of fixes. The density band
had, by this point, a legible hit target, an honest hatch for gaps, mark
coalescing, and a real per-lane expansion — every affordance ruling 12 and
the ones before it could offer — and it still read as noise to the only
person using it. Per prd3 ruling 25's protocol, it was cut rather than given
a fourth round.

**Removed entirely, collapsed and expanded, live and replay:** the state-
fill bands, the per-lane rows, the `+N` coalescing chip, and the row-budget
machinery that sized them. **What's left:** the chapter-mark lane, a time
axis, and the transport — nothing else — implemented in
`packages/web/src/tide/TideDock.tsx` (issue #169, cut to this shape by issue
#194) and `ChapterMarks.tsx`. Concretely, in the shipped code:

- **One x-axis, one `timeScale` call** backs both the mark row's layout and
  the transport's own playhead/click-to-seek math — the mark row and the
  `Scrubber` are two rows of one `grid-template-columns: auto 1fr auto`
  layout, so the browser's own grid track sizing (not a hand-computed
  offset) guarantees the shared column stays the same width in both rows.
- **Portaled hover cards.** `ChapterMarks.tsx` renders `MarkHoverCard` via
  `createPortal(..., document.body)` — moving the DOM node itself out from
  under any ancestor's stacking context or `overflow`, so nothing on the
  page can clip or bury it. A `HOVER_DELAY_MS` (150ms) gates it in, the
  same "the label appears as you linger" idiom a video scrubber uses.
- **Zoom is local, visual, and cursor-anchored, never global.** `Shift`+wheel
  narrows the window the mark lane draws over, anchored on the timestamp
  under the cursor (`scale.tsOf`) rather than the window's centre — it never
  restricts what the full-range `Scrubber` can scrub, and never reaches
  another panel or the URL. A still bracket drawn over the `Scrubber` track
  (in the *full-range* scale, a deliberately separate `timeScale` call) shows
  where the zoomed window sits against the whole session, labelled
  `window N/M · HH:MM–HH:MM`. Depth is capped by the log's own median event
  spacing (`usefulMaxZoomLevel`), not an arbitrary ceiling.
- **`[`/`]` step to the neighbouring chapter**, scoped to the dock and
  guarded against stealing the keys from a text field
  (`isTypingTarget`) — deliberately not guarded against the native range
  `<input>`, which owns none of those keys.
- **One height, not a mode-dependent one.** Replay's per-lane rows used to
  earn extra vertical room; with them gone, `ChapterMarks` renders at one
  default height in both live and replay, and the axis appears whenever
  zoomed, in either mode.

**What the cut does not touch:** hover cards, duration as a first-class
fact, no per-panel legend, gaps read as absence (now via marks and the axis
alone rather than a hatch), the deep-linkable window, the transport's
zoom/shift affordances, and ruling 1's framing — the dock is still the
replay bar's body, never a panel.

## prd15 — the anywhere instrument: system agnosticism

**BLESSED**, operator, 2026-08-05: *"I am aiming for TRUE, FULL FEATURED
system agnosticism"* — any OS, any terminal, any agent CLI, any provider,
eventually from a plain `npm install`. This supersedes the framing where a
tmuxless boot was a degraded tier: feature parity is the goal, and tmux
becomes optional enrichment rather than a prerequisite. It is also what
finally re-opens the door prd9 ruling 2 had closed on publishing — see
[prd9](#prd9--the-trace-era) above and the README's ["When this is published
to npm"](../README.md#when-this-is-published-to-npm); publish stays the
*last* wave of this prd, gated on #177's still-open history-vs-fresh-tree
decision.

### Ruling 1 — the transcript-tail state machine is the universal organ (#188, landed)

Every observable agent CLI writes a session transcript as it works; this
ruling turns the shape of that transcript's *tail* into a state machine per
lane, yielding liveness AND attention with **zero cooperation** from the
agent stack — no tmux, no hooks, any terminal, any OS.
`packages/server/src/collectors/sessionlog/turn-shape.ts` folds a transcript
left-to-right (never seeks backward from EOF — a fold over a prefix must
equal a fold over the full log truncated there, the same replay law this
whole app is built on) into one of five shapes (`empty`, `turn-complete`,
`pending-tool`, `mid-stream`, `awaiting-reply`), and
`lane-state.ts` derives four lane states from shape + recency + (only at a
stall) process aliveness (`process-probe.ts`):

| state | meaning | reached when |
|---|---|---|
| `working` | in motion | the turn is unfinished and moving, or just ended |
| `waiting` | **the needs-you signal** | the turn completed and stayed completed |
| `frozen` | stalled mid-turn, still alive | mid-turn, silent past the stall, process alive-or-unknown |
| `gone` | stalled, process confirmed absent | silent past the threshold, probe says `false` |

Three laws hold this structurally rather than by threshold: **WAITING
requires a completed turn** — no path from a mid-turn shape reaches it at
any silence or duration, which is #133's false-summons law made structural
(a lane delegating to a subagent has an open `Task` call, so its tail is
`pending-tool` and it *cannot* summon the operator no matter how long the
subagent runs); **FROZEN requires a mid-turn shape** — a lane that finished
its turn has nothing to be frozen in the middle of; and **unknown is never
death** — only an explicit `processAlive === false` reaches `gone`, and a
`null` probe (macOS, Windows-native, an unreadable procfs) degrades to the
weaker `frozen` claim instead.

The per-CLI grammar this reads is itself a **versioned capture, not
documentation** (dialect-verification discipline) —
`packages/server/src/collectors/sessionlog/turn-grammar-claude.ts` derives
Claude Code's own JSONL shape from a real survey of this machine's entire
Claude Code corpus: **253 transcripts, 64,979 lines, 42,842 conversational
entries**, across claude-code 2.1.220–2.1.222. The corpus's own headline
finding is why a naive reader gets this wrong: **the last line of a
transcript is almost never conversation** — 213 of 253 files end on
`last-prompt`, 29 on `permission-mode`, 4 on `mode`, and only 4 on an actual
`assistant`/`user` entry, so a reader that took "the last line" as the turn
shape would be wrong 98% of the time. `message.stop_reason` is the
completion discriminator (`tool_use` 26,178 of 26,567 assistant entries,
split further into PENDING-with-a-tool-call vs. still-being-written-across-
lines); `isSidechain` is present on 100% of conversational entries in this
corpus, so the subagent filter is structural. The fixtures beside this file
(`fixtures/claude-code-2.1.222-*`) are real, mechanically-redacted slices of
that survey.

### Ruling 5 — the enrichment ladder, named not ranked (#190, landed)

`packages/core/src/collector.ts` names six signals every collector may speak
to (`identity | liveness | activity | attention | telemetry | cost`), each at
one of three levels (`provided | partial | absent` — the latter two are
*compiler-required* to carry a one-line reason, "a reason for anything not
provided" restated as a type rather than a convention an author could skip).
Every collector now declares its own `AdapterCapabilities` — `git`, `tmux`,
`workmux`, `sessionlog`, `otel`, and the judge collector each have their own
(`packages/server/src/collectors/*/`) — and `mergeCapabilities` folds several
collectors' views of one lane into the best level any of them reaches per
signal (a second witness only ever adds confidence, never removes it). A
lane sits at exactly one rung at a time, pure and total for any signal
combination:

| rung | label | climbs to next by |
|---|---|---|
| **L0** | zero-cooperation (git + transcript organ) | env vars at launch (`rhizomorph env <lane>`) bringing OTLP dollars/traces |
| **L1** | env/OTLP | a hook beacon declaring attention instead of inferring it |
| **L2** | beacon (declared attention) | a PTY wrapper (`rhizomorph run`) adding a live output stream |
| **L3** | PTY wrapper | tmux/workmux adding pane previews and one-keystroke ATTACH |
| **L4** | tmux/workmux | top rung — nothing further to climb |

L2 and L3 are not reachable by any collector shipped in this repo yet (prd15
waves 3 and 7 — the beacon collector and the PTY wrapper); `deriveRung`
still maps every signal combination onto all five rungs so the law "every
capability combination maps to exactly one rung" holds before those
collectors exist, not only after. `deriveRung` reads top-down: `attention:
provided` → L4; `attention: partial` with `telemetry: absent` → L3; `cost`
anything but `absent` → L1; otherwise the L0 floor. That floor is real
signal, not silence — bare git alone lands at L0 with every signal but
identity/liveness absent, while git plus the transcript organ lands at the
*same rung* with full token telemetry (activity, liveness and tokens all
`provided`) and only `cost` still `absent` — "L0 is zero-cooperation, not
zero-signal" is the ladder's own framing for exactly this distinction.
`rhizomorph doctor` (`packages/server/src/cli/doctor.ts`) and `GET
/api/meta` (`packages/server/src/api/meta.ts`, carrying `{ capabilities,
rung }` per lane) both say the rung per lane and name what climbing it
requires, per ruling 5's own text: *"`doctor` and the provenance strip SAY
the rung per lane."* See [docs/telemetry.md](telemetry.md#the-enrichment-rung)
for what this means for "instrumented."

### What's ruled here but not yet reachable by any shipping collector

Ruling 2 (hook beacons upgrading inferred attention to declared), ruling 3
(provider/model/cost parity for codex/pi adapters, estimated dollars via the
vendored pricing table), ruling 6 (multi-orchestrator honesty — distinct
conductor identities rendered as a family rather than silently summed), and
ruling 7 (a named Windows-native verification pass, captures not
confidence) are all **ruled, not yet landed** — waves 3–7 of prd15's own
sequencing. The support matrix in the README moves rows only on evidence per
ruling 7's own text, and no such evidence exists in this tree yet.

## prd16 — the session is a thing you can hold

**BLESSED**, operator, 2026-08-06, closing #182's reserved ruling: *"there is
still the question of what defines a session, and what defines what is
recorded and what is part of a 'session'... the session logs should keep the
conversation transcripts, trace, etc accessible if it's replayed."* Ruled
last before the laboratory proper (prd14), because prd12's checkpoints bind
to session positions and prd14's experiments *are* sessions — session
identity had to be solid before either.

### Ruling 2 — the observer gains a third hand: rotation (constitutional amendment)

prd12 had amended the read-only constitution to two hands (the observer,
absolutely read-only; the laboratory, an explicitly-invoked second actor).
prd16 adds a third, narrower than either — **the recorder** — and frames it
precisely as *not new authority*: *"the observer has always written its own
recording; what changes is who decides when a recording ends."* The
recorder's hand may only close the current session log and open a new one,
writing solely inside `~/.local/share/rhizomorph/<repo-slug>/` — never the
watched repo, never a ref, never a worktree, never `~/.claude` — exposed as
an explicit human invocation only (`rhizomorph rotate`, or the dashboard's
"end session · start fresh" button), never a background process. See the
README's [Trust](../README.md#trust) section for the reader-facing version
of all three hands named side by side; this is where the constitutional
amendment itself was ruled.

**The prerequisite this ruling depended on: the session lock (#187).**
`packages/server/src/log/session-lock.ts` claims a pid+heartbeat lock
(`session-<id>.lock.json`, refreshed every 5s, three missed refreshes'
tolerance) beside the log at boot, so two instances can no longer race onto
the same session. `decideSessionBoot`
(`packages/server/src/log/session-log.ts`) consults it after every other
boot-reason check: a live lock (heartbeat fresh *and* the pid still alive,
per `isPidAlive`'s `process.kill(pid, 0)` probe) returns `writer-alive` and
starts a fresh session rather than splicing into one another process is
still writing. `--resume-window <ms>` (default 4h; `0` behaves exactly like
`--fresh`) makes the whole boundary operator-controllable and self-
explaining, and both the boot line and `rhizomorph doctor` say which way it
decided and why.

**The amendment ships with its own law tests**, the same discipline prd12's
namespace test set: the existing readonly greps stay green untouched, and a
rotation-namespace test asserts every write this hand performs lands under
the data directory and nowhere else.

### Ruling 3 — a recording is self-contained: transcripts are captured, not resolved

The gap this closes: `trace.span` events replay perfectly because they *are*
events, while a lane's conversation used to be resolved live from
`~/.claude/projects` at read time — durable only as long as that external
directory exists, and simply gone on another machine.
`packages/server/src/log/transcript-capture.ts` copies each lane's live
transcript, redacted by the same hygiene discipline the OTel fixtures
carry, into that session's own artefact directory the moment it closes
(`packages/server/src/recorder/rotate.ts`'s `closeCurrentSession`, before it
appends `session.closed`). Replay reads the captured copy first, falling
back to live resolution only for the still-open session — one code path,
one precedence rule. Capture is bounded and honest about its own size (one
busy lane in this project's own build day ran ~9MB of transcript), and a
session whose transcripts could not be fully captured says so precisely via
`TranscriptCaptureManifest.complete: false` rather than silently producing a
conversation-less recording. The append-only law holds throughout: captured
transcripts live beside the log, never inside it — the same sidecar posture
labels already use.

### Ruling 4 — recordings get a real surface: `/recordings` (#206, landed)

The replay picker is for *choosing* a session to scrub through; managing
what was recorded needed its own room.
`packages/web/src/recordings/RecordingsPage.tsx` lists every recording with
what `SessionListing` already computes (title, label, lanes, landed,
duration, tokens, cost, whether cost is authoritative), plus **rename in
place**, **open in replay**, and **export the portable record** (prd11's
builder). `POST /api/label` (`packages/server/src/api/label.ts`) is the
app's *second* mutating route — the first is the laboratory's own CLI
surface — and writes only the label sidecar, refusing with a named reason
(`this server is replaying a session record, not watching a directory of
recordings — there is nowhere durable to save a label here`) when the
server is itself in replay-only mode. Renaming a session refreshes every
other picker showing it, including the live dashboard's own session
picker — a same-HEAD fix (`fix(web): renaming a recording also refreshes
the balcony's session picker`) closed a gap where the two pickers cached
independently and one went stale.

This is a **library, not a second overview**: it reuses the existing
hand-rolled router (`packages/web/src/app/router.ts`'s `{ name:
'recordings' }` route, mounted in `App.tsx`), adds no row to the curated
panel order, and its own law test
(`packages/web/src/recordings/no-live-fleet-law.test.ts`)
greps its own module tree for `useFleet`/`FleetProvider`/`buildFleet`/panel
or scene imports/`reduceAll(` and fails the build the day any of them
appears — a structural guarantee that this surface can answer "what did we
record" without ever growing into a second answer to "what is happening
now," which is the scene's job alone.

### Ruling 6 — the recorder seam is framed, not a process split (operator, on the council's advice)

The rotation lane draws a clean module boundary around the recording-writer
(`packages/server/src/recorder/index.ts`) — its own module, its own
namespace law — **without** splitting the process. The accepted argument:
prd16 is the last cheap moment to frame this doorway, since the wall is
already open; if a future federation or agnosticism round ever wants the
recorder running separately, the doorway exists and nobody performs
surgery. No door is installed today — one process, one binary, until a
future prd rules otherwise.

## prd17 — the complete record: judgements and decisions join the log

**BLESSED**, operator, 2026-08-06, on a council synthesis's unanimous
finding: *the causal record is missing its two most important actors — the
instrument's own judgements, and the operator's decisions.* prd1's founding
insight ("orchestrated setups undercount by omitting the orchestrator")
recurred one level up — the operator is the only unobserved agent in the
system.

### Ruling 3 — recordings never rot: the integrity laws (landed)

A verified finding motivated this ruling: the parser used to silently
**skip** an event type it didn't recognize (the reducer's forward-compat arm
was unreachable in practice), and live folded events in arrival order while
replay folded the same events ts-sorted through an order-sensitive
reducer — two different fold orders for one recording, undocumented. Five
laws now hold, four of them landed in this tree:

1. **Lenient parse (landed).** An unrecognized event line is counted and
   voiced, never silently dropped, and preserved byte-for-byte in the log
   and the record. `packages/core/src/events/index.ts`'s
   `UnknownEventLine`/`parseEventLenient` is the mechanism; the exact,
   tested voice (`voiceUnknownEvents()`) is `"N events from a newer era
   were preserved but not understood (type-a, type-b, …)"` (singular for
   one event, an overflow `+N more` past four distinct types) — rendered
   verbatim in the replay banner
   (`packages/web/src/replay/Banner.tsx`, `data-testid="replay-unknown-era"`)
   and the session listing (`replay/index.tsx`).
2. **The golden era corpus (landed).** One real recording per era
   (`packages/core/src/eras/era-1/`) folds byte-identically in CI against a
   committed snapshot — plain string equality, deliberately not
   `toMatchFileSnapshot`, so `vitest -u` cannot silently re-bless a
   regression. This is the one event-sourcing orthodoxy this repo had
   skipped until now.
3. **An identity `upcast()` chokepoint (landed).** `packages/core/src/
   events/upcast.ts` is, today, the identity function — but it is the one
   function both the live path and the replay path bottom out in
   (`packages/core/src/reduce.ts`'s `reduce()`), reserved now so the day a
   real migration is needed it has a home every event already flows
   through, rather than a chokepoint retrofitted under time pressure.
4. **The fold-order law — pinned, NOT resolved. See the open ruling below.**
5. **Durability (landed).** fsync on session close and rotation; the
   rotation crash ordering is close-then-open, never both-open, and is
   itself tested.

### The fold-order divergence — OPEN, tracked on #205

`packages/core/src/reduce.test.ts`'s "the fold-order law" fixture proves,
rather than assumes, that **live and replay fold the same interleaved
recording to two different states** on at least three axes: last-write-wins
fields (`agent.status`), create-vs-delete ordering (`branch.updated` vs.
`branch.removed`), and first-sighting order (`commitOrder`,
`firstEventTs`). prd17 ruling 3 item 4 states the law only pins what a
fixture is owed and requires the divergence itself to be *"ruled and
documented"* — that ruling has not been made. **Issue #205 is open**: no
document in this tree, and no code, states or implies a fold-order
guarantee in either direction, and none should be inferred from anything
above. Cross-actor ordering for a future multi-instrument "forest" is
already anchored on the commit DAG (`commit.landed.parents`) rather than
wall clocks, which sidesteps this question for that specific case without
resolving it generally.

### Ruling 1 — the new event families (ruled, landing)

Six additive event types are ruled but only one has landed in code so far:
`session.closed` (landed, prd16's own durability fact — a session's end is
an event, not an absence). **Ruled, not yet landed:** `summons.raised` /
`summons.cleared` (the instrument's own attention judgements, becoming
events — without them, summons precision and time-in-alarm are
uncomputable, exactly what alarm-management practice audits an alarm system
on); `gate.verdict` / `dispatch.brief` / `fence.declared` (a fence becomes
data the moment a lane manifest changes, closing a real gap — today a
recording contains no fences at all, so a trespass can never be re-derived
from the record alone); and `operator.ack` / `operator.verdict` /
`operator.note` (the human's own acts, each stamped with the log offset
they were decided against). Ruling 2's ingestion mechanism (a beacon
collector tailing one-line JSON beacons `gate.sh`/`dispatch.sh` write) and
ruling 4's timeline dividend (gate holds and summonses becoming chapter
marks in the TIDE) are downstream of these event types existing and are
therefore also not yet landed.

## Testing

Mass on core selectors/reducers and collector parsers (fixtures captured
from real command output). Light render tests on panels. The scene is
verified by eyes, not units — said honestly. Merge gate: `npm test` +
`npm run typecheck` green, enforced mechanically both by a workmux
`pre_merge` hook and by `scripts/gate.sh` (fence compliance, a clean rebase,
no NUL bytes, the test/typecheck gate itself, and the actual merge to
`main`) — `scripts/fence-lint.sh` checks a wave's declared fences before any
lane is dispatched against them. 3,158 tests across 202 files pass at commit
`24dcaa5` (`npm test`), alongside a green `npm run typecheck`.

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
- 2026-08-02 — #117: a law pinned to a single number (`turning > 2π`) turned
  out to also be the thing forcing every retired lane into one identical
  shape, because a full turn *is* a ring with an eye in it. The fold that
  replaced the knot is asserted by four clauses instead of one specifically
  so a future regression that re-introduces a shared shape (a "mould") has
  something to trip — clause 4 measures the spread of shapes across an
  identical fleet and would have caught the original bug outright. See
  "Beyond prd7" above.
- 2026-08-02 — #118: an absolute-and-capped growth law can still fail to
  read if the cap is stated as a fraction of the thing growing rather than
  of the picture it grows into — "+30% of resting size" was correct and
  invisible at once, on a fleet with thirty-eight landings. The fix was to
  re-anchor the cap against the scene (half the distance to the retirement
  band) rather than against the mass's own resting radius, and to carry the
  extra growth as interior resolution (more depth shells) rather than a
  larger silhouette — the same lesson as ruling 1's absolute seed sizing,
  applied one level up. See "Beyond prd7" above.
- 2026-08-04 — #156: a session's title is derived from `selectSpendByBranch`
  (lanes, landings, issue numbers), never a separate summary an author has
  to keep in sync with what the reducer already knows — and never invented
  when a session has nothing to say ("no activity recorded" is a real,
  tested value, not an empty string a view has to special-case). The label
  sidecar (`session-<id>.label.json`) is a second file rather than a field
  bolted onto the log for the same reason the log itself lives outside the
  watched repo: evidence that can be edited after the fact isn't evidence.
  See "Recordings as first-class artefacts" above.

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
  `buildFleet`, not the view** ([graft g5](prds/prd3.md)). The calm branch of the
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
- 2026-08-01 — prd4 (issue #92): **law 9 splits into 9a/9b, and the calm
  world gets real hue.** The operator's review named the regression exactly:
  an alpha floor of `0.22` on a calm thread read as "too dark and pale," a
  complaint the old law's "no ladder hue on a calm mark" reading had no way
  to fix without breaking the rule it was defending. 9a moves the "one hue,
  one meaning" guarantee onto a shared six-hue scale (working/done one green,
  waiting-benign/needs-you one amber, at two brightnesses each) enforced at a
  single chokepoint (`ACTIVITY_HUE`/`activityInk` in `scene/palette.ts`); 9b
  moves the actual job of buying a summons its attention onto a measured
  contrast budget (`CALM_CEILING`/`ALARM_FLOOR`/`CALM_FLOOR`/`RECEDE` in
  `scene/salience.ts`), each number pinned by a test against a real fixture
  rather than tunable by eye. See [The layman bar
  (prd4)](#the-layman-bar-prd4) above for the full budget and why `BROKEN` is
  the one hue exempt from `ALARM_FLOOR`.
- 2026-08-01 — prd4 (issue #94): **the transcript endpoint returns records,
  not a rendered string.** `GET /api/transcript/:lane` used to hand back one
  pre-formatted `▌ assistant\n…` string, which forced every presentation
  decision (face, quietness, truncation) into a file a stylesheet cannot
  reach. It now emits `entries: [{ ts?, role, blocks }]` with typed blocks
  (`text` / `tool_use` / `tool_result`, the last carrying a declared
  `dropped` count rather than a silent trim), and the drawer's main view
  (`Conversation.tsx`, renamed from `Transcript.tsx`) renders it CLI-style
  and default-open — superseding prd3 #84's collapsed-by-default transcript.
  See [The layman bar (prd4)](#the-layman-bar-prd4) above.
- 2026-08-01 — prd4 (issue #93): **the scene moved from a panel among panels
  to the centerpiece**, rendering first, hero-sized, directly beneath the
  attention/burn dock, with the fleet table demoted to the legend/detail
  surface beneath it (`PanelGrid.tsx`'s curated order, ruling 2). The
  reorder is registry-only — no panel's own internals changed to earn its
  new position, which is what kept this a same-day, low-risk wave once #92's
  palette landed under it.
- 2026-08-01 — prd4 (issue #95): **parked is a state, not a mute** — see
  the "Parked is a state, not a mute" note under [Lane geography and the
  manifest](#lane-geography-and-the-manifest-prd3-ruling-19) above for the
  manifest field, its three consequences in `buildFleet` and the fleet
  table, and the two gaps (`laneSchema`'s missing schema field for it
  server-side, and the scene's `LaneActivity` union having no member for it)
  left for #96 to document rather than close, since both sit outside a
  docs-only fence.
- 2026-08-01 — prd4 (issue #96, this issue): **docs and screenshots refreshed
  against the landed instrument**, not the plan for it. The screenshots in
  `docs/screenshots/` were regenerated from a live server against this
  repo's own real, in-progress build swarm (`live.png`) and the `fleet20` /
  `pathology` fixtures (`fixture-20-lane.png`, `fixture-pathology.png`,
  `replay.png`), plus one lane drawer opened on a real session
  (`drawer.png`) so the conversation view shows genuine turns rather than a
  fixture's absent-transcript gap state. `live.png` in particular shows real
  attention chips (a stale spike-branch WAITING signal, an off-fence
  trespass) rather than a staged ALL CLEAR — left as-is rather than
  cropped or restaged, since this wave's own brief is to document what
  landed honestly, warts included.
- 2026-08-01 — prd5 (issue #100, the camera keystone): **the camera's laws
  are pure arithmetic over `{k, x, y}`, and d3-zoom owns only the
  gestures.** `Camera` is structurally d3-zoom's own `ZoomTransform`, so a
  transform coming out of a drag or a wheel event needs no adapter before
  `camera.ts`'s functions can be applied to it or tested against it in
  isolation. Two vehicle departures from d3's defaults, both probed live
  before adoption (`docs/research/2026-08-01-obs-prd5-implementation-
  vehicles.md`): `wheelDelta` drops d3's blanket ×10 ctrlKey boost (meant
  for trackpad pinch, and a 4× jump on an actual mouse notch) in favour of
  reading the delta's magnitude directly; `flight()` caps van Wijk's
  suggested zoom-to-fit duration at 420ms rather than the ~2.5s the arc's
  own length would suggest, because a control bound to a keypress that
  takes two seconds to respond has stopped feeling like a control. See
  [The camera (#100, ruling 2)](#the-camera-100-ruling-2) above.
- 2026-08-01 — prd5 (issue #101, the motion budget): **the spring is a
  closed-form step, not an integrated one, because the integrated version
  measurably diverges.** Semi-implicit Euler at this budget's stiffness
  (k=170) reaches −5.2e8 within twenty nominally-10ms steps the moment a
  frame runs long — a backgrounded tab, a GC pause, twenty lanes landing
  together are not hypothetical — while the exact solution sampled at
  whatever `dt` a frame actually took agrees with itself whether stepped
  once at 2s or two hundred times at 10ms. The pause control (WCAG 2.2.2)
  freezes every mark builder by freezing the one clock they all read from,
  with structural motion exempted so a topology change can finish rather
  than freeze mid-flight into a picture of a fleet that doesn't exist. See
  [The motion budget, as law (#101, ruling 4)](#the-motion-budget-as-law-101-ruling-4)
  above.
- 2026-08-01 — prd5 (issue #102, the cord-cut): **a finished lane
  disconnects from the mass instead of being restyled in place**, because
  every graph tool surveyed restyles and nothing found detaches the edge —
  so "is this fleet still working" becomes a structural fact instead of a
  colour a viewer could misread. Fired once per lane, on news only (a
  replayed session builds every scar and animates none of them, the same
  law `pulses.ts` already enforces for traffic); queued behind the
  structural concurrency cap rather than throttled, so a wave of landings
  never cuts more than two cords at once but every cut still happens; and
  never fading below `SCAR_FLOOR`, because invisible completion is
  indistinguishable from a render bug. A same-issue follow-up fix
  (`fix(#102)`) corrected the scar's size from a fixed *fraction* of a
  thread's length (which made a three-o'clock lane's scar three times a
  twelve-o'clock one's, on the wide ellipse a landscape panel produces) to
  a fixed arc length, so every scar is the same size object. See [The
  cord-cut (#102, ruling 3)](#the-cord-cut-102-ruling-3) above.
- 2026-08-01 — prd5 (issue #103, amber aging): **a needs-you summons's
  insistence ages within its rung; the rung itself never changes.** Three
  bands (quiet/ink/pulse) are pinned as shared constants
  (`ageBands.ts`) specifically so the attention chip and the browser-tab
  title can't independently drift onto two different ideas of "how old is
  old" — and `broken`/`notice` are excluded from all of it by construction,
  not by convention. The chip's own CSS pulse duration was landed as a
  literal explicitly flagged in its own comment as provisional, pending
  #101's motion-budget constants; #101 landed an aged pulse for the scene's
  marks but never reconciled the strip's, so the two durations (2,600ms
  vs. 6,800ms) still disagree — a real, open seam, documented rather than
  silently closed by this docs issue. See [Amber ages with the strip (#103,
  ruling 5)](#amber-ages-with-the-strip-103-ruling-5) above.
- 2026-08-01 — prd5 (issue #104, orientation extras): **three keyboard
  registers, not one keymap** — scene-scoped camera keys (#100),
  page-global idle-worker jump (`n`/`Shift+n`), and table-scoped fleet
  verbs (`f`/`a`) — named explicitly in `app/keyboard.ts`'s own comment so
  a fourth register isn't invented by accident later. The jump reuses the
  same `select`/`jump` path a click already takes, so it can never diverge
  from click-driven selection in what it opens or highlights; the table
  verbs reuse the drawer's own `attachPlan`/`copyToClipboard` for the same
  reason. See [Orientation extras (#104, ruling 1+6)](#orientation-extras-104-ruling-16)
  above.
- 2026-08-01 — prd5 (issue #105, this issue): **docs, and the screenshot
  set, regenerated against the finished application** rather than the plan
  for it. `docs/screenshots/` now includes the prd5-era chrome (camera
  controls, the pause button, the hide-finished toggle) on the two
  fixtures, a paused-scene capture, and a scar-bearing scene — the
  `finished` fixture (`fleet/fixtures.ts`'s `finishedSpec`, already used by
  the retire/geometry/marks test suites but not wired to a keyboard key in
  the shipped app) reached through a **temporary, uncommitted** local key
  mapping for the capture session only, then reverted before this issue's
  diff was cut — so the picture is the real rendering pipeline
  (`paint.ts`/`marks/`/`retire.ts`) driven by real fixture data, and the
  fence stays docs-and-screenshots-only in the committed tree.
- 2026-08-02 — prd6 (issue #106, the living cycle): **seed size went
  absolute, and distance changed hands from recency to lifecycle.**
  `seedSize(outputTokens)` (`packages/web/src/scene/geometry.ts`) logs a
  lane's own output between two fixed references and caps it, so a lane's
  size is a fact about that lane — the old relative reading
  (`log1p(output)/log1p(maxOutput)`) shrank every seed the moment the
  fleet's busiest lane worked harder, which is why growth never read.
  **This overrules #102's "a scar is a mark, so it is the same size for
  every lane"** — `scarLengthPx` now scales by the same `sizeFrac`, so the
  rim shows what each lane actually accomplished, and a germinated lane's
  size is floored by whatever its seed had already produced.
  `lifecycleFrac()` blends work done (dominant) and age-since-first-seen,
  pinned to the rim by the cut's own retract — **this replaces prd3 graft
  g6's distance-as-recency**, which needed explaining and so failed the
  layman bar; recency keeps thread lightness, the channel it already
  shared. A same-issue fix pushed a newborn lane's birth radius
  (`bornRadial`) out far enough to clear the root-mass on a cramped panel,
  where the old fixed fraction let the rim close in on a mass that doesn't
  shrink with it. See [prd6 — the living cycle](#prd6--the-living-cycle)
  above.
- 2026-08-02 — prd6 (issue #106): **severed work returns home, and the
  root-mass grows.** `RetireGeometry.homeward` (`geometry.ts`'s
  `homewardFlow()`) rides the cord-cut's own retract stage — no new motion
  budgeted — so a lane's substance visibly travels down its severing
  thread into the mass as it retires. `rootGirth()`
  (`packages/web/src/scene/marks/root.ts`) thickened the mass by up to 30%
  over a session, on the same absolute, two-reference log scale seeds use,
  read off the *drawn* scene (`homecoming(retire)`) so the mass grows
  exactly as each cord parts rather than lurching for a wave of landings —
  **the 30%-of-resting-size cap itself was superseded by #118** (see
  "Beyond prd7" above), which re-anchors the ceiling against the scene
  rather than the mass and carries the growth as interior resolution
  instead of a larger silhouette. A dormant seed (a scarred, retired lane)
  germinates a returning handle's
  new thread from its own seat (`germination()`, matched on `Lane.handles`
  since a re-dispatch can arrive under a new worktree/branch), so the ring
  is never re-spaced by a lane coming back — the one exception graft g7
  itself anticipates. See [prd6 — the living
  cycle](#prd6--the-living-cycle) above.
- 2026-08-02 — prd6 (issue #107, the main node): **the root-mass is
  clickable, and answers with the conductor's own conversation.**
  `MAIN_SELECTION` (`packages/web/src/fleet/selection.tsx`) is a
  pseudo-lane value the one selection slot can hold — deliberately never a
  `Lane` in `fleet.lanes`, so the fleet table, ladder and scene's thread
  list skip it by construction rather than each learning to special-case
  it (`selection.test.tsx` pins that no lane is ever built with this id).
  `SceneView.tsx` hit-tests the mass in the same world coordinates it's
  drawn in, at the same scale-divided tolerance a lane node uses, losing a
  contested pixel to the smaller, more specific target on purpose.
  `GET /api/transcript/main` (`packages/server/src/api/transcript.ts`)
  resolves the conductor by **role**, never by name
  (`findConductorAttribution`), since `--extra-sessions <dir>:<lane>` lets
  an operator call the conductor anything. `LaneDrawer` branches on
  `isMainSelected` before it looks up a `Lane` at all and renders through
  the same `DrawerFrame` a lane's drawer uses; `MainVitals` reuses the
  burn strip's own formatters for its `$`/output/overhead cells rather
  than re-summing them, so the drawer can't disagree with the strip four
  inches to its left. See [prd6 — the living cycle](#prd6--the-living-cycle)
  above.
- 2026-08-02 — prd6 (issue #108, this issue): **docs, and the screenshot
  set, regenerated against the landed living cycle**, the same discipline
  #96/#105 set: nothing here documents the plan, only what `git log`
  confirms landed. `docs/screenshots/` now includes a 20-lane fleet with
  visibly different thread widths (absolute sizing, ruling 1), a rim of
  differently-sized scars beside a visibly thicker root-mass (ruling 1+2),
  and the root-mass's own drawer open on a real conductor session found
  via `--extra-sessions <dir>:conductor` against this repo's own recorded
  telemetry-spike sessions — genuine turns, not a fixture's absent-
  transcript gap state. The `live.png` and `drawer.png` captures were
  regenerated against this worktree's own real, in-progress state (this
  docs lane itself `WORKING`, a sibling lane already landed and scarred)
  rather than staged. As with #105, `finishedSpec` was reached through a
  **temporary, uncommitted** local key mapping (`StreamContext.tsx`'s
  `STREAM_SOURCE_KEYS`) and a temporary, uncommitted weight spread on
  `finishedSpec`'s lanes (`fleet/fixtures.ts`, otherwise a uniform `weight:
  1` that would have made every scar the same size and defeated the point
  of the capture) — both reverted before this issue's diff was cut, so the
  fence stays docs-and-screenshots-only in the committed tree.
- 2026-08-02 — prd7 (issue #112, the prerequisite): **semantic roles are
  renamed to what they mean before ruling 3 touches a single pixel, and the
  rename is proved zero-diff rather than trusted.** The serialized display
  list over 33 frames × 6,072 marks — every fixture, every cut stage, storm,
  reduced motion, pause, spotlight, no-manifest — is byte-identical with
  roles stripped (md5 `fe774758…`, two runs each side), which is what let
  the conductor review a mechanical rename for weakened laws with nothing
  else moving under it. All 70 assertions in `marks.test.ts` were restated
  at equal or greater strength, none deleted; the one one-to-many split
  (`node-thorn` → `node-tip` / `off-fence-mark`) is named rather than
  smuggled, because it is the one place a worker could have quietly
  softened a law while "migrating" it. A `structuredClone` conformance test
  was added alongside the rename (not gated on it) — the boundary
  `postMessage` uses, so a mark that closes over a lane object or carries a
  live handle is caught by construction rather than by a reviewer noticing.
  See [Ruling 2](#ruling-2--semantic-roles-before-any-visual-change-112)
  above.
- 2026-08-02 — prd7 (issue #113, the form keystone): **a thread is a filled
  ribbon now, and every discrete glyph ruling 3 named a replacement for is
  gone, at zero new objects per substitution.** `perfect-freehand` (MIT),
  `d3-shape`'s centripetal Catmull-Rom (ISC) and `simplex-noise` (MIT) are
  the three new runtime dependencies, each adopted only after being probed
  live in this repo's own stack — `docs/research/2026-08-02-observatory-prd7-procedural-form.md`
  — rather than assumed from their docs. Two real bugs surfaced only by
  building a throwaway, uncommitted software rasterizer to actually look at
  the display list: ribbons faceted under the prd5 camera's 6× zoom because
  resampling to a constant sample count threw away half a thread's own
  spine resolution (fixed by defaulting to the spine's own resolution,
  bounded); and the heat licks alternated sides, which read as a zigzag —
  a chevron by another name, quietly undoing the substitution it was part
  of. A wall-clock performance assertion (four times the measured cost) was
  its own flake under concurrent test workers — measured 3.6 ms as 17.1 ms
  on a loaded box three times in twelve runs — and was replaced with a
  **ratio guard** (display-list cost as a bounded multiple of layout cost,
  since both dilate together under load) plus a deterministic vertex cap,
  because a timing assertion under `--maxWorkers` measures the machine, not
  the code. Settled cost: 3.265 ms/frame at 30 lanes against a ~4 ms
  allowance inside the 16.7 ms budget; scene chunk 93,466 → 110,428 B raw
  (+18.8% gzipped), entirely inside the lazily-loaded chunk. See [Ruling
  3](#ruling-3--stop-stroking-lines-start-filling-ribbons-113-the-keystone)
  and [Ruling 4](#ruling-4--bounded-uniqueness-seeded-from-identity) above.
- 2026-08-02 — prd7 (issue #114, the root-mass): **the centre is one
  marching-squares contour now, not fifty-four curls around two glows —
  chosen on a measured 1.28 ms/frame against 42.8 ms/frame for a per-pixel
  metaball field (108.5 ms with SDF+smin), and because a contour is a
  polygon the tests can still query where a pixel buffer would not be.**
  `smin`'s non-associativity is asserted directly (`contour.test.ts`: the
  same field, folded in two orders, gives two different answers), which is
  why `orderFalloffs` sorts by a stable id before any blending happens — an
  unsorted fold would flap the mass's shape frame to frame with no event
  behind it. A same-issue fix (`fix(#114)`, found by rendering the display
  list to a PNG and looking at it) corrected a facet that appeared at full
  arrival swell: a falloff parked deep inside the body contributed a
  near-flat arc at that scale, so what reached the silhouette was a facet
  rather than a curve; moving it smaller and further out removed the facet
  and, as a side effect kept on purpose, made a bulge unable to appear out
  of nothing (below half swell the falloff sits entirely inside the body).
  `root-arrival` — the expanding ring drawn over the mass on every
  landing — is deleted outright; the surface itself now carries that fact
  by swelling toward the substance arriving, which is what a ring never
  could say directionally. `girthOf` reads whatever geometry a mark carries
  rather than assuming `mark.kind === 'stroke'`, so retuning the mass's
  proportions cannot silently break "the mass thickens with landed work"
  (prd6 ruling 2) the way a shape-coupled reading would. See [Ruling
  5](#ruling-5--the-root-mass-as-one-surface-114) above.
- 2026-08-02 — prd7 (issue #115, this issue): **docs and the screenshot set
  regenerated against the landed form change**, the same discipline
  #96/#105/#108 set, extended with two new close-ups this wave's own brief
  asked for: a ribbon bundle showing individual taper and per-lane wander,
  and the root-mass's own melted contour (`docs/screenshots/ribbon-taper.png`,
  `organic-centre.png`). `fixture-20-lane.png`, `fixture-pathology.png`,
  `live.png`, `drawer.png`, `main-drawer.png`, `paused.png`, `replay.png`
  and `scars.png` were all recaptured from a live server against this
  worktree's own repo — `live.png` and `drawer.png` show this docs lane
  itself, alone in the fleet (the #112–#114 worktrees were already merged
  and removed by the time this wave was dispatched, unlike #105/#108's
  captures which caught a sibling lane still landing); `main-drawer.png`
  honestly shows `CONDUCTOR NOT INSTRUMENTED` rather than a conversation,
  since no `--extra-sessions` conductor was wired for this capture. As with
  #105/#108, `scars.png` was reached through the same **temporary,
  uncommitted** detour — a `'4': 'finished'` key added to
  `StreamContext.tsx`'s `STREAM_SOURCE_KEYS` and a varied `weight` on
  `finishedSpec`'s lanes (`fleet/fixtures.ts`) — verified reverted
  (`git diff --stat` empty, and the rebuilt bundle's chunk hashes matched
  the pre-detour build exactly) before this issue's diff was cut, so the
  fence stays docs-and-screenshots-only in the committed tree. Root `npm
  test` (104 files, 1,553 tests) and `npm run typecheck` both green against
  the tree this doc describes.

