import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AdapterCapabilities,
  absentCapabilities,
  attentionReading,
  buildFleet,
  CONFIGURED_SILENT_REASON,
  CONFIGURED_SILENT_REMEDY,
  type DeclaredAttention,
  type Exec,
  type ExecResult,
  formatSpan,
  lapsedVoice,
  mergeCapabilities,
  reduceAll,
  type SessionState,
} from '@rhizomorph/core'
import { lanesManifestPath, readLanesManifest } from '../api/lanes.js'
import { beaconCapabilitiesFor } from '../collectors/beacon/index.js'
import { GIT_CAPABILITIES } from '../collectors/git/index.js'
import { OTEL_CAPABILITIES } from '../collectors/otel/index.js'
import { processWitnessCapabilitiesFor } from '../collectors/process/doctor-row.js'
import { SESSIONLOG_CAPABILITIES } from '../collectors/sessionlog/index.js'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { TMUX_CAPABILITIES } from '../collectors/tmux/index.js'
import { WORKMUX_CAPABILITIES } from '../collectors/workmux/index.js'
import { DECLARED_HARNESSES, IMPLEMENTED_HARNESS_IDS } from '../harness-roster.js'
import { formatBytes } from '../lib/format.js'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import { decideSessionBoot, formatBootDuration, listSessions, readSessionEvents } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
import { DEFAULT_PORT, type FlagSpec, parseFlags } from './args.js'
// Presence, never value (ADR-0034 clause 2) — and reached THROUGH the connect
// command's own read rather than by importing `shipper/`, which would widen
// that law's one-file `DECLARED_IMPORTERS` seam.
import { shipperDoctorFacts, shipperKeyPath } from './connect-team.js'
import { capabilityAwareFetch } from './rotate.js'
import type { RunCliOptions } from './types.js'

/**
 * Read-only preflight for a stranger's first run: every check here only
 * inspects state (filesystem, a probe socket, `git rev-parse`) and never
 * changes anything. `rhizomorph doctor` exists because the plain run
 * command validates nothing and a broken setup fails silently or with a raw
 * stack trace — see docs/prd2.md scope D.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: CheckStatus
  /** One line: the finding, and — for warn/fail — the exact remedy. */
  message: string
  /**
   * True when this finding rests on an assumed fact rather than one this
   * call actually measured — never set by the CLI, which measures
   * everything it reports. `GET /api/doctor` sets it on `ladder`/`ladder:*`
   * when the `target-path` input that fed the ladder's git contributor was
   * a synthetic `ok` rather than a real `checkTargetPath` run (adversarial
   * review item 3): a stranger reading the JSON must be able to tell
   * measured from assumed without reading this file's source. Absent, not
   * `false`, when nothing was assumed — the common case stays as compact as
   * before.
   */
  assumed?: boolean
  /**
   * Whether an ENRICHMENT is actually on the machine — prd-57 ruling 8.
   *
   * Present only on an enrichment's own check (`tmux`, `workmux`), and it
   * exists because ruling 8 made `status` unable to answer the question. Both
   * present and absent read `ok` now, deliberately: neither is a problem. But
   * the ladder's contributors still have to know which, and they used to read
   * it off `status === 'ok'` — so the moment the verdict moved, an ABSENT tool
   * began contributing its capabilities and every bare machine read as though
   * it had a rig.
   *
   * Caught by a test that mocked both tools missing and still got "pane
   * previews and ATTACH from the rig you already run". The lesson is the one
   * this repo keeps re-learning: a reader that INFERS a fact from a verdict
   * breaks silently the moment the verdict's meaning changes, so the fact gets
   * carried rather than deduced.
   */
  present?: boolean
  /**
   * The shipper check's own fact (prd-51 ruling 12): epoch ms of the most
   * recently acknowledged batch across every session recorded in its cursor.
   * Present ONLY on the `shipper` check, and ONLY once at least one batch has
   * actually been acknowledged. Absent — never `0` — on every other check,
   * and absent on `shipper` itself before its first acknowledgement: the
   * same absent-not-false convention {@link assumed} uses one field up, for
   * the same reason — a shipper that has never acknowledged anything has no
   * timestamp to report, not a zero one.
   */
  lastAckAt?: number
}

export interface DoctorReport {
  checks: DoctorCheck[]
  /** Non-zero only when the app genuinely cannot work: bad path, not a repo, no web build, port taken. */
  exitCode: 0 | 1
}

export interface DoctorOptions {
  /** Target repo path, or undefined to default to cwd — same convention as the main command. */
  path?: string
  port: number
  exec?: Exec
  webDistDir?: string
  /** Overrides `~/.claude/projects`; tests point this at a fixture dir. */
  claudeProjectsRoot?: string
  /** Overrides `~/.local/share/rhizomorph` — tests point this at a temp dir. */
  dataRoot?: string
  /** Injectable clock for the session-boundary check, so its age figures are deterministic in tests. */
  now?: () => number
  /** Overrides `process.version`, e.g. `"v18.2.0"` — tests inject this so the check is deterministic. */
  nodeVersion?: string
  /** Overrides the root `package.json` path this reads `engines.node` from. */
  rootPackageJsonPath?: string
  /** Overrides `process.env` for the telemetry check. */
  env?: NodeJS.ProcessEnv
  /** Overrides `process.platform` for the telemetry check's remedy voice — tests inject `'win32'` deterministically. */
  platform?: string
  /** Injectable `fetch`, so the own-server-on-a-busy-port probe needs no real socket in tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

/** Falls back to this when the root `package.json` has no `engines.node` yet (README already states it). */
const DEFAULT_NODE_ENGINE_RANGE = '>=22'

const FAILING_CHECK_IDS: ReadonlySet<string> = new Set(['target-path', 'web-build', 'port'])

/** Parses `rhizomorph doctor [path] [--port <n>] [--help]`. */
export interface DoctorArgs {
  path: string | undefined
  port: number
  help: boolean
}

/** `rhizomorph doctor`'s own usage table, distinct from the main command's. */
export function doctorHelpText(): string {
  return `rhizomorph doctor [path] [options]

Read-only preflight: checks the Node version, the target path (exists and is
a git repo), the web build, whether the port is free, Claude Code session
logs, tmux/workmux presence, telemetry env, the harness roster, and each
present lane's declared attention (never declared / configured but silent /
declared / lapsed) — one ok/warn/FAIL line per check, each with its remedy. Exits non-zero only when
the app genuinely cannot run (bad path, not a repo, no web build, port taken).

Arguments:
  path                    Repo to check (default: current directory)

Options:
  --port <n>              Port to check for availability (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit
`
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, port: DEFAULT_PORT, help: true }
  }

  let portArg: string | undefined
  const specs: FlagSpec[] = [{ flag: '--port', read: (v) => { portArg = v } }]

  const positionals = parseFlags(argv, specs)
  const path = positionals[0]

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { path, port, help: false }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const exec = options.exec ?? realExec
  const fetchImpl = options.fetch ?? globalThis.fetch
  const repoPath = path.resolve(options.path ?? process.cwd())

  const baseChecks: DoctorCheck[] = [
    await checkNodeVersion(options),
    await checkTargetPath(repoPath, exec),
    checkWebBuild(options.webDistDir ?? defaultWebDistDir()),
    await checkPort(options.port, repoPath, fetchImpl),
    checkClaudeProjects(options.claudeProjectsRoot, repoPath, options.now),
    await checkSessionBoundary(repoPath, options.dataRoot, options.now ?? Date.now),
    await checkOptionalTool('tmux', 'tmux', ['-V'], exec),
    await checkOptionalTool('workmux', 'workmux', ['status'], exec),
    checkTelemetryEnv(options.env ?? process.env, options.platform ?? process.platform),
    await checkLaneManifest(repoPath),
    await checkShipper(repoPath, options.dataRoot),
    await checkCliVersionDrift(exec),
    checkHarnessRoster(),
  ]

  const attention = await checkDeclaredAttention(repoPath, options.dataRoot, options.now ?? Date.now)
  const withAttention: DoctorCheck[] = [...baseChecks, ...attention.checks]

  const checks: DoctorCheck[] = [
    ...withAttention,
    ...(await checkEnrichmentLadder(withAttention, repoPath, attention.declared, attention.processes)),
  ]

  const exitCode = checks.some((check) => FAILING_CHECK_IDS.has(check.id) && check.status === 'fail') ? 1 : 0
  return { checks, exitCode }
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

