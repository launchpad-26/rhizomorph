import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { buildRecord, parseRecord, verifyRecord, type Actor } from '@rhizomorph/core/src/record/index.js'
import { canonicalize, isInside } from '../paths/containment.js'
import { laneHandlesOf } from './lane-index.js'
import { defaultDataRoot, repoSlug, sessionDirFor } from './paths.js'
import {
  applyRetentionPlan,
  readRetentionPlan,
  voiceRetentionPlan,
  type RetentionAnswer,
  type RetentionCandidate,
  type RetentionPlan,
} from './retention.js'
import { LOCK_STALE_MS, isLockLive, readSessionLock, type SessionLock } from './session-lock.js'
import { listSessions, readSessionEvents, sessionFilePath, type SessionSummary } from './session-log.js'
import { allAttributedLanes } from './transcript-attribution.js'
import {
  readTranscriptCaptureManifest,
  transcriptCaptureManifestPath,
  writeTranscriptCaptureManifest,
  type CapturedLaneTranscript,
  type TranscriptCaptureManifest,
} from './transcript-capture.js'

/**
 * SEAL → ARCHIVE → VERIFY → TOMBSTONE → PRUNE, as ONE act — prd-51 ruling 11
 * (#432), built on the executed spike
 * `docs/research/2026-08-29-shared-record-s7-archive-tombstone.md`.
 *
 * **The order IS the ruling, and this module is the only place it exists.**
 * Build the portable record, gzip it, `verifyRecord` the archive *read back off
 * disk*, write the tombstone manifest at the transcript-capture path **while
 * the log still exists**, and only then hand that one candidate to
 * `applyRetentionPlan`. Every one of those steps is a gate on the next: a
 * refusal at any of them leaves the log exactly where it was.
 *
 * **Prune is reachable by no other route.** `log/retention.ts` had zero
 * importers before this file, and `log/archive.test.ts` holds the importer set
 * to exactly `{ log/archive.ts, log/retention.test.ts }` — so "removing the
 * archive step removes the prune" is structural rather than a habit. This
 * module **composes against retention's published grammar and never edits it**
 * (ruling 11's falsifier): `readRetentionPlan`, `voiceRetentionPlan`,
 * `applyRetentionPlan` and a `RetentionPlan` narrowed to one candidate by an
 * object spread. Nothing here needs a line of that module changed.
 *
 * **Why the tombstone at all.** The spike's scenario A: after a prune, a lane
 * with no captured-transcript sidecar does not read as *pruned* — it vanishes
 * from the lane index entirely, which is the dishonest failure prd-44 #38 and
 * ADR-0011 both forbid. A tombstone manifest is the minimum honest sidecar that
 * makes `readLaneIndex` render the lane as a named gap
 * (`lane-index.ts`'s `missingRecordingGap`) instead of nothing at all.
 *
 * **Two things the spike named travel as requirements.**
 * 1. The manifest's lane list is **cross-checked against the log before the log
 *    goes** ({@link mergeTombstone} step 1). A manifest that parses cleanly and
 *    names a lane the log never does would conjure that lane into the index
 *    forever — the spike's verdict-3 sibling shape — and the only window in
 *    which the check is possible at all is while the log is still there.
 * 2. Lanes **only git knows about** — a non-main worktree branch whose agent was
 *    never instrumented — are named, by deriving the tombstone's lane set from
 *    the same union the lane index carries ({@link logLaneSets} unions
 *    `laneHandlesOf` over `allAttributedLanes`). That is the first half of
 *    ruling 11's either/or, and the command **also** says out loud how many
 *    lanes came from telemetry and how many from git alone (`cli/archive.ts`),
 *    so the widening is observable in stdout and not only in a manifest.
 *
 * **On Windows the command answers `EBUSY` by naming the holder, never by
 * pretending** ({@link busyRefusal}). POSIX `unlink` of an open file succeeds,
 * so no runner produces a real `EBUSY` — the fault is injected through
 * {@link ArchiveSeams.prune}, which is why that case is witnessed on every
 * platform and needs no `.windows-known-failures` entry.
 */

