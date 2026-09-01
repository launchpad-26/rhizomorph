import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME, transcriptCaptureDir } from './paths.js'
import { allAttributedLanes, candidateTranscriptPaths, capturedTranscriptPath } from './transcript-attribution.js'

/**
 * TRANSCRIPT CAPTURE (prd16 ruling 3) — on session close, each lane's live
 * transcript is copied, redacted, into this session's own artefact
 * directory, so a recording replayed on another machine (or after its
 * worktree is long gone) still shows its conversations. Invoked from the
 * close half of rotation (`recorder/rotate.ts`), BEFORE the log's own
 * closing event is appended — see this module's own note on
 * {@link captureSessionTranscripts} for what that ordering buys, and why the
 * outcome lives in a manifest sidecar rather than in the event itself.
 */

/** One lane's capture outcome — always present, whether it succeeded or not. */
export interface CapturedLaneTranscript {
  lane: string
  /** The Claude Code session id this lane's transcript was tailed under. */
  claudeSessionId: string
  captured: boolean
  /** Bytes actually written (post-redaction). `0` when `captured` is false. */
  bytes: number
  /** WHAT → WHY, law-12 style. Set only when `captured` is false. */
  reason?: string
}

/**
 * The capture sidecar for one session — beside its log, never inside it (the
 * append-only law; the same sidecar posture `log/label.ts` uses).
 *
 * `complete` is the one fact a reader needs before trusting a captured
 * recording at all: false the moment ANY attributed lane didn't make it in,
 * so "this recording has conversations" is never confused with "this
 * recording has ALL its conversations". prd17 ruling 1 put a session's own
 * end in the log as `session.closed`; that event's payload is core's own
 * schema and this issue's fence does not extend there, so completeness is
 * stated here instead — a sidecar a reader consults beside the log, exactly
 * as a label already is, rather than a mutation of the append-only log.
 */
export interface TranscriptCaptureManifest {
  sessionId: string
  capturedAt: number
  complete: boolean
  totalBytes: number
  lanes: CapturedLaneTranscript[]
  /**
   * Which events the lane list itself came from (#133). `'recording'` means the
   * session's own log, so the list is every lane the session named;
   * `'window'` means the recorder's in-memory buffer, which prd-44 ruling 4
   * caps at `MAX_BUFFERED_EVENTS` — so past that cap the list may be SHORT and
   * nothing here can tell. Absent on a manifest written before #133, which
   * reads the same way as `'window'`: unknown rather than complete.
   *
   * This is a different question from {@link complete}, and the two are
   * deliberately separate: `complete` is about the lanes that were found,
   * `attributedFrom` is about whether finding them was possible at all.
   */
  attributedFrom?: 'recording' | 'window'
}

function manifestFilePath(sessionDir: string, sessionId: string): string {
  return path.join(transcriptCaptureDir(sessionDir, sessionId), TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME)
}

/**
 * A session's capture manifest, or `null` when there is none — no capture
 * ever ran (nothing was attributed), the sidecar is missing, or it is
 * unreadable. All three read as "nothing verified captured" rather than an
 * error, the same convention `readSessionLabel` already follows.
 */
export async function readTranscriptCaptureManifest(
  sessionDir: string,
  sessionId: string,
): Promise<TranscriptCaptureManifest | null> {
  let raw: string
  try {
    raw = await readFile(manifestFilePath(sessionDir, sessionId), 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as TranscriptCaptureManifest
  } catch {
    return null
  }
}

async function writeTranscriptCaptureManifest(
  sessionDir: string,
  manifest: TranscriptCaptureManifest,
): Promise<void> {
  const filePath = manifestFilePath(sessionDir, manifest.sessionId)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

// ── redaction (#177's fixture-hygiene discipline, applied to a real capture) ─

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** The whole home-rooted path segment, not just the username in it — the law is "no `/home/` or `/Users/` substring at all". */
const HOME_PATH_PATTERN = /\/(?:home|Users)\/[^"\s]*/g
/** Built at runtime rather than written as an escape in source — a literal NUL byte in this file would itself break the "no NUL bytes" law. */
const NUL_CHAR = String.fromCharCode(0)

/** Structural fields that carry account/org identity, if a transcript line has them at all — scrubbed by key, not left to a text guess. */
const IDENTITY_KEYS = new Set([
  'userid',
  'useruuid',
  'accountid',
  'accountuuid',
  'organizationid',
  'organizationuuid',
  'orgid',
  'orguuid',
  'email',
  'useremail',
  'hostname',
  'machineid',
])

function redactIdentityFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactIdentityFields)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = IDENTITY_KEYS.has(key.toLowerCase()) ? '[redacted]' : redactIdentityFields(val)
    }
    return out
  }
  return value
}