/** Renders a `runDoctor` report as the lines `rhizomorph doctor` prints. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => `[${STATUS_LABEL[check.status]}] ${check.message}`)
  const failing = report.checks.filter((check) => check.status === 'fail').length
  const summary =
    failing > 0
      ? `${failing} check${failing === 1 ? '' : 's'} failed — fix these before rhizomorph can run.`
      : 'All required checks passed.'
  return [...lines, '', summary].join('\n')
}

/**
 * `rhizomorph doctor [path]` — a standalone, read-only subcommand, no
 * server boot. Same clean-usage-error contract as the main command: a bad
 * argv prints to stderr and exits 1, `--help` prints to stdout and exits 0.
 * The report's own exit code (0 or 1) is what actually terminates the
 * process — it reflects whether the app can run, not an argv parse failure.
 */
export async function runDoctorCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let doctorArgs
  try {
    doctorArgs = parseDoctorArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${doctorHelpText()}`)
    exit(1)
  }

  if (doctorArgs.help) {
    log.log(doctorHelpText())
    exit(0)
  }

  const report = await runDoctor({
    path: doctorArgs.path,
    port: doctorArgs.port,
    exec: options.exec,
    webDistDir: options.webDistDir,
    claudeProjectsRoot: options.claudeProjectsRoot,
    dataRoot: options.dataRoot,
    now: options.now,
  })

  log.log(renderDoctorReport(report))
  exit(report.exitCode)
}

export async function checkNodeVersion(options: Pick<DoctorOptions, 'nodeVersion' | 'rootPackageJsonPath'>): Promise<DoctorCheck> {
  const nodeVersion = options.nodeVersion ?? process.version
  const range = await resolveRequiredNodeRange(options.rootPackageJsonPath ?? defaultRootPackageJsonPath())
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0])
  const required = requiredMajor(range)

  if (Number.isFinite(major) && major >= required) {
    return { id: 'node', status: 'ok', message: `Node ${nodeVersion} satisfies the required ${range}` }
  }
  return {
    id: 'node',
    status: 'warn',
    message: `Node ${nodeVersion} is older than the required ${range} — install a newer Node (e.g. \`nvm install ${required}\`)`,
  }
}

function requiredMajor(range: string): number {
  const match = /(\d+)/.exec(range)
  return match ? Number(match[1]) : 22
}

async function resolveRequiredNodeRange(rootPackageJsonPath: string): Promise<string> {
  try {
    const raw = await readFile(rootPackageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as { engines?: { node?: string } }
    return pkg.engines?.node ?? DEFAULT_NODE_ENGINE_RANGE
  } catch {
    return DEFAULT_NODE_ENGINE_RANGE
  }
}

function defaultRootPackageJsonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', '..', 'package.json')
}

/**
 * Same dist dir the server would otherwise serve statically
 * (`cli/index.ts`'s `defaultWebDistDir`) — duplicated rather than imported
 * to avoid a circular `index.ts` <-> `doctor.ts` import.
 */
function defaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', 'web', 'dist')
}

async function checkTargetPath(repoPath: string, exec: Exec): Promise<DoctorCheck> {
  if (!existsSync(repoPath)) {
    return {
      id: 'target-path',
      status: 'fail',
      message: `target path ${repoPath} does not exist — pass an existing repo, e.g. \`npm exec rhizomorph -- doctor ~/code/my-repo\``,
    }
  }

  const result = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath })
  if (result.failed || result.stdout.trim() !== 'true') {
    return {
      id: 'target-path',
      status: 'fail',
      message: `${repoPath} is not a git repository — cd into a git repo, or pass one as the first argument`,
    }
  }

  return { id: 'target-path', status: 'ok', message: `${repoPath} exists and is a git repository` }
}

function checkWebBuild(webDistDir: string): DoctorCheck {
  const indexHtml = path.join(webDistDir, 'index.html')
  if (existsSync(indexHtml)) {
    return { id: 'web-build', status: 'ok', message: `web build present at ${indexHtml}` }
  }
  return {
    id: 'web-build',
    status: 'fail',
    message: `web build missing at ${indexHtml} — run \`npm run build --workspace packages/web\``,
  }
}

/**
 * A busy port used to be an unconditional FAIL — the audit's worst stumble:
 * a healthy rhizomorph already serving this very port reported
 * `[FAIL] port in use … fix these before rhizomorph can run` (prd9 ruling 8).
 * So a busy port now gets one more look before it is condemned: probe
 * `/api/meta` and, if it answers with a rhizomorph's own meta shape, that is
 * exactly the thing working as intended.
 */