/**
 * Test-only fault injection. Production callers pass nothing; every field
 * defaults to the real thing. Kept to exactly two seams — the compressor and
 * the prune — because those are the two steps whose *failure* the ordering law
 * has to be observed through, and a seam for anything else would be a way to
 * skip a step rather than to watch one.
 */
export interface ArchiveSeams {
  /** Defaults to `gzipSync` (node:zlib). */
  compress?: (json: string) => Buffer
  /** Defaults to `applyRetentionPlan` from `./retention.js` — the ONLY prune this module has. */
  prune?: typeof applyRetentionPlan
}

export interface ArchiveOptions {
  repoPath: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
  /** The operator's age, per invocation. No default — `retention.ts`'s ruling, unweakened. */
  answer: RetentionAnswer
  nowMs: number
  /** Actor handle for the record; defaults to the OS username marked `declared: false`, exactly as `cli/export-record.ts` does. */
  handle?: string
  /** Where the `.gz` archives land. Default: the session dir. Refused if inside `repoPath`. */
  outDir?: string
  /** Voice the plan and stop. Writes nothing, prunes nothing. */
  dryRun?: boolean
}

/** What one candidate's pass did. Every candidate produces exactly one of these. */
export type CandidateOutcome =
  | {
      kind: 'archived'
      sessionId: string
      archivePath: string
      eventCount: number
      archiveBytes: number
      chainDigest: string
      tombstone: TombstoneOutcome
      bytesFreed: number
    }
  | { kind: 'refused'; sessionId: string; reason: string }

export interface TombstoneOutcome {
  /** False when an existing real capture already named every lane the log names — then nothing is written. */
  written: boolean
  manifestPath: string
  /** Lanes the log attributes through telemetry (`allAttributedLanes`). */
  attributedLanes: string[]
  /** Lanes only git named — a non-main worktree branch with no instrumented agent (spike verdict 5). */
  gitOnlyLanes: string[]
  /** Entries carried over from a pre-existing capture manifest, byte-for-byte. */
  keptLanes: string[]
  /** Entries this run added. */
  addedLanes: string[]
}

export interface ArchiveRunResult {
  plan: RetentionPlan
  /** `voiceRetentionPlan(plan)`, always — the dry-run report is the same words the real run prints. */
  voice: string[]
  outcomes: CandidateOutcome[]
  dryRun: boolean
  /** The session a live lock claims, excluded from the plan. `null` when nothing is being written. */
  liveSessionId: string | null
}

/** The lane sets a log names, split by HOW it names them. Pure over already-read events. */
export interface LogLaneSets {
  attributed: Array<{ lane: string; claudeSessionId: string }>
  gitOnly: string[]
}

/**
 * Every lane a log names, split by whether telemetry attributed it or git alone
 * saw it. The union — not `allAttributedLanes` on its own — because that is the
 * set `lane-index.ts` itself carries, and the spike's verdict 5 is exactly the
 * difference: a non-main worktree branch with no instrumented agent has no
 * `llm.usage`/`tool.activity`/`llm.cost` event at all, so an attribution-only
 * tombstone writes no entry for it and the lane vanishes from the index the
 * moment its log is pruned.
 *
 * `laneHandlesOf` deliberately skips a *main* worktree's branch, while
 * `allAttributedLanes` can return `CONDUCTOR_LANE` (`'main'`) for the
 * conductor's own session — so the two halves are unioned rather than one
 * subtracted from the other.
 */
export function logLaneSets(events: readonly RhizomorphEvent[]): LogLaneSets {
  const attributed = allAttributedLanes(events)
    .map((entry) => ({ lane: entry.lane, claudeSessionId: entry.attribution.sessionId }))
    .sort((a, b) => a.lane.localeCompare(b.lane))

  const attributedNames = new Set(attributed.map((entry) => entry.lane))
  const all = new Set([...laneHandlesOf(reduceAll(events)), ...attributedNames])
  const gitOnly = [...all].filter((lane) => !attributedNames.has(lane)).sort((a, b) => a.localeCompare(b))

  return { attributed, gitOnly }
}

