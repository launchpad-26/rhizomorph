import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec, ExecResult } from '@observatory/core'
import { exec as realExec } from '../server/exec.js'

/**
 * Read-only preflight for a stranger's first run: every check here only
 * inspects state (filesystem, a probe socket, `git rev-parse`) and never
 * changes anything. `observatory doctor` exists because the plain run
 * command validates nothing and a broken setup fails silently or with a raw
 * stack trace — see docs/prd2.md scope D.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: CheckStatus
  /** One line: the finding, and — for warn/fail — the exact remedy. */
  message: string
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
  /** Overrides `process.version`, e.g. `"v18.2.0"` — tests inject this so the check is deterministic. */
  nodeVersion?: string
  /** Overrides the root `package.json` path this reads `engines.node` from. */
  rootPackageJsonPath?: string
  /** Overrides `process.env` for the telemetry check. */
  env?: NodeJS.ProcessEnv
}

/** Falls back to this when the root `package.json` has no `engines.node` yet (README already states it). */
const DEFAULT_NODE_ENGINE_RANGE = '>=22'

const FAILING_CHECK_IDS: ReadonlySet<string> = new Set(['target-path', 'web-build', 'port'])

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const exec = options.exec ?? realExec
  const repoPath = path.resolve(options.path ?? process.cwd())

  const checks: DoctorCheck[] = [
    await checkNodeVersion(options),
    await checkTargetPath(repoPath, exec),
    checkWebBuild(options.webDistDir ?? defaultWebDistDir()),
    await checkPort(options.port),
    checkClaudeProjects(options.claudeProjectsRoot),
    await checkOptionalTool('tmux', 'tmux', ['-V'], exec),
    await checkOptionalTool('workmux', 'workmux', ['status'], exec),
    checkTelemetryEnv(options.env ?? process.env),
  ]

  const exitCode = checks.some((check) => FAILING_CHECK_IDS.has(check.id) && check.status === 'fail') ? 1 : 0
  return { checks, exitCode }
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

/** Renders a `runDoctor` report as the lines `observatory doctor` prints. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => `[${STATUS_LABEL[check.status]}] ${check.message}`)
  const failing = report.checks.filter((check) => check.status === 'fail').length
  const summary =
    failing > 0
      ? `${failing} check${failing === 1 ? '' : 's'} failed — fix these before observatory can run.`
      : 'All required checks passed.'
  return [...lines, '', summary].join('\n')
}

async function checkNodeVersion(options: DoctorOptions): Promise<DoctorCheck> {
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
      message: `target path ${repoPath} does not exist — pass an existing repo, e.g. \`observatory doctor ~/code/my-repo\``,
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

async function checkPort(port: number): Promise<DoctorCheck> {
  const free = await isPortFree(port)
  if (free) {
    return { id: 'port', status: 'ok', message: `port ${port} is free` }
  }
  return {
    id: 'port',
    status: 'fail',
    message: `port ${port} is already in use — pass a different one with --port <n>`,
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

function checkClaudeProjects(claudeProjectsRoot?: string): DoctorCheck {
  const dir = claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')
  if (existsSync(dir)) {
    return { id: 'session-logs', status: 'ok', message: `Claude Code session logs found at ${dir}` }
  }
  return {
    id: 'session-logs',
    status: 'warn',
    message: `no Claude Code session logs at ${dir} — per-agent history stays empty until \`claude\` has run at least once here (or point elsewhere with --extra-sessions)`,
  }
}

/** True only when the binary itself could not be run — not for a non-zero exit with real output (same test used by the workmux collector). */
function isMissingBinary(result: { failed: boolean; errorMessage?: string }): boolean {
  return result.failed && result.errorMessage !== undefined
}

async function checkOptionalTool(id: string, command: string, args: string[], exec: Exec): Promise<DoctorCheck> {
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

function checkTelemetryEnv(env: NodeJS.ProcessEnv): DoctorCheck {
  if (env.CLAUDE_CODE_ENABLE_TELEMETRY === '1') {
    return { id: 'telemetry', status: 'ok', message: 'CLAUDE_CODE_ENABLE_TELEMETRY=1 is set in this shell' }
  }
  return {
    id: 'telemetry',
    status: 'warn',
    message:
      'telemetry env is not set in this shell — spend stays at zero until you run `eval "$(observatory env <lane>)"` (see docs/telemetry.md)',
  }
}
