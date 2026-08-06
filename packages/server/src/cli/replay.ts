import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventsToJsonl } from '@rhizomorph/core'
import { parseRecord, readRecord, verifyRecord } from '@rhizomorph/core/src/record/index.js'
import { sessionFileName } from '../log/paths.js'
import { buildApp } from '../server/build-app.js'
import { exec as realExec } from '../server/exec.js'
import { createPollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { DEFAULT_PORT, parseFlags, type FlagSpec } from './args.js'
import type { CliHandle, RunCliOptions } from './types.js'

/**
 * Same dist dir the server would otherwise serve statically
 * (`run.ts`'s `defaultWebDistDir`) — duplicated rather than imported
 * to avoid a circular run.ts <-> replay.ts import.
 */
function defaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', 'web', 'dist')
}

/** Parses `rhizomorph replay <record-file> [--port <n>] [--help]`. */
export interface ReplayArgs {
  file: string
  port: number
  help: boolean
}

/** `rhizomorph replay`'s own usage table, distinct from the main command's. */
export function replayHelpText(): string {
  return `rhizomorph replay <record-file> [options]

Verifies a portable session record's hash chain — refusing a tampered file
loudly — then serves it read-only through the same dashboard the live
command uses: a foreign actor's record renders exactly as a local recording
does. Nothing is executed and nothing is written back into the record.

Arguments:
  record-file             Path to a '.rhizorecord.json' file written by 'rhizomorph export-record'

Options:
  --port <n>              Port to listen on (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit
`
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { file: '', port: DEFAULT_PORT, help: true }
  }

  let portArg: string | undefined
  const specs: FlagSpec[] = [{ flag: '--port', read: (v) => { portArg = v } }]

  const positionals = parseFlags(argv, specs)
  const file = positionals[0]
  if (file === undefined || file.trim().length === 0) {
    throw new Error('missing required argument: <record-file>')
  }

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { file, port, help: false }
}

/**
 * `rhizomorph replay <record-file>` — verifies a portable session record's
 * hash chain (refusing a tampered file loudly, prd11 ruling 4) and then boots
 * the same server the live command does, pointed at a reconstructed copy of
 * the record's own event log instead of a watched repo. No collectors run and
 * nothing is written back into the record itself: the temp directory holding
 * the reconstructed session file exists only so the existing `/api/sessions`
 * machinery (which lists a directory of `session-*.jsonl` files) can find and
 * serve it exactly like a local recording.
 */
export async function runReplayCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<CliHandle> {
  let args
  try {
    args = parseReplayArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${replayHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(replayHelpText())
    exit(0)
  }

  const filePath = path.resolve(args.file)

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    process.stderr.write(`could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  const parsed = parseRecord(json)
  if (!parsed.ok) {
    process.stderr.write(`${filePath} is not a valid session record: ${parsed.error}\n`)
    exit(1)
  }

  const verification = verifyRecord(parsed.record)
  if (!verification.ok) {
    process.stderr.write(
      `refusing to replay ${filePath}: verification failed (${verification.reason})\n` +
        `${verification.detail}\n`,
    )
    exit(1)
  }

  const { manifest } = parsed.record
  // `readRecord` is the lenient reader every consumer of a record's body goes
  // through (prd17 ruling 3, item 1): a line from an era this build has never
  // heard of is counted and preserved, never silently stepped over the way a
  // strict `lineToEvent` walk would. `verification.unknownVoice` is the exact
  // sentence `voiceUnknownEvents` already computed while verifying above —
  // the same one the record verifier and the web's replay banner say, so a
  // stranger's record voices identically wherever it's read.
  const { events } = readRecord(parsed.record)

  const now = options.now ?? Date.now
  const tempDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-replay-'))
  // A fresh synthetic id for this read-only serving process — distinct from
  // `manifest.actor.instance` (a foreign record's own identity, printed
  // below), which need not even be numeric for a record from a compatible
  // third-party emitter.
  const replaySessionTs = now()
  const sessionId = String(replaySessionTs)
  const replaySessionFilePath = path.join(tempDir, sessionFileName(replaySessionTs))
  await writeFile(replaySessionFilePath, eventsToJsonl(events), 'utf8')

  const recorder = new SessionRecorder(sessionId, replaySessionFilePath, { resumeFrom: events })
  const repoPath = `record:${manifest.repoSlug}`
  const pollLoop = createPollLoop({
    repoPath,
    collectors: [],
    recorder,
    exec: options.exec ?? realExec,
    now,
  })

  const webDistDir = options.webDistDir ?? defaultWebDistDir()
  const app = buildApp({
    repoPath,
    repoName: manifest.repoSlug,
    sessionDir: tempDir,
    recorder,
    webDistDir,
    // A record is a finished thing: `POST /api/rotate` refuses here (prd11
    // ruling 4's read-only replay, restated for the recorder's new hand).
    readOnly: true,
  })

  let url: string
  try {
    url = await app.listen({ port: args.port, host: '127.0.0.1' })
  } catch (err) {
    await app.close().catch(() => {})
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    const message =
      code === 'EADDRINUSE'
        ? `port ${args.port} is already in use — pass a different one with --port <n>`
        : `failed to start server: ${err instanceof Error ? err.message : String(err)}`
    process.stderr.write(`${message}\n`)
    exit(1)
  }

  const declared = manifest.actor.declared ? '' : ' (undeclared)'
  log.log(`rhizomorph replaying ${filePath} at ${url}`)
  log.log(
    `read-only session record — ${manifest.eventCount} events, ` +
      `actor ${manifest.actor.handle}${declared}@${manifest.actor.instance}, repo ${manifest.repoSlug}`,
  )
  // Never silence: a record from a newer instrument still replays, but this
  // build must say plainly that some of it went unfolded (prd17 ruling 3).
  if (verification.unknownVoice !== undefined) {
    log.log(verification.unknownVoice)
  }

  const stop = async () => {
    await pollLoop.stop()
    await app.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return { app, recorder, pollLoop, url, stop }
}
