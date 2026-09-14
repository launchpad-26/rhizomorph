import path from 'node:path'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import {
  cursorPath,
  ingestKeyPath,
  INGEST_KEY_MODE,
  MIN_INTERVAL_MS,
  readTeamConfig,
  runShipperLoop,
  shipperDirFor,
  shipperStatus,
  teamConfigPath,
  TEAM_CONFIG_VERSION,
  writeIngestKey,
  writeTeamConfig,
  type FetchLike,
  type ShipperStatus,
} from '../shipper/index.js'
import { parseFlags, type FlagSpec } from './args.js'
import type { RunCliOptions } from './types.js'

/**
 * `rhizomorph connect team` — THE ONLY PATH TO AN ENABLED SHIPPER
 * (ADR-0034 clause 3, prd-51 ruling 14).
 *
 * This module is the single entry in `shipper/hand-law.test.ts`'s
 * `DECLARED_IMPORTERS`, and the single site in the codebase allowed to name
 * `runShipperLoop` or `shipOnce` (that law's clause 3b). Both of those are
 * asserted, not promised.
 *
 * Three forms, one command:
 *
 * ```
 * rhizomorph connect team <url> --project <id> [path]              enable  (key on stdin)
 * rhizomorph connect team --status [path]                          report
 * rhizomorph connect team --ship [path] [--interval <s>] [--once]  run the hand
 * ```
 *
 * **The key arrives on standard input and never on argv.** prd-38 ruling 4's
 * never-list rules out a `--key` flag outright, and the reason is not
 * fastidiousness: argv is in the shell history, in `ps`, and in this process's
 * own `process.argv` where a later reader could pick it up. A TTY stdin is
 * refused by name with the pipe form as its remedy rather than prompting,
 * because every other subcommand in this CLI is non-interactive and a prompt
 * here would be the only one.
 *
 * **The hand's timer runs here, in the foreground, or nowhere.** `--ship`
 * constructs the `AbortController`, wires `SIGINT`/`SIGTERM` and calls
 * `runShipperLoop`. Nothing in the server's boot, a collector or a poll can
 * start it — the import graph cannot enforce that half (`build-app.ts` already
 * reaches `cli/index.ts` through `api/lab.ts`), so the call-site law does.
 */

export interface ConnectTeamSeams {
  /** Injected so the enable path's stdin read, and its TTY refusal, are testable without a terminal. */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  fetch?: FetchLike
  now?: () => number
  /** Injected in place of the `SIGINT`/`SIGTERM` controller, so a loop test ends without signalling a real process. */
  signal?: AbortSignal
}

export interface ConnectTeamArgs {
  mode: 'enable' | 'status' | 'ship'
  url: string | undefined
  project: string | undefined
  path: string | undefined
  intervalMs: number | undefined
  once: boolean
  help: boolean
}

export function connectHelpText(): string {
  return `rhizomorph connect team <url> --project <id> [path]
rhizomorph connect team --status [path]
rhizomorph connect team --ship [path] [options]

Turns on the shipper for one repo — the fifth hand (ADR-0034), off by default
and outbound only. Once enabled, 'rhizomorph connect team --ship' tails this
repo's session ledgers in the foreground and posts them, re-serialized through
the current event schema, to the one team server you named.

The ingest key is read from STANDARD INPUT and never from the command line, so
it is never in your shell history, never in 'ps', and never in this process's
argv:

  echo "$RZK_INGEST_KEY" | rhizomorph connect team https://team.example --project acme-widgets

Arguments:
  url                     The team server's base URL (https, or http for a loopback host)
  path                    Repo this applies to (default: current directory)

Options:
  --project <id>          The team server's project id (required to enable)
  --status                Print what is enabled, how far each session has shipped, and exit
  --ship                  Run the batch timer in the foreground until you stop it
  --interval <seconds>    Batch cadence for --ship (default: 30, minimum: ${MIN_INTERVAL_MS / 1000})
  --once                  With --ship, run exactly one pass and exit
  --help, -h              Show this help and exit

To turn the shipper off, delete the 'shipper' directory this command prints.
With no configuration file there is no destination and no credential, and the
hand cannot run.
`
}