async function checkPort(
  port: number,
  targetRepoPath: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<DoctorCheck> {
  const free = await isPortFree(port)
  if (free) {
    return { id: 'port', status: 'ok', message: `port ${port} is free` }
  }

  const ownMeta = await probeRhizomorphMeta(port, fetchImpl)
  if (ownMeta) {
    const startedAt = new Date(ownMeta.startedAt).toISOString()
    const which = ownMeta.repoPath === targetRepoPath ? 'this repo' : ownMeta.repoName
    return {
      id: 'port',
      status: 'ok',
      message: `a rhizomorph is already serving ${which} on port ${port} (started ${startedAt}) — nothing to fix`,
    }
  }

  return {
    id: 'port',
    status: 'fail',
    message: `port ${port} is already in use — pass a different one with --port <n>`,
  }
}

interface RhizomorphMeta {
  repoPath: string
  repoName: string
  sessionId: string
  startedAt: number
}

function isRhizomorphMeta(body: unknown): body is RhizomorphMeta {
  if (typeof body !== 'object' || body === null) return false
  const meta = body as Record<string, unknown>
  return (
    typeof meta.repoPath === 'string' &&
    typeof meta.repoName === 'string' &&
    typeof meta.sessionId === 'string' &&
    typeof meta.startedAt === 'number'
  )
}

/**
 * Whatever is on `port` is a rhizomorph only if it answers `/api/meta` with
 * that exact shape — anything else (a stray dev server, a typo'd port) stays
 * a FAIL.
 *
 * `/api/meta` is a `gated-read` (prd-29 ruling 7, #59), so this speculative
 * probe goes through {@link capabilityAwareFetch} — the same shared scrape
 * `rhizomorph env` uses — rather than a bare, tokenless request that would
 * now just 401. This probe is inherently speculative (the port might not be
 * a rhizomorph at all, or a rhizomorph with no built dashboard to hand a
 * token out through), so EVERY failure along that path — the GET / scrape
 * itself throwing, a non-2xx, a body that isn't JSON, a body that isn't
 * rhizomorph-shaped — still collapses onto the same honest `null` the
 * try/catch below always returned: "not our own rhizomorph, port genuinely
 * busy". Nothing about adding the extra scrape request changes that contract.
 */
async function probeRhizomorphMeta(
  port: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<RhizomorphMeta | null> {
  try {
    const rhizomorphFetch = capabilityAwareFetch(port, { fetch: fetchImpl })
    const response = await rhizomorphFetch(`http://127.0.0.1:${port}/api/meta`)
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isRhizomorphMeta(body) ? body : null
  } catch {
    return null
  }
}

function isPortFree(port: number): Promise<boolean> {
  // 0 means "let the OS pick a free port" — always free by construction.
  if (port === 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** One line always safe to repeat in a warn message — never assumes which rung (slug dir vs global root) is the one to fix. */
const NO_HISTORY_REMEDY =
  'per-agent history stays empty until `claude` has run at least once here'

/**
 * `~/.claude/projects` existing at all used to be the whole check (#284
 * review, Seat A finding 7 / this issue): a machine where Claude Code was
 * ever run for ANY repo greened this for an unrelated watched repo. The real
 * fact prd-19 ruling 5 wants is the *slug dir the sessionlog collector would
 * actually tail for this repo* — `~/.claude/projects/<slug>` — so this now
 * derives that path with `worktreePathToProjectSlug`, the collector's own
 * inference (`collectors/sessionlog/collector.ts`'s `tailProjectDir`), rather
 * than duplicating the `/` `_` → `-` rule a second time. The global root stays
 * in the message as a fallback rung — present or not, it never overrides what
 * the slug dir itself says — so a warn here never reads as "nothing is set up
 * anywhere" when the truth is narrower: "not for this repo".
 *
 * `repoPath` is `undefined` only when called exactly as before this issue —
 * today that is `GET /api/doctor` (`packages/server/src/api/doctor.ts`),
 * which sits outside this fix's fence (issue #288) and still calls this with
 * one argument. That branch is kept so the route keeps compiling and behaving
 * byte-for-byte as it did pre-#288; the moment that file's own call site
 * threads its already-in-scope `repoPath` through as the second argument, it
 * gets the same deepened, per-repo answer the CLI gets here.
 */
export function checkClaudeProjects(claudeProjectsRoot?: string, repoPath?: string, now?: () => number): DoctorCheck {
  const root = claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')

  if (repoPath === undefined) {
    return checkGlobalClaudeProjectsRootOnly(root)
  }

  const slugDir = path.join(root, worktreePathToProjectSlug(repoPath))
  const slugState = readSessionLogDirState(slugDir)

  if (slugState.kind === 'has-sessions') {
    const age = formatBootDuration((now ?? Date.now)() - slugState.newestMtimeMs)
    const count = slugState.jsonlCount
    return {
      id: 'session-logs',
      status: 'ok',
      message: `Claude Code session logs found at ${slugDir} (${count} session file${count === 1 ? '' : 's'}, newest ${age} old)`,
    }
  }

  const rootExists = existsSync(root)
  const missReason =
    slugState.kind === 'empty-dir'
      ? `a session log dir for this repo exists at ${slugDir} but has no *.jsonl files yet`
      : `no Claude Code session log dir for this repo at ${slugDir}`
  const rootClause = rootExists
    ? `the global root at ${root} exists — Claude Code has been used for other repos, just not this one`
    : `no Claude Code session logs exist anywhere at ${root} either`

  return {
    id: 'session-logs',
    status: 'warn',
    message: `${missReason} — ${rootClause} — ${NO_HISTORY_REMEDY}`,
  }
}

/** Byte-identical to this check's pre-#288 behaviour — see `checkClaudeProjects`'s own doc for why this branch stays reachable. */
function checkGlobalClaudeProjectsRootOnly(dir: string): DoctorCheck {
  if (existsSync(dir)) {
    return { id: 'session-logs', status: 'ok', message: `Claude Code session logs found at ${dir}` }
  }
  return {
    id: 'session-logs',
    status: 'warn',
    message: `no Claude Code session logs at ${dir} — ${NO_HISTORY_REMEDY}`,
  }
}

type SessionLogDirState =
  | { kind: 'missing' }
  | { kind: 'empty-dir' }
  | { kind: 'has-sessions'; jsonlCount: number; newestMtimeMs: number }

/** Synchronous by design — `checkClaudeProjects` must stay sync so it can keep sitting unawaited in both `runDoctor`'s and `runServerDoctor`'s check arrays. */
function readSessionLogDirState(slugDir: string): SessionLogDirState {
  if (!existsSync(slugDir)) return { kind: 'missing' }

  const jsonlNames = readdirSync(slugDir).filter((name) => name.endsWith('.jsonl'))
  if (jsonlNames.length === 0) return { kind: 'empty-dir' }

  const newestMtimeMs = Math.max(...jsonlNames.map((name) => statSync(path.join(slugDir, name)).mtimeMs))
  return { kind: 'has-sessions', jsonlCount: jsonlNames.length, newestMtimeMs }
}

/**
 * The session-boundary line #126's honesty style demands: which session the
 * *next* plain `rhizomorph` boot would pick, why, and the exact flag to
 * override it — read-only, same as every other check here, via
 * `decideSessionBoot` (never `recordResume`, which would count as a boot).
 * Never fails: the boundary is a default to know about, not a precondition
 * to run.
 */
export async function checkSessionBoundary(repoPath: string, dataRoot: string | undefined, now: () => number): Promise<DoctorCheck> {
  const sessionDir = sessionDirFor(repoPath, dataRoot ?? defaultDataRoot())
  const decision = await decideSessionBoot(sessionDir, now())
  const window = formatBootDuration(decision.windowMs)
  const forceFlag = 'force a new one with --fresh (or --resume-window 0)'

  if (decision.reason === 'first-run') {
    return {
      id: 'session-boundary',
      status: 'ok',
      message: `no rhizomorph session recorded yet for ${repoPath} — the next run starts a fresh one (resume window ${window})`,
    }
  }

  if (decision.reason === 'writer-alive' && decision.liveWriter) {
    return {
      id: 'session-boundary',
      status: 'warn',
      message:
        `session ${decision.liveWriter.sessionId} is being written by a live instance ` +
        `(pid ${decision.liveWriter.pid}) — the next run will start a fresh session instead of resuming it, ` +
        `${forceFlag} to silence this, or stop the other instance`,
    }
  }

  // prd16 ruling 2: an operator's rotation outranks the window, so doctor must
  // not report a deliberately-closed session as merely stale.
  if (decision.reason === 'closed') {
    return {
      id: 'session-boundary',
      status: 'ok',
      message: `the last session for ${repoPath} was closed on purpose (\`npm exec rhizomorph -- rotate\`, or the dashboard's button) — the next run starts a fresh one (a closed log is never resumed, whatever the ${window} window says)`,
    }
  }

  if (decision.resumed) {
    const size = await sessionFileSize(decision.resumed.filePath)
    const age = decision.previousAgeMs === null ? 'unknown age' : `${formatBootDuration(decision.previousAgeMs)} old`
    return {
      id: 'session-boundary',
      status: 'ok',
      message:
        `session ${decision.resumed.sessionId} would resume — newest event ${age} < ${window} window, ` +
        `${decision.eventCountAtBoot.toLocaleString()} events (${size}), resumed ${decision.resumedCount} ` +
        `time${decision.resumedCount === 1 ? '' : 's'} so far — ${forceFlag}`,
    }
  }

  const age = decision.previousAgeMs === null ? 'unreadable' : `${formatBootDuration(decision.previousAgeMs)} stale`
  return {
    id: 'session-boundary',
    status: 'ok',
    message: `previous session ${age} > ${window} window — the next run starts a fresh one`,
  }
}

async function sessionFileSize(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath)
    return formatBytes(info.size)
  } catch {
    return 'size unknown'
  }
}


/**
 * THE THREE LEVELS — prd-57 ruling 8.
 *
 * A RE-CUT of prd-15 ruling 5's ladder, not a second one. That ruling's rungs
 * keep their names and their meanings, and `core`'s `Rung`/`deriveRung` are
 * untouched: `ADR-0037`'s option D cites "L2 versus L0" in its reasoning, and a
 * rename would leave that citation resolving to nothing. What moves is what the
 * rungs GROUP, and it moves here, in the one file that reports them to a person.
 *
 * The old ladder made **L4 (tmux/workmux) the top**, so every machine without a
 * multiplexer was told, in the instrument's own words, that it sat two rungs
 * below where it could be and that the way up was to install one. That is the
 * claim ruling 8 removes. A rig is an ENRICHMENT — it adds pane previews and
 * one-keystroke ATTACH, both real and neither a level.
 *
 * So the levels are cut on what the instrument can SEE, which is the axis the
 * operator actually cares about:
 *
 * - **L0** — git and the transcript organ. Zero cooperation from anything.
 * - **L1** — plus dollars and traces, because OTLP is wired.
 * - **L2** — plus attention that was DECLARED rather than inferred.
 *
 * `L2` is reached by either declaring witness, which is the substantive change
 * from `deriveRung`: it splits them (`L2` for the beacon, `L4` for the rig)
 * because it is answering "what is providing this", and the answer matters to a
 * fold. A person climbing is asking a different question — *is attention
 * declared or guessed* — and both witnesses answer it the same way.
 *
 * `L3` (the PTY wrapper) folds to whatever its telemetry says, because its
 * signature is a HEURISTIC attention: that is inference, so it is not L2, and
 * `deriveRung`'s own doc says it comes with no telemetry at all, so it is L0.
 * Nothing in this repo reaches it.
 */
export type DoctorLevel = 'L0' | 'L1' | 'L2'

export const LEVEL_INFO: Record<DoctorLevel, { label: string; climb: string | null }> = {
  L0: {
    label: 'L0 — git and your own session logs',
    // ONE command, and it is one command because ruling 4 made it one: `enlist`
    // writes the telemetry variables AND the lifecycle hooks in a single act,
    // so the climb out of L0 does not stop at L1. Naming two steps here would
    // be describing the old paste-per-lane path, which still works and is not
    // what a first-time reader should be sent to.
    climb: 'run `rhizomorph enlist claude` — one act, and it reaches L2',
  },
  L1: {
    label: 'L1 — plus dollars and traces',
    climb: 'run `rhizomorph enlist claude` — its hooks declare attention instead of inferring it',
  },
  L2: { label: 'L2 — plus declared attention', climb: null },
}

/**
 * Which level this machine stands at. Pure, total, and read top-down.
 *
 * Attention first because it is the higher bar, and `provided` by ANY witness —
 * see {@link LEVEL_INFO} for why this differs from `deriveRung` exactly there.
 */
export function doctorLevel(capabilities: AdapterCapabilities): DoctorLevel {
  if (capabilities.attention.level === 'provided') return 'L2'
  if (capabilities.cost.level !== 'absent') return 'L1'
  return 'L0'
}

/** True only when the binary itself could not be run — not for a non-zero exit with real output (same test used by the workmux collector). */
function isMissingBinary(result: { failed: boolean; errorMessage?: string }): boolean {
  return result.failed && result.errorMessage !== undefined
}

/**
 * An ENRICHMENT's check — prd-57 ruling 8.
 *
 * **Absent reads `ok`, not `warn`**, and that is the ruling rather than a
 * softening. A `warn` says *something is wrong here that you should fix*. A
 * machine with no tmux has nothing wrong with it: the instrument works, the
 * fleet folds, every level below is reachable. The old wording already knew
 * this and said it in the same breath — *"optional and will be degraded, not
 * fatal"* — which is a `warn` apologising for itself.
 *
 * What it cost is the thing ruling 8 exists to end: a first run printed two
 * warnings naming two tools the reader had never heard of, and the honest
 * reading of a warning is that you are expected to act on it. So the answer to
 * "what do I install to use this?" became "tmux and workmux", which was never
 * true and is the opposite of an anywhere-instrument.
 *
 * **The blast radius, measured rather than assumed.** The issue's sibling case
 * warns that this is shared and that changing its verdict changes it for every
 * other optional tool. There is no other optional tool: all four call sites in
 * the package are tmux and workmux (two here, two in `api/doctor.ts`), which is
 * why the semantics could move without a second function and without touching a
 * file outside this fence. `doctor.test.ts` holds that as a law rather than
 * leaving it to the grep I ran once — a third tool routed through here would
 * redden it, and whoever adds one has to decide deliberately whether it is an
 * enrichment too.
 *
 * A tool that is PRESENT and erroring still warns. That is a different fact: it
 * is on the machine, the operator installed it on purpose, and it is broken.
 */
export async function checkOptionalTool(id: string, command: string, args: string[], exec: Exec): Promise<DoctorCheck> {
  const result = await exec(command, args)
  if (isMissingBinary(result)) {
    return {
      id,
      status: 'ok',
      present: false,
      message: `${command} is not installed — an enrichment this instrument does not require`,
    }
  }
  if (result.failed) {
    return {
      id,
      status: 'warn',
      // On the machine, and broken. Still `present`: the operator installed it
      // on purpose and the ladder should not pretend it is absent.
      present: true,
      message: `${command} found but erroring: ${describeToolError(result)} — its data is optional and will be degraded, not fatal`,
    }
  }
  // Present and working. Said as an enrichment that IS here rather than as a
  // requirement that is satisfied — the two configurations must differ in
  // nothing but this sentence (Success 7).
  return {
    id,
    status: 'ok',
    present: true,
    message: `${command} is installed — an enrichment this instrument does not require`,
  }
}

/** Best available one-line reason for a present-but-failing tool: real stderr, else the exit code. */
function describeToolError(result: ExecResult): string {
  const stderr = result.stderr.trim()
  if (stderr) return stderr.split('\n')[0]!
  return `exited with code ${result.code}`
}

/**
 * Reports the harness roster — prd-26 ruling 6, "never two rosters" — from the
 * roster itself, imported.
 *
 * ## Why this is an import and not a source read
 *
 * The concierge namespace law (ADR-0019 / prd-20 ruling 1,
 * `concierge/namespace-law.test.ts`) grants exactly one import edge into
 * `concierge/`, `api/concierge.ts`; this file is not it, and the law's
 * `SPECIFIER_RE` matches `from '…'`, so even a type-only import would be a
 * violation. #325 worked around that by reading the adapter *source text* at
 * runtime — legal, and correct in development.
 *
 * It was wrong everywhere else. `npm run build` emits one esbuild bundle,
 * `packages/server/dist/cli/index.js`, and the published package ships `dist`
 * and `bin` with no `src/`, so an installed `rhizomorph doctor` looked for
 * `.ts` files that are not there and reported `could not read the harness
 * roster` on every run — a check reporting its own absence as a source-shape
 * change, on one of the three surfaces #325 exists to make honest. Verified by
 * running the built bundle, not by reading it.
 *
 * `harness-roster.ts` holds the roster as data outside the concierge namespace
 * for exactly this reason: `concierge/harness/not-implemented.ts` builds its
 * adapters from it and this check reads it, one table with two readers, no
 * edge into the hand and nothing parsed at runtime. `scripts/pack-smoke.sh`
 * now runs `doctor` against the installed artifact so the shipped answer is
 * gated rather than assumed.
 *
 * Status is `ok` or nothing: there is no failure mode left to report. The
 * arrays are compile-time constants, so the old `warn` arms could not fire for
 * a real reason — and a branch that cannot fire is the shape this repo treats
 * as a defect rather than as caution.
 */
export function checkHarnessRoster(): DoctorCheck {
  const implemented = IMPLEMENTED_HARNESS_IDS
  const declared = DECLARED_HARNESSES.map((harness) => harness.id)
  return {
    id: 'harness-roster',
    status: 'ok',
    message:
      `harness roster: ${implemented.length} implemented (${implemented.join(', ')}), ${declared.length} declared ` +
      `not-implemented (${declared.join(', ')}) — one roster, packages/server/src/harness-roster.ts`,
  }
}

export interface DeclaredAttentionFacts {
  checks: DoctorCheck[]
  /** The newest session's folded `declared`, for the ladder's beacon contributor; `{}` when no session exists. */
  declared: Readonly<Record<string, DeclaredAttention>>
  /**
   * The newest session's folded `processes`, for the ladder's PROCESS
   * contributor; `{}` when no session exists.
   *
   * Review of #555, finding 2. `checkEnrichmentLadder` grew a fourth parameter
   * when the process row landed, and `api/doctor.ts` passes it while this path
   * did not — so `actorCount` was permanently 0 on the CLI and
   * `rhizomorph doctor` could never report the witness as `provided`, printing
   * the zero-actor reason on a Linux machine with agents plainly running.
   *
   * The fold was already in hand and thrown away: `reduceAll` builds the whole
   * `SessionState` here and this shape returned only `declared` from it. The
   * beacon row's fold-derived input was threaded through; the process row's
   * was not, which is the sibling shape one file over.
   */
  processes: Readonly<Record<string, unknown>>
}

/**
 * prd-27 rulings 3 and 6 (#218; #307): one line per present lane — never
 * declared, configured but silent, live, or lapsed — phrased ONCE here so the
 * CLI (`checkDeclaredAttention`, over the newest recorded session) and
 * `GET /api/doctor` (over the running recorder's fold) can never say the same
 * reading two ways. Pure over the fold; the caller supplies `now`.
 *
 * Reads the lanes off the same `buildFleet` the dashboard uses, so doctor and
 * the STATE column cannot disagree about a lane either.
 *
 * Never `fail`. A lapse is a warn (the hooks may have been removed under the
 * lane), everything else is `ok`, and `FAILING_CHECK_IDS` is unchanged — a
 * quiet beacon is a degraded reading, never a reason the app cannot run.
 */
export function declaredAttentionChecks(state: SessionState, now: number): DoctorCheck[] {
  const fleet = buildFleet(state, { now })

  const present = fleet.lanes.filter((lane) => lane.present).sort((a, b) => a.id.localeCompare(b.id))
  if (present.length === 0) {
    return [{ id: 'attention', status: 'ok', message: 'declared attention: no present lane in the newest session' }]
  }

  return present.map((lane): DoctorCheck => {
    const reading = attentionReading(state.declared, lane.id, now, lane.lastWorkTs)
    const id = `attention:${lane.id}`
    switch (reading.kind) {
      case 'never-declared':
        return {
          id,
          status: 'ok',
          message: `lane ${lane.id}: never declared — attention read from the other organs (rung below); hooks: \`rhizomorph env ${lane.id} --hooks claude\``,
        }
      case 'configured-silent':
        return {
          id,
          status: 'ok',
          message: `lane ${lane.id}: ${CONFIGURED_SILENT_REASON} — ${CONFIGURED_SILENT_REMEDY}`,
        }
      case 'live':
        return {
          id,
          status: 'ok',
          message: `lane ${lane.id}: declared ${reading.declared.kind} ${formatSpan(Math.max(0, now - reading.declared.at))} ago (beacon ${reading.declared.writer})`,
        }
      case 'lapsed':
        return {
          id,
          status: 'warn',
          message: `lane ${lane.id}: ${lapsedVoice(reading.lapsedForMs)} — check the lane's hooks are still installed (\`rhizomorph env ${lane.id} --hooks claude\`)`,
        }
      default: {
        const _never: never = reading
        throw new Error(`unreachable attention reading: ${String(_never)}`)
      }
    }
  })
}

/**
 * The CLI's reader: finds the newest recorded session for this repo, folds it,
 * and hands the fold to {@link declaredAttentionChecks}. Read-only — reads the
 * log, folds it, writes nothing. Its own two lines (no session; unreadable) are
 * the only readings it phrases itself, because neither is a fact about a fold.
 */
export async function checkDeclaredAttention(
  repoPath: string,
  dataRoot: string | undefined,
  now: () => number,
): Promise<DeclaredAttentionFacts> {
  const sessionDir = sessionDirFor(repoPath, dataRoot ?? defaultDataRoot())
  const sessions = await listSessions(sessionDir)
  if (sessions.length === 0) {
    return {
      checks: [
        {
          id: 'attention',
          status: 'ok',
          message: 'declared attention: no session recorded for this repo yet — nothing to read',
        },
      ],
      declared: {},
      processes: {},
    }
  }

  const newest = sessions[sessions.length - 1]!
  let state: SessionState
  try {
    const events = await readSessionEvents(path.join(sessionDir, newest.fileName))
    state = reduceAll(events)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      checks: [
        {
          id: 'attention',
          status: 'warn',
          message: `could not read the newest session (${newest.fileName}): ${message}`,
        },
      ],
      declared: {},
      processes: {},
    }
  }

  return { checks: declaredAttentionChecks(state, now()), declared: state.declared, processes: state.processes }
}

/** Which process's env `checkTelemetryEnv` actually inspected — see its own doc. */
export type DoctorShellContext = 'agent' | 'server'

/**
 * Names the wiring command in the reader's own shell (#140): a Windows
 * conductor's doctor run has no `eval`, so telling it to run one is a remedy
 * that cannot work. `win32` gets the PowerShell pipe form; every other
 * platform (the vast majority — WSL, Linux, macOS) keeps the `eval` form
 * unchanged.
 *
 * `shellContext` names which process's env this actually read. `'agent'`
 * (the CLI's default) is honest as-is, byte-identical to before `'server'`
 * existed: `rhizomorph doctor` runs IN the agent's own shell, so
 * `process.env` there is the env that matters, and either an `ok` or a
 * `warn` is a real finding. `GET /api/doctor` (prd-19 ruling 5) passes
 * `'server'` instead and is delegated to {@link checkTelemetryEnvFromServerShell}
 * — see its own doc for why that arm can never report `ok` (adversarial
 * review item 4).
 */
export function checkTelemetryEnv(
  env: NodeJS.ProcessEnv,
  platform: string,
  shellContext: DoctorShellContext = 'agent',
): DoctorCheck {
  if (shellContext === 'server') {
    return checkTelemetryEnvFromServerShell(env)
  }

  if (env.CLAUDE_CODE_ENABLE_TELEMETRY === '1') {
    return { id: 'telemetry', status: 'ok', message: 'CLAUDE_CODE_ENABLE_TELEMETRY=1 is set in this shell' }
  }

  // A clone user has no `rhizomorph` binary on PATH (audit stumble, prd9 ruling 8) — name the
  // forms that actually work from a plain clone instead.
  const remedy =
    platform === 'win32'
      ? 'run `node packages/server/bin/rhizomorph.mjs env <lane> --shell powershell | Invoke-Expression` (PowerShell)'
      : 'run `eval "$(node packages/server/bin/rhizomorph.mjs env <lane>)"` (or `npm start -- env <lane>` from the repo root)'

  return {
    id: 'telemetry',
    status: 'warn',
    message: `telemetry env is not set in this shell — spend stays at zero until you ${remedy} (see docs/telemetry.md)`,
  }
}

/**
 * The route's own arm (adversarial review item 4): reports `warn`
 * unconditionally, whatever `CLAUDE_CODE_ENABLE_TELEMETRY` reads as in THIS
 * server process's own env. An `ok` here would say "telemetry is flowing" —
 * a claim this check cannot make, since the env that actually decides that
 * belongs to the agent process this route is meant to verify, which it
 * cannot see. Status now agrees with the words instead of contradicting
 * them, and — just as importantly — `checkEnrichmentLadder`'s
 * `checkOk(checks, 'telemetry')` reads `false` here unconditionally, so the
 * ladder never counts this as proven OTel capability from the route either.
 */
function checkTelemetryEnvFromServerShell(env: NodeJS.ProcessEnv): DoctorCheck {
  const serverProcessHasIt = env.CLAUDE_CODE_ENABLE_TELEMETRY === '1'
  return {
    id: 'telemetry',
    status: 'warn',
    message:
      `CLAUDE_CODE_ENABLE_TELEMETRY ${serverProcessHasIt ? 'is' : 'is not'} set in this server's own shell — ` +
      "server shell, not agent shell: the env that decides whether telemetry actually flows belongs to the " +
      'agent\'s own process, which this route cannot see, so this can never be a green light from here',
  }
}

/**
 * The trace parser's fixtures are pinned to this same captured CLI version
 * (research/2026-08-03-trace-era-captures.md §1); a beta span-name rename between
 * that version and what's actually installed is a fixture update, not a schema
 * migration (prd9 ruling 3) — but it is worth a loud warning so a stale fixture
 * doesn't look like a parser bug. The receiver/parser lane pins this value
 * independently in its own fixtures and cannot be imported from here (it runs
 * in a parallel, separately-fenced lane this week) — this is a deliberate
 * duplicate, not a drift bug of its own; consolidating the two pins is
 * follow-up work.
 */
const TRACE_FIXTURE_CLI_VERSION = '2.1.220'

export async function checkCliVersionDrift(exec: Exec): Promise<DoctorCheck> {
  const result = await exec('claude', ['--version'])

  if (isMissingBinary(result)) {
    return {
      id: 'cli-version-drift',
      status: 'warn',
      message: `claude not found on PATH — cannot check it against the pinned trace fixture version ${TRACE_FIXTURE_CLI_VERSION}`,
    }
  }
  if (result.failed) {
    return {
      id: 'cli-version-drift',
      status: 'warn',
      message: `claude --version errored: ${describeToolError(result)} — cannot check it against the pinned trace fixture version ${TRACE_FIXTURE_CLI_VERSION}`,
    }
  }

  const installed = parseClaudeVersion(result.stdout)
  if (installed === null) {
    return {
      id: 'cli-version-drift',
      status: 'warn',
      message: `could not parse a version out of \`claude --version\` output "${result.stdout.trim()}" — cannot check it against the pinned trace fixture version ${TRACE_FIXTURE_CLI_VERSION}`,
    }
  }

  if (installed === TRACE_FIXTURE_CLI_VERSION) {
    return {
      id: 'cli-version-drift',
      status: 'ok',
      message: `claude ${installed} matches the pinned trace fixture version ${TRACE_FIXTURE_CLI_VERSION}`,
    }
  }

  return {
    id: 'cli-version-drift',
    status: 'warn',
    message: `claude ${installed} does not match the pinned trace fixture version ${TRACE_FIXTURE_CLI_VERSION} — beta span names may have drifted from the pinned fixtures; the parser maps any unrecognised span name to "other", never an error, but trace kinds may be miscategorised until the fixtures are refreshed`,
  }
}

function parseClaudeVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout)
  return match?.[1] ?? null
}

