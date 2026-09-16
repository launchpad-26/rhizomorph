import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import {
  BEACON_LAPSE_MS,
  CONFIGURED_SILENT_REASON,
  CONFIGURED_SILENT_REMEDY,
  createEvent,
  lapsedVoice,
  reduceAll,
} from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { sessionDirFor } from '../log/paths.js'
import { SessionLogWriter } from '../recorder/index.js'
import { readResumedCount, recordResume, RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { writeSessionLock } from '../log/session-lock.js'
import { CAPABILITY_TOKEN_HEADER } from '../api/security.js'
// Through `connect-team.ts`, the hand's one declared importer, never
// `../shipper/index.js`: a second route in is what ADR-0034's clause-3 seam
// exists to refuse, and `shipper/hand-law.test.ts` convicts a test file for it
// exactly as it would a source file.
import { enableShipper, shipperCursorPath, shipperKeyPath, shipperTeamConfigPath } from './connect-team.js'
import {
  checkClaudeProjects,
  checkDeclaredAttention,
  checkEnrichmentLadder,
  checkHarnessRoster,
  checkTelemetryEnv,
  declaredAttentionChecks,
  doctorHelpText,
  parseDoctorArgs,
  renderDoctorReport,
  runDoctor,
  type DoctorCheck,
} from './doctor.js'
import { processWitnessCapabilitiesFor } from '../collectors/process/doctor-row.js'
import { CAPABILITY_META_NAME } from './rotate.js'

/**
 * One injectable read fault for `checkDeclaredAttention`'s guard (#218). Every
 * *file-level* failure is already swallowed by `readSessionLog` (ADR-0011 — a
 * recording never rots), so nothing seeded on disk can reach that arm; the
 * seam is the honest place to fail it. Everything else in this file reaches the
 * real reader — the passthrough below is the real function.
 */
const readFault = vi.hoisted(() => ({ armed: false }))
vi.mock('../log/session-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../log/session-log.js')>()
  return {
    ...actual,
    readSessionEvents: async (...args: Parameters<typeof actual.readSessionEvents>) => {
      if (readFault.armed) throw new Error('EIO: i/o error, read')
      return actual.readSessionEvents(...args)
    },
  }
})

function okResult(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, failed: false }
}

function missingBinary(command: string): ExecResult {
  return { stdout: '', stderr: '', code: null, failed: true, errorMessage: `spawn ${command} ENOENT` }
}

function gitFailure(): ExecResult {
  return { stdout: '', stderr: 'fatal: not a git repository', code: 128, failed: true }
}

/** A tool that exists on PATH but errors when run — distinct from `missingBinary`: no `errorMessage`. */
function toolError(stderr: string, code = 1): ExecResult {
  return { stdout: '', stderr, code, failed: true }
}

/** Matches the fixture version pinned in doctor.ts (`TRACE_FIXTURE_CLI_VERSION`) so the healthy-machine test stays all-`ok`. */
const PINNED_CLI_VERSION = '2.1.220'

/** Everything a fully healthy machine would report. */
const healthyExec: Exec = async (command, args) => {
  if (command === 'git' && args[0] === 'rev-parse') return okResult('true\n')
  if (command === 'tmux') return okResult('tmux 3.3a\n')
  if (command === 'workmux') return okResult('handle  status\n')
  if (command === 'claude' && args[0] === '--version') return okResult(`${PINNED_CLI_VERSION} (Claude Code)\n`)
  return { stdout: '', stderr: 'not stubbed', code: 1, failed: true, errorMessage: 'not stubbed' }
}

/** A `fetch` that never answers — the default for tests that don't care about the own-server probe. */
const unreachableFetch: typeof globalThis.fetch = (async () => {
  throw new Error('fetch failed')
}) as typeof globalThis.fetch

/** The fixture token every `metaFetch` mock hands out and demands back — arbitrary, just consistent between the two halves below. */
const PROBE_FIXTURE_TOKEN = 'doctor-probe-fixture-token'

/**
 * A `fetch` that plays both halves of the in-band scrape `probeRhizomorphMeta`
 * now performs (prd-29 ruling 7, #59 — `/api/meta` is a `gated-read`, so the
 * probe goes through `capabilityAwareFetch`): `GET /` answers a dashboard
 * shell carrying the capability meta tag, and `GET /api/meta` answers `body`
 * (with `init`) only when the request carries the matching token header —
 * otherwise a 401, exactly what the real gate would answer.
 */
function metaFetch(body: unknown, init: ResponseInit = {}): typeof globalThis.fetch {
  return (async (input, requestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    if (url.endsWith('/api/meta')) {
      const headers = new Headers(requestInit?.headers)
      if (headers.get(CAPABILITY_TOKEN_HEADER) !== PROBE_FIXTURE_TOKEN) {
        return new Response(JSON.stringify({ error: 'missing or invalid capability token' }), { status: 401 })
      }
      return new Response(JSON.stringify(body), init)
    }
    return new Response(
      `<!doctype html><html><head><meta name="${CAPABILITY_META_NAME}" content="${PROBE_FIXTURE_TOKEN}"></head><body></body></html>`,
    )
  }) as typeof globalThis.fetch
}

function checkFor(checks: readonly DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((c) => c.id === id)
  if (!check) throw new Error(`no check with id "${id}"`)
  return check
}