function scrubText(text: string): string {
  return text
    .split(NUL_CHAR)
    .join('')
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(HOME_PATH_PATTERN, '/redacted-path')
}

/** One line: structural redaction where the line parses, a text scrub either way. Line count and blank lines are preserved exactly. */
function redactLine(raw: string): string {
  const withoutCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  if (withoutCr.trim().length === 0) return scrubText(withoutCr)
  try {
    const parsed: unknown = JSON.parse(withoutCr)
    return scrubText(JSON.stringify(redactIdentityFields(parsed)))
  } catch {
    return scrubText(withoutCr)
  }
}

/**
 * A captured transcript is the artefact most likely to be shared (prd16
 * ruling 3), so every line is redacted on the way in: email addresses, home
 * directories, and known account/org identity fields, scrubbed before a byte
 * ever reaches disk. What the parser reads (`type`, `isSidechain`,
 * `timestamp`, `message.*`) is untouched — none of it is an identity field —
 * so a redacted capture replays exactly like the original.
 */
export function redactTranscript(raw: string): string {
  return raw.split('\n').map(redactLine).join('\n')
}

// ── the capture itself ───────────────────────────────────────────────────────

/** The first candidate that actually reads, or null. Mirrors `readTranscript`'s own try-each-candidate loop. */
async function readFirstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      continue
    }
  }
  return null
}

/** WHAT → WHY → nothing to run (law 12): unlike a live-read gap, there is no command that makes a vanished transcript reappear. */
function captureGapReason(lane: string, tried: readonly string[]): string {
  const where = tried.length === 0 ? 'no worktree path was recorded for it' : tried.join(' or ')
  return (
    `TRANSCRIPT NOT CAPTURED for "${lane}" — none of the paths the sessionlog collector tails ` +
    `(${where}) had this lane's transcript at session close, so nothing could be copied — the ` +
    'conversation for this lane is not in this recording'
  )
}

export interface CaptureSessionTranscriptsOptions {
  /**
   * The closing session's events as the caller holds them in memory. Since
   * prd-44 ruling 4 (#37) that is a WINDOW of the last `MAX_BUFFERED_EVENTS`,
   * not necessarily the session — see {@link recordedEvents}, which is where a
   * caller that can read the log says so.
   */
  events: readonly RhizomorphEvent[]
  /**
   * The same session's events as read back from its own log — every lane it
   * ever named, whatever has since fallen out of {@link events} (#133).
   *
   * **Sound because the log is always the superset.** prd-40 ruling 1 appends
   * before publishing, so nothing reaches {@link events} that is not already in
   * the file; and rotation captures BEFORE appending `session.closed`, which is
   * not an attributed type, so the log at that instant carries exactly the
   * attributions this needs.
   *
   * Three states, and the third is the one worth reading:
   *
   * - **omitted** — the caller has not been taught the difference and is
   *   vouching for {@link events}. Attribution comes from there, exactly as it
   *   did before #133, and {@link TranscriptCaptureManifest.complete} is
   *   computed exactly as it was.
   * - **non-empty** — the authority. Attribution comes from here.
   * - **empty** — the caller asked for the recording and the read gave nothing
   *   back (`readSessionEvents` reports an unreadable log as `[]`). Attribution
   *   falls back to {@link events}, which still captures the recent lanes
   *   rather than none — but `complete` is forced to `false`, because the lane
   *   list may now be short and nothing at this layer can know that it is. A
   *   capture that quietly claimed completeness there would be the dishonest
   *   failure ADR-0011 abolished, one artefact over.
   */
  recordedEvents?: readonly RhizomorphEvent[]
  /** This repo's session directory — captures land under `transcripts/<sessionId>/` inside it. */
  sessionDir: string
  /** The session being closed. */
  sessionId: string
  /** Root Claude Code tails project session logs under. */
  claudeProjectsRoot: string
  /** Stamped onto the manifest as `capturedAt` — the same instant the caller is closing the session at. */
  now: number
}