/**
 * Three-state vocabulary (#73), reused from `checkOptionalTool`: present-and-valid
 * is `ok`; absent and present-but-broken are both `warn` (off-fence detection is an
 * optional capability, not something the app needs to run), distinguished only by
 * message — "no lane manifest" vs "is broken: <detail>".
 */
export async function checkLaneManifest(repoPath: string): Promise<DoctorCheck> {
  const manifestPath = lanesManifestPath(repoPath)
  const result = await readLanesManifest(repoPath)

  if (result.available) {
    const count = result.lanes.length
    return {
      id: 'lane-manifest',
      status: 'ok',
      message: `lane manifest present and valid at ${manifestPath} — ${count} lane${count === 1 ? '' : 's'}`,
    }
  }

  if (result.reason.startsWith('no lane manifest')) {
    return {
      id: 'lane-manifest',
      status: 'warn',
      message: `no lane manifest at ${manifestPath} — dispatch has not written .swarm/lanes.json yet; off-fence detection stays unavailable until a dispatch runs`,
    }
  }

  return {
    id: 'lane-manifest',
    status: 'warn',
    message: `lane manifest at ${manifestPath} is broken: ${result.reason}`,
  }
}

/**
 * ADR-0034 clause 2's half of the doctor: **presence, never value.**
 *
 * The facts come from `cli/connect-team.ts`, never from `shipper/` directly —
 * a second entry in `shipper/hand-law.test.ts`'s `DECLARED_IMPORTERS` would
 * widen the clause-3 seam that law exists to keep one file wide, and the
 * doctor has no business being the thing that widens it.
 *
 * Off is `ok` and says how to turn it on. On with a credential at `0600` is
 * `ok` and says where it ships, under which project, and how far. A missing
 * credential beside a present enable record is the one `fail`: the hand is
 * configured and cannot run, which is exactly the state a person cannot see
 * without being told. A laxer mode is a `warn` with the `chmod`, because the
 * hand still works and the fix is one line.
 */
