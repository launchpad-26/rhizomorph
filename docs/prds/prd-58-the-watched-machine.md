# prd-58 — the watched machine: the instrument watches the operator, the client shows one repo

> **Status:** ACCEPTED — drafted 2026-09-15, filed 2026-09-15 alongside prd-57, blessed by the
> operator 2026-09-17. prd-57's last wave landed as #579, so the gate this document set on its own
> grooming is spent and waves 1–5 are groomed against the tree prd-57 actually produced. Two of
> its debts came with it: **#597** (a `Notification` hook reaches no lane) and **#590** (a lab fork
> starts its arms concurrently).
> **Kind:** specifying.
> **Milestone:** `prd58`, opened at filing so `prd-location-law` has a manifest row for this
> document from its first commit (`.swarm/prd-milestones.txt`; coupling lines 171-173).
> **Depends on prd-57** — every wave here assumes the process witness, the hook witness, the enlist
> grant and the installation id exist. Nothing here is buildable before prd-57 wave 3.
> **Licenses one ADR** at most: **0056** (amends ADR-0013 — a collector's tick budget is per watched
> repo, not per instrument), if wave 2's measurement says the budget needs restating. Filed only if
> the measurement demands it, never in advance.
> **Zero new dependencies.**

## Problem

prd-57 removes the multiplexer, so the instrument works in any terminal. It still watches **one
repo**, chosen at boot, and an agent running anywhere else on the machine is invisible.

That is the wrong shape for what the tool now sees. The process witness enumerates every agent on
the machine regardless of where it is; the hook witness receives declarations from every enlisted
session in every repo. Both are already machine-wide at the source and are then discarded down to
one repo by a boot argument. An operator with three repos open runs three instruments or sees one
third of their work — and `POST /api/retarget` exists precisely because that choice, once made at
boot, is expensive to change.

The first draft of this design said: watch the machine, draw every repo at once. That trips
`web/src/scene/tripwire-law.test.ts`'s ``describe('`live` has no shipped fixture …')`` block
(`:203-230`), which pins `useFrameLoop.ts` to a one-colony call and proves in the file that a
two-colony call would not match — and it reopens prd-52 ruling 3's supported-size question, in a
document `#500` currently holds.

**That collision is avoidable, because it came from conflating two things.** What the instrument
*watches* and what the client *composes* are independent. Watch everything; compose one; let the
operator choose which. The scene's call site never changes, the size law stays green, prd-52 stays
closed, and the machine-wide view becomes a later, elective feature rather than a prerequisite.

## Evidence

- **The scene law is live and specific.** `tripwire-law.test.ts:212-213` defines
  `ONE_COLONY_CALL` as a regex over `layoutWorld([{ id: LOCAL_COLONY, fleet: current.fleet }], …)`;
  `:215-220` asserts `useFrameLoop.ts` matches it and `:222-229` proves a two-colony call would not.
  Its comment (`:49-56`) explains that `live` has no shipped fixture *because* the call site
  composes one colony — so a two-colony call would remove the ground on which `live` is excluded
  from the size law. **This design preserves the call site, so none of that moves.**
- **The machinery already takes N.** `web/src/scene/geometry/world.ts`'s `layoutWorld` accepts a
  list; prd-52 built it that way. Composing several remains possible and stays unbuilt.
- **The record is locked to one repo by arithmetic.** `docs/record-format.md:119` —
  `genesis = sha256hex('rhizomorph-record:${schemaVersion}:${repoSlug}:${actor.instance}')`. The
  repo slug is inside the hash chain's genesis, and `mergeRecords` refuses across it (`:39`). So a
  machine-wide recording is not a thing that can exist: N repos means N recorders, period.
- **The recorder is already per-slug.** prd-16 writes under `~/.local/share/rhizomorph/<repo-slug>/`,
  where the slug is *"a sanitized repo basename plus a short hash of its absolute path"*
  (`record-format.md:39`). Rotation, retention and `rhizomorph archive` are per recorder.