/** WHAT → WHY (law 12) for a lane telemetry named but never captured a transcript for. */
function attributedTombstoneReason(lane: string): string {
  return (
    `TOMBSTONE for "${lane}" — no transcript capture ever ran for this session; this manifest ` +
    "exists only to prove the session (and this lane's presence in it) was real before its event " +
    'log was archived and pruned, so the lane index can still name a gap here rather than showing ' +
    'nothing at all'
  )
}

/** WHAT → WHY (law 12) for a lane git alone saw — the spike's verdict 5, named rather than left silent. */
function gitOnlyTombstoneReason(lane: string): string {
  return (
    `TOMBSTONE for "${lane}" — this lane was named by git alone (a non-main worktree branch) and ` +
    'its agent was never instrumented, so no transcript ever existed for it; this manifest exists ' +
    'only so the lane still reads as pruned rather than as never having run'
  )
}

export interface MergedTombstone {
  /** The manifest to write, or `null` when nothing should be written at all. */
  manifest: TranscriptCaptureManifest | null
  /** Lanes the existing manifest names that the log does not — the candidate is refused when this is non-empty. */
  conjured: string[]
}

/**
 * Merges the tombstone into whatever manifest is already beside the log. Pure —
 * no IO, no clock beyond `nowMs`, so the whole of ruling 11's honesty rules are
 * testable without a filesystem.
 *
 * Four rules, in order, and each is a failure the spike actually observed:
 *
 * 1. **Cross-check first.** A pre-existing manifest naming a lane the log never
 *    does is refused outright (`conjured` non-empty, `manifest: null`), and the
 *    caller must not prune. Pruning it would leave that lane in the index
 *    forever with nothing left to contradict it.
 * 2. **Never rewrite an existing entry.** A real capture's `captured: true`
 *    entry, its `bytes` and its `capturedAt` are carried through untouched.
 * 3. **Append only what is missing**, with a reason naming which kind of lane
 *    it is.
 * 4. **Nothing to add ⇒ nothing to write**, so a complete real capture is left
 *    byte-identical and re-running the command is a no-op.
 */
export function mergeTombstone(
  existing: TranscriptCaptureManifest | null,
  sessionId: string,
  lanes: LogLaneSets,
  nowMs: number,
): MergedTombstone {
  const logLanes = new Set([...lanes.attributed.map((entry) => entry.lane), ...lanes.gitOnly])

  const conjured = (existing?.lanes ?? [])
    .map((entry) => entry.lane)
    .filter((lane) => !logLanes.has(lane))
    .sort((a, b) => a.localeCompare(b))
  if (conjured.length > 0) return { manifest: null, conjured }

  const kept: CapturedLaneTranscript[] = [...(existing?.lanes ?? [])]
  const known = new Set(kept.map((entry) => entry.lane))

  const added: CapturedLaneTranscript[] = []
  for (const entry of lanes.attributed) {
    if (known.has(entry.lane)) continue
    added.push({
      lane: entry.lane,
      claudeSessionId: entry.claudeSessionId,
      captured: false,
      bytes: 0,
      reason: attributedTombstoneReason(entry.lane),
    })
  }
  for (const lane of lanes.gitOnly) {
    if (known.has(lane)) continue
    added.push({
      lane,
      claudeSessionId: '',
      captured: false,
      bytes: 0,
      reason: gitOnlyTombstoneReason(lane),
    })
  }

  if (added.length === 0) return { manifest: null, conjured: [] }

  const all = [...kept, ...added]
  return {
    manifest: {
      sessionId,
      // Never restamp a real capture's time: `capturedAt` is when the
      // transcripts were taken, and this run took none of them.
      capturedAt: existing?.capturedAt ?? nowMs,
      complete: all.every((entry) => entry.captured),
      totalBytes: all.reduce((sum, entry) => sum + entry.bytes, 0),
      lanes: all,
      attributedFrom: 'tombstone',
    },
    conjured: [],
  }
}