/**
 * Copies every lane's live transcript into this session's own artefact
 * directory, redacted, and writes the manifest recording what happened.
 *
 * Called from the close half of rotation BEFORE the `session.closed` event is
 * appended (prd16 ruling 3's crash ordering): if this throws or the process
 * dies mid-capture, the session is never marked closed at all, and the next
 * boot resumes it exactly as any other crash leaves it — never a closed log
 * with no record beside it. Once this returns, capture is done (however
 * honestly) and the close can proceed: a lane whose transcript could not be
 * found is a recorded gap, not a reason to block rotation.
 *
 * Returns `null` and writes nothing when the session never attributed a
 * single lane — there is nothing to capture, so no `transcripts/` directory
 * appears for a session that was never instrumented.
 *
 * **The lane list comes from the recording, not from the caller's window**
 * (#133), whenever the caller can supply one — see
 * {@link CaptureSessionTranscriptsOptions.recordedEvents}. Attributing from a
 * bounded window means a lane whose only attributing events have been evicted
 * is absent from the manifest: not reported unreadable, not counted, simply
 * gone, and gone permanently, because the capture is what the lane index reads
 * once the log itself has been pruned. That the newest attribution wins
 * (`findAttribution` walks backwards) is what makes the wider list purely
 * additive: a lane already in the window keeps exactly the attribution it had.
 */
export async function captureSessionTranscripts(
  options: CaptureSessionTranscriptsOptions,
): Promise<TranscriptCaptureManifest | null> {
  const { events, recordedEvents, sessionDir, sessionId, claudeProjectsRoot, now } = options
  // The recording is the authority when there is one; the window is the
  // fallback, and a fallback the caller did not choose is never sold as
  // complete (see `recordedEvents`).
  const fromRecording = recordedEvents !== undefined && recordedEvents.length > 0
  const readFailed = recordedEvents !== undefined && recordedEvents.length === 0
  const lanes = allAttributedLanes(fromRecording ? recordedEvents : events)
  if (lanes.length === 0) return null

  const dir = transcriptCaptureDir(sessionDir, sessionId)
  await mkdir(dir, { recursive: true })

  const captured: CapturedLaneTranscript[] = []
  for (const { lane, attribution } of lanes) {
    const candidates = candidateTranscriptPaths(attribution, claudeProjectsRoot)
    const raw = await readFirstExisting(candidates)

    if (raw === null) {
      captured.push({
        lane,
        claudeSessionId: attribution.sessionId,
        captured: false,
        bytes: 0,
        reason: captureGapReason(lane, candidates),
      })
      continue
    }

    const destination = capturedTranscriptPath(sessionDir, sessionId, attribution)
    if (destination === null) {
      captured.push({
        lane,
        claudeSessionId: attribution.sessionId,
        captured: false,
        bytes: 0,
        reason: `TRANSCRIPT NOT CAPTURED for "${lane}" — its session id could not be turned into a safe path`,
      })
      continue
    }

    const redacted = redactTranscript(raw)
    await writeFile(destination, redacted, 'utf8')
    captured.push({
      lane,
      claudeSessionId: attribution.sessionId,
      captured: true,
      bytes: Buffer.byteLength(redacted, 'utf8'),
    })
  }

  const manifest: TranscriptCaptureManifest = {
    sessionId,
    capturedAt: now,
    // `readFailed` forces this false even when every lane that WAS found made
    // it in: the question `complete` answers is "is this recording's
    // conversation whole", and a possibly-short lane list cannot answer yes.
    complete: !readFailed && captured.every((entry) => entry.captured),
    totalBytes: captured.reduce((sum, entry) => sum + entry.bytes, 0),
    lanes: captured,
    attributedFrom: fromRecording ? 'recording' : 'window',
  }
  await writeTranscriptCaptureManifest(sessionDir, manifest)
  return manifest
}