export async function checkShipper(repoPath: string, dataRoot: string | undefined): Promise<DoctorCheck> {
  const facts = await shipperDoctorFacts(repoPath, dataRoot)

  if (facts.configError !== null) {
    return { id: 'shipper', status: 'fail', message: `shipper: ${facts.configError}` }
  }

  if (!facts.enabled) {
    return {
      id: 'shipper',
      status: 'ok',
      message:
        'shipper: off — nothing leaves this machine. Turn it on per repo with: ' +
        'echo "$RZK_INGEST_KEY" | rhizomorph connect team <url> --project <id>',
    }
  }

  const keyPath = shipperKeyPath(repoPath, dataRoot)
  if (!facts.keyPresent) {
    return {
      id: 'shipper',
      status: 'fail',
      message:
        `shipper: on for ${facts.url} (project ${facts.project}) but its credential is missing at ${keyPath} — ` +
        're-run: echo "$RZK_INGEST_KEY" | rhizomorph connect team <url> --project <id>',
    }
  }

  const reach =
    facts.sessionCount === 0
      ? 'nothing shipped yet'
      : `shipped through n=${facts.maxN} across ${facts.sessionCount} session${facts.sessionCount === 1 ? '' : 's'}` +
        (facts.skippedCount > 0 ? `, ${facts.skippedCount} line(s) this build could not fold` : '')

  const ackSuffix = facts.lastAckAt > 0 ? ` Last acknowledged batch ${new Date(facts.lastAckAt).toISOString()}.` : ''
  const ackField: { lastAckAt: number } | Record<string, never> = facts.lastAckAt > 0 ? { lastAckAt: facts.lastAckAt } : {}

  if (facts.keyMode !== null && facts.keyMode !== 0o600) {
    return {
      id: 'shipper',
      status: 'warn',
      message:
        `shipper: on — ${facts.url}, project ${facts.project}, credential present but readable beyond you ` +
        `(mode ${facts.keyMode.toString(8).padStart(4, '0')}): chmod 600 ${keyPath}${ackSuffix}`,
      ...ackField,
    }
  }

  if (facts.cursorReset !== null) {
    return {
      id: 'shipper',
      status: 'warn',
      message:
        `shipper: on — ${facts.url}, project ${facts.project}, credential present (its value is never shown or logged). ` +
        `${facts.cursorReset} — the next pass cold-starts, which the ingest key dedups.${ackSuffix}`,
      ...ackField,
    }
  }

  return {
    id: 'shipper',
    status: 'ok',
    message:
      `shipper: on — ${facts.url}, project ${facts.project}, credential present ` +
      `(its value is never shown or logged). ${reach}.${ackSuffix}`,
    ...ackField,
  }
}