/**
 * The refusal sentence for a prune that failed because the log is held open —
 * `null` when the error is not that, because pretending a disk-full is a busy
 * file is the same lie one step over. `EPERM` counts: Windows surfaces both
 * codes for a held file.
 *
 * WHAT → WHY → remedy (law 12), and the three cases read differently on
 * purpose: which process to go and stop is the entire useful content, and a
 * single constant sentence for all three would say nothing while looking like
 * it did. All three end by naming which half of the sequence completed — the
 * "never by pretending" clause of ruling 11.
 *
 * `archivePath` is a parameter rather than derived because the closing clause
 * has to name the artefact that DID land; see the build report on #432.
 */
export function busyRefusal(
  candidate: RetentionCandidate,
  err: NodeJS.ErrnoException,
  lock: SessionLock | null,
  nowMs: number,
  archivePath: string,
): string | null {
  if (err.code !== 'EBUSY' && err.code !== 'EPERM') return null

  const held = err.path ?? candidate.fileName
  const head = `${candidate.fileName} could not be pruned — the filesystem refused to remove ${held} with ${err.code}`
  const tail = ` The archive at ${archivePath} is written and verified; nothing was deleted.`

  if (lock === null) {
    return (
      `${head}, and no rhizomorph lock names a holder, so another process on this machine has ` +
      `${held} open and rhizomorph cannot name it — close it and re-run.${tail}`
    )
  }

  const age = nowMs - lock.heartbeatMs
  if (isLockLive(lock, nowMs)) {
    return (
      `${head}, and rhizomorph's own lock names pid ${lock.pid}, heartbeat ${age} ms ago (live) — ` +
      `stop that process and re-run.${tail}`
    )
  }

  const why = age > LOCK_STALE_MS ? `older than ${LOCK_STALE_MS} ms` : `pid ${lock.pid} is no longer running`
  return (
    `${head}, and rhizomorph's own lock names pid ${lock.pid}, heartbeat ${age} ms ago ` +
    `(STALE — ${why}, so the holder is probably not rhizomorph) — find the process holding ${held} ` +
    `and close it, then re-run.${tail}`
  )
}

export type ArchiveVerdict =
  | { ok: true; eventCount: number; chainDigest: string }
  | { ok: false; detail: string }

/**
 * Reads the `.gz` **back off disk**, gunzips, parses, and runs core's
 * `verifyRecord` on the result. Re-reading is the point rather than a
 * belt-and-braces: verifying the in-memory object the previous step just built
 * proves the builder works, and proves nothing at all about the bytes that
 * landed — and it is the bytes that survive the prune. That distinction is the
 * word "archive" in ruling 11.
 *
 * Every failure is NAMED, never thrown: unreadable file, not-gzip, not-JSON,
 * not a record, and `verifyRecord`'s own reason.
 */
export async function verifyArchiveFile(archivePath: string): Promise<ArchiveVerdict> {
  let raw: Buffer
  try {
    raw = await readFile(archivePath)
  } catch (err) {
    return { ok: false, detail: `the archive could not be read back: ${err instanceof Error ? err.message : String(err)}` }
  }

  let text: string
  try {
    text = gunzipSync(raw).toString('utf8')
  } catch (err) {
    return { ok: false, detail: `the archive is not readable gzip: ${err instanceof Error ? err.message : String(err)}` }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, detail: `the archive is not JSON: ${err instanceof Error ? err.message : String(err)}` }
  }

  const parsed = parseRecord(value)
  if (!parsed.ok) return { ok: false, detail: `the archive is not a session record: ${parsed.error}` }

  const verdict = verifyRecord(parsed.record)
  if (!verdict.ok) {
    const where = verdict.lineNumber === null ? '' : ` at line ${verdict.lineNumber}`
    return { ok: false, detail: `${verdict.reason}${where}: ${verdict.detail}` }
  }

  return {
    ok: true,
    eventCount: parsed.record.manifest.eventCount,
    chainDigest: parsed.record.manifest.chainDigest,
  }
}

/**
 * The session a live writer claims, so the command never archives the log being
 * appended to. Fed to `readRetentionPlan` **and** to `applyRetentionPlan`, so
 * the live check is re-made at the moment of deletion exactly as that module
 * intends (a rotation between the plan and the delete is its own documented
 * race).
 */