- **The wire carries one project per batch.** `core/src/wire/protocol.ts:41,56` — `project:
  nonEmptyString`. prd-51's shipper is per project. N recorders means N shipper scopes, and the
  protocol is unchanged.
- **`retarget` is twelve files**, not one: `api/retarget.ts` + two tests, `server/retarget-cost.ts`
  + test, `server/retarget-validation.ts` + test, `contract/src/retarget.contract.test.ts`,
  `web/src/concierge/retarget.ts` + test, and two research notes — plus its `ROUTE_CLASSES` row
  (`api/index.ts:123`), its import and registration, and its `MUTATING_MODULES` entry
  (`mutating-calls-law.test.ts:198-202`). **It is also enumerated by name inside accepted ADR-0008**
  (`:84-92`, ten gated mutations listed individually).
- **Six files carry a prose route count** that any route change moves: `api/security.ts:75`,
  `api/lane-index.test.ts:20`, `api/gated-reads.test.ts:80`, `docs/architecture.md:157`,
  `SECURITY.md:142`, `server/mutation-guard.ts:100-102`, plus ADR-0008:85. `route-class-law.test.ts`
  pins 34 twice and 29 once.
- **`/api/meta` has no version** (`api/meta.ts:263-266` — `repoPath`, `sessionId`, `startedAt`).
  Two independently-updating clients make that a real gap.
- **ADR-0013 bounds a collector tick** at 5s per exec, 10s per poll
  (`docs/design-notes/collector-tick-budget.md`), written when one repo was watched.

## Success

1. **The instrument watches the operator, not a path.** Started with no repo argument on a machine
   with agents in three repos, it records facts for all three, each into its own recording, and
   `doctor` names all three. **Not met while** any agent's facts are discarded for being outside a
   chosen repo.
2. **The client composes exactly one colony, still.** `tripwire-law.test.ts`'s `ONE_COLONY_CALL`
   assertion is **unchanged and green** at the end of this PRD, and `useFrameLoop.ts` still passes a
   single-element list. **Not met while** that law is edited, skipped, or made to pass by widening
   its regex.
3. **Switching repos is a view change, not a restart.** Choosing a different watched repo re-renders
   from facts already held; no collector restarts, no recorder rotates, no session ends. Round-trip
   under a declared ceiling, measured. **Not met while** switching requires a boot, or while it
   loses a lane's history.
4. **N recorders, N records, unchanged format.** Each colony's recording exports as a portable
   record that verifies, and ships over protocol v1 with no edit to `docs/record-format.md` or
   `packages/core/src/wire/protocol.ts`. **Not met while** either file appears in any fence.
5. **Colony attribution never enters an event.** The colony a fact belongs to is carried by the
   frame and the response envelope. A fixture asserts no event schema in
   `packages/core/src/events/` carries a project or colony field. **Not met while** any does — and
   note this is what keeps the era unchanged and old recordings folding identically.
6. **An unwatched colony still raises attention.** A lane that flatlines, crashes or reaches
   `waiting-permission` in a colony the operator is not currently viewing produces a count on the
   selector and an entry in the fleet list. **Not met while** the only way to learn of it is to
   switch to it.
7. **The envelope is stated.** The per-colony tick cost is measured on a machine watching at least
   three repos, and the support envelope names a watched-repo ceiling with a number behind it.
   **Not met while** the ceiling is reasoned rather than measured.
8. **The API declares a version and the client refuses a mismatch by name.** **Not met while** a
   version mismatch produces anything other than a `/connect`-voice refusal naming both versions and
   the remedy.
9. **Words true in the same commit.** The Trust section, `SECURITY.md` and `docs/vision.md`'s
   "point it at a repo" framing change in the commit that makes each false.
10. **`packages/team/` carries no edit.**

## Non-goals

- **Composing more than one colony in the scene.** The machinery takes N; this PRD passes one. A
  simultaneous multi-colony view is its own PRD and owes prd-52 ruling 3 a measured answer about
  supported size before it ships.
