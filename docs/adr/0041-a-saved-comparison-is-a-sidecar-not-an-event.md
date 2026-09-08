# 0041. A saved comparison is a sidecar artefact beside the recordings, not an event in the log

- **Status:** accepted (prd-14 ruling 5, ruled 2026-08-24; recorded here on the build, #213)
- **Date:** 2026-09-08

## Context and Problem Statement

prd-14 ruling 3 promised that a finished comparison "saves as a reopenable
artifact", and `packages/web/src/lab/compare/artifact.ts` has carried a
versioned, defensively-parsed shape for it since 2026-08-06 — with no
production caller. Ruling 5 (2026-08-24) settled the persistence seam in
prose: *saved through prd-16's machinery, listed with its kin*. This record
settles the structural question that prose leaves open: **what kind of thing
is a saved comparison on disk?**

ADR-0002 says every fact is an event in one append-only log, reduced by one
reducer for live and replay. ADR-0005 says the log lives outside the watched
repo. prd-16 ruling 3 says a recording's companions — captured transcripts,
the operator's label — live *beside* the log, never inside it, so the
append-only law holds. A comparison has to be one of those two things.

## Considered Options

- **A — An event.** Append a `lab.comparison.saved` event carrying the
  artifact to the live session log; the reducer folds it into state; the
  recordings library derives its rows from the fold.
- **B — A sidecar file.** Write the artifact, unchanged, to
  `<sessionDir>/comparisons/comparison-<uuid>.json`, the posture
  `snapshots/`, `transcripts/` and the `.label.json` sidecar already hold.
- **C — Inside the recording it derives from.** Append the artifact to the
  session file of the parent lane's session, or rewrite that file's tail.

## Decision Outcome

Chosen: **B**, because a comparison is a *reading* of recordings, not a fact
about the fleet. It is produced by the operator after the runs it summarises
have finished, it derives entirely from data the log already holds, and it
has its own versioned shape that the web side already parses defensively.

**A lost** on two counts. An event's payload is validated at the collector
boundary and folded by the reducer for every session, live and replay
(ADR-0002); a saved comparison is written once, by a human, into whichever
session happens to be live, and would then replay as if the fleet had done
something at that instant. It would also put a second versioned envelope
inside the first — the artifact's `version: 1` inside the record's own
protocol version (ADR-0033) — and prd-17's upcast chokepoint would then own a
migration that ruling 5 says must never happen silently. The fold gains a
fact that means nothing to any selector.

**C lost** because it rewrites a finished, hash-chained record (ADR-0009) or
appends to a session the operator may since have closed — the append-only
law and the label sidecar's whole reason for existing say no.

The sidecar directory is invisible to `listSessions` by construction (it
matches only `session-<ts>.jsonl` in the directory itself), so retention,
the lane index and the replay picker are unchanged without any of them
learning a new exclusion.

## Consequences

- Good: the artifact on disk is byte-identical to what the web's
  `serialiseComparison` produces, so wave 2 reopens it with the parser that
  already exists. Nothing in the fold, the reducer or the record protocol
  changes.
- Good: an artifact from an older format version is *refused by name* at
  read time and left where it is — never migrated, never deleted.
- Bad: a comparison is not in the event log, so it does not travel with a
  portable record (ADR-0009, ADR-0033) or reach the team server's shared
  record (prd-51). Anyone wanting that must decide then whether a comparison
  becomes a record-protocol payload — a new record, not an edit to this one.
- Bad: the listing reads every artifact file to report `savedAt` and arm
  count; fine at the sizes involved, and a bound will be needed if it ever
  is not.
- Neutral: `comparisons/` is a fourth sibling under the session directory
  beside `snapshots/`, `transcripts/` and the label sidecars.