/** `true` when the named check in an already-computed report is `ok`. */
function checkOk(checks: readonly DoctorCheck[], id: string): boolean {
  return checks.find((check) => check.id === id)?.status === 'ok'
}

/**
 * Whether an enrichment is on the machine — see {@link DoctorCheck.present}.
 *
 * Deliberately NOT `checkOk`: since ruling 8 both present and absent read `ok`,
 * so the verdict cannot answer this and a caller that asked it would get `true`
 * for a tool that is not installed.
 */
function checkPresent(checks: readonly DoctorCheck[], id: string): boolean {
  return checks.find((check) => check.id === id)?.present === true
}

/** `true` when the named check in an already-computed report is itself flagged `assumed` — see `DoctorCheck.assumed`'s own doc. */
function checkAssumed(checks: readonly DoctorCheck[], id: string): boolean {
  return checks.find((check) => check.id === id)?.assumed === true
}

/**
 * prd15 ruling 5 — "`doctor` and the provenance strip SAY the rung per lane."
 * Reuses the tool/env checks already computed above rather than re-deriving
 * the same live facts a second time: session-logs/tmux/workmux/telemetry
 * already answered "is this mechanism actually here right now" — this just
 * asks what that buys, honestly, per prd15's ladder.
 *
 * Every lane in `.swarm/lanes.json` gets its own line (dispatch's lane
 * manifest, already read by `checkLaneManifest`); with no manifest (or an
 * empty one — no wave dispatched yet), one line speaks for the repo as a
 * whole instead of naming a lane that doesn't exist yet. Collector-loader's
 * mechanisms here are process-wide, not per-lane, so every named lane shares
 * the same rung today — the loop that builds `lines` below is what makes
 * per-lane divergence free the moment a collector gains that granularity.
 *
 * Reads the `target-path` check's `ok`-ness out of `checks` the same way
 * every other contributor here does — `GET /api/doctor` (which never runs
 * `target-path` at all, prd-19 ruling 5) supplies a synthetic `ok` entry for
 * it instead of skipping the contributor: the server is, by construction,
 * already running against a valid git repository, so the fact `target-path`
 * would have reported is already known true, just not from a check the route
 * needs to expose.
 */
