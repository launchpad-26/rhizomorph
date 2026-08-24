# 0028. A bounded, single-flight, mtime+size-validated cache for parsed session logs

- **Status:** accepted
- **Date:** 2026-08-24

## Context and Problem Statement

`/api/lane-index` and `/api/sessions` each re-read and re-parse every session
log in a repo's session directory on every request (prd-44 evidence:
281.3 / 280.0 / 252.2 ms per request on 4 files, 20 MB, 51,690 lines, page
cache warm). A closed session's log file never changes again once written, so
that parse is pure waste on every request after the first — but the *live*
session's file is still mid-append and must keep being read from the
recorder's in-memory buffer, never from disk. Any cache introduced here must:
never answer with a session's parse from before it changed on disk; never
grow without bound as recordings accumulate over a long server uptime; never
let a burst of concurrent requests each pay for their own parse of the same
cold file; and get out of the way cleanly when a recording is later deleted
by retention enforcement (prd-44 wave 3 / #38) — which must degrade the way
the index already degrades for a recording it cannot read, never as a lane
that never existed.

## Considered Options

- A — A TTL cache over the route's assembled answer.
- B — No cache; only make the three per-session reads concurrent.
- C — Cache the parsed events per session-log file, keyed by path + `mtime`
  + `size`, validated by a fresh `stat()` on every read.
- D — Cache `reduceAll`'s fold (`SessionState`) instead of, or in addition to,
  the raw parse.
- E — An unbounded cache (no eviction).
- F — Bound the cache by entry count.
- G — Bound the cache by cumulative raw file bytes, LRU eviction.
- H — A cache instance constructed per server/app (a factory), versus one
  process-wide singleton.

## Decision Outcome

Chosen: **C + G**, as a process-wide singleton (**H**, singleton branch).

**C over A:** prd-44's own Non-goals reject a TTL here explicitly — "it turns
a cost problem into a staleness problem on a route whose answer is a list of
facts." Ruling 1 draws the same line: this caches *parsing*, never *answers*,
so the route still recomputes its response from the parsed sessions every
time and nothing it reports can go stale. `mtime` and `size` together — not
either alone — are the validity key: a same-length edit only shows up in
`mtime`; a same-`mtime` filesystem, or two writes inside one clock tick, only
shows up in `size`. Either one drifting invalidates the entry.

**B was rejected as insufficient on its own** — it does nothing about the
O(number of recordings) growth prd-44's Success criterion 1 names as the
thing that must go away. It is layered on top of C in this same change (the
three per-session reads become concurrent regardless), not offered instead of
it.

**D was rejected:** prd-44's Non-goals reserve `reduceAll(eventsSoFar())` for
prd-40 ("Not the fold per request"). That citation is about the live poll
path specifically, but folding an already-parsed closed session inside
`buildLaneIndex` is a separate, already-pure, already-cheap-relative-to-parsing
step, and caching it answers a cost this issue's Definition of Done never
measured or asked for.

**E was rejected outright:** prd-44 open question 1 asks for exactly the
bound E lacks, and this repo's working agreement is measured against an 8 GB
reference box that "already thrashes at four lanes" (AGENTS.md) — a cache
with no ceiling is a slow leak on a process meant to run for a session's
whole lifetime.

**F (entry count) was rejected in favor of G (bytes):** sessions vary wildly
in size (this repo's own directory: 4 files, 20 MB, one alone 51,690 lines),
so a count bound says nothing about the memory it actually costs. A byte
bound, using the same `size` a `stat()` already reports, ties the limit to
the resource it protects. **128 MB** answers open question 1: more than 3x
this repo's own session directory today (37 files, 39 MB, per
`docs/review/2026-08-24-performance.md`), while staying a small fraction of
an 8 GB box's memory even after the parsed-object overhead over raw JSON text
(see Consequences). Eviction is plain LRU — least-recently-read entry first —
except a single entry larger than the whole budget is still cached alone
rather than never cached, since caching it once still saves every request
after the first.

**H:** a bare module-level singleton was chosen over a per-instance factory
(the shape `api/doctor.ts`'s probe cache uses, specifically to stop one
`buildApp()` instance's cache leaking into another's inside that file's own
tests). That risk does not apply here: every production entry point
(`cli/run.ts`, `cli/replay.ts`) constructs exactly one `buildApp()` per
process, and this cache is keyed by absolute file path, which already encodes
the session directory — a `POST /api/retarget` mid-process repo switch cannot
collide two repos' entries under one key. Tests reset the singleton
explicitly (`resetForTests()`) instead of needing per-instance isolation.

## Consequences

- **Good:** every route that walks a repo's session directory
  (`/api/lane-index`, `/api/lane-index/:handle`, `/api/sessions`) now pays for
  a closed recording's parse at most once per process lifetime (until
  evicted), with zero change to what any of them returns.
- **Good:** one cache, shared by both callers (`lane-index.ts` and
  `listing.ts`), rather than two independent ones each holding their own copy
  of the same bytes.
- **Good:** a single-flight guard means a burst of concurrent requests
  hitting a cold cache still costs exactly one parse, not one per request in
  flight.
- **Bad:** the byte budget is measured against a file's on-disk size, not the
  parsed object graph's actual heap footprint. Parsed JS objects (one per
  event, with nested fields) typically cost several times their source
  JSON's bytes, so a "128 MB cache" can hold noticeably more than 128 MB of
  live heap. The budget is deliberately conservative against the wrong
  number rather than precise against the right one, because the right one is
  expensive to measure on every read and this is meant to be a cheap check.
- **Bad:** `listing.ts` now imports from `lane-index.ts` for the shared cache
  — a new intra-package dependency where none existed, in the direction of
  the older/simpler module depending on the newer one. A third shared module
  was the alternative, and was not available inside this issue's fence.
- **Neutral:** the cache is invisible to a caller that never asks twice — it
  changes cost, not behavior, which is the point, but it also means there is
  nothing for a route-level test to see beyond a repeat-call parse count.
