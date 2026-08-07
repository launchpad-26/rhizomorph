import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
import { runDoctor, type DoctorCheck } from '../cli/doctor.js'
import { sessionDirFor } from '../log/paths.js'
import { readResumedCount, sessionFilePath } from '../log/session-log.js'
import { SessionLogWriter } from '../recorder/index.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { runServerDoctor } from './doctor.js'

function okResult(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, failed: false }
}

/** Every argv this suite's server-side checks are allowed to invoke — see the "no writes" test below. */
const healthyExec: Exec = async (command, args) => {
  if (command === 'tmux' && args[0] === '-V') return okResult('tmux 3.3a\n')
  if (command === 'workmux' && args[0] === 'status') return okResult('handle  status\n')
  if (command === 'claude' && args[0] === '--version') return okResult('2.1.220 (Claude Code)\n')
  return { stdout: '', stderr: 'not stubbed', code: 1, failed: true, errorMessage: 'not stubbed' }
}

/**
 * `registerDoctorRoute` (via `ServerContext`) has no `exec` seam to inject —
 * deliberately: `ServerContext` is this fence's read-only boundary, not a
 * file we may touch (see the issue's fence). The "GET /api/doctor" suite
 * below exercises the real route wiring end-to-end through `buildApp`, so it
 * would otherwise fall through to the real `tmux`/`workmux`/`claude` on this
 * machine — on Windows, probing two genuinely-absent binaries (tmux, workmux)
 * means a PATHEXT scan per missing tool, which is real but slow and makes the
 * suite's speed depend on what happens to be installed on whichever machine
 * runs it. Mocking the module `runServerDoctor`'s default falls back to keeps
 * the wiring test hermetic and fast without touching `ServerContext` at all;
 * every test that calls `runServerDoctor` directly still passes its own
 * `exec` fixture and is unaffected by this mock.
 */
vi.mock('../server/exec.js', () => ({
  exec: (async (command: string, args: readonly string[]) => {
    if (command === 'tmux' && args[0] === '-V') return okResult('tmux 3.3a\n')
    if (command === 'workmux' && args[0] === 'status') return okResult('handle  status\n')
    if (command === 'claude' && args[0] === '--version') return okResult('2.1.220 (Claude Code)\n')
    return { stdout: '', stderr: 'not stubbed', code: 1, failed: true, errorMessage: 'not stubbed' }
  }) satisfies Exec,
}))

function checkFor(checks: readonly DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((c) => c.id === id)
  if (!check) throw new Error(`no check with id "${id}"`)
  return check
}