export function parseConnectTeamArgs(argv: readonly string[]): ConnectTeamArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { mode: 'status', url: undefined, project: undefined, path: undefined, intervalMs: undefined, once: false, help: true }
  }

  let projectArg: string | undefined
  let intervalArg: string | undefined
  let status = false
  let ship = false
  let once = false

  const specs: FlagSpec[] = [
    { flag: '--project', read: (v) => { projectArg = v } },
    { flag: '--interval', read: (v) => { intervalArg = v } },
    { flag: '--status', boolean: true, read: () => { status = true } },
    { flag: '--ship', boolean: true, read: () => { ship = true } },
    { flag: '--once', boolean: true, read: () => { once = true } },
  ]

  const positionals = parseFlags(argv, specs)

  if (status && ship) throw new Error('--status and --ship do the opposite things: pass one of them, not both')

  if (status || ship) {
    if (positionals.length > 1) {
      throw new Error(`too many arguments: ${status ? '--status' : '--ship'} takes at most a repo path`)
    }
    const intervalMs = readInterval(intervalArg, ship)
    return {
      mode: status ? 'status' : 'ship',
      url: undefined,
      project: undefined,
      path: positionals[0],
      intervalMs,
      once,
      help: false,
    }
  }

  const url = positionals[0]
  if (url === undefined || url.trim().length === 0) {
    throw new Error('missing required argument: <url> (the team server to ship to)')
  }
  if (projectArg === undefined || projectArg.trim().length === 0) {
    throw new Error('missing required option: --project <id> (the team server\'s project id)')
  }
  if (intervalArg !== undefined) {
    throw new Error('--interval applies to --ship, not to enabling')
  }

  return { mode: 'enable', url, project: projectArg, path: positionals[1], intervalMs: undefined, once, help: false }
}

function readInterval(raw: string | undefined, ship: boolean): number | undefined {
  if (raw === undefined) return undefined
  if (!ship) throw new Error('--interval applies to --ship, not to --status')
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid --interval value: "${raw}" (must be a positive number of seconds)`)
  }
  return Math.round(seconds * 1000)
}

/**
 * `rhizomorph connect <subcommand>` — `team` is the only one, handled inside
 * this module the way `lab`'s subcommands are handled inside `cli/index.ts`.
 * The `team` sub-word deliberately never appears as an `argv[0] === '…'`
 * branch, so `cli-surface-law.test.ts`'s registered-surface regex sees exactly
 * one new top-level subcommand, `connect`, and not two.
 */
export async function runConnectCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
  seams: ConnectTeamSeams = {},
): Promise<never> {
  if (rest.length === 0 || rest.includes('--help') || rest.includes('-h')) {
    log.log(connectHelpText())
    exit(0)
  }

  if (rest[0] !== 'team') {
    process.stderr.write(`unknown connect subcommand: "${rest[0]}"\n\n${connectHelpText()}`)
    exit(1)
  }

  let args: ConnectTeamArgs
  try {
    args = parseConnectTeamArgs(rest.slice(1))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${connectHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(connectHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())
  const sessionDir = sessionDirFor(repoPath, options.dataRoot ?? defaultDataRoot())

  // Each branch RETURNS its exit code rather than calling `exit` itself: an
  // injected `exit` that throws (every test in this package injects one) would
  // otherwise be caught by the `catch` below and reported as a failure.
  let code = 0
  try {
    code =
      args.mode === 'enable'
        ? await enable(args, sessionDir, log, seams)
        : args.mode === 'status'
          ? await report(sessionDir, log)
          : await ship(args, sessionDir, log, seams)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }
  exit(code)
}

async function enable(
  args: ConnectTeamArgs,
  sessionDir: string,
  log: Pick<Console, 'log' | 'warn'>,
  seams: ConnectTeamSeams,
): Promise<number> {
  const raw = await readKeyFromStdin(seams.stdin ?? process.stdin)
  await enableShipper(sessionDir, {
    url: args.url as string,
    project: args.project as string,
    key: raw,
    now: seams.now ?? Date.now,
  })

  log.log(
    [
      `The shipper is on for this repo. From now on, when you run \`rhizomorph connect team --ship\`,`,
      `these leave this machine and nothing else does:`,
      '',
      `  what     the lines a portable record would carry for each recorded session, re-serialized`,
      `           through the current event schema — never the raw bytes of your log, and never`,
      `           prompts, completions, transcripts or pane content, which are in no record`,
      `  to       ${args.url}`,
      `  project  ${args.project}`,
      `  when     only while a \`rhizomorph connect team --ship\` you started is running`,
      '',
      `  credential  stored at ${ingestKeyPath(sessionDir)} (mode ${INGEST_KEY_MODE.toString(8).padStart(4, '0')})`,
      `              its value is never displayed, never logged and never written anywhere else`,
      '',
      `To turn it off: delete ${shipperDirFor(sessionDir)}`,
      `Your session logs and recordings are untouched — they were always local and they stay local.`,
    ].join('\n'),
  )
  return 0
}

