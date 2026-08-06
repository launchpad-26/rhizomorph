# Systems chair — distributed systems & data engineering

Council question: *"what functionality are we missing? what am I missing that's
obvious? what design principles should we follow?"* — answered from the
distributed-systems / data-engineering chair.

**Grading.** [Read] = quoted or directly inspected in the repo this session
(read-only, `\\wsl.localhost\Ubuntu\home\lachlan\worktrees-challenge`).
[Audit] = carried from `docs/research/2026-08-05-adversarial-audit.md`, which
graded its own claims. [Journal] = the conductor's journal
(`C:\Users\operator\agenticlaunchpad\JOURNAL.md`). [Prior] = standard literature I
know well, spot-checked against sources today where cited. [Hypothesis] =
needs a run I did not do; I say what run.

Files read in full or substantially: `docs/architecture.md`,
`docs/record-format.md`, `docs/prd11.md`, `docs/prd15.md`, `docs/prd16.md`,
`packages/core/src/record/schema.ts`, `packages/core/src/reduce.ts`,
`packages/core/src/events/{index,common}.ts`,
`packages/server/src/log/{session-log,session-lock}.ts`,
`packages/server/src/api/stream.ts`, `packages/web/src/app/streamState.ts`,
`packages/web/src/fleet/FleetContext.tsx`, the adversarial audit, the
agnostic-adapters spike.

---

## 1. Recording longevity / schema evolution — recordings rot today, silently

**Is "a future reducer folds identically forever" a stated law?** No. The
stated law is *"Live and replay are the same reducer"*
(`docs/architecture.md`, Web section) — an identity across **surfaces at one
version**, not across **versions over time**. The record wrapper carries
`schemaVersion: 1` (`packages/core/src/record/schema.ts:31`) and the spec says
a reader that doesn't understand a version "should refuse, not guess"
(`docs/record-format.md`, manifest table) — but that versions the *envelope of
the file*, and **individual events carry no version at all**
(`events/common.ts`: `{ id, ts, source, type, payload }`). prd11 ruling 3
asserts "the reducer already survives unknown types." That claim is not true
at runtime, and here is the mechanism:

- **The reducer's unknown-type arm is unreachable.** `reduce.ts:110-115` has a
  `default:` case with a `never` cast and the comment "an unknown future type
  must never break a replay" — but unknown types can never reach it, because
  the runtime gate in front of it is `parseEvent` =
  `z.discriminatedUnion('type', [...])` over **literal** type strings
  (`events/index.ts:23-32`). An unknown `type` fails the parse. [Read]
- **The reader's failure mode is silence.** `readSessionEvents`
  (`log/session-log.ts:75-95`) catches every parse failure and *skips the
  line* — deliberately, for torn tails, but the same catch swallows every
  schema mismatch: an event type this build doesn't know, a payload field that
  was renamed or retyped, a `nonEmptyString` that a future emitter allowed to
  be empty. The fold then proceeds on a silently thinner log. No gap voice, no
  count, no refusal. [Read]
- **So both temporal directions rot.** *Old reader × newer recording*: every
  event of a newer type vanishes from the fold (and note the SSE client
  subscribes to frames **by name** — issue #17 decision in
  `docs/architecture.md` — so a version-skewed viewer doesn't even receive
  unknown frames). *New reader × old recording*: any field rename, retype, or
  constraint-tightening in the zod schemas silently deletes historical
  events from every old recording. Zod strips unknown payload keys by default
  [Prior], so purely **additive optional fields are safe** — which is exactly
  the discipline the team already practices (prd11 ruling 2 "additive") — but
  nothing *enforces* it, and nothing catches semantic drift (a field keeping
  its name while changing meaning).
- **The portable record is harder-edged, not safer.** `record-format.md`'s
  verification step 4 parses every line and checks `eventCount ===
  body.length`; a record containing one event type the reader doesn't know
  presumably fails verification wholesale, so `rhizomorph replay <record>`
  refuses the entire artifact (exit 1, no server) over one unknown line.
  [Inferred from the spec text; I did not read `record/verify.ts` — confirm
  whether its second pass treats an unparseable line as failure.] Either way
  the outcome is rot: silent thinning on the session path, total refusal on
  the record path. The hash chain guarantees the **bytes** survive; nothing
  guarantees the **meaning** survives. Hash-chaining bytes you may later be
  unable to parse preserves the envelope and composts the letter.