- **Deleting `retarget`.** It narrows (ruling 4).
- **A daemon that survives logout, or an OS service.** Autostart is a tray preference, nothing more.
- **Cross-colony analysis.** Machine-wide spend and cross-repo comparison are selectors over N
  recordings and are a later PRD; this one makes them possible and builds none of them.
- **Remote or containerised harnesses.** Still invisible, still the relay's problem.

## Rulings

### Ruling 1 — the instrument watches the operator; the client chooses the colony

The watched set is **discovered**, not declared: a repo becomes a colony when an actor is placed in
it (process cwd → toplevel) or a transcript names it. An operator may still pin one, and starting
inside a repo pins that repo first — so today's behaviour is the zero-configuration case of the new
one.

The client renders **one** colony at a time, chosen by a selector. `useFrameLoop.ts` continues to
pass a single-element list to `layoutWorld`, so `ONE_COLONY_CALL` is untouched and prd-52's size
question stays closed. The selector is a view control: it changes which colony's fleet the scene
composes, and nothing else.

### Ruling 2 — N recorders, one per colony, and the record format does not move

One recorder per colony under its own slug, exactly as prd-16 writes it. Rotation, retention and
archive stay per recorder; prd-44's no-default retention ruling is inherited per recorder, not
centralised.

This is not a choice. `record-format.md:119` puts `repoSlug` inside the genesis hash and
`mergeRecords` refuses across it — a machine-wide recording cannot be expressed in this format, and
the format is not up for amendment here (Success 4).

The shipper runs per enabled colony. prd-51's `project` is one repo, as it always was.

### Ruling 3 — colony attribution lives in the transport, never in the event

An event says what happened; the frame says which colony it happened in. The SSE frame and every API
response envelope carry the colony; no event schema gains a field.

Two consequences, both load-bearing: **there is no new era**, because no event changes shape and an
old recording folds identically; and a recording remains exactly what it is today, one colony's
events, so export and shipping are untouched.

The stream is the open question this ruling forces and wave 1 answers: one stream carrying a colony
tag per frame with the client filtering, or a stream per colony. Both satisfy this ruling. The
decision is measured against `streamState.ts`'s existing one-session assumptions, not argued.

### Ruling 4 — `retarget` narrows; it is not deleted

The first draft deleted `retarget` because "there is no target." Under ruling 1 there is a target —
it is chosen from what is already watched. So `POST /api/retarget` keeps its name, its
`gated-mutation` class and its `ROUTE_CLASSES` row, and changes meaning: **it selects the rendered
colony from the watched set** rather than re-pointing the instrument at a path.

This is the cheaper and the more honest call. Twelve files are modified rather than removed; the
route counts in six prose sites and `route-class-law.test.ts`'s three pinned numbers do not move;
**accepted ADR-0008's enumeration of ten gated mutations stays true**, so it needs no amendment
blockquote. What changes is the route's validation (a colony id from the watched set, not an
arbitrary path), its cost model (`retarget-cost.ts` — selecting a known colony is not a re-clone),
and the wizard step that explains it.

Where the operator names a repo that is **not** watched — a path with no agent in it — the honest
answer is a distinct act, not a stretched `retarget`: the concierge already clones and launches, and
"watch a repo where nothing is running yet" is pinning, which wave 3 designs.

### Ruling 5 — an unwatched colony is still heard

A colony the operator is not viewing still produces facts, and the ones that need a human still
reach them: the selector carries a count of lanes at `waiting-permission`, `crashed` or flatlined
per colony, and the fleet list — which is a table, not a scene, and composes freely — shows every
colony's lanes.

This is what makes ruling 1 safe. Rendering one colony is only acceptable if not rendering the
others hides nothing that needs you.

### Ruling 6 — an actor outside every repo is named, not hidden

An agent running outside any git repository is an actor with no lane. It is reported in the fleet
list under a stated placement of "no repository", counted in machine-wide spend, and appears in no
colony's scene. It is never silently dropped, and it never invents a colony.

### Ruling 7 — the tick budget is restated per watched repo, from measurement