describe('runDoctor', () => {
  let repoPath: string
  let webDistDir: string
  let claudeProjectsRoot: string
  /** Keeps the new session-boundary check off the real `~/.local/share/rhizomorph` — hermetic under concurrency. */
  let dataRoot: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-repo-'))
    webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-web-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-claude-'))
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-data-'))
    await writeFile(path.join(webDistDir, 'index.html'), '<html></html>')
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(webDistDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
    ])
  })

  it('reports ok on every check for a fully healthy machine and exits 0', async () => {
    await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
    await writeFile(path.join(repoPath, '.swarm', 'lanes.json'), JSON.stringify({ version: 1, lanes: [] }))
    const slugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
    await mkdir(slugDir, { recursive: true })
    await writeFile(path.join(slugDir, 'session-1.jsonl'), '')

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      nodeVersion: 'v22.5.0',
      rootPackageJsonPath: path.join(repoPath, 'does-not-exist.json'),
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
    })

    expect(report.exitCode).toBe(0)
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([
      'node',
      'target-path',
      'web-build',
      'port',
      'session-logs',
      'session-boundary',
      'tmux',
      'workmux',
      'telemetry',
      'lane-manifest',
      'shipper',
      'cli-version-drift',
      'harness-roster',
      'attention',
      'ladder',
    ])
  })

  it('warns (not fails) on an old Node version', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      nodeVersion: 'v18.19.0',
      rootPackageJsonPath: path.join(repoPath, 'does-not-exist.json'),
    })

    const node = checkFor(report.checks, 'node')
    expect(node.status).toBe('warn')
    expect(node.message).toContain('v18.19.0')
    expect(node.message).toContain('>=22')
    expect(report.exitCode).toBe(0)
  })

  it('reads engines.node from the given package.json when present', async () => {
    const pkgPath = path.join(repoPath, 'package.json')
    await writeFile(pkgPath, JSON.stringify({ engines: { node: '>=99' } }))

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      nodeVersion: 'v22.5.0',
      rootPackageJsonPath: pkgPath,
    })

    const node = checkFor(report.checks, 'node')
    expect(node.status).toBe('warn')
    expect(node.message).toContain('>=99')
  })

  it('fails when the target path does not exist, naming it and exits 1', async () => {
    const missingPath = path.join(repoPath, 'does-not-exist-at-all')
    const report = await runDoctor({
      path: missingPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
    dataRoot,
    })

    const targetPath = checkFor(report.checks, 'target-path')
    expect(targetPath.status).toBe('fail')
    expect(targetPath.message).toContain(missingPath)
    expect(targetPath.message).toContain('does not exist')
    expect(report.exitCode).toBe(1)
    // #276 clone-safe syntax (adversarial review item 7): a clone user has no
    // `rhizomorph` binary on PATH, so the remedy must not tell them to run a bare one.
    expect(targetPath.message).toContain('npm exec rhizomorph -- doctor')
    expect(targetPath.message).not.toMatch(/[`"]rhizomorph /)
  })

  it('fails when the target path exists but is not a git repository', async () => {
    const notGitExec: Exec = async (command, args) => {
      if (command === 'git' && args[0] === 'rev-parse') return gitFailure()
      return healthyExec(command, args)
    }

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: notGitExec,
      webDistDir,
      claudeProjectsRoot,
    dataRoot,
    })

    const targetPath = checkFor(report.checks, 'target-path')
    expect(targetPath.status).toBe('fail')
    expect(targetPath.message).toContain('not a git repository')
    expect(report.exitCode).toBe(1)
  })

  it('fails when the web build is missing, naming the build command', async () => {
    const emptyDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-empty-dist-'))
    try {
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir: emptyDistDir,
        claudeProjectsRoot,
      dataRoot,
      })

      const webBuild = checkFor(report.checks, 'web-build')
      expect(webBuild.status).toBe('fail')
      expect(webBuild.message).toContain('npm run build --workspace packages/web')
      expect(report.exitCode).toBe(1)
    } finally {
      await rm(emptyDistDir, { recursive: true, force: true })
    }
  })

  describe('port check', () => {
    let server: Server
    let busyPort: number

    beforeEach(async () => {
      server = createServer()
      busyPort = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : 0)
        })
      })
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('fails when the requested port is already in use by something unreachable at /api/meta, naming --port', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: busyPort,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        fetch: unreachableFetch,
      })

      const port = checkFor(report.checks, 'port')
      expect(port.status).toBe('fail')
      expect(port.message).toContain(String(busyPort))
      expect(port.message).toContain('--port')
      expect(report.exitCode).toBe(1)
    })

    it('fails when the busy port answers /api/meta but not with a rhizomorph-shaped body — a stranger, not a healthy self', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: busyPort,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        fetch: metaFetch({ hello: 'world' }),
      })

      const port = checkFor(report.checks, 'port')
      expect(port.status).toBe('fail')
      expect(port.message).toContain(String(busyPort))
      expect(report.exitCode).toBe(1)
    })

    it('reports ok — not FAIL — when the busy port is a rhizomorph already serving this repo (prd9 ruling 8)', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: busyPort,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        fetch: metaFetch({
          repoPath,
          repoName: 'my-repo',
          sessionId: '1785458425389',
          startedAt: 1785458425389,
        }),
      })

      const port = checkFor(report.checks, 'port')
      expect(port.status).toBe('ok')
      expect(port.message).toContain('this repo')
      expect(port.message).toContain(new Date(1785458425389).toISOString())
      expect(report.exitCode).toBe(0)
    })

    it('reports ok and names the other repo when the busy port is a rhizomorph serving a different repo', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: busyPort,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        fetch: metaFetch({
          repoPath: '/somewhere/else',
          repoName: 'other-repo',
          sessionId: '1785458425389',
          startedAt: 1785458425389,
        }),
      })

      const port = checkFor(report.checks, 'port')
      expect(port.status).toBe('ok')
      expect(port.message).toContain('other-repo')
      expect(port.message).not.toContain('this repo')
      expect(report.exitCode).toBe(0)
    })

    it('treats port 0 as always free without ever probing /api/meta', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        fetch: unreachableFetch,
      })

      expect(checkFor(report.checks, 'port').status).toBe('ok')
    })
  })

  it('warns when ~/.claude/projects (or its override) is missing entirely — no slug dir, no global root either', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot: path.join(claudeProjectsRoot, 'does-not-exist'),
      dataRoot,
    })

    const sessionLogs = checkFor(report.checks, 'session-logs')
    expect(sessionLogs.status).toBe('warn')
    expect(sessionLogs.message).toContain('--extra-sessions')
    expect(report.exitCode).toBe(0)
  })

  describe('session-logs check answers for the watched repo\'s own slug dir, not just the global root (#288)', () => {
    it('reads a named miss with the expected slug dir path when this repo has none, while the global root fact still reads present', async () => {
      // claudeProjectsRoot exists (a real machine that has used Claude Code for
      // OTHER repos) but no <slug> subdir for THIS repoPath exists under it —
      // the exact bug #288 reports: today this alone would green the check.
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
      })

      const expectedSlugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
      const sessionLogs = checkFor(report.checks, 'session-logs')
      expect(sessionLogs.status).toBe('warn')
      expect(sessionLogs.message).toContain(expectedSlugDir)
      expect(sessionLogs.message).toContain(claudeProjectsRoot)
      expect(sessionLogs.message).toContain('other repos')
      expect(report.exitCode).toBe(0)
    })

    it('warns distinctly when the slug dir exists but has no *.jsonl files yet, rather than claiming a total miss', async () => {
      const slugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
      await mkdir(slugDir, { recursive: true })

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
      })

      const sessionLogs = checkFor(report.checks, 'session-logs')
      expect(sessionLogs.status).toBe('warn')
      expect(sessionLogs.message).toContain(slugDir)
      expect(sessionLogs.message).toContain('no *.jsonl files yet')
    })

    it('reports ok with the session file count and newest-file age once the slug dir actually has sessions', async () => {
      const slugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
      await mkdir(slugDir, { recursive: true })
      await writeFile(path.join(slugDir, 'old.jsonl'), '')
      await writeFile(path.join(slugDir, 'new.jsonl'), '')

      const fixedNow = Date.now() + 5 * 60 * 1000
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        now: () => fixedNow,
      })

      const sessionLogs = checkFor(report.checks, 'session-logs')
      expect(sessionLogs.status).toBe('ok')
      expect(sessionLogs.message).toContain(slugDir)
      expect(sessionLogs.message).toContain('2 session files')
      expect(sessionLogs.message).toMatch(/newest .+ old/)
    })

    it('checkClaudeProjects called with just a root — the pre-#288 call shape — stays byte-identical to before', () => {
      const withRoot = checkClaudeProjects(claudeProjectsRoot)
      expect(withRoot).toEqual({
        id: 'session-logs',
        status: 'ok',
        message: `Claude Code session logs found at ${claudeProjectsRoot}`,
      })

      const missingRoot = path.join(claudeProjectsRoot, 'does-not-exist')
      const withMissingRoot = checkClaudeProjects(missingRoot)
      expect(withMissingRoot.status).toBe('warn')
      expect(withMissingRoot.message).toBe(
        `no Claude Code session logs at ${missingRoot} — per-agent history stays empty until \`claude\` has run at least once here (or point elsewhere with --extra-sessions)`,
      )
    })
  })

  it('warns (degraded, not fatal) when tmux is missing', async () => {
    const noTmuxExec: Exec = async (command, args) => {
      if (command === 'tmux') return missingBinary('tmux')
      return healthyExec(command, args)
    }

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: noTmuxExec,
      webDistDir,
      claudeProjectsRoot,
    dataRoot,
    })

    const tmux = checkFor(report.checks, 'tmux')
    expect(tmux.status).toBe('warn')
    expect(tmux.message).toContain('optional')
    expect(report.exitCode).toBe(0)
  })

  it('warns (degraded, not fatal) when workmux is missing', async () => {
    const noWorkmuxExec: Exec = async (command, args) => {
      if (command === 'workmux') return missingBinary('workmux')
      return healthyExec(command, args)
    }

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: noWorkmuxExec,
      webDistDir,
      claudeProjectsRoot,
    dataRoot,
    })

    const workmux = checkFor(report.checks, 'workmux')
    expect(workmux.status).toBe('warn')
    expect(report.exitCode).toBe(0)
  })

  it('reports "found but erroring" (not "not found") when tmux is on PATH but exits non-zero', async () => {
    const brokenTmuxExec: Exec = async (command, args) => {
      if (command === 'tmux') {
        return toolError('tmux: error connecting to /tmp/tmux-1000/default (No such file or directory)')
      }
      return healthyExec(command, args)
    }

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: brokenTmuxExec,
      webDistDir,
      claudeProjectsRoot,
    dataRoot,
    })

    const tmux = checkFor(report.checks, 'tmux')
    expect(tmux.status).toBe('warn')
    expect(tmux.message).toContain('found but erroring')
    expect(tmux.message).toContain('error connecting to /tmp/tmux-1000/default')
    expect(tmux.message).not.toContain('not found on PATH')
    expect(report.exitCode).toBe(0)
  })

  it('reports "found but erroring" for workmux when it errors with no stderr, falling back to the exit code', async () => {
    const brokenWorkmuxExec: Exec = async (command, args) => {
      if (command === 'workmux') return toolError('', 2)
      return healthyExec(command, args)
    }

    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: brokenWorkmuxExec,
      webDistDir,
      claudeProjectsRoot,
    dataRoot,
    })

    const workmux = checkFor(report.checks, 'workmux')
    expect(workmux.status).toBe('warn')
    expect(workmux.message).toContain('found but erroring: exited with code 2')
    expect(report.exitCode).toBe(0)
  })

  it('warns in the sh voice by default, pointing at docs/telemetry.md', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      env: {},
      platform: 'linux',
    })

    const telemetry = checkFor(report.checks, 'telemetry')
    expect(telemetry.status).toBe('warn')
    expect(telemetry.message).toContain('docs/telemetry.md')
    expect(telemetry.message).toContain('eval')
    expect(telemetry.message).not.toContain('powershell')
    // Audit stumble (prd9 ruling 8): a clone user has no `rhizomorph` binary on PATH,
    // so the remedy must not tell them to run a bare one.
    expect(telemetry.message).not.toMatch(/[`"]rhizomorph /)
    expect(telemetry.message).toContain('packages/server/bin/rhizomorph.mjs')
    expect(report.exitCode).toBe(0)
  })

  it('warns in the PowerShell voice on win32, naming --shell powershell instead of eval', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      env: {},
      platform: 'win32',
    })

    const telemetry = checkFor(report.checks, 'telemetry')
    expect(telemetry.status).toBe('warn')
    expect(telemetry.message).toContain('docs/telemetry.md')
    expect(telemetry.message).toContain('--shell powershell')
    expect(telemetry.message).toContain('Invoke-Expression')
    expect(telemetry.message).not.toContain('eval')
    // Same no-bare-binary rule (#126) applies in the PowerShell voice too.
    expect(telemetry.message).not.toMatch(/[`"]rhizomorph /)
    expect(telemetry.message).toContain('packages/server/bin/rhizomorph.mjs')
    expect(report.exitCode).toBe(0)
  })

  it('defaults to process.platform\'s own voice when platform is not overridden', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      env: {},
    })

    const telemetry = checkFor(report.checks, 'telemetry')
    expect(telemetry.status).toBe('warn')
    expect(telemetry.message).toContain(process.platform === 'win32' ? '--shell powershell' : 'eval')
  })

  describe("checkTelemetryEnv's shellContext (prd-19 ruling 5)", () => {
    it("defaults to 'agent' and behaves byte-identically to before GET /api/doctor existed", () => {
      const ok = checkTelemetryEnv({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' }, 'linux')
      expect(ok.status).toBe('ok')
      expect(ok.message).toBe('CLAUDE_CODE_ENABLE_TELEMETRY=1 is set in this shell')
      expect(ok.message).not.toContain('server shell')

      const warn = checkTelemetryEnv({}, 'linux')
      expect(warn.status).toBe('warn')
      expect(warn.message).not.toContain('server shell')
      expect(warn.message).not.toContain('agent shell')
    })

    it(
      "passing 'server' NEVER reports ok, even when this process's own env has the var set — an ok here " +
        'would contradict the very message saying this route cannot see the env that matters (adversarial review item 4)',
      () => {
        const withVarSet = checkTelemetryEnv({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' }, 'linux', 'server')
        expect(withVarSet.status).toBe('warn')
        expect(withVarSet.id).toBe('telemetry')
        expect(withVarSet.message).toContain('is set')
        expect(withVarSet.message).toContain('server shell, not agent shell')
        expect(withVarSet.message).toContain("agent's own process")
        expect(withVarSet.message).toContain('cannot see')

        const withVarUnset = checkTelemetryEnv({}, 'linux', 'server')
        expect(withVarUnset.status).toBe('warn')
        expect(withVarUnset.message).toContain('is not set')
        expect(withVarUnset.message).toContain('server shell, not agent shell')
      },
    )

    it("'server' context is deaf to platform — no eval/PowerShell remedy voice, since it never reaches the CLI's own remedy branch", () => {
      const check = checkTelemetryEnv({}, 'win32', 'server')
      expect(check.status).toBe('warn')
      expect(check.message).not.toContain('--shell powershell')
      expect(check.message).not.toContain('eval')
    })
  })

  describe('cli version drift check', () => {
    it('reports ok when the installed claude matches the pinned trace fixture version', async () => {
      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const drift = checkFor(report.checks, 'cli-version-drift')
      expect(drift.status).toBe('ok')
      expect(drift.message).toContain(PINNED_CLI_VERSION)
      expect(report.exitCode).toBe(0)
    })

    it('warns naming both versions and the consequence when the installed claude differs from the pinned fixture', async () => {
      const driftedExec: Exec = async (command, args) => {
        if (command === 'claude' && args[0] === '--version') return okResult('2.2.0 (Claude Code)\n')
        return healthyExec(command, args)
      }

      const report = await runDoctor({ path: repoPath, port: 0, exec: driftedExec, webDistDir, claudeProjectsRoot, dataRoot })

      const drift = checkFor(report.checks, 'cli-version-drift')
      expect(drift.status).toBe('warn')
      expect(drift.message).toContain('2.2.0')
      expect(drift.message).toContain(PINNED_CLI_VERSION)
      expect(drift.message).toContain('other')
      expect(report.exitCode).toBe(0)
    })

    it('warns (not fails) when claude is not on PATH', async () => {
      const noClaudeExec: Exec = async (command, args) => {
        if (command === 'claude') return missingBinary('claude')
        return healthyExec(command, args)
      }

      const report = await runDoctor({ path: repoPath, port: 0, exec: noClaudeExec, webDistDir, claudeProjectsRoot, dataRoot })

      const drift = checkFor(report.checks, 'cli-version-drift')
      expect(drift.status).toBe('warn')
      expect(drift.message).toContain('not found on PATH')
      expect(report.exitCode).toBe(0)
    })

    it('warns without throwing when `claude --version` output has no parseable version', async () => {
      const unparseableExec: Exec = async (command, args) => {
        if (command === 'claude' && args[0] === '--version') return okResult('unknown\n')
        return healthyExec(command, args)
      }

      const report = await runDoctor({ path: repoPath, port: 0, exec: unparseableExec, webDistDir, claudeProjectsRoot, dataRoot })

      const drift = checkFor(report.checks, 'cli-version-drift')
      expect(drift.status).toBe('warn')
      expect(drift.message).toContain('could not parse')
      expect(report.exitCode).toBe(0)
    })
  })

  describe('lane manifest check', () => {
    it('warns with a one-line fix when .swarm/lanes.json is absent, and does not fail the exit code', async () => {
      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const laneManifest = checkFor(report.checks, 'lane-manifest')
      expect(laneManifest.status).toBe('warn')
      expect(laneManifest.message).toContain('no lane manifest')
      expect(laneManifest.message).toContain('.swarm/lanes.json')
      expect(report.exitCode).toBe(0)
    })

    it('reports ok with the lane count when the manifest is present and valid', async () => {
      await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
      await writeFile(
        path.join(repoPath, '.swarm', 'lanes.json'),
        JSON.stringify({
          version: 1,
          lanes: [{ handle: '77-attention-strip', branch: '77-attention-strip', fence: ['packages/web/**'] }],
        }),
      )

      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const laneManifest = checkFor(report.checks, 'lane-manifest')
      expect(laneManifest.status).toBe('ok')
      expect(laneManifest.message).toContain('1 lane')
      expect(report.exitCode).toBe(0)
    })

    it('reports ok when a lane carries a null issue/model rather than treating the manifest as broken', async () => {
      await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
      await writeFile(
        path.join(repoPath, '.swarm', 'lanes.json'),
        JSON.stringify({
          version: 1,
          lanes: [
            {
              handle: '77-attention-strip',
              branch: '77-attention-strip',
              fence: ['packages/web/**'],
              issue: null,
              model: null,
            },
          ],
        }),
      )

      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const laneManifest = checkFor(report.checks, 'lane-manifest')
      expect(laneManifest.status).toBe('ok')
      expect(laneManifest.message).toContain('1 lane')
      expect(report.exitCode).toBe(0)
    })

    it('warns with the broken-file detail when the manifest is present but malformed, and does not fail the exit code', async () => {
      await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
      await writeFile(path.join(repoPath, '.swarm', 'lanes.json'), '{ not valid json')

      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const laneManifest = checkFor(report.checks, 'lane-manifest')
      expect(laneManifest.status).toBe('warn')
      expect(laneManifest.message).toContain('is broken')
      expect(laneManifest.message).toContain('not valid JSON')
      expect(report.exitCode).toBe(0)
    })
  })

  describe('shipper check (ADR-0034 clause 2 — presence, never value)', () => {
    const SHIPPER_KEY = 'rzk_DOCTORFIXTUREVALUE0123456789'

    async function turnOn(key: string = SHIPPER_KEY): Promise<void> {
      await enableShipper(sessionDirFor(repoPath, dataRoot), {
        url: 'https://team.example',
        project: 'acme-widgets',
        key,
        now: () => 1,
      })
    }

    function report() {
      return runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })
    }

    it('is ok and off by default, naming the command that would turn it on', async () => {
      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('ok')
      expect(shipper.message).toContain('shipper: off')
      expect(shipper.message).toContain('rhizomorph connect team')
    })

    it('is ok when on, and names the destination and the project but never the value', async () => {
      await turnOn()
      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('ok')
      expect(shipper.message).toContain('https://team.example')
      expect(shipper.message).toContain('acme-widgets')
      expect(shipper.message).toContain('credential present')
      expect(shipper.message).not.toContain(SHIPPER_KEY)
      expect(shipper.message).not.toContain(SHIPPER_KEY.slice(0, 12))
      // prd-51 ruling 12 — the central assertion: nothing has ever shipped,
      // so there is no ack fact and no ack sentence, not a zero timestamp.
      expect(shipper.lastAckAt).toBeUndefined()
      expect(shipper.message).not.toContain('Last acknowledged')
    })

    it('reports the ack fact and its exact timestamp once a batch has been acknowledged (prd-51 ruling 12)', async () => {
      await turnOn()
      await writeFile(
        shipperCursorPath(repoPath, dataRoot),
        JSON.stringify({
          version: 1,
          actors: { 'session-one': { offset: 40, n: 4, lastAckAt: 1_700_000_000_000, skippedCount: 0, skipped: [] } },
        }),
      )

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('ok')
      expect(shipper.lastAckAt).toBe(1_700_000_000_000)
      expect(shipper.message).toContain(new Date(1_700_000_000_000).toISOString())
    })

    it('the most recent acknowledgement wins across sessions, never the first or the alphabetically-last', async () => {
      await turnOn()
      await writeFile(
        shipperCursorPath(repoPath, dataRoot),
        JSON.stringify({
          version: 1,
          actors: {
            // The maximum sits in the MIDDLE — first, last (alphabetically,
            // which is also `shipperStatus`'s own sort order) and max are
            // three different values, so a reduce that quietly returns the
            // first or the last actor's `lastAckAt` cannot pass this test by
            // accident the way it could when the max happened to also be
            // the alphabetical first (verify #488, finding 1).
            'session-aaa': { offset: 10, n: 1, lastAckAt: 100_000_000_000, skippedCount: 0, skipped: [] },
            'session-mmm': { offset: 20, n: 2, lastAckAt: 900_000_000_000, skippedCount: 0, skipped: [] },
            'session-zzz': { offset: 30, n: 3, lastAckAt: 500_000_000_000, skippedCount: 0, skipped: [] },
          },
        }),
      )

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.lastAckAt).toBe(900_000_000_000)
    })

    it('reading the same facts twice yields the same timestamp — no clock is read at the facts layer', async () => {
      await turnOn()
      await writeFile(
        shipperCursorPath(repoPath, dataRoot),
        JSON.stringify({
          version: 1,
          actors: { 'session-one': { offset: 40, n: 4, lastAckAt: 1_700_000_000_000, skippedCount: 0, skipped: [] } },
        }),
      )

      const first = checkFor((await report()).checks, 'shipper')
      const second = checkFor((await report()).checks, 'shipper')
      expect(first.lastAckAt).toBe(second.lastAckAt)
    })

    it('FAILS when the enable record is there and the credential is not, and names the path and the remedy', async () => {
      await turnOn()
      await rm(shipperKeyPath(repoPath, dataRoot))

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('fail')
      expect(shipper.message).toContain(shipperKeyPath(repoPath, dataRoot))
      expect(shipper.message).toContain('rhizomorph connect team')
    })

    it.skipIf(process.platform === 'win32')('warns with the chmod when the credential is readable beyond you, and still reports the acknowledgement — a wrong-permission credential does not erase shipping history', async () => {
      await turnOn()
      await writeFile(
        shipperCursorPath(repoPath, dataRoot),
        JSON.stringify({
          version: 1,
          actors: { 'session-one': { offset: 40, n: 4, lastAckAt: 1_700_000_000_000, skippedCount: 0, skipped: [] } },
        }),
      )
      await chmod(shipperKeyPath(repoPath, dataRoot), 0o644)

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('warn')
      expect(shipper.message).toContain(`chmod 600 ${shipperKeyPath(repoPath, dataRoot)}`)
      expect(shipper.lastAckAt).toBe(1_700_000_000_000)
      expect(shipper.message).toContain(new Date(1_700_000_000_000).toISOString())
    })

    it('warns and says the next pass cold-starts when the cursor could not be trusted', async () => {
      await turnOn()
      await writeFile(shipperCursorPath(repoPath, dataRoot), '{ not json')

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('warn')
      expect(shipper.message).toContain('cold-starts')
    })

    it('a partially-corrupt cursor still reports the surviving actor\'s acknowledgement — the sibling case', async () => {
      await turnOn()
      await writeFile(
        shipperCursorPath(repoPath, dataRoot),
        JSON.stringify({
          version: 1,
          actors: {
            'session-good': { offset: 30, n: 3, lastAckAt: 555_000_000_000, skippedCount: 0, skipped: [] },
            'session-bad': { offset: -1, n: 3, lastAckAt: 0, skippedCount: 0, skipped: [] },
          },
        }),
      )

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('warn')
      expect(shipper.message).toContain('holds an unusable entry')
      expect(shipper.lastAckAt).toBe(555_000_000_000)
      expect(shipper.message).toContain(new Date(555_000_000_000).toISOString())
    })

    it('FAILS rather than reading a corrupt enable record as "off"', async () => {
      await turnOn()
      await writeFile(shipperTeamConfigPath(repoPath, dataRoot), '{ not json')

      const shipper = checkFor((await report()).checks, 'shipper')
      expect(shipper.status).toBe('fail')
      expect(shipper.message).toContain('team.json')
    })

    it('never fails the exit code — a shipper problem does not stop the app running', async () => {
      await turnOn()
      await rm(shipperKeyPath(repoPath, dataRoot))
      const result = await report()
      expect(checkFor(result.checks, 'shipper').status).toBe('fail')
      expect(result.exitCode).toBe(0)
    })
  })

  describe('harness roster check (#325 — one roster, read live off concierge/harness/)', () => {
    it('reports the real registry split: claude/codex implemented, openclaw/pi/shell declared', () => {
      const check = checkHarnessRoster()

      expect(check.status).toBe('ok')
      expect(check.message).toContain('2 implemented (claude, codex)')
      expect(check.message).toContain('3 declared not-implemented (openclaw, pi, shell)')
      // pi must not be reachable through this line's own honesty check — this
      // check reports the roster, `harness-law.test.ts` is what proves pi's
      // reason itself no longer claims it is uncaptured.
      expect(check.message).not.toContain('captured nowhere')
    })

    it('is wired into runDoctor, additive to every other check', async () => {
      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const harnessRoster = checkFor(report.checks, 'harness-roster')
      expect(harnessRoster.status).toBe('ok')
      expect(report.exitCode).toBe(0)
    })
  })

  describe('session boundary check', () => {
    it('reports first-run when no session has ever been recorded for this repo', async () => {
      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const boundary = checkFor(report.checks, 'session-boundary')
      expect(boundary.status).toBe('ok')
      expect(boundary.message).toContain('no rhizomorph session recorded yet')
    })

    it('names the session that would resume, its age, the window, resumedCount and event count', async () => {
      const sessionDir = sessionDirFor(repoPath, dataRoot)
      const filePath = sessionFilePath(sessionDir, '1000')
      await new SessionLogWriter(filePath).append(
        createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
      )
      await recordResume(sessionDir, '1000')
      await recordResume(sessionDir, '1000')

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        now: () => 1000 + 5000,
      })

      const boundary = checkFor(report.checks, 'session-boundary')
      expect(boundary.status).toBe('ok')
      expect(boundary.message).toContain('session 1000 would resume')
      expect(boundary.message).toContain('resumed 2 times')
      expect(boundary.message).toContain('1 events')
      expect(boundary.message).toContain('--fresh')
      expect(boundary.message).toContain('--resume-window 0')
    })

    it('names a stale previous session and that the next run starts fresh', async () => {
      const sessionDir = sessionDirFor(repoPath, dataRoot)
      const filePath = sessionFilePath(sessionDir, '1000')
      await new SessionLogWriter(filePath).append(
        createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
      )

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        now: () => 1000 + RESUME_WINDOW_MS + 1,
      })

      const boundary = checkFor(report.checks, 'session-boundary')
      expect(boundary.status).toBe('ok')
      expect(boundary.message).toContain('stale')
      expect(boundary.message).toContain('starts a fresh one')
    })

    it('names a live writer instead of the resumable session it is blocking, with its pid and the remedy', async () => {
      const sessionDir = sessionDirFor(repoPath, dataRoot)
      const filePath = sessionFilePath(sessionDir, '1000')
      await new SessionLogWriter(filePath).append(
        createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
      )
      await writeSessionLock(sessionDir, '1000', process.pid, 1000)

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        now: () => 1000 + 5000,
      })

      const boundary = checkFor(report.checks, 'session-boundary')
      expect(boundary.status).toBe('warn')
      expect(boundary.message).toContain('session 1000 is being written by a live instance')
      expect(boundary.message).toContain(`pid ${process.pid}`)
      expect(boundary.message).toContain('--fresh')
      expect(boundary.message).toContain('stop the other instance')
    })

    it('names the session as resumable once its lock names a dead pid — a crash never strands it', async () => {
      const { spawnSync } = await import('node:child_process')
      const dead = spawnSync(process.execPath, ['-e', '']).pid
      if (!dead) throw new Error('expected the probe process to have been given a pid')

      const sessionDir = sessionDirFor(repoPath, dataRoot)
      const filePath = sessionFilePath(sessionDir, '1000')
      await new SessionLogWriter(filePath).append(
        createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
      )
      await writeSessionLock(sessionDir, '1000', dead, 1000)

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        now: () => 1000 + 5000,
      })

      const boundary = checkFor(report.checks, 'session-boundary')
      expect(boundary.status).toBe('ok')
      expect(boundary.message).toContain('session 1000 would resume')
    })

    it('names the closed-session remedy in clone-safe syntax, not a bare `rhizomorph rotate` a clone user cannot run (#276 context)', async () => {
      const sessionDir = sessionDirFor(repoPath, dataRoot)
      const filePath = sessionFilePath(sessionDir, '1000')
      const writer = new SessionLogWriter(filePath)
      await writer.append(
        createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
      )
      await writer.append(
        createEvent('session.closed', { sessionId: '1000', reason: 'rotated', eventCount: 1 }, { id: 'evt-2', ts: 2000 }),
      )

      const report = await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot })

      const boundary = checkFor(report.checks, 'session-boundary')
      expect(boundary.status).toBe('ok')
      expect(boundary.message).toContain('closed on purpose')
      expect(boundary.message).toContain('npm exec rhizomorph -- rotate')
      expect(boundary.message).not.toContain('`rhizomorph rotate`')
    })

    it('never writes anything: a doctor run is not itself a boot', async () => {
      const sessionDir = sessionDirFor(repoPath, dataRoot)
      const filePath = sessionFilePath(sessionDir, '1000')
      await new SessionLogWriter(filePath).append(
        createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
      )

      await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot, now: () => 2000 })
      await runDoctor({ path: repoPath, port: 0, exec: healthyExec, webDistDir, claudeProjectsRoot, dataRoot, now: () => 3000 })

      expect(await readResumedCount(sessionDir, '1000')).toBe(0)
    })
  })

  /**
   * prd-27 rulings 3 and 6 (#218). Three readings that a boolean would collapse
   * into two — never declared, configured but silent, declared — plus the
   * fourth this wave adds, lapsed; and the mirror the issue names, a landed
   * lane, which has finished rather than lapsed.
   *
   * Every case reads the newest recorded session through the same `buildFleet`
   * the dashboard reads, so doctor and the STATE column cannot disagree about
   * a lane. `BEACON_LAPSE_MS` is imported, never typed: the boundary cases
   * below move with the constant, and the constant is held to the design note
   * by its own law in `collectors/beacon/collector.test.ts`.
   */
  describe('declared attention (prd-27 rulings 3 and 6, #218)', () => {
    const NOW = 1_800_000_000_000
    const now = () => NOW
    const WRITER = 'claude-hook'
    const DIGEST = 'c'.repeat(64)
    let evtId = 0

    function evt(type: Parameters<typeof createEvent>[0], payload: never, ts: number) {
      evtId += 1
      return createEvent(type, payload, { id: `evt-${evtId}`, ts })
    }

    function worktrees(): ReturnType<typeof createEvent>[] {
      return [
        evt('session.started', { sessionId: '900000', repoPath, repoName: 'repo' } as never, NOW - 900_000),
        evt('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true } as never, NOW - 900_000),
        evt(
          'worktree.discovered',
          { path: '/repo-wt/2-core', branch: '2-core', head: 'sha-2', isMain: false } as never,
          NOW - 900_000,
        ),
        evt(
          'worktree.discovered',
          { path: '/repo-wt/3-web', branch: '3-web', head: 'sha-3', isMain: false } as never,
          NOW - 900_000,
        ),
      ]
    }

    function beaconFor(lane: string, kind: string, ts: number) {
      return evt(
        'beacon.received',
        { writer: WRITER, kind, lane, detail: 'hook: Notification', digest: DIGEST, file: 'claude-hook.jsonl', offset: 0 } as never,
        ts,
      )
    }

    function workFor(lane: string, ts: number) {
      return evt(
        'llm.usage',
        {
          lane,
          role: 'worker',
          model: 'claude-sonnet-4',
          tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 },
          sessionId: `sess-${lane}`,
          worktreePath: `/repo-wt/${lane}`,
          branch: lane,
          thread: 'main',
        } as never,
        ts,
      )
    }

    async function seed(events: ReturnType<typeof createEvent>[]): Promise<void> {
      const writer = new SessionLogWriter(sessionFilePath(sessionDirFor(repoPath, dataRoot), '900000'))
      for (const event of events) await writer.append(event)
    }

    function run(exec: Exec = healthyExec) {
      return runDoctor({ path: repoPath, port: 0, exec, webDistDir, claudeProjectsRoot, dataRoot, now })
    }

    it('never declared: every present lane says so, and the ladder reads L4 on a healthy machine', async () => {
      await seed(worktrees())
      const report = await run()

      expect(checkFor(report.checks, 'attention:2-core').message).toContain('never declared')
      expect(checkFor(report.checks, 'attention:3-web').message).toContain('never declared')
      expect(checkFor(report.checks, 'attention:2-core').status).toBe('ok')
      expect(checkFor(report.checks, 'ladder').message).toContain('L4')
    })

    it('configured but silent: a lane with no beacon beside one that has reads the reason, and the other reads declared', async () => {
      await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
      const report = await run()

      expect(checkFor(report.checks, 'attention:3-web').message).toContain(CONFIGURED_SILENT_REASON)
      expect(checkFor(report.checks, 'attention:3-web').status).toBe('ok')
      expect(checkFor(report.checks, 'attention:2-core').message).toContain('declared waiting 30s ago')
    })

    it('live declaration on a workmux-less machine: the ladder reads L2 and names the beacon', async () => {
      const noWorkmuxExec: Exec = async (command, args) => {
        if (command === 'workmux') return missingBinary('workmux')
        return healthyExec(command, args)
      }
      await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
      const report = await run(noWorkmuxExec)

      const ladder = checkFor(report.checks, 'ladder')
      expect(ladder.message).toContain('L2')
      expect(ladder.message).toContain('beacon')
    })

    it('live declaration on a healthy machine: the rig still wins the tie, L4', async () => {
      await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
      const report = await run()

      expect(checkFor(report.checks, 'ladder').message).toContain('L4')
    })

    it('lapsed: a working beacon older than the interval warns, and says how long ago it lapsed', async () => {
      await seed([...worktrees(), beaconFor('2-core', 'working', NOW - BEACON_LAPSE_MS - 60_000)])
      const report = await run()

      const lane = checkFor(report.checks, 'attention:2-core')
      expect(lane.status).toBe('warn')
      expect(lane.message).toContain('declared attention lapsed 1m00s ago; reading turn shape')
      expect(lane.message).toContain('--hooks claude')
      // A lapse is per lane; the organ's session-wide manifest is unchanged, so
      // the rung does not fall with it.
      expect(checkFor(report.checks, 'ladder').message).toContain('L4')
      expect(report.exitCode).toBe(0)
    })

    it('a waiting beacon does not lapse without later work, and does with it', async () => {
      const declaredAt = NOW - BEACON_LAPSE_MS - 60_000
      await seed([...worktrees(), beaconFor('2-core', 'waiting', declaredAt)])
      const alone = await run()
      expect(checkFor(alone.checks, 'attention:2-core').status).toBe('ok')
      expect(checkFor(alone.checks, 'attention:2-core').message).toContain('declared waiting')

      await seed([workFor('2-core', NOW - 30_000)])
      const withWork = await run()
      expect(checkFor(withWork.checks, 'attention:2-core').status).toBe('warn')
      expect(checkFor(withWork.checks, 'attention:2-core').message).toContain('declared attention lapsed')
    })

    it('a landed lane is finished, not lapsed — it gets no line at all', async () => {
      await seed([
        ...worktrees(),
        beaconFor('2-core', 'working', NOW - BEACON_LAPSE_MS - 60_000),
        evt('worktree.removed', { path: '/repo-wt/2-core' } as never, NOW - 10_000),
      ])
      const report = await run()

      expect(report.checks.some((check) => check.id === 'attention:2-core')).toBe(false)
      expect(report.checks.some((check) => check.id === 'attention:3-web')).toBe(true)
    })

    it('no session yet: one honest line, no lane lines, and the ladder is unchanged', async () => {
      const report = await run()

      expect(checkFor(report.checks, 'attention').message).toContain('no session recorded for this repo yet')
      expect(report.checks.some((check) => check.id.startsWith('attention:'))).toBe(false)
      expect(checkFor(report.checks, 'ladder').message).toContain('L4')
    })

    /**
     * The fault is injected at the read seam rather than seeded on disk, and
     * the reason is worth keeping: ADR-0011 says a recording never rots, so
     * `readSessionLog` swallows *every* file-level failure and hands back an
     * empty session — garbage bytes, a path that will not open, a vanished
     * file. None of them reach this arm. What can still throw is the read
     * itself and the fold over it — since #307 the guard is scoped to exactly
     * those two, the fleet build having moved into the pure
     * `declaredAttentionChecks` the route shares — and this proves the guard
     * holds: doctor degrades to one honest warn line instead of taking the
     * whole preflight down with it, and the exit code stays 0.
     */
    it('an unreadable newest session warns instead of throwing', async () => {
      await seed(worktrees())
      readFault.armed = true
      try {
        const report = await run()

        const attention = checkFor(report.checks, 'attention')
        expect(attention.status).toBe('warn')
        expect(attention.message).toContain('could not read')
        expect(attention.message).toContain('session-900000.jsonl')
        expect(report.checks.some((check) => check.id.startsWith('attention:'))).toBe(false)
        expect(report.exitCode).toBe(0)
      } finally {
        readFault.armed = false
      }
    })

    it('a session of unparseable lines reads as an empty session, not as a fault — ADR-0011', async () => {
      const sessionDir = sessionDirFor(repoPath, dataRoot)
      await mkdir(sessionDir, { recursive: true })
      await writeFile(sessionFilePath(sessionDir, '900000'), 'not json at all\n{"also": ')
      const report = await run()

      const attention = checkFor(report.checks, 'attention')
      expect(attention.status).toBe('ok')
      expect(attention.message).toContain('no present lane')
    })

    /**
     * #307: the four readings are phrased once, in `declaredAttentionChecks`,
     * because `GET /api/doctor` now prints them too — over the running
     * recorder's fold instead of the newest recorded session. This is the proof
     * that the pure reader IS what the CLI prints: the same log, seeded and
     * read through `runDoctor`, then folded directly and handed to the pure
     * function, and the two check lists are compared whole. A route (or a CLI)
     * that grew its own wording for any of the four fails here.
     *
     * The reason and remedy come from `core`'s own constants rather than being
     * typed out, so a reworded reason moves both surfaces and this test at once
     * instead of pinning a stale string.
     */
    it('declaredAttentionChecks phrases the four readings from a fold alone', async () => {
      const declaredLog = [...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)]
      await seed(declaredLog)
      const report = await run()

      const fromFold = declaredAttentionChecks(reduceAll(declaredLog), NOW)
      expect(fromFold).toEqual(report.checks.filter((check) => check.id.startsWith('attention')))

      // live, and configured-but-silent beside it — one fold, two readings.
      expect(fromFold).toEqual([
        {
          id: 'attention:2-core',
          status: 'ok',
          message: `lane 2-core: declared waiting 30s ago (beacon ${WRITER})`,
        },
        {
          id: 'attention:3-web',
          status: 'ok',
          message: `lane 3-web: ${CONFIGURED_SILENT_REASON} — ${CONFIGURED_SILENT_REMEDY}`,
        },
      ])

      // never declared — no lane in the fold has a declaration at all.
      expect(declaredAttentionChecks(reduceAll(worktrees()), NOW)).toEqual([
        {
          id: 'attention:2-core',
          status: 'ok',
          message:
            'lane 2-core: never declared — attention read from the other organs (rung below); hooks: `rhizomorph env 2-core --hooks claude`',
        },
        {
          id: 'attention:3-web',
          status: 'ok',
          message:
            'lane 3-web: never declared — attention read from the other organs (rung below); hooks: `rhizomorph env 3-web --hooks claude`',
        },
      ])

      // lapsed — the one reading that warns.
      const lapsed = declaredAttentionChecks(
        reduceAll([...worktrees(), beaconFor('2-core', 'working', NOW - BEACON_LAPSE_MS - 60_000)]),
        NOW,
      )
      expect(lapsed[0]).toEqual({
        id: 'attention:2-core',
        status: 'warn',
        message: `lane 2-core: ${lapsedVoice(60_000)} — check the lane's hooks are still installed (\`rhizomorph env 2-core --hooks claude\`)`,
      })
    })
  })

  describe('the enrichment ladder (prd15 ruling 5)', () => {
    it('names L4 and says there is nothing further to climb on a fully healthy machine', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      })

      const ladder = checkFor(report.checks, 'ladder')
      expect(ladder.status).toBe('ok')
      expect(ladder.message).toContain('L4')
      expect(ladder.message).toContain('nothing further to climb')
      // The CLI's own `target-path` is always a real, measured `checkTargetPath`
      // run — never the route's synthetic entry — so nothing here is `assumed`
      // (adversarial review item 3; `assumed` only ever appears from the route).
      expect(ladder.assumed).toBeUndefined()
      expect(ladder.message).not.toContain('assumed')
    })

    it('drops a rung — the direction\'s own example — when workmux is missing, and names the remedy for the next one', async () => {
      const noWorkmuxExec: Exec = async (command, args) => {
        if (command === 'workmux') return missingBinary('workmux')
        return healthyExec(command, args)
      }
      // The transcript organ's own `telemetry: provided` is what keeps a
      // partial-attention, no-OTel machine off L3 — give it a real slug dir
      // (#288) so this test's only variable is workmux, as its name promises.
      const slugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
      await mkdir(slugDir, { recursive: true })
      await writeFile(path.join(slugDir, 'session-1.jsonl'), '')

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: noWorkmuxExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        env: {}, // telemetry unset too — nothing left to hold cost above absent
      })

      const ladder = checkFor(report.checks, 'ladder')
      expect(ladder.message).toContain('L0')
      expect(ladder.message).toContain('next:')
      expect(ladder.status).toBe('ok') // degrading a rung is honest, not a failure
    })

    it('climbs to L1 once telemetry env is set, even with no tmux/workmux at all', async () => {
      const noPaneToolsExec: Exec = async (command, args) => {
        if (command === 'tmux' || command === 'workmux') return missingBinary(command)
        return healthyExec(command, args)
      }

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: noPaneToolsExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      })

      expect(checkFor(report.checks, 'ladder').message).toContain('L1')
    })

    it('names one line per lane from the dispatch manifest, all at the same live rung', async () => {
      await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
      await writeFile(
        path.join(repoPath, '.swarm', 'lanes.json'),
        JSON.stringify({
          version: 1,
          lanes: [
            { handle: '188-sessionlog', branch: '188-sessionlog', fence: [] },
            { handle: '190-honesty', branch: '190-honesty', fence: [] },
          ],
        }),
      )

      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      })

      const laneChecks = report.checks.filter((check) => check.id.startsWith('ladder:'))
      expect(laneChecks.map((check) => check.id)).toEqual(['ladder:188-sessionlog', 'ladder:190-honesty'])
      for (const check of laneChecks) {
        expect(check.message).toContain('L4')
        expect(check.status).toBe('ok')
      }
      // The whole-repo fallback line only fires with no lanes at all.
      expect(report.checks.some((check) => check.id === 'ladder')).toBe(false)
    })
  })
})

