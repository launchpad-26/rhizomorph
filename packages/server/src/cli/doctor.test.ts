import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@observatory/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/** Everything a fully healthy machine would report. */
const healthyExec: Exec = async (command, args) => {
  if (command === 'git' && args[0] === 'rev-parse') return okResult('true\n')
  if (command === 'tmux') return okResult('tmux 3.3a\n')
  if (command === 'workmux') return okResult('handle  status\n')
  return { stdout: '', stderr: 'not stubbed', code: 1, failed: true, errorMessage: 'not stubbed' }
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

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-repo-'))
    webDistDir = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-web-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-claude-'))
    await writeFile(path.join(webDistDir, 'index.html'), '<html></html>')
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(webDistDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
    ])
  })

  it('reports ok on every check for a fully healthy machine and exits 0', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
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
      'tmux',
      'workmux',
      'telemetry',
    ])
  })

  it('warns (not fails) on an old Node version', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
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
    })

    const targetPath = checkFor(report.checks, 'target-path')
    expect(targetPath.status).toBe('fail')
    expect(targetPath.message).toContain('not a git repository')
    expect(report.exitCode).toBe(1)
  })

  it('fails when the web build is missing, naming the build command', async () => {
    const emptyDistDir = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-empty-dist-'))
    try {
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir: emptyDistDir,
        claudeProjectsRoot,
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

    it('fails when the requested port is already in use, naming --port', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: busyPort,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
      })

      const port = checkFor(report.checks, 'port')
      expect(port.status).toBe('fail')
      expect(port.message).toContain(String(busyPort))
      expect(port.message).toContain('--port')
      expect(report.exitCode).toBe(1)
    })

    it('treats port 0 as always free', async () => {
      const report = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
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
    })

    const workmux = checkFor(report.checks, 'workmux')
    expect(workmux.status).toBe('warn')
    expect(workmux.message).toContain('found but erroring: exited with code 2')
    expect(report.exitCode).toBe(0)
  })

  it('warns when telemetry env is not configured, pointing at docs/telemetry.md', async () => {
    const report = await runDoctor({
      path: repoPath,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      env: {},
    })

    const telemetry = checkFor(report.checks, 'telemetry')
    expect(telemetry.status).toBe('warn')
    expect(telemetry.message).toContain('docs/telemetry.md')
    expect(report.exitCode).toBe(0)
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
