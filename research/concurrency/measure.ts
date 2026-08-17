/**
 * THE CONCURRENCY MEASUREMENT (#567, prd-33 ruling 10) —
 *
 * Replays real recorded fleet sessions through the same event → pulse mapping
 * `packages/web/src/scene/pulses.ts` uses, WITHOUT the cap it currently
 * enforces, and sweeps the resulting intervals to find how many pulses are
 * genuinely alive at once. That is "concurrent events" defined the way the
 * scene itself already defines it — a pulse's own life is its coincidence
 * window — rather than an invented threshold.
 *
 * `EVENT.maxConcurrent` and `STRUCTURAL.maxConcurrent` are imported live from
 * `packages/web/src/scene/motion.ts` (read-only — nothing under packages/**
 * is written by this script). The per-kind pulse life table in
 * `pulses.ts:108-113` is not exported, so it is reproduced here verbatim with
 * a citation rather than guessed; if that table changes, this script's
 * numbers stop matching the shipping scene until it is updated to match.
 *
 * Run: npx tsx research/concurrency/measure.ts
 * (needs the raw session logs under ~/.local/share/rhizomorph — see README.md)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { EVENT, STRUCTURAL } from '../../packages/web/src/scene/motion.js'

// --- mirrored constants (cited, not guessed) --------------------------------

/** pulses.ts:108-113 — LIFE, per SpawnKind. Not exported, so mirrored here. */
const PULSE_LIFE_MS: Record<'commit' | 'landing' | 'mote' | 'tick', number> = {
  commit: 2_200,
  landing: 2_800,
  mote: 3_400,
  tick: 460,
}
/** pulses.ts:101 */
const TOKENS_PER_MOTE = 450
/** pulses.ts:103 */
const MAX_MOTES_PER_REQUEST = 3
/** pulses.ts:213 — three motes from one request are staggered, not stacked. */
const MOTE_STAGGER_MS = 90

/**
 * "History never pulses" (pulses.ts's rule 1, ruling 32). A recorder that has
 * just booted enumerates every pre-existing worktree/pane in one instant —
 * every file below shows this as a burst of `worktree.discovered` at ~0ms
 * offset from `session.started`. That burst is catch-up state, not news, so it
 * is excluded from the structural measurement exactly as the shipping scene
 * excludes it. 60s is generous: the measured boot bursts land within 150ms and
 * the next genuine discovery is minutes away in every file checked.
 */
const BOOT_SCAN_WINDOW_MS = 60_000

// --- types -------------------------------------------------------------------

interface RawEvent {
  ts: number
  type: string
  payload: Record<string, unknown>
}

interface Interval {
  startMs: number
  endMs: number
  kind: string
  label: string
}

interface SessionFile {
  root: string
  file: string
  label: string
}

// --- the manifest: which recordings this note is measured from --------------
//
// Every entry was checked by hand (see the note's "what was measured"
// section) against its own `session.started` payload to confirm it is real
// rhizomorph fleet history and not a vitest fixture repo (this machine's data
// root also holds ~70 directories from the server test suite's throwaway
// repos — "plain-repo-*", "a-repo-with-spaces-*" etc. — which are excluded by
// not being listed here). Two eras: the current main checkout, and an earlier
// checkout of the same project recorded under a different directory name
// (`worktrees-challenge`) — its commits carry this repo's own issue numbers
// (e.g. "#123 trace.span event"), which is how that was confirmed.

const DATA_ROOT = process.env.RHIZOMORPH_DATA_ROOT ?? path.join(homedir(), '.local', 'share', 'rhizomorph')

