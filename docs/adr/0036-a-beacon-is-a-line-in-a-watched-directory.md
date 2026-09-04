# 0036. A beacon is one JSON line appended to a rhizomorph-owned directory and tailed by a collector

- **Status:** accepted (ruled by the operator 2026-08-24 in prd-27's and prd-17's amendments; recorded on the build, #217)
- **Date:** 2026-09-04

## Context and Problem Statement

The instrument's weakest signal is attention, and it says so about itself:
`packages/server/src/collectors/sessionlog/collector.ts` declares `attention:
partial` — *inferred from transcript shape … a hook beacon would declare it*.
The false summons of #133 is what inference costs. prd-15 ruling 2 blessed the
remedy — an agent CLI's own hooks write one-line JSON beacons that a collector
tails — and prd-17 ruling 2 then asked the same doorway to carry the conduct
tooling's decisions (a gate's landing, a dispatch). Two PRDs, one door, and the
door's shape was never recorded: where a beacon is written, what one line is,
what happens to a malformed one, and why it is a file and not a request.

Three constraints bound the answer. ADR-0001: the observer writes nothing into
the watched repo and takes no instruction. ADR-0002: every fact is an event on
one log, through one reducer, live and replay alike. ADR-0008: the server is
localhost-only and every mutating route is a privileged surface that must be
token-gated and enumerated.

## Considered Options

- **A — A file drop.** Writers append one JSON line per beacon to a file of
  their own in a rhizomorph-owned directory; a collector tails the directory
  through the standard contract (ADR-0004) and emits an event per line.
- **B — A `POST /api/beacon` route.** Hooks and scripts send the beacon over
  HTTP to the running server.
- **C — A control socket.** A Unix socket the CLI's hooks connect to.
- **D — Widen `agent.status`.** No new event; the beacon collector emits
  `agent.status` for declared attention.

Within A, two sub-choices were weighed: a single instrument-wide
`~/.local/share/rhizomorph/beacons/` (the agnosticism spike's sketch) versus a
per-repo directory beside that repo's recordings; and carrying the whole line
in the event versus carrying the occurrence with a digest.

## Decision Outcome

Chosen: **A**, per-repo, occurrence-plus-digest.

**The directory** is `<dataRoot>/<repoSlug>/beacons/` — `beaconDirFor()` in
`packages/server/src/collectors/beacon/paths.ts` — beside the recordings it
will be read with, invisible to `listSessions` like `snapshots/` and
`transcripts/`. **Per-repo beat instrument-wide** because a beacon from one
repo's swarm must never fold into another repo's session: the pi collector
learned that scoping the hard way (#609) and had to enforce it by header; a
directory keyed by the repo's slug enforces it structurally. A writer names
its own file — `<writer>.jsonl`, one per writer, so concurrent hooks never
interleave inside one line — and the collector tails every `*.jsonl` in the
directory. **The collector never creates the directory**: creating one's own
input is one step from writing into it, and the writer that appends is the
one that knows the directory has to exist.

**The line** is `{ "v": 1, "at": <epoch ms>, "writer": …, "kind": …, "lane"?: …,
"detail"?: … }`, closed fields validated in core (`events/beacon.ts` states the
rules); extra keys are ignored and covered by the digest. `kind` is free-form
here on purpose: prd-27's attention vocabulary and prd-17's decision vocabulary
are those PRDs' next waves, and a collector that dropped a kind it had not met
would be the silent loss ADR-0011 forbids.

**The event** is `beacon.received`, source `beacon`, `ts` = the writer's `at`,
payload = the line's fields plus `digest` (sha256 of the exact line), `file`
and `offset`. That is the principles chair's split, ruled in prd-17: **sidecar
for content, event for occurrence.** The file keeps whatever the writer said;
the log records that it was said, when, by whom, about which lane, and a
pointer to the bytes.

**A malformed line is skipped, counted and named**, never fatal: one
`collector.error` per file per tick with `count`, the first reason and its
offset. A collector that died on one bad line would take attention with it.

**B lost** because it is a new privileged surface on a localhost-only server
(ADR-0008): a fourth `gated-mutation` row, a token that a hook has no honest
channel to learn (prd-23 ruling 6 already had to leave the OTLP inbox ungated
for exactly this reason), and a running server as a precondition for a hook
that fires in another process. A file needs neither network nor token nor a
server up at the moment it is written, and it replays: the directory is
evidence the way a session log is.

**C lost** as a privileged channel with the same token problem and an ADR-0001
amendment's worth of blast radius, spent to carry what a line carries. The
non-goals of prd-27 say it in one sentence: *a fourth hand costs its own ADR,
never a writable directory.*

**D lost** because `agent.status`'s envelope pins `source: 'workmux'`, so a
beacon publishing through it would sign someone else's name on a hash-chained
log (ADR-0009) — prd-27 ruling 2's forged-provenance objection. Widening that
envelope is ruling 2's own keystone and its own record; a beacon needs its own
event either way, because a landing is not an agent status.

`'beacon'` joins `eventSourceSchema` outright. `lab` was kept out because it
is an explicitly-invoked hand, not a collector; `judge` was kept out only by a
fence. A beacon collector is a real polled collector behind the poll loop, so
the enum's own definition — *which collector saw it* — admits it.

## Consequences

- Good: no route, no token, no server dependency at write time; a hook is a
  one-line `echo >>`. The directory replays like a recording.
- Good: the reducer, the resilience wrapper, the snapshot store, the wrap-
  boundary law and `doctor` all pick the seventh collector up through the
  existing contract with nothing new to remember.
- Good: a writer this instrument has never met can start speaking today; its
  `kind`s are preserved until a wave folds them.
- Bad: **nothing folds a beacon yet.** This record and its collector land the
  door; `attention` stays `absent` on the beacon's own manifest until #218
  reads beacons per lane, and the provenance bar in the web app still lists
  five sources. The keystone is honest but invisible until the next wave.
- Bad: a directory nobody creates is an ordinary silent state, so a
  misconfigured emitter (writing to the wrong slug's directory) looks exactly
  like no emitter. `doctor` gains no check for it here; the lapse mechanism
  (prd-27 ruling 6) is where "configured and quiet" gets its voice.
- Bad: `kind` free-form means two writers can disagree on spelling; the folding
  waves own the vocabulary and will have to normalise or refuse.
- Neutral: one-file-per-writer relies on writers choosing distinct names; two
  processes appending to one file with lines under the pipe buffer are still
  safe on POSIX, so a shared file degrades to interleaving only for oversized
  lines, which the 512-char `detail` cap keeps unlikely.