**How mature event-sourced systems handle this.** [Prior, spot-checked]

- Greg Young, *Versioning in an Event Sourced System*: the base law is
  *"a new version of an event must be convertible from the old version; if
  not, it is not a new version, it is a new event."* Weak-schema +
  **upcasters**: a transform-on-read layer between deserialization and the
  fold, so stored events are never migrated in place
  ([Goodreads](https://www.goodreads.com/book/show/34327067-versioning-in-an-event-sourced-system),
  [event-driven.io on versioning patterns](https://event-driven.io/en/simple_events_versioning_patterns/)).
- **Confluent/Kafka Schema Registry**: compatibility is a *named, enforced
  mode* (BACKWARD / FORWARD / FULL, transitive variants) checked at publish
  time — a producer physically cannot register a schema that breaks the
  declared compatibility with prior versions. The enforcement point is the
  writer, not the reader's goodwill. [Prior]
- **EventStoreDB / Marten / Axon** all converge on: never delete or repurpose
  a type; version by new-type-name or upcaster
  ([Marten's events versioning doc](https://martendb.io/events/versioning.html)).
- **CloudEvents** puts `specversion` on every single event, not on the
  container. [Prior]

**Smallest law + mechanism that makes "recordings never rot" true:**

1. **State the law** (record-format.md, one paragraph): *event types are never
   deleted or repurposed; payload fields are never renamed, retyped, or
   tightened — only added, optional; a semantic change is a new type.* This is
   FORWARD_TRANSITIVE compatibility, self-imposed.
2. **Enforce it mechanically, at write time** (the registry lesson): a
   schema-lock test in core that snapshots the JSON shape of every event
   schema; any diff that isn't a pure addition fails CI. ~Small.
3. **Golden recordings**: freeze one real session JSONL per release as a
   fixture; CI folds the whole corpus with HEAD's reducer and snapshot-asserts
   the fold. This is the *testable* form of "recordings never rot" and would
   already have caught any past violation. ~Small (an afternoon).
4. **Kill the silent skip**: `parseEvent`/`readSessionEvents` gain a lenient
   mode returning `{ kind: 'unrecognized', line }`, counted and **voiced**
   ("214 events from a newer rhizomorph were not understood") — the house
   gap-voice religion applied to the one boundary it currently skips. ~Small.
5. **Reserve the upcaster seat**: one `upcast(parsedLine) → parsedLine`
   chokepoint in front of the reducer, identity today — so the day a rename is
   truly needed, there is exactly one place it lands. ~Trivial now, expensive
   to retrofit later.

## 2. Time — three clock domains already, and live vs replay do not fold in the same order

**What exists.** `ts` is epoch-ms stamped by the *source's own clock* (#56):
`collector.ts:66-70` ("unless `options.ts` names the source's own time,
`now`") [Read]. The codebase itself documents the consequence: *"the final
line of a tail can be older than the line above it"*
(`session-log.ts:158-166`) — even one actor's log is not ts-monotonic. There
is no per-event sequence number; **log position is the only order**, and it is
implicit. The record's hash chain does pin per-actor order cryptographically
(`body` order is chained) — that is stronger than most systems have, worth
saying out loud.

**Ordering guarantees today, honestly stated:**

- Per-actor: append order preserved (log file, chain, and merge law all agree
  — `record-format.md` merge rule "never reorder two events from the same
  actor"). [Read]
- Cross-source *within* one instrument: none. Three clock domains already
  exist **today**, not in the forest future: (a) WSL-side collectors stamping
  observer `now`; (b) the Windows-side conductor's transcripts via
  `--extra-sessions /mnt/c/...` carrying Windows-clock timestamps [Journal:
  the conductor is wired sessionlog-side across the WSL/Windows boundary];
  (c) OTLP exporters stamping their own span times. Usually NTP-close; never
  guaranteed.

**The seam nobody has named: live folds in arrival order, replay folds in ts
order.** Live: `foldStreamEvent` appends in arrival order
(`streamState.ts:64-73`). Replay: `replayStreamState` explicitly requires
"the shared, stably-identified **sorted** log" and binary-searches a
"ts-ascending array" (`streamState.ts:128-135`) [Read]. The core reducer is
**order-sensitive**: `agentStatus` is last-write-wins (`reduce.ts:406`),
`foldUsage` keeps "whichever of the pair arrived first" (`reduce.ts:692`),
`collectorError`'s status ratchet depends on sequence. So whenever ts order ≠
arrival order — which the code documents happens — **the same session can
fold to a different final state live than in replay.** The audit cleared
"replay identity" at the fold-function level ("both call the same core
reduce") and missed that the *input order* differs. [Read for the two order
sources; **Hypothesis** for a demonstrated divergence — the killing test is a
fixture with two same-lane `agent.status` events whose ts order inverts their
log order, folded both ways.]

**What skew does to the derived surfaces:**

- **Alarms** (`ageMs`/`workAgeMs` = viewer-`now` − source-`ts`): a conductor
  whose clock runs 90s behind reads as drifting toward FROZEN; one running
  fast can never trip WAITING. The thresholds are minutes-scale so today this
  is tolerable — but the arithmetic mixes clock domains with no stated bound.
- **The boot boundary**: `findResumableSession` takes the max event ts; a
  source clock jumped *forward* a day makes `previousAgeMs` negative and the
  session resumable for a day past its real staleness (`session-log.ts:180`).
  A max "never overstates freshness" is only true when no clock is ever fast —
  the comment's own premise ("every source timestamp is in the past") is a
  clock-trust assumption, unstated. [Read]
- **The TIDE / news**: `isNews` compares source ts against viewer
  `connectedAt` (`streamState.ts:56-58`) — a fast source's history flares as
  news within the 4s grace; replay is protected only because
  `REPLAY_CONNECTED_AT = MAX_SAFE_INTEGER` [Audit].
- **The merge / forest**: cross-actor order is *raw ts with `actor.instance`
  tiebreak* (`record-format.md`). Under skew, causality inverts silently:
  actor B's reaction to actor A's commit can sort before the commit. Two
  actors' instruments never exchange messages (law 2: nothing auto-transmits),
  so there is no channel for logical-clock information to flow.

**Literature vs the pragmatic answer.** Lamport clocks capture happens-before
only through *communication events* ([Lamport 1978], [Prior]); rhizomorph
actors deliberately never communicate, so Lamport/HLC across actors has
nothing to propagate on. HLC (Kulkarni, Demirbas et al. 2014 — the
[Logical Physical Clocks paper](https://cse.buffalo.edu/tech-reports/2014-04.pdf),
adopted by CockroachDB/MongoDB) is the right tool **only if** live federation
ever ships; prd15 explicitly rules it out ("records only"). So:

- **Pragmatic now (small):** (1) stamp `recordedTs` (observer clock at append)
  on the envelope, additively — one clock domain per instrument; state the law
  *all liveness/alarm arithmetic compares timestamps from one clock domain*.
  (2) Make the fold-order law explicit — rule either "the fold order is log
  order" or "the fold order is ts order, stable-sorted", and make live and
  replay obey the same rule, pinned by the divergence fixture above.
- **The forest's causal skeleton is git, not clocks.** This is the
  domain-specific gift: two actors watching one repo share the commit DAG, and
  `commit.landed` carries `parents` (`reduce.ts:334`). Commit ancestry is a
  true happened-before relation that survives any skew and needs no message
  exchange — a merge can order and *validate* cross-actor interleavings
  against it ("actor B saw sha X land, so every B-event after that sighting is
  after A's commit"). Anchor cross-actor causality on the DAG; let ts be a
  display order. No other system in this space gets a free vector clock from
  its own subject matter.

## 3. The gate is outside the record — the thesis's own admission control is invisible

**Confirmed.** The landing gates — fence-clean check, `npm test` + typecheck,
12/12 runs under load, post-merge build, holds and re-gates — run as shell
scripts in the conductor's untracked scratchpad (`scratchpad/gate-lane.sh`,
[Journal:974]; "FOURTEEN issues landed behind 12/12 gates" [Journal:1008]) and
emit **no events**. The gate's verdicts live in journal prose on another
machine. Meanwhile prd11's stated purpose is *"causality — why did this code
happen"*, and the record is hash-chained and signature-ready specifically so a
stranger can trust it.

**As a systems gap:** the log captures *effects* (commits, tokens, pane
churn) but not *decisions* (admission control). In event-sourcing terms, the
commands are missing. The trust-relevant causal chain for any landed change is
five links: **brief → fence → work → gate verdict → merge**. The record today
holds link 3 fully, link 5 as a bare `commit.landed`, and links 1, 2, 4 not at
all. For the federation story this is acute: the artifact you can
cryptographically verify is precisely the one that cannot answer "did this
change pass its gate, and what did the gate check?"

**Census of what else lives outside the record and shouldn't:**

| Outside the record | Where it lives | Should it be an event? |
|---|---|---|
| Gate verdicts (incl. holds, re-gates, load confounds) | untracked scratchpad scripts + journal prose | **Yes** — the single highest-value missing event type |
| Fence definitions | `.swarm/lanes.json`, read live per request, never evented — and replay deliberately doesn't fetch it (`FleetContext.tsx:67`: `useLaneManifest(source === 'live')`) [Read], so **a recording has no fences at all**: off-fence trespasses are un-re-derivable from any replay or exported record | **Yes** — `fence.declared` on manifest change |
| Dispatch briefs | conductor's prompts dir | Digest + issue ref, yes |
| Operator rulings / prd blessings | docs prose | Borderline — a `ruling.recorded` beacon would date-stamp constitutional changes into the sessions they governed |
| Labels, resume counters, locks | sidecars, deliberate | No — correctly outside (mutable operator metadata must not enter an append-only evidence log) |
| Session close/rotation act (prd16) | will be a UI button | **Yes** — see §4 |

**Mechanism, without violating the constitution.** The gate is the
*conductor's* tooling, and rhizomorph "observes, never instruments" — but
prd15 ruling 2 already blessed the exact mechanism: the **beacon collector**
(a rhizomorph-owned directory of one-line JSON events written by cooperating
tools). Extend the beacon vocabulary with
`gate.verdict { lane, issue, headSha, checks: [{name, pass, detail}], verdict }`
and `dispatch.brief { lane, issue, briefDigest }`; `gate-lane.sh` drops one
line per verdict. Separately, the git collector already polls the watched
repo read-only; noticing `.swarm/lanes.json` changed and emitting its content
as a `fence.declared` event violates nothing and closes the replay-has-no-
fences hole in one motion. Rough cost: **M** (two additive event types + one
emitter line in the gate script + one collector diff), and it converts the
instrument's single largest blind spot into permanent record.

## 4. Crash / durability — good torn-tail hygiene, unstated fsync and rotation invariants

**What's proven or well-built** [Read]:

- Torn last line: `appendFile` per event; on resume, `dropTrailingPartialLine`
  truncates back to the last newline (`session-log.ts:58-68`); readers skip
  malformed lines. A process kill mid-append costs at most the line in flight.
- The #187 lock: pid + 5s heartbeat, stale at 20s, **both signals must
  agree** (`isLockLive`, `session-lock.ts:103-106`) — pid-reuse handled by
  staleness, crash handled by pid-death. The five-reason boot decision
  (`writer-alive` etc.) is exemplary self-explanation.
- The live session is served from the recorder's in-memory buffer, never the
  file, so reads can't race the writer (`api/sessions.ts:23-26`).

**Invariants that are unstated or unproven:**

1. **No fsync, ever.** `appendFile(..., 'utf8')` with no `fdatasync`. Process
   crash: fine (page cache survives). **Power loss**: an arbitrary tail of
   *acknowledged, already-streamed* events can vanish. The invariant worth
   stating is **prefix durability**: *after any failure, the log on disk is a
   prefix of what subscribers were shown.* True for process crash; unproven
   for power loss (and on some fs configurations a torn write can leave
   garbage mid-file, which the line-skip reader tolerates but the record
   export would then chain over). For an evidence instrument, "what you
   watched live" and "what the recording holds" diverging is a real, if rare,
   honesty failure. Cheap posture: fsync on rotation/close and on
   `export-record`; accept the window during steady streaming, and *say so* in
   record-format.md. [Read for the code; Hypothesis for actual power-loss
   behavior — needs a pull-the-plug or `dm-flakey` test.]
2. **Lock heartbeat is a non-atomic overwrite.** `writeSessionLock` rewrites
   the lock file in place every 5s (`session-lock.ts:59-63`); a crash
   mid-write leaves corrupt JSON, which `readSessionLock` reads as *"no writer
   claims this session"* — momentarily inviting a second writer onto a file
   whose writer is alive. Tiny window, standard fix (write-temp + rename), and
   the same temp+rename rule should be law for every sidecar. [Read]
3. **Concurrent appends rely on unstated O_APPEND atomicity.** `append()` has
   no internal queue; two in-flight `appendFile`s rely on single-write
   O_APPEND atomicity for non-interleaving. Practically fine on local Linux
   fs at these line sizes; it is an assumption, not a stated invariant. [Read]
4. **Rotation (prd16) has no crash story yet, and no `session.closed` event
   exists.** Today a session's end is only inferable from the next file's
   existence. Rotation must be an *ordered* act: (a) append + fsync a terminal
   event in the old log naming the successor id → (b) capture transcripts
   (staged: temp dir + rename) → (c) `session.started` in the new log naming
   the predecessor. That doubly-linked chain makes every failure mode
   *detectable*: power loss between (a) and (c) leaves a closed log naming a
   successor that doesn't exist — a loud, precise state instead of an
   ambiguous gap. prd16 ruling 3 already demands capture failures "say so
   precisely"; extend the same demand to the boundary itself. Cost: one ruling
   sentence + one event type inside the wave that's already scheduled.
5. **Capture-on-close atomicity.** One busy lane ran ~9MB of transcript
   (prd16); a crash mid-copy must not leave a half-transcript that replay
   trusts. Stage-and-rename, plus a capture manifest (list of captured files +
   sizes + digests) so a recording can state its own completeness. The digest
   also future-proofs sharing: prd16 says a recording is "the thing most
   likely to be shared" — a capture manifest is what a stranger verifies.

## 5. Scale ceilings and backpressure — the fold is now flat; the re-walkers and the corpus are what remain

**Already fixed since the audit** (credit where due): the ledger one-liner
(#171) and the no-panel-refolds law; the judge head-movement gate (#172); the
reducer's O(1) usage/trace indexes (#179/#184 — the WeakMap-detach design in
`reduce.ts` is genuinely good engineering [Read]); first-load batching (#183:
boot 1.1s, first paint 25ms [Journal]). The audit's P1/P2 fold findings are
closed.

**Remaining ceilings, in order of arrival, with honest numbers:**

1. **Browser: unbounded `StreamState.events` + full-log re-walks (weeks).**
   `events: [...state.events, event]` still accumulates forever
   (`streamState.ts:41,67` [Read]; #176 ruled "B-then-shrink" 2026-08-05
   [Journal:729] but not landed). The drawer (`foldActivity`,
   `attachPlan`) and feed re-walk the full array **per incoming event while
   open** [Audit]. At the measured ~46-55k events/day (49% `pane.activity`
   [Audit census]), a two-day session ≈ 100k events → each pane-activity burst
   costs a 100k-element walk per open consumer on the main thread. This is
   the first *felt* ceiling: days, not months. Cost to close: M, already
   ruled — land #176.
2. **Host: poll subprocess fan-out (lanes, not days).** ~(branches + worktrees
   + panes) spawns per 2s poll ≈ 80–120 `git`/`tmux` processes per tick on a
   40-lane fleet [Audit P3], competing with the very agents being watched.
   Ceiling ≈ 50–100 lanes on one box. Not urgent at today's fleet; it is the
   number that bounds "one instrument per repo per machine," which matters for
   the forest's sizing story. Mitigations are per-collector (skip unchanged
   panes via `list-panes` activity flags; batch `status`).
3. **Disk + listing: the corpus (months).** No rotation until prd16; ~46k
   events/day ≈ 10–20MB/day JSONL (est. at 200–400B/line — unmeasured
   [Hypothesis]); prd16 capture adds up to ~9MB/lane/session. The sharper
   problem is not bytes but that **`GET /api/sessions` full-parses every
   session file on every request** — documented as a deliberate
   correctness-over-cost choice when the corpus was small
   (`architecture.md`, #156 section) and concurred with by the audit *for
   that call site* — but prd16's `/recordings` library makes it a
   room you visit, over a corpus that only grows. Months in, mounting the
   library is a full-corpus parse. Fix is a summary **sidecar written at
   rotation** (the listing row computed once, at close, immutable thereafter
   — the same sidecar posture labels use). Cost: S–M, and it belongs inside
   prd16 wave 3.
4. **SSE fan-out (forest-time).** Each subscriber gets its own
   `JSON.stringify` per event (`stream.ts:6-9,63` [Read]) and each fresh
   viewer replays the entire session. At 1–3 viewers today: irrelevant. At
   forest scale: serialize-once-write-many is a trivial fix; backlog-per-join
   is O(session) and wants the keyframe/index the replay path already has.
   Cost: XS now or later.
5. **Scene: per-frame geometry over ever-growing retired strands.** #175
   measured paint <20%, recomputation of never-changing geometry ~80%
   [Journal]. Bounded by landings, mitigable with the cache `heart.ts` already
   models [Audit]. Cosmetic-tier relative to 1–3.

**Backpressure, stated as absences:** there is none anywhere — collectors
never shed, the recorder buffer never bounds, SSE never coalesces, and the
`pane.activity` firehose (49% of all events, mostly heartbeat) has no
server-side thinning. The honest framing: at one repo, one operator, the
system doesn't need backpressure; every 10× (lanes, viewers, days) currently
converts directly into memory or CPU somewhere with no relief valve. The
events-diet ruling (#176) is the first relief valve; name the others when
their 10× arrives.

## 6. Process architecture — one process is right today, but the recorder's lifetime is the seam that matters

**What one process owns:** six-plus collectors, the OTLP receiver, the judge,
Fastify (API + SSE + static web), the recorder (buffer + JSONL writer + lock
heartbeat), and the lab's second hand. [Read: architecture.md; cli boots
collectors + server.]

**Coupling, honestly:** a *collector* crash is well-contained — the
error/degraded/disabled ratchet with recovery is exactly right
(`reduce.ts:130-213` [Read]). What is not contained is everything else
sharing one fate: a scene-induced browser tab crash costs nothing, but a
Fastify OOM, a judge subprocess storm, or an unhandled rejection anywhere
takes down **recording** — the one function whose downtime is unrecoverable
evidence loss (the gap in the log is permanent). The lock heartbeat dying
also opens the session to a competing writer after 20s. Meanwhile the UI —
the component you most want to restart freely (upgrades, port conflicts,
experiments) — shares the recorder's lifetime, so every UI restart is a
recording interruption bridged only by the resume window.

**What a split buys, mapped to the stated futures:**

- **Agnosticism (prd15):** the thing you `npm install` on the box where
  agents run is a small headless recorder daemon (collectors + writer + lock
  + OTLP door); the viewer runs anywhere. Windows-native verification
  (ruling 7) gets easier when the verified surface is a daemon with no UI.
- **The forest:** N recorders (one per repo per machine) + any number of
  viewers is the only shape multiplayer can take; a monolith forces every
  viewer onto the recorder's box and every recorder to carry a UI.
- **Durability:** recording survives UI/upgrade churn; blast radius of a
  viewer bug drops to zero.

**What it costs now:** process supervision (who restarts the daemon), doctor
complexity, a second deploy artifact — real costs, and **not worth paying
this quarter.** The honest observation is that the architecture is already
*wire-shaped*: the web talks only HTTP/SSE; server-internal coupling is one
`ServerContext` carrying the recorder. The cheap, high-leverage move is to
**name the seam now**: keep one process, but (a) make recorder + collectors a
lib with a narrow interface that owns *all* writes (log, lock, rotation,
capture), (b) land prd16's rotation/capture strictly on the recorder side of
that seam, (c) forbid the UI/server side from ever holding state the recorder
can't rebuild. Then the daemon split, when the forest forces it, is a
packaging change, not a rewrite. prd16 is the last cheap moment to draw this
line — rotation and capture are recorder verbs, and if they land entangled
with the Fastify context the seam closes.

---

## (a) Ranked missing functionality / missing invariants

| # | Missing thing | Evidence | Rough cost |
|---|---|---|---|
| 1 | **The fold-forever law + golden-recording CI corpus + lenient unknown-event handling.** Recordings rot today: unknown types and tightened schemas are silently skipped on read (`readSessionEvents`), or brick a whole portable record. No stated cross-version law exists. | §1; `events/index.ts:23`, `session-log.ts:87-92`, `reduce.ts:110` (dead comfort) | S (law + corpus + schema-lock test) → M (lenient parse + gap voice + upcast chokepoint) |
| 2 | **Gate verdicts, dispatch briefs, and fence definitions as events.** The trust chain (brief → fence → work → verdict → merge) has 3 of 5 links off-record; recordings contain no fences at all (`useLaneManifest(source === 'live')`). | §3; [Journal:974,1008]; `FleetContext.tsx:67` | M (beacon vocab + one emitter line + `fence.declared` collector diff) |
| 3 | **A session boundary that exists in the record: `session.closed`/rotation as a linked, fsynced, evented act with staged capture.** Today the end of a session is inferable only from the next file; prd16 will add rotation with no crash-ordering ruling yet. | §4.4–4.5; prd16 rulings 2–3 | S ruling + S build, inside prd16's scheduled waves |
| 4 | **Land #176 (bounded browser events + projections).** Ruled B-then-shrink, not built; first felt ceiling (~100k events / two days) — full-log re-walks per event while drawer/feed open. | §5.1; `streamState.ts:41,67`; [Audit P1-2; Journal:729] | M, already ruled |
| 5 | **A stated fold-order law + the live/replay order-divergence test.** Live folds arrival order, replay folds ts order, the reducer is order-sensitive — the "same reducer" law doesn't cover input order. | §2; `streamState.ts:64-73` vs `:128-135`; `reduce.ts:406,692` | S (one fixture, one ruling) |
| 6 | **Durability posture: temp+rename for all sidecars (lock heartbeat first), fsync at rotation/close/export, prefix-durability stated in record-format.md.** | §4.1–4.3; `session-lock.ts:59` | S |
| 7 | **`recordedTs` on the envelope + one-clock-domain law for alarm arithmetic; git-DAG ancestry as the forest's causal anchor (ts becomes display order).** | §2; `collector.ts:66`, `record-format.md` merge rule | S now (additive field + law); forest-time for DAG-anchored merge |
| 8 | **Listing sidecar written at rotation, so `/recordings` never full-parses the corpus.** | §5.3; `architecture.md` #156's own admission; prd16 ruling 4 | S–M, belongs in prd16 wave 3 |
| 9 | **Serialize-once SSE fan-out + recorder-death honesty in the viewer** (a viewer that outlives its recorder must say so, not freeze). | §5.4, §6 | XS–S |
| 10 | **The recorder/UI lifetime seam named in code (headless-recorder-shaped lib), ahead of any process split.** | §6 | S now vs L later |

## (b) Candidate design principles, stated as testable laws

1. **The fold is total.** No event any recorder ever wrote is silently
   dropped by any reader; "unrecognized" is a counted, voiced category, never
   a skip. *Test:* inject an unknown-type line into a fixture log; assert the
   envelope count includes it and a gap voice names it.
2. **Recordings never rot.** For every release *m* and every reducer version
   *n ≥ m*, folding the frozen release-*m* golden recording with reducer *n*
   yields a state whose *m*-era facts are byte-identical to the *m*-era fold.
   *Test:* the golden corpus in CI; schemas may only gain optional fields
   (schema-lock snapshot).
3. **One clock per judgment.** No derived value may compare timestamps from
   two clock domains without a stated skew bound; all liveness/alarm
   arithmetic uses the observer's clock. *Test:* a skewed-clock fixture
   (conductor +10min) must not move FROZEN/WAITING/boot-resume decisions.
4. **If it gated the merge, it is in the record.** Every `commit.landed` on
   the main branch during a conducted session is preceded by a `gate.verdict`
   event naming its sha; absence is a voiced gap, never silence. *Test:* a
   selector over any recording asserts the pairing and reports violations.
5. **Every write is an append or an atomic rename.** The log only appends;
   every sidecar and capture is written to a temp path and renamed; therefore
   a crash at any instant leaves (a prefix of the log) + (only valid
   sidecars). *Test:* crash-injection — truncate/corrupt mid-write in a
   harness and assert every reader returns a valid prior state.
6. **The viewer holds nothing the recorder can't rebuild.** Kill the viewer
   at any moment: reattach loses nothing (Last-Event-ID resume — exists).
   Kill the recorder: the viewer says so within one heartbeat rather than
   rendering a frozen fleet as live. *Test:* the #166 resume test (exists) +
   a recorder-death banner test (missing).

## (c) What the operator is missing that's obvious

**The gap-voice discipline — this codebase's own religion — stops exactly at
the parse boundary, and that boundary guards the permanent record.** Every
surface in the instrument refuses to render absence as nothing: conductor
not instrumented, no lane manifest, unplaced dollars, capture-couldn't —
all voiced. But when `readSessionEvents` meets a line it doesn't understand,
it *silently discards evidence* (`session-log.ts:87-92`), and when the SSE
client meets a frame type it doesn't know, it never even receives it. The one
place the honesty law isn't applied is the one place that decides what the
permanent, hash-chained, signature-ready, meant-to-outlive-this-machine
record *means*. You have versioned the file and not the events; you have made
tampering detectable and rot undetectable. The forest's foundational artifact
— a stranger's recording, replayed in a year, under a newer reducer — fails
in the exact mode this project was built to abolish: quietly, with a
confident picture and no voice saying what's missing. The fix is small
(§1: one law, one golden corpus, one lenient-parse gap voice, one upcast
chokepoint) and it is the difference between "the bytes survived" and "the
session survived."

---

### Sources

Repo (read-only): `docs/architecture.md`, `docs/record-format.md`,
`docs/prd11.md`, `docs/prd15.md`, `docs/prd16.md`,
`docs/research/2026-08-05-adversarial-audit.md`,
`docs/research/2026-08-05-agnostic-adapters-spike.md`,
`packages/core/src/{reduce.ts,record/schema.ts,events/index.ts,events/common.ts,collector.ts}`,
`packages/server/src/{log/session-log.ts,log/session-lock.ts,api/stream.ts,api/sessions.ts}`,
`packages/web/src/{app/streamState.ts,fleet/FleetContext.tsx}`.
Conductor journal: `C:\Users\operator\agenticlaunchpad\JOURNAL.md` (gate
machinery, #176 ruling, #171–#187 wave outcomes).

Literature:
[Greg Young, *Versioning in an Event Sourced System*](https://www.goodreads.com/book/show/34327067-versioning-in-an-event-sourced-system) ·
[event-driven.io, simple patterns for events schema versioning](https://event-driven.io/en/simple_events_versioning_patterns/) ·
[Marten, events versioning](https://martendb.io/events/versioning.html) ·
[Kulkarni, Demirbas, Madappa, Avva, Leone — *Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases* (HLC)](https://cse.buffalo.edu/tech-reports/2014-04.pdf) ·
Lamport 1978, *Time, Clocks, and the Ordering of Events in a Distributed
System* [Prior] · Confluent Schema Registry compatibility modes [Prior] ·
CloudEvents `specversion` [Prior].