const MANIFEST: SessionFile[] = [
  { root: 'rhizomorph-5189ebfe', file: 'session-1786665720450.jsonl', label: 'main, 2026-08-15/16' },
  { root: 'rhizomorph-5189ebfe', file: 'session-1786602585014.jsonl', label: 'main, 2026-08-14/15 (the 7-lane wave)' },
  { root: 'rhizomorph-5189ebfe', file: 'session-1786321490492.jsonl', label: 'main, 2026-08-11/13' },
  { root: 'rhizomorph-5189ebfe', file: 'session-1786665406591.jsonl', label: 'main, short reconnect' },
  { root: 'worktrees-challenge-71202028', file: 'session-1785739192605.jsonl', label: 'early era, ~issue 100s' },
  { root: 'worktrees-challenge-71202028', file: 'session-1785929533332.jsonl', label: 'early era' },
  { root: 'worktrees-challenge-71202028', file: 'session-1785895666938.jsonl', label: 'early era' },
  { root: 'worktrees-challenge-71202028', file: 'session-1785978475040.jsonl', label: 'early era' },
  { root: 'worktrees-challenge-71202028', file: 'session-1785677492476.jsonl', label: 'early era, short' },
  { root: 'worktrees-challenge-71202028', file: 'session-1785935062975.jsonl', label: 'early era, short' },
]

// --- loading -------------------------------------------------------------

function loadEvents(root: string, file: string): RawEvent[] {
  const full = path.join(DATA_ROOT, root, file)
  const raw = readFileSync(full, 'utf8')
  const events: RawEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const e = JSON.parse(trimmed)
      if (typeof e.ts === 'number' && typeof e.type === 'string') {
        events.push({ ts: e.ts, type: e.type, payload: e.payload ?? {} })
      }
    } catch {
      // half-written last line; same convention the recorder itself uses
    }
  }
  events.sort((a, b) => a.ts - b.ts)
  return events
}

// --- deriving pulse-worthy intervals, uncapped ----------------------------

/** True for the conductor's own activity in the main checkout — no thread to animate. */
function isLaneActivity(payload: Record<string, unknown>): boolean {
  if (payload.role === 'conductor') return false
  if (payload.branch === 'main') return false
  return true
}

/**
 * Timestamps shared by >=3 events of `type` — the batch-flush tell (see
 * {@link deriveEventPulses}'s `commit.landed` comment). One file's
 * `worktree.removed` shows the sibling case on the removal side: 18 worktrees
 * spanning issues #225 through #519 — months of already-finished lanes —
 * all logged gone at one instant, which is a prune sweep or a collector
 * resync noticing a backlog of cleanup, not 18 lanes disconnecting live at
 * once. Events at these timestamps are excluded from both the event-class
 * ('landing') and structural ('disconnect') derivations.
 */
function batchFlushTimestamps(events: RawEvent[], type: string): Set<number> {
  const counts = new Map<number, number>()
  for (const e of events) {
    if (e.type !== type) continue
    counts.set(e.ts, (counts.get(e.ts) ?? 0) + 1)
  }
  const flushed = new Set<number>()
  for (const [ts, count] of counts) if (count >= 3) flushed.add(ts)
  return flushed
}

/**
 * Every interval a live `PulseField` would have opened, had `EVENT.spawn` not
 * enforced `EVENT.maxConcurrent`. Mirrors `pulses.ts`'s `ingestOne` switch,
 * event-for-event, minus the cap and the lane bookkeeping (concurrency here is
 * scene-wide, not per-lane — `pulses.ts:351`, `this.live.length` is a global
 * count).
 */