async function report(sessionDir: string, log: Pick<Console, 'log' | 'warn'>): Promise<number> {
  log.log(renderStatus(await shipperStatus(sessionDir), sessionDir))
  return 0
}

async function ship(
  args: ConnectTeamArgs,
  sessionDir: string,
  log: Pick<Console, 'log' | 'warn'>,
  seams: ConnectTeamSeams,
): Promise<number> {
  const config = await readTeamConfig(sessionDir)
  if (config === null) {
    process.stderr.write(
      'the shipper is not enabled for this repo — turn it on first with:\n' +
        '  echo "$RZK_INGEST_KEY" | rhizomorph connect team <url> --project <id>\n',
    )
    return 1
  }

  const controller = new AbortController()
  const stop = () => controller.abort()
  if (seams.signal === undefined) {
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }

  const result = await runShipperLoop({
    sessionDir,
    intervalMs: args.intervalMs,
    once: args.once,
    signal: seams.signal ?? controller.signal,
    now: seams.now,
    fetch: seams.fetch,
    log: {
      pass: (pass) => {
        if (!pass.enabled) return
        log.log(
          `shipped ${pass.shipped} line${pass.shipped === 1 ? '' : 's'}` +
            (pass.skipped > 0 ? `, skipped ${pass.skipped}` : '') +
            (pass.failures.length > 0 ? `\n  ${pass.failures.join('\n  ')}` : ''),
        )
      },
      error: (message) => {
        process.stderr.write(`${message}\n`)
      },
    },
  })

  if (result.clamped) {
    log.warn(`--interval was below the ${MIN_INTERVAL_MS / 1000}s floor and was raised to it`)
  }

  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  return 0
}

/**
 * All of stdin, trimmed. A TTY is refused by name rather than prompted: the
 * remedy is the pipe form, and printing it is more useful than a prompt
 * nothing else in this CLI has.
 */
async function readKeyFromStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (stream.isTTY === true) {
    throw new Error(
      'no key on stdin — pipe it: echo "$RZK_INGEST_KEY" | rhizomorph connect team <url> --project <id>',
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) {
    throw new Error(
      'nothing arrived on stdin — pipe the key: echo "$RZK_INGEST_KEY" | rhizomorph connect team <url> --project <id>',
    )
  }
  return raw
}

/** `--status`'s report. Presence and counts; the credential's value appears nowhere and cannot. */
export function renderStatus(status: ShipperStatus, sessionDir: string): string {
  if (!status.enabled) {
    return [
      'shipper: off — nothing leaves this machine.',
      'Turn it on for this repo with:',
      '  echo "$RZK_INGEST_KEY" | rhizomorph connect team <url> --project <id>',
    ].join('\n')
  }

  const lines = [
    'shipper: on',
    `  to          ${status.url}`,
    `  project     ${status.project}`,
    `  credential  ${status.keyPresent ? 'present' : 'MISSING'}${
      status.keyMode === null ? '' : ` (mode ${status.keyMode.toString(8).padStart(4, '0')})`
    } — its value is never shown or logged`,
  ]

  if (status.actors.length === 0) {
    lines.push('  shipped     nothing yet')
  } else {
    for (const actor of status.actors) {
      lines.push(
        `  session ${actor.actorInstance}  through n=${actor.n} (byte ${actor.offset})` +
          (actor.skippedCount > 0 ? `, ${actor.skippedCount} line(s) this build could not fold` : ''),
      )
      for (const skip of actor.skipped) {
        lines.push(`      n=${skip.n} ${skip.kind}: ${skip.reason}`)
      }
    }
  }

  if (status.cursorReset !== null) lines.push(`  note        ${status.cursorReset}`)
  lines.push(`  off switch  delete ${shipperDirFor(sessionDir)}`)
  return lines.join('\n')
}

/**
 * The doctor's read (ADR-0034 clause 2: presence, never value).
 *
 * `cli/doctor.ts` calls THIS, and never imports `shipper/` — a second entry in
 * `hand-law.test.ts`'s `DECLARED_IMPORTERS` would widen the clause-3 seam the
 * law exists to keep narrow, and the seam being one file wide is the whole
 * property.
 */
