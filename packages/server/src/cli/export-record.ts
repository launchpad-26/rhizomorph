import { mkdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { buildRecord, type Actor, type SessionRecord } from '@rhizomorph/core/src/record/index.js'
import { defaultDataRoot, repoSlug, sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'

export interface ExportRecordOptions {
  repoPath: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
  /** Which recorded session to export; defaults to the most recently recorded one. */
  sessionId?: string
  /** Output file path; defaults to alongside the session logs. */
  out?: string
  /** Human-declared actor name; defaults to the OS username, marked `declared: false`. */
  handle?: string
}

export interface ExportRecordResult {
  outPath: string
  record: SessionRecord
}

/** `os.userInfo()` can throw when the process has no passwd entry (some minimal containers) — an honest fallback, not a crash. */
function osUsername(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function resolveActor(handle: string | undefined): Actor {
  return handle === undefined
    ? { instance: '', handle: osUsername(), declared: false }
    : { instance: '', handle, declared: true }
}

/**
 * Reads a recorded session off disk and writes it out as a portable session
 * record (prd11 ruling 3) — outside the watched repo, same law the session
 * logs themselves already keep. `sessionId` defaults to the most recently
 * recorded session for this repo; `--out` may point anywhere except inside
 * `repoPath`, which would break the "export never touches the watched repo"
 * law, so that case is refused rather than silently allowed.
 */
export async function runExportRecord(options: ExportRecordOptions): Promise<ExportRecordResult> {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.repoPath, dataRoot)
  const slug = repoSlug(options.repoPath)

  let sessionId = options.sessionId
  if (sessionId === undefined) {
    const sessions = await listSessions(sessionDir)
    const latest = sessions[sessions.length - 1]
    if (!latest) {
      throw new Error(`no recorded sessions for ${options.repoPath} (looked in ${sessionDir})`)
    }
    sessionId = latest.id
  } else {
    const sessions = await listSessions(sessionDir)
    if (!sessions.some((s) => s.id === sessionId)) {
      throw new Error(`no session with id "${sessionId}" for ${options.repoPath} (looked in ${sessionDir})`)
    }
  }

  const events = await readSessionEvents(sessionFilePath(sessionDir, sessionId))

  const actor: Actor = { ...resolveActor(options.handle), instance: sessionId }
  const record = buildRecord(events, { repoSlug: slug, actor })

  const outPath = path.resolve(
    options.out ?? path.join(sessionDir, `${slug}-${sessionId}.rhizorecord.json`),
  )

  const repoPathResolved = path.resolve(options.repoPath)
  const relativeToRepo = path.relative(repoPathResolved, outPath)
  const isInsideRepo = relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo))
  if (isInsideRepo) {
    throw new Error(
      `refusing to write the record inside the watched repo (${outPath}) — pass --out with a path outside ${repoPathResolved}`,
    )
  }

  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  return { outPath, record }
}