export async function checkEnrichmentLadder(
  checks: readonly DoctorCheck[],
  repoPath: string,
  declared: Readonly<Record<string, DeclaredAttention>> = {},
  /** prd-57 ruling 1's actors, from the fold. Keyed `pid:startedAt`; only the count is read here. */
  processes: Readonly<Record<string, unknown>> = {},
  /**
   * Injectable so the process row's two readings can be told apart ANYWHERE.
   *
   * Review of #555, finding 2. On win32 `processWitnessCapabilitiesFor` answers
   * `partial` whatever the actor count is — that leg identifies and cannot
   * place — so a test of "the fold reaches this row", written on Windows,
   * produces the same ladder with zero actors and with one, and could only ever
   * fail on a Linux runner.
   *
   * That is the shape `signatureToken` hit two commits earlier: a claim that can
   * fail only on someone else's machine is not an assertion. Injecting the
   * platform is what lets the test fail here.
   */
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck[]> {
  const contributors: AdapterCapabilities[] = [
    checkOk(checks, 'target-path') ? GIT_CAPABILITIES : absentCapabilities('target path is not a usable git repository'),
    checkOk(checks, 'session-logs')
      ? SESSIONLOG_CAPABILITIES
      : absentCapabilities(
          'no Claude Code session logs found for this repo yet',
          'run `claude` at least once here',
        ),
    // The rig contributes what it has and says nothing when it is not there.
    // No remedy, deliberately: a remedy is an instruction, and there is nothing
    // here for the operator to do (prd-57 ruling 8).
    checkPresent(checks, 'tmux') ? TMUX_CAPABILITIES : absentCapabilities('tmux is not installed'),
    checkPresent(checks, 'workmux') ? WORKMUX_CAPABILITIES : absentCapabilities('workmux is not installed'),
    checkOk(checks, 'telemetry')
      ? OTEL_CAPABILITIES
      : absentCapabilities(
          'telemetry env is not set in this shell',
          'run `npm exec rhizomorph -- env <lane>` (see docs/telemetry.md)',
        ),
    // prd-27 ruling 3 (#218): the beacon organ's manifest is a function of the
    // fold, not a static declaration — `provided` (signed `beacon`, so L2)
    // once any lane has been declared for, `partial` with the
    // configured-but-silent reason before that.
    beaconCapabilitiesFor(declared),
    // prd-57 ruling 1 and ruling 2: the process witness. Like the beacon
    // organ above, its manifest is a function of the fold rather than a
    // static declaration — `provided` once any actor has been seen,
    // `partial` while the leg exists but has said nothing, and on a platform
    // with no leg built, `absent` carrying the CAPTURE command as its remedy
    // (prd-15 ruling 7: a leg lands behind a capture, never from a man page).
    processWitnessCapabilitiesFor(Object.keys(processes).length, platform),
  ]

  const merged = mergeCapabilities(contributors)
  const level = doctorLevel(merged)
  const info = LEVEL_INFO[level]
  const climbLine = info.climb === null ? 'the top level — nothing further to climb' : `next: ${info.climb}`
  // What the rig ADDS, said where it is true and nowhere else. Never "missing",
  // never a remedy: an enrichment that is absent produces no sentence at all,
  // which is the whole of Success 1.
  const rig =
    checkPresent(checks, 'tmux') || checkPresent(checks, 'workmux')
      ? ' · pane previews and ATTACH from the rig you already run'
      : ''
  const label = `${info.label}${rig}`

  // Visible, not just a code comment (adversarial review item 3): every
  // ladder entry this call produces carries the SAME assumed-ness its own
  // `target-path` input did, since the ladder's git contributor read that
  // input directly — a stranger reading the JSON must be able to tell
  // measured from assumed without reading this file's source.
  const assumedNote = checkAssumed(checks, 'target-path')
    ? ' (assumed: target-path was not itself measured by this call — see its own check for why)'
    : ''
  const assumedFlag: { assumed: true } | Record<string, never> = checkAssumed(checks, 'target-path') ? { assumed: true } : {}

  const lanesResult = await readLanesManifest(repoPath)
  const handles = lanesResult.available ? lanesResult.lanes.map((lane) => lane.handle) : []

  if (handles.length === 0) {
    return [
      {
        id: 'ladder',
        status: 'ok',
        message: `this repo sits at ${label} — ${climbLine}${assumedNote}`,
        ...assumedFlag,
      },
    ]
  }

  return handles.map((handle) => ({
    id: `ladder:${handle}`,
    status: 'ok',
    message: `lane ${handle} sits at ${label} — ${climbLine}${assumedNote}`,
    ...assumedFlag,
  }))
}