export interface ShipperDoctorFacts {
  enabled: boolean
  url: string | null
  project: string | null
  keyPresent: boolean
  keyMode: number | null
  /** The furthest `n` any session has shipped through. */
  maxN: number
  /**
   * The most recently acknowledged batch's local wall clock, epoch ms, across
   * every session recorded in the cursor (prd-51 ruling 12's falsifier: the
   * cursor is per-session, this fact is per-repo, and "most recent wins" is
   * the same answer `maxN` already gives the identical question). `0` when
   * no session has ever had a batch acknowledged — the same sentinel `maxN`
   * and `sessionCount` already use below, never confused with a real
   * timestamp because `Date.now()` never returns `0`.
   *
   * Sourced from `ActorCursor.lastAckAt` (`shipper/cursor.ts`), which is
   * documented there as "never crosses the wire" — this field is that same
   * guarantee read back to the OPERATOR (a doctor check, a CLI report, a
   * `/connect` row), never sent onward to the team server. Nothing in this
   * lane adds a second write path for it.
   */
  lastAckAt: number
  /** How many sessions have a cursor entry at all. */
  sessionCount: number
  skippedCount: number
  cursorReset: string | null
  /** Set when the enable record itself could not be read — "off" would be the wrong answer, so it is not given. */
  configError: string | null
}

export async function shipperDoctorFacts(repoPath: string, dataRoot?: string): Promise<ShipperDoctorFacts> {
  const sessionDir = sessionDirFor(repoPath, dataRoot ?? defaultDataRoot())
  const absent: ShipperDoctorFacts = {
    enabled: false,
    url: null,
    project: null,
    keyPresent: false,
    keyMode: null,
    maxN: 0,
    lastAckAt: 0,
    sessionCount: 0,
    skippedCount: 0,
    cursorReset: null,
    configError: null,
  }

  let status: ShipperStatus
  try {
    status = await shipperStatus(sessionDir)
  } catch (err) {
    return { ...absent, configError: err instanceof Error ? err.message : String(err) }
  }

  if (!status.enabled) return absent

  return {
    enabled: true,
    url: status.url,
    project: status.project,
    keyPresent: status.keyPresent,
    keyMode: status.keyMode,
    maxN: status.actors.reduce((most, actor) => Math.max(most, actor.n), 0),
    lastAckAt: status.actors.reduce((most, actor) => Math.max(most, actor.lastAckAt), 0),
    sessionCount: status.actors.length,
    skippedCount: status.actors.reduce((sum, actor) => sum + actor.skippedCount, 0),
    cursorReset: status.cursorReset,
    configError: null,
  }
}

/** Where the credential lives, for the doctor's remedy line. A PATH, never a read. */
export function shipperKeyPath(repoPath: string, dataRoot?: string): string {
  return ingestKeyPath(sessionDirFor(repoPath, dataRoot ?? defaultDataRoot()))
}

export interface EnableShipperOptions {
  url: string
  project: string
  /** The raw `rzk_` value, as it arrived on stdin. Validated here; never printed. */
  key: string
  now?: () => number
}

/**
 * Turn the hand on for one repo: store the credential, then the enable record.
 *
 * **The key is written first, deliberately.** An enable record with no
 * credential beside it is the one state `doctor` has to call a `fail`, and
 * there is no reason to create it on the way to a value that might be refused
 * anyway — `writeIngestKey` validates the shape and throws before anything
 * else exists on disk.
 *
 * Exported because this is the hand's one write path, and everything that
 * needs to reach it — the doctor's own tests included — comes through this
 * module rather than importing `shipper/` and widening ADR-0034's clause-3
 * seam to a second declared importer.
 */
export async function enableShipper(sessionDir: string, options: EnableShipperOptions): Promise<void> {
  await writeIngestKey(sessionDir, options.key)
  await writeTeamConfig(sessionDir, {
    version: TEAM_CONFIG_VERSION,
    url: options.url,
    project: options.project,
    enabledAt: (options.now ?? Date.now)(),
  })
}

/** The directory the "how to turn it off" line names — deleting it is the off switch. */
export function shipperDirectory(repoPath: string, dataRoot?: string): string {
  return shipperDirFor(sessionDirFor(repoPath, dataRoot ?? defaultDataRoot()))
}

/** Where the enable record lives, for a caller holding a repo path rather than a session dir. */
export function shipperTeamConfigPath(repoPath: string, dataRoot?: string): string {
  return teamConfigPath(sessionDirFor(repoPath, dataRoot ?? defaultDataRoot()))
}

/** Where ruling 7's cursor lives, same convention. */
export function shipperCursorPath(repoPath: string, dataRoot?: string): string {
  return cursorPath(sessionDirFor(repoPath, dataRoot ?? defaultDataRoot()))
}