export async function liveSessionIdFrom(
  sessionDir: string,
  summaries: readonly SessionSummary[],
  nowMs: number,
): Promise<string | null> {
  for (let i = summaries.length - 1; i >= 0; i -= 1) {
    const summary = summaries[i]
    if (summary === undefined) continue
    const lock = await readSessionLock(sessionDir, summary.id)
    if (lock !== null && isLockLive(lock, nowMs)) return summary.id
  }
  return null
}

/** `os.userInfo()` can throw when the process has no passwd entry — an honest fallback, not a crash (same as `cli/export-record.ts`). */
function osUsername(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function resolveActor(handle: string | undefined, sessionId: string): Actor {
  return handle === undefined
    ? { instance: sessionId, handle: osUsername(), declared: false }
    : { instance: sessionId, handle, declared: true }
}

/**
 * The prune, and the ONLY call to `applyRetentionPlan` anywhere in this package
 * outside retention's own test.
 *
 * `tombstone` is a parameter the body only reports from, and that is
 * deliberate: it makes "prune after tombstone" a **data** dependency, so the
 * mutation "move the tombstone write below the prune" has to move the data flow
 * too rather than swapping two adjacent statements. It does not replace the
 * ordering tests in `archive.test.ts` — it makes the mutant harder to write by
 * accident.
 */
async function pruneAfterTombstone(
  prune: typeof applyRetentionPlan,
  sessionDir: string,
  onePlan: RetentionPlan,
  liveSessionId: string | null,
  tombstone: TombstoneOutcome,
): Promise<{ bytesFreed: number; refusedLiveSessionIds: string[]; tombstone: TombstoneOutcome }> {
  const applied = await prune(sessionDir, onePlan, { liveSessionId })
  return { bytesFreed: applied.bytesFreed, refusedLiveSessionIds: applied.refusedLiveSessionIds, tombstone }
}

/**
 * Ruling 11, as one function: seal → archive → verify → tombstone → prune, per
 * candidate, in that order, or that candidate is refused and its log stays
 * exactly where it is.
 *
 * **One `applyRetentionPlan` call per candidate**, never one for the whole
 * plan. `applyRetentionPlan` calls `rm(filePath, { force: true })`, and `force`
 * swallows only `ENOENT` — an `EBUSY`/`EPERM` throws straight out of the
 * function and abandons every remaining candidate in that plan. A per-candidate
 * plan turns that into one refused candidate.
 *
 * **A refusal is `continue`, never `break`.** One busy log must not cost its
 * siblings their archive.
 */
export async function runArchive(options: ArchiveOptions, seams: ArchiveSeams = {}): Promise<ArchiveRunResult> {
  const compress = seams.compress ?? ((json: string) => gzipSync(json))
  const prune = seams.prune ?? applyRetentionPlan

  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.repoPath, dataRoot)
  const slug = repoSlug(options.repoPath)
  const outDir = path.resolve(options.outDir ?? sessionDir)

  // The same containment law `cli/export-record.ts` keeps: an archive of the
  // watched repo's own history never lands inside the watched repo (ADR-0001).
  const repoPathResolved = path.resolve(options.repoPath)
  if (isInside(repoPathResolved, outDir)) {
    throw new Error(
      `refusing to write the archive inside the watched repo (${canonicalize(outDir)}) — ` +
        `pass --out-dir with a path outside ${canonicalize(repoPathResolved)}`,
    )
  }

  const summaries = await listSessions(sessionDir)
  const liveSessionId = await liveSessionIdFrom(sessionDir, summaries, options.nowMs)
  const plan = await readRetentionPlan(sessionDir, {
    answer: options.answer,
    nowMs: options.nowMs,
    liveSessionId,
  })
  const voice = voiceRetentionPlan(plan)

  if (options.dryRun === true) {
    return { plan, voice, outcomes: [], dryRun: true, liveSessionId }
  }

  const outcomes: CandidateOutcome[] = []

  for (const candidate of plan.candidates) {
    const logPath = sessionFilePath(sessionDir, candidate.sessionId)
    const events = await readSessionEvents(logPath)

    // A log with bytes on disk and not one parseable event is NOT an empty
    // session: archiving it would write a record of nothing and pruning it
    // would destroy the only copy of whatever those bytes were. A genuinely
    // 0-byte log has nothing to lose and is archived and pruned (see below).
    if (candidate.sizeBytes > 0 && events.length === 0) {
      outcomes.push({
        kind: 'refused',
        sessionId: candidate.sessionId,
        reason:
          `${candidate.fileName} is ${candidate.sizeBytes} bytes on disk and not one line of it parses ` +
          'as an event, so an archive of it would be an empty record and pruning it would destroy the ' +
          'only copy — nothing was archived and nothing was deleted. Move the file aside and inspect it.',
      })
      continue
    }

    const record = buildRecord(events, { repoSlug: slug, actor: resolveActor(options.handle, candidate.sessionId) })
    const bytes = compress(`${JSON.stringify(record)}\n`)
    const archivePath = path.join(outDir, `${slug}-${candidate.sessionId}.rhizorecord.json.gz`)
    await mkdir(outDir, { recursive: true })
    await writeFile(archivePath, bytes)

    const verdict = await verifyArchiveFile(archivePath)
    if (!verdict.ok) {
      outcomes.push({
        kind: 'refused',
        sessionId: candidate.sessionId,
        reason:
          `the archive at ${archivePath} did not verify (${verdict.detail}); the event log was NOT ` +
          `pruned and is still at ${logPath}.`,
      })
      continue
    }

    const manifestPath = transcriptCaptureManifestPath(sessionDir, candidate.sessionId)
    const existing = await readTranscriptCaptureManifest(sessionDir, candidate.sessionId)
    const laneSets = logLaneSets(events)
    const merged = mergeTombstone(existing, candidate.sessionId, laneSets, options.nowMs)

    if (merged.conjured.length > 0) {
      outcomes.push({
        kind: 'refused',
        sessionId: candidate.sessionId,
        reason:
          `the capture manifest at ${manifestPath} names lane(s) the log never does ` +
          `(${merged.conjured.join(', ')}), so pruning the log would leave a tombstone conjuring a lane ` +
          `that never ran; the log is still at ${logPath}. Fix or remove the manifest and re-run.`,
      })
      continue
    }

    const keptLanes = (existing?.lanes ?? []).map((entry) => entry.lane)
    const tombstone: TombstoneOutcome = {
      written: merged.manifest !== null,
      manifestPath,
      attributedLanes: laneSets.attributed.map((entry) => entry.lane),
      gitOnlyLanes: [...laneSets.gitOnly],
      keptLanes,
      addedLanes:
        merged.manifest === null ? [] : merged.manifest.lanes.map((e) => e.lane).filter((lane) => !keptLanes.includes(lane)),
    }
    if (merged.manifest !== null) await writeTranscriptCaptureManifest(sessionDir, merged.manifest)

    // ── and ONLY now ────────────────────────────────────────────────────────
    const onePlan: RetentionPlan = { ...plan, candidates: [candidate], bytes: candidate.sizeBytes }
    let applied: Awaited<ReturnType<typeof pruneAfterTombstone>>
    try {
      applied = await pruneAfterTombstone(prune, sessionDir, onePlan, liveSessionId, tombstone)
    } catch (err) {
      const reason = busyRefusal(
        candidate,
        err as NodeJS.ErrnoException,
        await readSessionLock(sessionDir, candidate.sessionId),
        options.nowMs,
        archivePath,
      )
      if (reason === null) throw err
      outcomes.push({ kind: 'refused', sessionId: candidate.sessionId, reason })
      continue
    }

    if (applied.refusedLiveSessionIds.length > 0) {
      outcomes.push({
        kind: 'refused',
        sessionId: candidate.sessionId,
        reason:
          'a writer claimed this session between the plan and the delete; the archive at ' +
          `${archivePath} stands and nothing was deleted.`,
      })
      continue
    }

    outcomes.push({
      kind: 'archived',
      sessionId: candidate.sessionId,
      archivePath,
      eventCount: verdict.eventCount,
      archiveBytes: bytes.byteLength,
      chainDigest: verdict.chainDigest,
      tombstone: applied.tombstone,
      bytesFreed: applied.bytesFreed,
    })
  }

  return { plan, voice, outcomes, dryRun: false, liveSessionId }
}
