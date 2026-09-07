# 0039. `attention` names its witness on the capability manifest — L2 is told from L4 by who declared, not by rank

- **Status:** accepted (prd-27 ruling 3 and prd-15 ruling 5; recorded on the build, #218) — extends [0010](0010-adapter-capabilities-named-not-ranked.md)
- **Date:** 2026-09-06

## Context and Problem Statement

ADR-0010 made every collector declare six signals at one of three levels, and
`deriveRung` reads the merged levels into one rung. Attention `provided` has
meant L4 (tmux/workmux) since prd-15, because the rig was the only organ that
could declare it. #217 landed the beacon door and had to leave the beacon's
manifest `attention: absent` — its own record (ADR-0036) says why: a
`partial` with no telemetry is the PTY-wrapper signature, and a
configured-but-silent hook would have read as L3, a rung on a promise. #283
made the fold believe a beacon per lane. Now two organs can provide attention
and the ladder has two rungs for them (L2 beacon, L4 rig), but a merged
manifest carries levels only — the provenance that tells the rungs apart is
gone by the time `deriveRung` runs.

Constraints: ADR-0010's three levels and compiler-required reasons stay (the
3^6 exhaustiveness law depends on them); `deriveRung(capabilities)` has two
callers (`/api/meta`, `doctor`) and the web's climb copy; and prd-27 ruling 3
says `provided` only where a harness actually declared.

## Considered Options

- **A — A `witness` on the detail.** `CapabilityDetail` gains an optional
  `witness?: 'rig' | 'beacon'`, meaningful on `attention`; `deriveRung` reads
  it; `mergeCapabilities` breaks a level tie toward the rig.
- **B — A second argument to `deriveRung`.** Callers pass which collectors
  contributed; the rung is computed from levels plus that list.
- **C — A fourth level.** `CapabilityLevel` gains `declared-by-beacon`.
- **D — Encode it in `reason` text** and pattern-match.

## Decision Outcome

Chosen: **A**.

The witness travels with the detail through `mergeCapabilities`, so a merged
manifest still knows who provided attention, and the beacon's live manifest
(`beaconCapabilitiesFor`) is the one constructor that sets `witness: 'beacon'`.
Every manifest written before this record has no `witness` and reads exactly
as it did. On a tie the rig wins: a fleet with both witnesses is L4, one with
only the hook is L2 — the ladder's own order.

**B lost** because the merged manifest is the thing `/api/meta` serialises and
`doctor` prints; a rung that needs a side-channel list cannot be re-derived
from the manifest a reader was shown, and the honesty law that re-folds the
body (`meta.test.ts`) would have nothing to compare.

**C lost** because it breaks ADR-0010's shape: a level is a strength, not a
source; four levels re-rank the ladder the record exists to keep named, and
every `partial`/`absent`-carries-a-reason rule would need a fourth arm.

**D lost** as the drift ADR-0010 was written against — a string a reader has
to parse to learn a fact the type could carry.

## Consequences

- Good: `rungInfo('L2')` is reachable by a real collector for the first time;
  `doctor` and `/api/meta` read the same rung from the same manifest.
- Good: the false PTY rung ADR-0036 recorded is closed by type — a `partial`
  signed `beacon` is never L3.
- Bad: **an optional field can be forgotten.** A beacon-provided attention
  built without `witness: 'beacon'` reads L4, the top rung, silently.
  `beaconCapabilitiesFor` is the only place that constructs it and its test
  pins the field; nothing else may build a beacon `provided`.
- Bad: the type allows `witness` on five signals where it means nothing.
  Documented on the type; not worth a second detail type per signal.
- Neutral: `mergeCapabilities`' tie-break is now source-aware for one case; the
  "first seen wins" rule still holds for every other tie.