describe('renderDoctorReport', () => {
  it('renders one labelled line per check plus a failing summary', () => {
    const text = renderDoctorReport({
      checks: [
        { id: 'node', status: 'ok', message: 'Node v22.5.0 satisfies the required >=22' },
        { id: 'target-path', status: 'fail', message: '/tmp/x does not exist — pass an existing repo' },
        { id: 'tmux', status: 'warn', message: 'tmux not found on PATH — optional' },
      ],
      exitCode: 1,
    })

    expect(text).toContain('[ok  ] Node v22.5.0 satisfies the required >=22')
    expect(text).toContain('[FAIL] /tmp/x does not exist — pass an existing repo')
    expect(text).toContain('[warn] tmux not found on PATH — optional')
    expect(text).toContain('1 check failed')
  })

  it('renders an all-clear summary when nothing failed', () => {
    const text = renderDoctorReport({
      checks: [{ id: 'node', status: 'ok', message: 'Node v22.5.0 satisfies the required >=22' }],
      exitCode: 0,
    })

    expect(text).toContain('All required checks passed.')
  })
})

describe('parseDoctorArgs', () => {
  const doctorDefaults = { path: undefined, port: 4321, help: false }

  it('defaults to no path and port 4321', () => {
    expect(parseDoctorArgs([])).toEqual(doctorDefaults)
  })

  it('takes the first non-flag token as the path', () => {
    expect(parseDoctorArgs(['../some-repo'])).toEqual({ ...doctorDefaults, path: '../some-repo' })
  })

  it('parses --port as a separate token', () => {
    expect(parseDoctorArgs(['../repo', '--port', '5000'])).toEqual({
      ...doctorDefaults,
      path: '../repo',
      port: 5000,
    })
  })

  it('parses --port=n', () => {
    expect(parseDoctorArgs(['--port=5000'])).toEqual({ ...doctorDefaults, port: 5000 })
  })

  it('throws on a non-numeric port', () => {
    expect(() => parseDoctorArgs(['--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('parses --help', () => {
    expect(parseDoctorArgs(['--help'])).toEqual({ ...doctorDefaults, help: true })
  })

  it('parses -h', () => {
    expect(parseDoctorArgs(['-h'])).toEqual({ ...doctorDefaults, help: true })
  })

  it('throws on an unrecognised flag, naming it', () => {
    expect(() => parseDoctorArgs(['--flatline-minutes', '3'])).toThrow(
      /unknown option.*"--flatline-minutes"/is,
    )
  })
})

describe('doctorHelpText', () => {
  it('documents the path argument, --port and --help', () => {
    const text = doctorHelpText()
    expect(text).toContain('rhizomorph doctor [path]')
    expect(text).toContain('--port')
    expect(text).toContain('4321')
    expect(text).toContain('--help')
  })
})

describe('the CLI doctor reports the process witness from the FOLD (review of #555, finding 2)', () => {
  /**
   * Nothing pinned this in either direction, which is why it shipped broken.
   *
   * `checkEnrichmentLadder` grew a fourth parameter when the process row
   * landed. `api/doctor.ts` passes it; `cli/doctor.ts` passed three arguments
   * and let `processes` fall back to `{}`. So on the CLI path `actorCount` was
   * permanently 0, and `rhizomorph doctor` on Linux with agents plainly running
   * printed the zero-actor reason — *"the process witness is reading, and has
   * not seen an agent process in this repo yet"* — while the fold knew
   * otherwise, dragging the derived rung down with it.
   *
   * The reviewer's `git grep` found ZERO assertions on this row anywhere on the
   * branch: the string appeared only at its definition site. A test asserting
   * it would have caught this and none existed — the same green-while-blind
   * shape as the headline defect in this PR's own body.
   */
  let ladderRepo: string

  beforeEach(async () => {
    ladderRepo = await mkdtemp(path.join(tmpdir(), 'rhizomorph-ladder-'))
  })

  afterEach(async () => {
    await rm(ladderRepo, { recursive: true, force: true })
  })

  const rowFor = async (processes: Readonly<Record<string, unknown>>): Promise<string> => {
    const ladder = await checkEnrichmentLadder(
      [{ id: 'target-path', status: 'ok', message: 'a git repository' }],
      ladderRepo,
      {},
      processes,
      'linux',
    )
    return JSON.stringify(ladder)
  }

  it('PINNED AS IT BEHAVES: the ladder output does not yet vary with the actor count', async () => {
    // The finding's stated EFFECT does not reproduce, and this pins why rather
    // than leaving the next reader to re-derive it.
    //
    // The review said `rhizomorph doctor` "will always print the row's
    // zero-actor reason" and that the miss "drags the derived rung down with
    // it". Measured on `platform: 'linux'` — where the row genuinely does move
    // from `partial` to `provided` — across all four combinations of
    // target-path ok/fail and zero/one actor: **every one returns L0**, and the
    // ladder's message is a rung label plus a climb line that carries no
    // contributor's reason at all.
    //
    // So the wiring defect is real — `api/doctor.ts` passed the fold and this
    // path did not — and it was invisible from here for a reason bigger than
    // the finding: the process row reaches NO CLI surface today. Its
    // capabilities are merged into `deriveRung`, which these four readings show
    // is insensitive to them, and its prose is never rendered anywhere. That
    // belongs to wave 4 (#531, "doctor names a level"), not to this wave.
    //
    // Pinned so that when wave 4 makes the row visible this assertion fails and
    // someone has to decide what it should say — rather than the row staying
    // invisible because nothing ever asked it to speak.
    const zero = await rowFor({})
    const one = await rowFor({ '4321:1788000000000': { pid: 4321, dialect: 'claude' } })
    expect(zero).toContain('L0')
    expect(one).toBe(zero)
  })

  it('and the fold really does reach the row — asserted where the row can be seen', async () => {
    // What the CLI wiring actually buys, asserted at the only surface that can
    // observe it today. `doctor-row.test.ts` holds the row's own four states;
    // this is the link between those and the fold the CLI now passes in.
    expect(processWitnessCapabilitiesFor(0, 'linux').identity.level).toBe('partial')
    expect(processWitnessCapabilitiesFor(1, 'linux').identity.level).toBe('provided')
  })
})

describe('checkDeclaredAttention hands the fold on rather than discarding it', () => {
  it('returns `processes` beside `declared`, so the ladder can be told', async () => {
    // The shape fix behind finding 2: `reduceAll` builds the whole SessionState
    // here and this function returned only `declared` from it. The data was in
    // hand and thrown away one line before the caller needed it — while the
    // beacon row's fold-derived input WAS threaded through, which is the
    // sibling shape this PR's body names one file over.
    const repo = await mkdtemp(path.join(tmpdir(), 'rhizomorph-facts-repo-'))
    const data = await mkdtemp(path.join(tmpdir(), 'rhizomorph-facts-data-'))
    try {
      const facts = await checkDeclaredAttention(repo, data, () => Date.now())
      expect(facts).toHaveProperty('processes')
      expect(facts.processes).toEqual({})
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(data, { recursive: true, force: true })
    }
  })
})