function deriveEventPulses(events: RawEvent[]): Interval[] {
  const removedFlushes = batchFlushTimestamps(events, 'worktree.removed')
  const out: Interval[] = []
  for (const e of events) {
    switch (e.type) {
      case 'commit.landed': {
        if (e.payload.branch === 'main') break // home already; flares the mass, no pulse
        // `ts` is the git collector's *discovery* instant, not the commit's own
        // time — a branch merge or rebase lands a whole range in one poll, all
        // stamped with that poll's ts (measured: one file shows 252 commits
        // sharing a single ts, `authoredAt` spanning four real days). That is
        // exactly the "history never pulses" hazard for a different event type:
        // a backlog a collector just noticed, not 252 things that happened at
        // once. `authoredAt` is the commit's own time and is what a viewer
        // watching continuously would actually have seen it land at.
        const born = typeof e.payload.authoredAt === 'number' ? e.payload.authoredAt : e.ts
        out.push({ startMs: born, endMs: born + PULSE_LIFE_MS.commit, kind: 'commit', label: String(e.payload.branch ?? '?') })
        break
      }
      case 'worktree.removed': {
        if (removedFlushes.has(e.ts)) break // prune sweep / resync, not a live disconnect
        out.push({ startMs: e.ts, endMs: e.ts + PULSE_LIFE_MS.landing, kind: 'landing', label: String(e.payload.path ?? '?') })
        break
      }
      case 'llm.usage': {
        if (!isLaneActivity(e.payload)) break
        const tokens = e.payload.tokens as { output?: number } | undefined
        const output = tokens?.output ?? 0
        const wanted = Math.max(1, Math.min(MAX_MOTES_PER_REQUEST, Math.round(output / TOKENS_PER_MOTE)))
        for (let i = 0; i < wanted; i += 1) {
          const born = e.ts + i * MOTE_STAGGER_MS
          out.push({ startMs: born, endMs: born + PULSE_LIFE_MS.mote, kind: 'mote', label: String(e.payload.branch ?? e.payload.lane ?? '?') })
        }
        break
      }
      case 'tool.activity': {
        if (!isLaneActivity(e.payload)) break
        out.push({ startMs: e.ts, endMs: e.ts + PULSE_LIFE_MS.tick, kind: 'tick', label: String(e.payload.branch ?? e.payload.lane ?? '?') })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Every interval `STRUCTURAL.maxConcurrent` would have to schedule around:
 * a lane appearing or disconnecting. `worktree.discovered` within the boot
 * scan window is catch-up, not news (see {@link BOOT_SCAN_WINDOW_MS}) and is
 * excluded the same way the shipping scene would never animate it.
 */
function deriveStructuralEvents(events: RawEvent[]): Interval[] {
  if (events.length === 0) return []
  const sessionStart = events[0]!.ts

  // A second catch-up shape beyond the boot scan: a mid-session resync (the
  // collector or the server itself restarting) re-enumerates every worktree
  // it can currently see and stamps the whole result with one instant. One
  // file shows exactly this — 38 `worktree.discovered` sharing one ts, 3.8h
  // into the session, nowhere near the boot window. The tell is the same as
  // the commit backlog: real, independently-dispatched lanes do not share a
  // millisecond (the verified 7-lane wave below is 16-18s apart, lane to
  // lane) — so any run of >=3 discoveries at the exact same ts is a resync,
  // not a dispatch, and is excluded the same way the boot burst is.
  const discoveredFlushes = batchFlushTimestamps(events, 'worktree.discovered')
  // Same tell on the removal side — see {@link batchFlushTimestamps}'s doc.
  const removedFlushes = batchFlushTimestamps(events, 'worktree.removed')

  const out: Interval[] = []
  for (const e of events) {
    if (e.type === 'worktree.discovered') {
      if (e.ts - sessionStart < BOOT_SCAN_WINDOW_MS) continue
      if (discoveredFlushes.has(e.ts)) continue
      if (e.payload.isMain) continue
      out.push({ startMs: e.ts, endMs: e.ts + STRUCTURAL.durationMs, kind: 'appear', label: String(e.payload.branch ?? e.payload.path ?? '?') })
    } else if (e.type === 'worktree.removed') {
      if (removedFlushes.has(e.ts)) continue
      out.push({ startMs: e.ts, endMs: e.ts + STRUCTURAL.durationMs, kind: 'disconnect', label: String(e.payload.path ?? '?') })
    }
  }
  return out
}

// --- sweep line ------------------------------------------------------------

interface SweepResult {
  maxConcurrency: number
  /** ms of wall-clock time spent at exactly concurrency level k, index k. */
  timeAtLevel: number[]
  totalMs: number
  count: number
}

function sweep(intervals: Interval[]): SweepResult {
  if (intervals.length === 0) return { maxConcurrency: 0, timeAtLevel: [0], totalMs: 0, count: 0 }
  type Point = { t: number; delta: number }
  const points: Point[] = []
  for (const iv of intervals) {
    points.push({ t: iv.startMs, delta: 1 })
    points.push({ t: iv.endMs, delta: -1 })
  }
  points.sort((a, b) => a.t - b.t || a.delta - b.delta)

  const timeAtLevel: number[] = []
  let level = 0
  let maxLevel = 0
  let prevT = points[0]!.t
  const bump = (lvl: number, ms: number) => {
    timeAtLevel[lvl] = (timeAtLevel[lvl] ?? 0) + ms
  }
  for (const p of points) {
    const dt = p.t - prevT
    if (dt > 0) bump(level, dt)
    level += p.delta
    maxLevel = Math.max(maxLevel, level)
    prevT = p.t
  }
  const totalMs = (points[points.length - 1]!.t) - points[0]!.t
  return { maxConcurrency: maxLevel, timeAtLevel, totalMs, count: intervals.length }
}

/**
 * The MOT-relevant number, distinct from raw pulse concurrency: how many
 * *different lanes* have a live pulse at once, not how many pulses. One busy
 * lane rattling through several tool calls a second can hold 40+ raw pulses
 * alive by itself (measured: lane `224`, `research/2026-08-16-concurrency-measurement.md`)
 * without asking a viewer to track more than one moving thing. Pylyshyn &
 * Storm's limit is about *independent* targets, so this is the number that
 * actually bears on where {@link EVENT.maxConcurrent} should sit — raw pulse
 * concurrency is reported alongside it because it's what the current
 * implementation literally caps, and the gap between the two numbers is
 * itself a finding.
 */
function sweepDistinctLanes(intervals: Interval[]): SweepResult {
  if (intervals.length === 0) return { maxConcurrency: 0, timeAtLevel: [0], totalMs: 0, count: 0 }
  type Point = { t: number; delta: number; label: string }
  const points: Point[] = []
  for (const iv of intervals) {
    points.push({ t: iv.startMs, delta: 1, label: iv.label })
    points.push({ t: iv.endMs, delta: -1, label: iv.label })
  }
  points.sort((a, b) => a.t - b.t || a.delta - b.delta)

  const laneCounts = new Map<string, number>()
  const timeAtLevel: number[] = []
  let level = 0
  let maxLevel = 0
  let prevT = points[0]!.t
  const bump = (lvl: number, ms: number) => {
    timeAtLevel[lvl] = (timeAtLevel[lvl] ?? 0) + ms
  }
  for (const p of points) {
    const dt = p.t - prevT
    if (dt > 0) bump(level, dt)
    const before = laneCounts.get(p.label) ?? 0
    const after = before + p.delta
    laneCounts.set(p.label, after)
    if (before === 0 && after > 0) level += 1
    else if (before > 0 && after === 0) level -= 1
    maxLevel = Math.max(maxLevel, level)
    prevT = p.t
  }
  const totalMs = points[points.length - 1]!.t - points[0]!.t
  return { maxConcurrency: maxLevel, timeAtLevel, totalMs, count: intervals.length }
}

/** Fraction of measured time at concurrency >= k. */
function fractionAtLeast(r: SweepResult, k: number): number {
  if (r.totalMs === 0) return 0
  let ms = 0
  for (let lvl = k; lvl < r.timeAtLevel.length; lvl += 1) ms += r.timeAtLevel[lvl] ?? 0
  return ms / r.totalMs
}

/**
 * Combines several files' independent sweeps into one histogram — summing
 * `timeAtLevel` bucket by bucket, never re-sweeping a merged timeline.
 * Several of these recordings' real wall-clock spans genuinely overlap
 * (measured: up to ~64 minutes between two "early era" files, ~10 minutes
 * between two "main" files — separate recorder runs of the same repo,
 * covering the same real fleet activity twice). Concatenating their
 * intervals into one timeline before sweeping would double-count a lane that
 * appears in both files at the same real instant as two *different* lanes,
 * which is exactly the artifact this function avoids: each file's
 * concurrency is measured only against itself, and only the resulting
 * time-at-level totals are added together.
 */
function mergeSweepResults(results: SweepResult[]): SweepResult {
  const timeAtLevel: number[] = []
  let totalMs = 0
  let count = 0
  let maxConcurrency = 0
  for (const r of results) {
    totalMs += r.totalMs
    count += r.count
    maxConcurrency = Math.max(maxConcurrency, r.maxConcurrency)
    for (let lvl = 0; lvl < r.timeAtLevel.length; lvl += 1) {
      timeAtLevel[lvl] = (timeAtLevel[lvl] ?? 0) + (r.timeAtLevel[lvl] ?? 0)
    }
  }
  return { maxConcurrency, timeAtLevel, totalMs, count }
}

/** Distinct episodes where concurrency reached >= k (separated by a drop below k). */
function episodesAtLeast(intervals: Interval[], k: number): number {
  if (intervals.length === 0) return 0
  type Point = { t: number; delta: number }
  const points: Point[] = []
  for (const iv of intervals) {
    points.push({ t: iv.startMs, delta: 1 })
    points.push({ t: iv.endMs, delta: -1 })
  }
  points.sort((a, b) => a.t - b.t || a.delta - b.delta)
  let level = 0
  let episodes = 0
  let above = false
  for (const p of points) {
    level += p.delta
    if (!above && level >= k) {
      episodes += 1
      above = true
    } else if (above && level < k) {
      above = false
    }
  }
  return episodes
}

// --- sensitivity variants ----------------------------------------------------

/** Same events, life scaled by `factor` — how much the answer moves if the window is wrong by that much. */
function scaleLives(intervals: Interval[], factor: number): Interval[] {
  return intervals.map((iv) => ({ ...iv, endMs: iv.startMs + (iv.endMs - iv.startMs) * factor }))
}

/**
 * The naive alternative definition: every event is a point, "concurrent"
 * means within W ms of each other. Uses the same `authoredAt`-for-commits
 * anchor as the primary method (see {@link deriveEventPulses}) so the window
 * width is the only thing this varies — otherwise it would silently re-admit
 * the collector-backlog artifact the primary method excludes, and the
 * comparison would be measuring two different bugs, not one choice of window.
 */
function fixedWindow(events: RawEvent[], predicate: (e: RawEvent) => boolean, windowMs: number): Interval[] {
  const out: Interval[] = []
  for (const e of events) {
    if (!predicate(e)) continue
    const anchor = e.type === 'commit.landed' && typeof e.payload.authoredAt === 'number' ? e.payload.authoredAt : e.ts
    out.push({ startMs: anchor, endMs: anchor + windowMs, kind: e.type, label: '' })
  }
  return out
}

// --- lane lifetime (supporting stat: does "5 min to 2 h" hold?) -------------

function laneLifetimes(events: RawEvent[]): number[] {
  const started = new Map<string, number>()
  const lifetimes: number[] = []
  for (const e of events) {
    if (e.type === 'worktree.discovered' && !e.payload.isMain) {
      const key = String(e.payload.branch ?? e.payload.path)
      if (!started.has(key)) started.set(key, e.ts)
    } else if (e.type === 'worktree.removed') {
      const key = String(e.payload.path)
      // worktree.removed only carries path; match against any started entry whose path-derived branch is unknown here,
      // so this is approximate — good enough for a supporting distribution, not asserted as exact.
      const branchGuess = [...started.keys()].find((k) => key.endsWith(k))
      const start = branchGuess ? started.get(branchGuess) : undefined
      if (start !== undefined) lifetimes.push(e.ts - start)
    }
  }
  return lifetimes
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]!
}

// --- main --------------------------------------------------------------------

function main(): void {
  const isLaneEvent = (e: RawEvent) =>
    (e.type === 'commit.landed' && e.payload.branch !== 'main') ||
    e.type === 'worktree.removed' ||
    (e.type === 'llm.usage' && isLaneActivity(e.payload)) ||
    (e.type === 'tool.activity' && isLaneActivity(e.payload))

  const perFile: Array<{
    label: string
    events: number
    spanHours: number
    eventPulses: SweepResult
    distinctLanes: SweepResult
    structural: SweepResult
    episodesAtLeast: Map<number, number>
    structuralEpisodesAtLeast: Map<number, number>
    lifeScale: Map<number, SweepResult>
    fixedWindow: Map<number, SweepResult>
  }> = []

  const allLifetimes: number[] = []

  // Several of these files' real wall-clock spans overlap (two separate
  // recorder runs covering the same live fleet — see `mergeSweepResults`'s
  // doc). Every aggregate below is therefore a file-by-file sweep whose
  // *results* are combined, never a merge of the raw intervals themselves —
  // that would double-count a lane present in two overlapping files as two
  // distinct lanes occupying the same instant.
  for (const entry of MANIFEST) {
    let events: RawEvent[]
    try {
      events = loadEvents(entry.root, entry.file)
    } catch (err) {
      console.error(`SKIP ${entry.root}/${entry.file}: ${(err as Error).message}`)
      continue
    }
    if (events.length < 20) {
      console.error(`SKIP ${entry.root}/${entry.file}: only ${events.length} events`)
      continue
    }
    const spanMs = events[events.length - 1]!.ts - events[0]!.ts
    const eventIntervals = deriveEventPulses(events)
    const structuralIntervals = deriveStructuralEvents(events)

    const episodesAtLeastMap = new Map<number, number>()
    for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 10]) episodesAtLeastMap.set(k, episodesAtLeast(eventIntervals, k))
    const structuralEpisodesAtLeastMap = new Map<number, number>()
    for (const k of [1, 2, 3, 4]) structuralEpisodesAtLeastMap.set(k, episodesAtLeast(structuralIntervals, k))
    const lifeScaleMap = new Map<number, SweepResult>()
    for (const factor of [0.5, 1, 2, 4]) lifeScaleMap.set(factor, sweep(scaleLives(eventIntervals, factor)))
    const fixedWindowMap = new Map<number, SweepResult>()
    for (const windowMs of [100, 250, 500, 1_000, 2_000, 4_000]) {
      fixedWindowMap.set(windowMs, sweep(fixedWindow(events, isLaneEvent, windowMs)))
    }

    perFile.push({
      label: `${entry.label} [${entry.file}]`,
      events: events.length,
      spanHours: spanMs / 3_600_000,
      eventPulses: sweep(eventIntervals),
      distinctLanes: sweepDistinctLanes(eventIntervals),
      structural: sweep(structuralIntervals),
      episodesAtLeast: episodesAtLeastMap,
      structuralEpisodesAtLeast: structuralEpisodesAtLeastMap,
      lifeScale: lifeScaleMap,
      fixedWindow: fixedWindowMap,
    })

    allLifetimes.push(...laneLifetimes(events))
  }

  console.log('=== per-file: event-class pulse concurrency (uncapped) ===')
  for (const f of perFile) {
    console.log(
      `${f.label}\n  events=${f.events} span=${f.spanHours.toFixed(1)}h pulses=${f.eventPulses.count}` +
        ` max=${f.eventPulses.maxConcurrency} (distinct-lane max=${f.distinctLanes.maxConcurrency})` +
        ` %>=2=${(fractionAtLeast(f.eventPulses, 2) * 100).toFixed(2)}` +
        ` %>=3=${(fractionAtLeast(f.eventPulses, 3) * 100).toFixed(2)}` +
        ` %>=5=${(fractionAtLeast(f.eventPulses, 5) * 100).toFixed(3)}` +
        ` %>=10=${(fractionAtLeast(f.eventPulses, 10) * 100).toFixed(4)}`,
    )
  }

  console.log('\n=== per-file: structural (appear/disconnect) concurrency (uncapped) ===')
  for (const f of perFile) {
    console.log(
      `${f.label}\n  structural events=${f.structural.count} max=${f.structural.maxConcurrency}` +
        ` %>=2=${(fractionAtLeast(f.structural, 2) * 100).toFixed(3)}` +
        ` %>=3=${(fractionAtLeast(f.structural, 3) * 100).toFixed(4)}`,
    )
  }

  const pooled = mergeSweepResults(perFile.map((f) => f.eventPulses))
  const pooledDistinctLanes = mergeSweepResults(perFile.map((f) => f.distinctLanes))
  const pooledStructural = mergeSweepResults(perFile.map((f) => f.structural))
  const sumEpisodes = (k: number) => perFile.reduce((acc, f) => acc + (f.episodesAtLeast.get(k) ?? 0), 0)
  const sumStructuralEpisodes = (k: number) => perFile.reduce((acc, f) => acc + (f.structuralEpisodesAtLeast.get(k) ?? 0), 0)

  console.log('\n=== pooled across all files (histograms summed, never a merged timeline) ===')
  console.log(`total pulses=${pooled.count} totalMs=${pooled.totalMs} max=${pooled.maxConcurrency}`)
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
    console.log(`  concurrency>=${k}: ${(fractionAtLeast(pooled, k) * 100).toFixed(4)}% of time, ${sumEpisodes(k)} distinct episodes`)
  }
  console.log(`\ndistinct-lane concurrency (MOT-relevant): max=${pooledDistinctLanes.maxConcurrency}`)
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
    console.log(`  lanes>=${k}: ${(fractionAtLeast(pooledDistinctLanes, k) * 100).toFixed(4)}% of time`)
  }

  // Normalized by "time the scene has any motion at all" rather than raw
  // wall-clock — most of a 49h session is the fleet asleep, which dilutes the
  // headline % and understates how often the cap binds while something is
  // actually happening. Dividing by fractionAtLeast(pooled, 1) rebases onto
  // active time.
  const activeFrac = fractionAtLeast(pooled, 1)
  console.log(`\n=== the same numbers, normalized to time the scene has ANY live pulse (${(activeFrac * 100).toFixed(2)}% of all time) ===`)
  for (const k of [2, 3, 4, 5, 6, 7, 8, 10]) {
    console.log(
      `  raw>=${k}: ${((fractionAtLeast(pooled, k) / activeFrac) * 100).toFixed(2)}% of active time` +
        `   distinct-lanes>=${k}: ${((fractionAtLeast(pooledDistinctLanes, k) / activeFrac) * 100).toFixed(3)}% of active time`,
    )
  }
  console.log(`structural: total=${pooledStructural.count} max=${pooledStructural.maxConcurrency}`)
  for (const k of [1, 2, 3, 4]) {
    console.log(`  structural>=${k}: ${(fractionAtLeast(pooledStructural, k) * 100).toFixed(4)}% of time, ${sumStructuralEpisodes(k)} distinct episodes`)
  }

  console.log('\n=== sensitivity: scaling every pulse life by a factor ===')
  for (const factor of [0.5, 1, 2, 4]) {
    const scaled = mergeSweepResults(perFile.map((f) => f.lifeScale.get(factor)!))
    console.log(
      `  ${factor}x life: max=${scaled.maxConcurrency}` +
        ` %>=5=${(fractionAtLeast(scaled, 5) * 100).toFixed(4)}%` +
        ` %>=10=${(fractionAtLeast(scaled, 10) * 100).toFixed(5)}%`,
    )
  }

  console.log('\n=== sensitivity: naive fixed-window definition (all lane events as points) ===')
  for (const windowMs of [100, 250, 500, 1_000, 2_000, 4_000]) {
    const r = mergeSweepResults(perFile.map((f) => f.fixedWindow.get(windowMs)!))
    console.log(
      `  window=${windowMs}ms: max=${r.maxConcurrency}` +
        ` %>=5=${(fractionAtLeast(r, 5) * 100).toFixed(4)}%` +
        ` %>=10=${(fractionAtLeast(r, 10) * 100).toFixed(5)}%`,
    )
  }

  const sortedLifetimes = allLifetimes.filter((ms) => ms > 0).sort((a, b) => a - b)
  console.log('\n=== supporting stat: lane lifetime (worktree.discovered -> worktree.removed) ===')
  console.log(`n=${sortedLifetimes.length}`)
  if (sortedLifetimes.length > 0) {
    console.log(`  min=${(sortedLifetimes[0]! / 60_000).toFixed(1)}min`)
    console.log(`  p50=${(percentile(sortedLifetimes, 0.5) / 60_000).toFixed(1)}min`)
    console.log(`  p90=${(percentile(sortedLifetimes, 0.9) / 60_000).toFixed(1)}min`)
    console.log(`  max=${(sortedLifetimes[sortedLifetimes.length - 1]! / 3_600_000).toFixed(2)}h`)
  }

  console.log(`\n(current law: EVENT.maxConcurrent=${EVENT.maxConcurrent}, STRUCTURAL.maxConcurrent=${STRUCTURAL.maxConcurrent})`)

  const summary = {
    currentCaps: { eventMaxConcurrent: EVENT.maxConcurrent, structuralMaxConcurrent: STRUCTURAL.maxConcurrent },
    perFile: perFile.map((f) => ({
      label: f.label,
      events: f.events,
      spanHours: f.spanHours,
      pulseCount: f.eventPulses.count,
      maxConcurrency: f.eventPulses.maxConcurrency,
      maxDistinctLaneConcurrency: f.distinctLanes.maxConcurrency,
      fractionAtLeast: Object.fromEntries([1, 2, 3, 5, 10].map((k) => [k, fractionAtLeast(f.eventPulses, k)])),
      structuralMax: f.structural.maxConcurrency,
    })),
    pooled: {
      totalPulses: pooled.count,
      totalMs: pooled.totalMs,
      maxConcurrency: pooled.maxConcurrency,
      maxDistinctLaneConcurrency: pooledDistinctLanes.maxConcurrency,
      fractionAtLeast: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 10].map((k) => [k, fractionAtLeast(pooled, k)])),
      distinctLaneFractionAtLeast: Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7, 8, 10].map((k) => [k, fractionAtLeast(pooledDistinctLanes, k)]),
      ),
      episodesAtLeast: Object.fromEntries([2, 3, 5, 7, 10].map((k) => [k, sumEpisodes(k)])),
      activeTimeFraction: fractionAtLeast(pooled, 1),
      activeTimeNormalized: Object.fromEntries(
        [2, 3, 4, 5, 6, 7, 8, 10].map((k) => [
          k,
          {
            raw: fractionAtLeast(pooled, k) / fractionAtLeast(pooled, 1),
            distinctLanes: fractionAtLeast(pooledDistinctLanes, k) / fractionAtLeast(pooled, 1),
          },
        ]),
      ),
      structural: {
        maxConcurrency: pooledStructural.maxConcurrency,
        fractionAtLeast: Object.fromEntries([1, 2, 3, 4].map((k) => [k, fractionAtLeast(pooledStructural, k)])),
      },
    },
    sensitivity: {
      lifeScale: [0.5, 1, 2, 4].map((factor) => {
        const scaled = mergeSweepResults(perFile.map((f) => f.lifeScale.get(factor)!))
        return { factor, max: scaled.maxConcurrency, fractionAtLeast5: fractionAtLeast(scaled, 5) }
      }),
      fixedWindow: [100, 250, 500, 1_000, 2_000, 4_000].map((windowMs) => {
        const r = mergeSweepResults(perFile.map((f) => f.fixedWindow.get(windowMs)!))
        return { windowMs, max: r.maxConcurrency, fractionAtLeast5: fractionAtLeast(r, 5) }
      }),
    },
    laneLifetimeMinutes: {
      n: sortedLifetimes.length,
      min: sortedLifetimes[0] !== undefined ? sortedLifetimes[0] / 60_000 : null,
      p50: percentile(sortedLifetimes, 0.5) / 60_000,
      p90: percentile(sortedLifetimes, 0.9) / 60_000,
      max: sortedLifetimes.length > 0 ? sortedLifetimes[sortedLifetimes.length - 1]! / 60_000 : null,
    },
  }

  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'results.json')
  writeFileSync(outPath, JSON.stringify(summary, null, 2))
  console.log(`\nwrote ${outPath}`)
}

main()
