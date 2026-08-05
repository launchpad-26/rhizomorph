import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDirFor } from '../log/paths.js'
import { SessionLogWriter } from '../recorder/index.js'
import { readResumedCount, recordResume, RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { writeSessionLock } from '../log/session-lock.js'
import { renderDoctorReport, runDoctor, type DoctorCheck } from './doctor.js'

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

/** A `fetch` that answers one `/api/meta`-shaped (or not) body, without a socket. */
function metaFetch(body: unknown, init: ResponseInit = {}): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), init)) as typeof globalThis.fetch
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
      'cli-version-drift',
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

  it('warns when ~/.claude/projects (or its override) is missing', async () => {
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
    })

    it('drops a rung — the direction\'s own example — when workmux is missing, and names the remedy for the next one', async () => {
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
