import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  absentCapabilities,
  deriveRung,
  mergeCapabilities,
  rungInfo,
  type AdapterCapabilities,
  type Exec,
  type ExecResult,
} from '@rhizomorph/core'
import { lanesManifestPath, readLanesManifest } from '../api/lanes.js'
import { GIT_CAPABILITIES } from '../collectors/git/index.js'
import { OTEL_CAPABILITIES } from '../collectors/otel/index.js'
import { SESSIONLOG_CAPABILITIES } from '../collectors/sessionlog/index.js'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { TMUX_CAPABILITIES } from '../collectors/tmux/index.js'
import { WORKMUX_CAPABILITIES } from '../collectors/workmux/index.js'
import { DECLARED_HARNESSES, IMPLEMENTED_HARNESS_IDS } from '../harness-roster.js'
import { formatBytes } from '../lib/format.js'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import { decideSessionBoot, formatBootDuration } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
import { DEFAULT_PORT, parseFlags, type FlagSpec } from './args.js'
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
logs, tmux/workmux presence, telemetry env, and the harness roster — one
ok/warn/FAIL line per check, each with its remedy. Exits non-zero only when
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
    await checkCliVersionDrift(exec),
    checkHarnessRoster(),
  ]

  const checks: DoctorCheck[] = [...baseChecks, ...(await checkEnrichmentLadder(baseChecks, repoPath))]

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
  'per-agent history stays empty until `claude` has run at least once here (or point elsewhere with --extra-sessions)'

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


/** True only when the binary itself could not be run — not for a non-zero exit with real output (same test used by the workmux collector). */
function isMissingBinary(result: { failed: boolean; errorMessage?: string }): boolean {
  return result.failed && result.errorMessage !== undefined
}

export async function checkOptionalTool(id: string, command: string, args: string[], exec: Exec): Promise<DoctorCheck> {
  const result = await exec(command, args)
  if (isMissingBinary(result)) {
    return {
      id,
      status: 'warn',
      message: `${command} not found on PATH — its data is optional and will be degraded, not fatal`,
    }
  }
  if (result.failed) {
    return {
      id,
      status: 'warn',
      message: `${command} found but erroring: ${describeToolError(result)} — its data is optional and will be degraded, not fatal`,
    }
  }
  return { id, status: 'ok', message: `${command} found on PATH` }
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

/** `true` when the named check in an already-computed report is `ok`. */
function checkOk(checks: readonly DoctorCheck[], id: string): boolean {
  return checks.find((check) => check.id === id)?.status === 'ok'
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
export async function checkEnrichmentLadder(checks: readonly DoctorCheck[], repoPath: string): Promise<DoctorCheck[]> {
  const contributors: AdapterCapabilities[] = [
    checkOk(checks, 'target-path') ? GIT_CAPABILITIES : absentCapabilities('target path is not a usable git repository'),
    checkOk(checks, 'session-logs')
      ? SESSIONLOG_CAPABILITIES
      : absentCapabilities(
          'no Claude Code session logs found for this repo yet',
          'run `claude` at least once here, or point --extra-sessions elsewhere',
        ),
    checkOk(checks, 'tmux')
      ? TMUX_CAPABILITIES
      : absentCapabilities('tmux not found on PATH', 'install tmux for pane previews'),
    checkOk(checks, 'workmux')
      ? WORKMUX_CAPABILITIES
      : absentCapabilities('workmux not found on PATH', 'install workmux for declared attention and one-keystroke ATTACH'),
    checkOk(checks, 'telemetry')
      ? OTEL_CAPABILITIES
      : absentCapabilities(
          'telemetry env is not set in this shell',
          'run `npm exec rhizomorph -- env <lane>` (see docs/telemetry.md)',
        ),
  ]

  const rung = deriveRung(mergeCapabilities(contributors))
  const info = rungInfo(rung)
  const climbLine = info.climb === 'top rung — nothing further to climb' ? info.climb : `next: ${info.climb}`

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
        message: `this repo sits at ${info.label} — ${climbLine}${assumedNote}`,
        ...assumedFlag,
      },
    ]
  }

  return handles.map((handle) => ({
    id: `ladder:${handle}`,
    status: 'ok',
    message: `lane ${handle} sits at ${info.label} — ${climbLine}${assumedNote}`,
    ...assumedFlag,
  }))
}