ADR-0013's ceilings were written for one repo. Wave 2 measures the per-colony cost of every collector
on a machine watching at least three, and the support envelope states a ceiling with that number
behind it. **ADR-0056 is filed only if the measurement shows the existing budget cannot hold** — not
in advance, and not on reasoning.

### Ruling 8 — the API declares a version

`/api/meta` gains `apiVersion`; the client compares on boot and refuses a mismatch by name in
`/connect`'s voice, naming both versions and the remedy. `doctor --json` freezes a
machine-readable shape. Small, and it exists because prd-57's CLI and the Electron shell can update
independently.

### Ruling 9 — words change in the same commit

The Trust section, `SECURITY.md` and `docs/vision.md`'s "point it at a repo" framing change in the
commit that makes each false. README admits one claimant per wave.

## Sequencing

**Territory.** No wave enters `packages/team/`, `docs/record-format.md`,
`packages/core/src/wire/protocol.ts`, or **`packages/web/src/scene/`** — ruling 1 exists so that
last one holds. `web/src/scene/view/useFrameLoop.ts` is **not** fenced by any wave; if a wave finds
it needs to be, that wave stops and the ruling is revisited.

**Wave 0 — operator acts.** Bless · confirm prd-57's last wave landed · rule the stream shape
(ruling 3) from a reading of `streamState.ts` · rule the pinning act's shape (wave 3) · decide the
tray autostart default.

**Wave 1 — the fold takes a colony.** Colony identity and discovery from placement · the frame and
envelope carry it (ruling 3) · the fixture asserting no event does · the stream shape from wave 0 ·
`buildFleet` keyed per colony. Additive; no scene, no recorder change yet.

**Wave 2 — N recorders.** One recorder per colony under one server · per-colony rotation, retention
and archive · the shipper per enabled colony · the per-colony tick measurement (ruling 7) and the
envelope statement · `doctor` names every watched colony. **README claimant: the support envelope.**

**Wave 3 — the selector, and `retarget` narrowed.** The selector UI and its per-colony attention
counts (ruling 5) · `retarget` changes meaning across its twelve files with its route class, counts
and ADR-0008 enumeration **unchanged** · the pinning act for a repo with nothing running · the
fleet list showing every colony including unrooted actors (ruling 6) · the round-trip measurement
(Success 3). **README claimant: the selector paragraph.**

**Wave 4 — the shell and the version.** `/api/meta`'s `apiVersion` and the client's refusal ·
`doctor --json` · the tray's autostart preference in prd-35's settings registry, badge counting
`waiting-permission` across all colonies. **README claimant: the CLI reference.**

**Wave 5 — words and closeout.** The Trust rewrite, `SECURITY.md`, `vision.md` · the closeout: each
Success assessed, what was measured versus reasoned, and an explicit statement of whether the
one-colony composition still holds or whether the multi-colony PRD is now owed.

## Wave 0 — the operator's rulings, 2026-09-17

Recorded as an amendment rather than by editing the rulings above, which stand as filed.

**The stream shape (ruling 3) — ONE stream, a colony tag per frame, the client filtering.**

Ruled on a reading of `streamState.ts` rather than argued, as ruling 3 asks. The reading changes
the size of the question: `foldStreamEvents` checks `opensNewSession` **inside** its loop and, on a
boundary, resets `events`, `news`, `newsCount` and `session` wholesale (`:224-230`) — and
`StreamContext.tsx` holds exactly one **live** `StreamState` (`:225`; the replay scrub composes its
own through `replayStreamState`, which is a separate fold and not a second colony). So a recording
rotation in one colony
would wipe every other colony's state.

**The client therefore holds one `StreamState` per colony under either transport.** That is forced
by the fold, not by the stream, so the choice was only ever about connections — and one connection
keeps one reconnect path, one backoff and one handshake, against N of each. The fan-in moves to the
server, where the collectors already are.

Two obligations this creates, both wave 1's:

