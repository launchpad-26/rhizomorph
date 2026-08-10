# prd-27 — the declared voice: attention that says so, and no silent states

> **Status:** proposed — implements prd-15 ruling 2 (the hook beacon, wave 3, unlanded) and extends
> it to the rendering side; picks up the two non-goals prd-19 named and left open, #192 and #223.

## Problem

The operator cannot trust a summons, and cannot act on a silence. When the instrument says a lane
needs them it is guessing from the shape of a transcript, and that guess has already been wrong — so
the summons is read with suspicion, which costs it the only thing a summons has. Meanwhile the states
the instrument is surest of reach no surface at all, and those that do arrive as one word (WAITING,
or a tooltip reading `stopped`) with no why and nothing to do. Both failures cost the same thing:
attention spent in the wrong place.

## Evidence

The instrument's own self-declaration — this PRD's thesis
(`packages/server/src/collectors/sessionlog/collector.ts:45`):

```ts
attention: { level: 'partial',
  reason: 'inferred from transcript shape via the turn-shape state machine, not declared by the CLI',
  remedy: 'a hook beacon would declare it (prd15 ruling 2, wave 3)' }
```

- **The false-summons scar (#133, 2026-08-03, closed).** The strip summoned a healthy lane: pane
  content-hash still **65s and 93s** while the agent delegated to a subagent, workmux never declaring
  waiting, its own telemetry arriving throughout. Verified in tree — the second witness is
  `SPAN_WITNESS_WINDOW_MS` (`fleet/constants.ts:55`) read at `buildFleet.ts:158`, and the false
  positive is a replayable fixture (`buildFleet.test.ts:406`) beside its inverse law and the
  uninstrumented case. Inferred: I did not replay the raw session log.
- **The surest reading in the tree renders as nothing.** `deriveLaneState` computes four states every
  poll, but `agentStatusEmissionFor` is tested and unwired, BLOCKED because `envelope('workmux',
  'agent.status', …)` pins `source` to the literal `'workmux'` — *"if both witnesses sign their
  observations `workmux`, a disagreement between them cannot even be seen."*
- **No remedy renders anywhere.** `Gap` carries `{what, why, command}`; `Pathology` carries
  `evidence` only, and `remedy` has no hits across `packages/web/src`. `ACTIVITY_TITLE.waiting` is
  the word `'stopped'`.
- **#192**, operator ruling 2026-08-05: *"the waiting tag can be misleading, especially if we aren't
  explaining at a glance WHY it's waiting."* **#223**, 2026-08-06: twelve landings went into the
  watched repo over 12 hours, including the fix for the symptom the operator was still reporting.
  **#147**, 2026-08-04: lanes read `est.` for hours behind a dead exporter.

## Success

1. An instrumented agent that stops for a human is named blocked **because it said so**, within one
   beacon interval of the hook firing, reading `declared` not `inferred`. *Not met while* any lane's
   `attention` reads `provided` without a beacon received for it.
2. No lane and no source renders a condition without a why and a remedy — or, absent one, without
   naming what is missing and which rung would prove it. *Not met while* a state word reaches the
   screen with an empty why, or an unknown condition renders rather than failing typecheck.
3. A server running code older than the `packages/**` it watches says so, in the UI and in `doctor`.
   *Not met while* stale data renders as calmly as current — beacon lapse and cost coverage included.
4. The #133 fixture stays green: a delegating lane, still pane, live telemetry, no summons.

## Non-goals

- **Not a control channel.** A beacon reports; it never takes instruction — no inbound direction, no
  queue the instrument writes into, no acknowledgement the agent waits on. ADR-0001's three hands and
  prd-20's amendment are the boundary: a fourth hand costs its own ADR, never a writable directory.
- **Not desktop or phone notifications.** "Nothing leaves the machine" is a live trust ruling
  (ADR-0008); an OS notification is a separate decision the leads have not made.
- **Not the removal of inference.** prd-15 ruling 1's organ stays universal; an uninstrumented harness
  keeps all it can infer. The beacon is an upgrade, never a prerequisite — #133's third law for
  attention.
- **Not the adapter contract** (prd-15 ruling 4 — prd-19's non-goal cites ruling 3; ruling 4 states
  it), and no per-CLI emitters beyond claude. No new hue, no fifth state, no era/upcast work.

**Rejected alternatives.** *Polling the agent* — the observer never instruments, and a poll is a write
into what is watched. *Scraping pane text harder* — the #133 scar is what that produces; the pane was
stillest when the agent was busiest. *A control socket* — a privileged channel and an ADR-0001
amendment spent to carry what a file line carries. *Notifications as the answer* — relocates the
guess; a wrong summons is worse on a phone.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — a beacon enters through an existing door, never a new privileged channel

prd-15 ruling 2 already ruled the beacon collector; this names its door. Proposed: the collector
contract over a watched directory (ADR-0004), not a new POST route — a hook that appends a JSON line
needs no network, and a route is a new privileged surface on a localhost-only server (ADR-0008).
Either door folds through the one reducer (ADR-0002), so live, replay and fixtures answer
identically. **ADR owed** on the beacon directory and event contract; the leads own the choice.

## Ruling 2 — `agent.status` must name its witness; this is the keystone

`envelope('workmux', …)` becomes `envelopeWithSources([…], …)`, as the existing BLOCKED note
specifies. Until then the organ's four states cannot be published at all, and a beacon that could
publish would sign someone else's name — forged provenance on a hash-chained log (ADR-0009). One
change unblocks both witnesses. **ADR owed**: widening a pinned envelope source is a format decision.

## Ruling 3 — `attention` moves to `provided` only where a harness actually declared

Not when hooks are configured, not when the collector is present — when a beacon for that lane has
arrived. `deriveRung` makes `provided` mean L4 (tmux/workmux) today; the beacon is L2, and
`collector.ts` already flags that distinction as its follow-up. **A human must decide** whether a
configured-but-silent beacon reads `partial` with a reason or `absent`; proposed `partial`, since
"configured and quiet" differs from "never offered".

## Ruling 4 — a declaration may raise a summons; an inference alone may only withdraw one

Read #133 precisely: it required agreement to **raise** an alarm, never to lower one; extend that
asymmetry. A declared WAITING summons; an inferred WAITING alone renders inferred (the `~` mark
exists) and stays the weaker claim; a beacon saying *working* suppresses an inferred summons; an organ
inferring *working* never suppresses a declared one, because the human was asked by name. The trade —
a false summons costs a wasted trip, a late alarm costs latency — is the one #133 already made and
tested. Disagreement renders: prd-15 ruling 2 forbids silent resolution, and
`LaneStateReading.evidence` is deterministic to the byte for exactly this.

## Ruling 5 — every renderable condition carries why and remedy, and an unknown one fails the build

#192's vocabulary as a pure total selector over folded evidence, each condition carrying three
strings — label, why (with evidence and elapsed), remedy — assembled once so every surface says it
identically, as `Gap` already does for feeds. `unknown` stays, and must name what is missing and which
rung would prove it. Exhaustiveness is a `_never` switch (the `rungInfo` pattern), so a new condition
fails typecheck before it renders bare. No new hue, no fifth top-level state.

## Ruling 6 — the instrument's own condition is a first-class state, in a lane's own alphabet

Three faults share one shape — code older than the `packages/**` it watches (#223), a beacon that
stops speaking, and an exporter dead behind an `est.` (#147) — so they get one law, each with a why
and a remedy: "built at `<sha>`, watching main at `<sha>` (+N)", remedied by a restart the operator
performs and never an auto-restart; "declared attention lapsed 3m ago; reading turn shape" rather than
a silent revert; and authoritative coverage per session ("0 of N expected-instrumented lanes delivered
authoritative cost"), checked by `doctor`. **#147 is adopted here, not left separate:** exempting
`cost` would leave one of the six signals outside this PRD's own law. All three are siblings of
prd-19's VERIFIED / BROKEN / UNPROVEN.

## Sequencing (waves, each gated as ever)

1. **Keystone:** ruling 2 — the source widening, its ADR, and the organ's four states published
   edge-triggered (the BLOCKED note is the brief). Nothing is visible until this lands.
2. Fenced apart: **#192**'s condition vocabulary and the fleet STATE hover · **#223**'s staleness
   voice in header and `doctor`.
3. Beacon collector + claude hooks emitter (prd-15 ruling 2's wave 3, capture-first per
   dialect-verification), the manifest move, the L2/L4 rung distinction, the disagreement voice.
4. Beacon lapse · **#147**'s authoritative coverage and its `doctor` check (ruling 6).

Unfiled work implied, described not numbered: the envelope widening plus the organ's publication; the
beacon directory/event ADR; the beacon-lapse state; the rung derivation that tells a declaring beacon
from tmux.

## Open questions

- **N intervals before a beacon is lapsed** — open, not ruled; no interval has been measured, and the
  value wants a design-note rather than a guess.
- **The beacon's door** — ruling 1 proposes the file drop; the leads decide, and it is an ADR either
  way. **Configured-but-silent beacons** — `partial` or `absent` (ruling 3). **How disagreement
  renders** — chip or hover card (ruling 4); visual form is the implementer's.
- prd-19's open question — whether "waiting" sources feed the gap registry and attention strip — now
  touches this vocabulary. Named, not ruled; whoever rules it owns both.