describe('runServerDoctor (prd-19 ruling 5)', () => {
  let repoPath: string
  let claudeProjectsRoot: string
  let dataRoot: string

  async function setup(): Promise<void> {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-repo-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-claude-'))
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-data-'))
  }

  async function teardown(): Promise<void> {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
    ])
  }

  it('excludes target-path, web-build and port — meaningless once this very request is already being answered', async () => {
    await setup()
    try {
      const checks = await runServerDoctor(repoPath, {
        exec: healthyExec,
        claudeProjectsRoot,
        dataRoot,
        nodeVersion: 'v22.5.0',
        rootPackageJsonPath: path.join(repoPath, 'does-not-exist.json'),
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      })

      const ids = checks.map((check) => check.id)
      expect(ids).not.toContain('target-path')
      expect(ids).not.toContain('web-build')
      expect(ids).not.toContain('port')
      expect(ids).toEqual([
        'node',
        'session-logs',
        'session-boundary',
        'tmux',
        'workmux',
        'telemetry',
        'lane-manifest',
        'cli-version-drift',
        'ladder',
      ])
    } finally {
      await teardown()
    }
  })

  it('still climbs the enrichment ladder to L4 on an otherwise-healthy machine — the implied target-path does not stall it at L0', async () => {
    await setup()
    try {
      const checks = await runServerDoctor(repoPath, {
        exec: healthyExec,
        claudeProjectsRoot,
        dataRoot,
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      })

      const ladder = checkFor(checks, 'ladder')
      expect(ladder.status).toBe('ok')
      expect(ladder.message).toContain('L4')
      expect(ladder.message).toContain('nothing further to climb')
    } finally {
      await teardown()
    }
  })

  it("marks telemetry as a server-shell reading, distinct from the CLI's own message for the identical env/platform", async () => {
    await setup()
    try {
      const serverChecks = await runServerDoctor(repoPath, {
        exec: healthyExec,
        claudeProjectsRoot,
        dataRoot,
        env: {},
        platform: 'linux',
      })

      const webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-web-'))
      try {
        const cliReport = await runDoctor({
          path: repoPath,
          port: 0,
          exec: healthyExec,
          webDistDir,
          claudeProjectsRoot,
          dataRoot,
          env: {},
          platform: 'linux',
        })

        const serverTelemetry = checkFor(serverChecks, 'telemetry')
        const cliTelemetry = checkFor(cliReport.checks, 'telemetry')

        expect(serverTelemetry.status).toBe('warn')
        expect(cliTelemetry.status).toBe('warn')
        expect(serverTelemetry.message).toContain('server shell, not agent shell')
        expect(cliTelemetry.message).not.toContain('server shell')
        expect(serverTelemetry.message).not.toBe(cliTelemetry.message)
      } finally {
        await rm(webDistDir, { recursive: true, force: true })
      }
    } finally {
      await teardown()
    }
  })

  describe('law: for the same fixture dir, the session-logs message equals the CLI\'s, character for character', () => {
    it('when Claude Code session logs are present', async () => {
      await setup()
      try {
        const serverChecks = await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot })

        const webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-web2-'))
        try {
          const cliReport = await runDoctor({
            path: repoPath,
            port: 0,
            exec: healthyExec,
            webDistDir,
            claudeProjectsRoot,
            dataRoot,
          })

          expect(checkFor(serverChecks, 'session-logs').message).toBe(checkFor(cliReport.checks, 'session-logs').message)
        } finally {
          await rm(webDistDir, { recursive: true, force: true })
        }
      } finally {
        await teardown()
      }
    })

    it('when Claude Code session logs are absent (the warn branch)', async () => {
      await setup()
      try {
        const missingClaudeProjectsRoot = path.join(claudeProjectsRoot, 'does-not-exist')

        const serverChecks = await runServerDoctor(repoPath, {
          exec: healthyExec,
          claudeProjectsRoot: missingClaudeProjectsRoot,
          dataRoot,
        })

        const webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-web3-'))
        try {
          const cliReport = await runDoctor({
            path: repoPath,
            port: 0,
            exec: healthyExec,
            webDistDir,
            claudeProjectsRoot: missingClaudeProjectsRoot,
            dataRoot,
          })

          const serverCheck = checkFor(serverChecks, 'session-logs')
          const cliCheck = checkFor(cliReport.checks, 'session-logs')
          expect(serverCheck.status).toBe('warn')
          expect(serverCheck.message).toBe(cliCheck.message)
        } finally {
          await rm(webDistDir, { recursive: true, force: true })
        }
      } finally {
        await teardown()
      }
    })
  })

  describe('law: the route performs no writes', () => {
    it('the exec seam is only ever called with the known read-only argv — never anything mutating', async () => {
      await setup()
      try {
        const calls: Array<{ command: string; args: string[] }> = []
        const spyExec: Exec = async (command, args, options) => {
          calls.push({ command, args: [...args] })
          return healthyExec(command, args, options)
        }

        await runServerDoctor(repoPath, { exec: spyExec, claudeProjectsRoot, dataRoot })

        expect(calls).toEqual([
          { command: 'tmux', args: ['-V'] },
          { command: 'workmux', args: ['status'] },
          { command: 'claude', args: ['--version'] },
        ])
      } finally {
        await teardown()
      }
    })

    it('never increments the resumed count — a doctor read is not itself a boot (via the same fs seam the CLI check uses)', async () => {
      await setup()
      try {
        const sessionDir = sessionDirFor(repoPath, dataRoot)
        const filePath = sessionFilePath(sessionDir, '1000')
        await new SessionLogWriter(filePath).append(
          createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
        )

        await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot, now: () => 2000 })
        await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot, now: () => 3000 })

        expect(await readResumedCount(sessionDir, '1000')).toBe(0)
      } finally {
        await teardown()
      }
    })
  })
})

describe('GET /api/doctor', () => {
  let repoPath: string
  let sessionDir: string

  async function setup(): Promise<void> {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-route-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-route-session-'))
  }

  async function teardown(): Promise<void> {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  }

  function makeApp() {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
  }

  it('serves the server-relevant checks as a JSON array, GET-only and without a token', async () => {
    await setup()
    try {
      const response = await makeApp().inject({ method: 'GET', url: '/api/doctor' })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBeGreaterThan(0)
      for (const check of body) {
        expect(typeof check.id).toBe('string')
        expect(['ok', 'warn', 'fail']).toContain(check.status)
        expect(typeof check.message).toBe('string')
      }
      const ids = body.map((check: { id: string }) => check.id)
      expect(ids).not.toContain('target-path')
      expect(ids).not.toContain('web-build')
      expect(ids).not.toContain('port')
      expect(ids).toContain('session-logs')
      expect(ids).toContain('ladder')
    } finally {
      await teardown()
    }
  })

  it('answers at this repo\'s own path — the session-boundary check names it', async () => {
    await setup()
    try {
      const response = await makeApp().inject({ method: 'GET', url: '/api/doctor' })
      const body = response.json()
      const boundary = checkFor(body, 'session-boundary')
      expect(boundary.message).toContain(repoPath)
    } finally {
      await teardown()
    }
  })

  it('is GET-only — a POST is not a registered route', async () => {
    await setup()
    try {
      const response = await makeApp().inject({ method: 'POST', url: '/api/doctor' })
      expect(response.statusCode).toBe(404)
    } finally {
      await teardown()
    }
  })
})