- `MAX_EVENTS` (75,000) and `MAX_NEWS` (256) become **per-colony** ceilings, so the raw window is
  N times what it was. `MAX_EVENTS` was chosen against measured 46k–55k-event sessions; whether it
  is still the right number per colony is a measurement, not an assumption.
- The `opensNewSession` reset must scope to the colony whose frame carried the boundary. A reset
  hoisted out of the per-colony map would be the same defect the comment at `:204-210` already
  warns about, one level up.

**The pinning act (wave 3) — there is no new act; a watched repo is one an agent is in.**

Ruled the way the question itself suggests: *"watching an idle repo writes nothing at all, so it may
need no hand."* It writes nothing because there is nothing to write — ruling 1 discovers a colony
when an actor is placed in it, so a repo with no agent is a repo this design never learns about. A
pin would create a colony that exists only in a preference file, with an empty fleet and a row in
the selector that never changes. That is a thing to explain rather than a thing to use.

**Stated precisely, because a draft of this overstated it** (caught in review of the PR that filed
these rulings): *"a repo with no agent produces no facts for any collector"* is false. Point the git
collector at any repo and it emits `worktree.discovered`, branches and dirty state, agent or no
agent. The honest form is narrower and is a **policy** rather than a fact about the collectors:
ruling 1 makes an actor the thing that constitutes a colony, so an agent-free repo yields nothing
this PRD would call a colony's facts — not nothing at all.

The case the operator actually has — *"I want something running in that repo"* — is already an act
this instrument offers: the concierge clones and launches, and the colony appears the moment the
agent does. So wave 3 builds **no pinning primitive**, and the selector's empty state says what to
do instead.

What ruling 1's "an operator may still pin one" keeps meaning: **pinning is ordering, not
watching.** Starting inside a repo puts that colony first in the selector. That is a preference
about presentation and it is all it is.

*Overturnable in review.* If the operator wants a repo watched before anything runs in it, that is a
different feature with a different cost — a colony with no actor needs a reason to exist in every
selector, every count and every recording decision — and it should be its own issue rather than a
clause inside wave 3.

**The tray autostart default (wave 4) — OFF.**

The house has ruled this shape before and in this direction: prd-44 #38 on retention, *"there is no
default age, and that is the ruling"*, and ADR-0010 rejecting a silent default for adapter
capabilities by name. An instrument that starts itself because it was installed is making a
decision the operator did not make. Wave 4 ships the preference and the off position; turning it on
is one click and an explicit one.

## The groomed waves

Filed 2026-09-17 against `prd58`, fence-linted clean wave by wave.

| wave | issues |
|---|---|
| 1 — the fold takes a colony | #605 (colony identity), #606 (the frame carries it), #607 (one stream, N fold states) |
| 2 — N recorders | #608 (N recorders), #609 (the measurement and the envelope — README claimant), #610 (doctor and the shipper) |
| 3 — the selector, retarget narrowed | #611 (retarget), #612 (counts, the list, unrooted actors), #613 (README claimant) |
| 4 — the shell and the version | #614 (apiVersion and the refusal), #615 (tray, autostart, badge — README claimant) |
| 5 — words and closeout | #616 |

**Inherited from prd-57**, because they are debts its closeout named rather than
new work: **#597** (a `Notification` hook reaches no lane — the other half of
prd-57's Success 6), **#590** (a lab fork starts its arms concurrently) and
**#617** (a declined beacon is counted and named).

One README claimant per wave, as `.swarm/coupling.txt` requires, and no two
issues in a wave claim a common path.

## Open questions

- ~~**The stream shape** (ruling 3).~~ **Ruled 2026-09-17** — see wave 0 above.
- ~~**Pinning a repo with nothing running.**~~ **Ruled 2026-09-17** — no such act; see wave 0.
- ~~**Tray autostart default.**~~ **Ruled 2026-09-17** — off; see wave 0.
- **Watched-set ceiling** — a number from wave 2's measurement, and what the instrument does at it:
  refuse, or watch and say so.
- **Whether the selector remembers** across restarts, and where that preference lives.
