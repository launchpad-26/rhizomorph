# prd-37 — the shared world: the repo is the landscape, and an organism is a person

> **Status:** parked · **Kind: specifying** (`docs/prds/README.md`) — proposed future direction,
> zero of six Success criteria implemented and no current backlog. Moving back into flight
> requires renewed operator blessing. Reconciled 2026-08-22 at `03df141`.
> **This PRD carries the reframe the UI era was rebuilt around** (`docs/design/ui-2.0-decisions.md`):
> the repo is the landscape and an organism is a *person* — a developer, their conductor, and
> their agents as threads. Several people working one repository are several colonies in one
> world, and **multi-person observability is what this instrument is for**, not a later stage.
> The UI is designed for it now (prd-33 ruling 7, prd-36, prd-31 ruling 5) and **ships
> solo-first**: one swarm renders as one complete colony, and this PRD lands underneath a UI that
> already assumed it. Sequenced in stage 4, in parallel with prd-33 — they are independent.
> Consumes the metamorphosis design (`docs/metamorphosis/system-design.md`, PR #462) for the
> observatory half; that document owns the transport, this one owns what a person sees.

## Problem

Every agentic team is running the same experiment blind. Four people point swarms at one
repository, and each of them can see exactly one thing: their own. Nobody can answer *who is
working what right now*, so two people start the same issue. Nobody can see *whose agents are
touching my files*, so the collision surfaces at merge time instead of at edit time. Nobody knows
*what the team is spending*, because every burn strip counts one machine. And when somebody's lane
blocks at 2am waiting for an answer, it waits until they wake up, even though a teammate was
awake and watching.

The instrument already computes all four of those facts — for one person. `selectCollisionPairs`
finds two branches touching one file today; it simply never sees another machine's branches. The
attention ladder ranks what needs a human today; it only ever ranks yours. The gap is not
analysis. **It is that every rhizomorph is an island, and the interesting questions are all
between islands.**

There is a second problem, one level up: an organisation running agentic workflows across several
teams has no way to observe that at all — not to surveil people, but to answer whether the
practice is working, where the cost is going, and which teams are stuck.

## Evidence

- **The collision machinery is already right and already blind.**
  `packages/core/src/selectors/collisions.ts` derives file×branch collisions from the fold; the
  fold contains one repo's events from one machine. Cross-person collisions need no new
  algorithm — they need other people's events in the same fold.
- **The metamorphosis already designed the transport.** `docs/metamorphosis/system-design.md`
  (PR #462) rules the observatory half: collectors ship an append-only log to **one server the
  team runs**, org → project(repo) tenancy, humans by borrowed org membership, machines by
  minted project-scoped ingest keys. **True peer-to-peer sync is rejected by name** there, so
  this PRD inherits a decided transport rather than reopening it.
- **The veil is already filed as the biggest trust change.** #461 — *the veil: what leaves a
  machine is ruled, not assumed* — names transcript text as per-project opt-in, redacted at the
  collector. This PRD's ruling 3 is that issue's UI half.
- **Identity already exists in the log, once.** Commit events carry a git author identity; it is
  the only person-shaped fact the instrument holds, and it is how an operator's email once turned
  up in a privacy sweep. Nothing else declares who a swarm belongs to.
- **The UI is already built for it.** prd-33 ruling 7 composes colonies; prd-36's fleet surface
  shares one selection model across representations; prd-31's run view is durable and
  attributable. None of them need redesigning to carry other people.

## Success

1. A person sees their teammates' swarms as colonies in the same world. **Not met while** the
   scene can render only one colony, or a teammate's lanes appear as an undifferentiated list.
2. Collisions cross people. **Not met while** two agents on two machines editing one file is
   invisible until merge.
3. Nobody is surveilled into it. **Not met while** any word a person did not choose to share
   leaves their machine, or the sharing state is not visible to the person sharing.
4. Shipping solo is unaffected. **Not met while** a person watching only their own repo sees
   scaffolding for a team they do not have.
5. The team's cost is answerable. **Not met while** spend can only be summed per machine.
6. An organisation can observe the practice without reading anybody's conversation. **Not met
   while** the only way to see whether agentic work is going well is to read what agents said.

## Non-goals

- **Not accounts, not OAuth, not a cloud.** Identity is declared locally (ruling 2). The server
  is one machine the team runs (metamorphosis, inherited). "Nothing leaves the machine" becomes
  **"nothing leaves the team"**, and that is a widening with a stated boundary, not an abandonment.
- **Not surveillance.** No idle tracking, no read receipts, no per-person productivity metric, no
  ranking of people — prd-17's non-goal ("no operator-surveillance framing") and ADR-0010's
  named-not-ranked posture both extend here. **A leaderboard of teammates is forbidden for the
  same reason a leaderboard of experiment arms is** (prd-12 ruling 4).
- **Not the transport.** The metamorphosis owns ingest, tenancy and keys; this PRD owns the
  reading and the veil's controls.
- **Not a chat.** The instrument shows what is happening; it is not where the team talks about it.

**Rejected alternatives.** *Everything visible by default* — maximum insight and the fastest way
to make people uncomfortable enough to turn the whole thing off; the veil exists because trust,
once spent, does not come back. *Per-repo global toggle* — one person's choice would bind
everybody's words. *Peer-to-peer* — rejected by name in the metamorphosis design.

## What already exists (do not rebuild)

The collision, spend, liveness and attention selectors — all of which become cross-person the
moment the fold contains more than one machine's events. The metamorphosis's transport design.
`SelectionProvider` and the derived fleet, which already model many lanes and need only an owner
dimension. prd-30's disclosure card, which is where a teammate's condition explains itself
without a new vocabulary.

## Rulings

## Ruling 1 — an organism is a person, and the repo is the landscape

The composition is settled by prd-33 ruling 7 and named here as product: **one colony per
person**, sharing a world that is the repository. A colony contains that person's conductor and
their agents; a thread is a lane; the mass is what they have landed.

The hierarchy this implies, and which the reading must support, is **org → team → repo →
person → agents**. The instrument's own scope stays one repo per server (the metamorphosis's
project tenancy); the org level is a question asked *across* servers and is deliberately the
thinnest layer here (ruling 5).

## Ruling 2 — identity is declared once, locally, on top of the identity already in the log

A person is identified by their **git identity** — the author identity the log already carries —
with a **one-time local declaration** of a display name and a colour, made in settings
(prd-35 S1's "You" group). No accounts, no auth flow, no network dependency, and it works before
any team server exists.

The colour is chrome, never status: it distinguishes whose colony is whose, and it is drawn from
a set that cannot collide with the six status hues or the category family (prd-32 ruling 8) —
identity is a *label*, and a label may never be mistaken for a state.

## Ruling 3 — the veil: facts always, words only if you share them

**Per-person opt-in, and the person opting in is the person whose words they are.**

- **Facts always leave**: lanes, states, elapsed times, spend, files touched, commits, outcomes,
  collisions. These are what coordination needs and they carry no prose.
- **Words leave only on an explicit opt-in**: prompts, agent text, transcripts. Default off. The
  control is in settings (prd-35 S1's "Sharing"), stated in plain language, and its state is
  visible to its owner at all times.
- **The view is uneven by design.** A teammate who shares facts only is not a second-class
  citizen and must not render as a degraded one: their colony is complete, and where words would
  be, the surface says *this person shares facts, not words* — a statement of a choice, never an
  honest-gap voice implying something is broken.

Redaction happens **at the collector**, before anything is sent — not at the server, and not at
the reader. A word that never left cannot leak.

## Ruling 4 — collisions cross people, and that is the feature

The collision surface stops being a curiosity and becomes the instrument's sharpest team
argument: **your agent and my agent are editing the same file right now.** It renders with both
owners named, both lanes reachable, and the file's provenance intact.

It obeys every rule it already obeys: a real collision is a ladder item; an empty state carries
its evidence (*"collisions: 0 — checked 47 branches across 4 people"*) and never bare
reassurance; no severity is invented from co-editing alone, because two people touching one file
is a fact, not yet a problem.

## Ruling 5 — the org view is a roll-up of facts, and it never reads a conversation

Organisation-level observation answers three questions and no others: **where is work happening**,
**what is it costing**, and **who is stuck**. It is a roll-up of the same facts the team view
shows, across repos and teams, and it **never** includes words — the veil does not have an
organisational override, and there is no role that can see through it.

It also carries no per-person comparison. Cost by repo, cost by team, blocked-lane counts, and
throughput of landed work are all legitimate; a ranking of people is not, and the same reasoning
that forbids ranking experiment arms forbids it here — a number that becomes a target stops
measuring the thing (`docs/roadmap.md`'s Goodhart guard, ADR-0010's named-not-ranked).

## Ruling 6 — solo is the default, and it never looks like a team with nobody in it

An instrument watching one person's swarm shows **one complete colony** and nothing else: no
empty seats, no "invite your team" prompt in the scene, no greyed-out teammates. The team layer
appears when there is a team, and until then its absence is invisible rather than advertised.

This is what makes "design for it, ship solo-first" honest rather than a promise: a solo user is
not looking at a degraded team product.

## The specification

Six answers per surface, per `docs/prds/README.md`.

### S1 — the shared world (the scene with many colonies)

**What and why.** Several people's swarms in one landscape.

**States.** *solo* (one colony, ruling 6 — indistinguishable from a single-user product) ·
*team, all present* (one colony per person, each labelled with its owner's declared identity) ·
*team, someone idle* (their colony at rest — prd-33 ruling 12's idle composition, per colony) ·
*team, someone offline* (their colony renders its last known state, **explicitly timestamped**:
"as of 14 minutes ago", never as if live) · *facts-only teammate* (complete colony; words
unavailable **by their choice**, said as a choice) · *no server configured* (solo, silently) ·
*server unreachable* (your own colony renders live; teammates render last-known with the gap
named once) · *replay* · *demo* (the simulated fleet may render as several colonies to show the
team story — marked simulated, as always).

**Data source.** The team server's fold (metamorphosis transport) merged with local events;
identity from each person's declaration; spend, collisions and liveness from the existing
selectors, now over a fold containing several machines.

**Interactions.** Camera as today; selecting a teammate's lane opens its run view read-only,
with words present only if they shared them; the disclosure card explains a teammate's condition
in the same vocabulary as your own.

**What would make it wrong.** A stale colony rendering as live · a facts-only person rendering as
broken or degraded · identity colour colliding with a status hue · any word rendered that its
owner did not share · a solo user seeing team scaffolding.

**Acceptance.** A fixture with three colonies renders correct per-person attribution; an offline
colony renders its timestamp; a facts-only colony renders complete with the choice stated; a test
asserts no transcript text is present for a non-sharing person **at the client at all** (not
merely unrendered).

### S2 — cross-person collisions

**What and why.** Ruling 4's feature, in the dock's collisions tab.

**States.** *none* (zero with its evidence, naming how many branches and people were checked) ·
*within one person* (as today) · *across people* (both owners named, both lanes openable) ·
*unknown* (a person whose file-touch facts have not arrived: named, not assumed clean).

**Data source.** `selectCollisionPairs` and `selectTouchesByBranch` over the merged fold, plus
identity for attribution.

**Interactions.** Open either lane; the disclosure card explains what the collision is and what
it is not.

**What would make it wrong.** A collision presented as a fault · an unknown rendering as zero ·
an owner unattributed.

**Acceptance.** A fixture with two people editing one file renders the pair with both owners; the
empty state names the people and branches checked.

### S3 — the sharing control

**What and why.** Ruling 3's veil, where its owner controls it.

**States.** *facts only* (default) · *facts and words* · *changed just now* (the control states
what will and will not leave from this point, and that nothing already sent can be recalled — an
honest statement about an append-only log).

**Data source.** Local preference; the collector reads it before sending.

**What would make it wrong.** A default that shares words · a control that implies retroactive
redaction · sharing state invisible to its owner · anyone else able to change it.

**Acceptance.** With words off, a test asserts the collector emits no transcript text; toggling
on affects only subsequent events; the control states the append-only truth plainly.

### S4 — the org roll-up

**What and why.** Ruling 5's three questions, across repos.

**States.** *live* · *partial* (some repos not reporting: named and counted, never averaged over
silently) · *empty* (no repos configured).

**Data source.** Per-repo fact roll-ups only. **No words, no per-person comparison, structurally
absent rather than filtered.**

**What would make it wrong.** Any conversation content reachable from here · a per-person ranking
· a partial roll-up presented as complete.

**Acceptance.** A test asserts the org surface's data shape contains no transcript field at all;
a partial roll-up names which repos are silent.

## Sequencing (waves, each gated as ever)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it. Every wave follows
prd-32 wave 1's tokens, and the scene work follows prd-33's colonies.

1. **Keystone:** identity — the declaration, its persistence, its colour set, and attribution
   through the fold to the derived fleet. Solo-visible immediately (your own colony gains a name),
   and everything else depends on it.
2. Parallel, fenced apart: the veil's control and collector-side redaction (**rides #461**) ·
   cross-person collisions over a merged fold (**rides the metamorphosis transport**) · the
   many-colony reading in the scene (**rides prd-33 wave 1**).
3. The org roll-up.

Unfiled work implied, described not numbered: the timestamping of a stale colony; the
facts-only voice; the demo fleet's multi-colony variant.

## Open questions

- **Whether a teammate's run view is reachable at all when they share facts only** — proposed
  yes, with words absent and the choice stated; open, not ruled.
- **How the org level is configured** — a list of team servers, or a server that federates
  others. The metamorphosis owns the transport answer; this PRD waits on it.
- **Whether identity colour is chosen or assigned** — chosen risks collisions and taste
  arguments; assigned risks nobody recognising themselves. Open, not ruled.
- **What happens when two people declare the same display name** — proposed: both render, both
  disambiguated by git identity; open, not ruled.
- **Whether spend roll-ups need per-person consent** separate from the words veil — cost is a
  fact by ruling 3, but a team that reads it as a productivity metric would be misusing it, and
  that misuse is foreseeable. Open, not ruled.
