import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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
import { createRouteDoctorProbe, PROBE_CACHE_TTL_MS, ROUTE_EXEC_TIMEOUT_MS, runServerDoctor } from './doctor.js'

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

/**
 * A real write barrier (adversarial review item 6): a stable digest of every
 * file under `rootDir`, recursively — path, size and content hash. Doctor's
 * checks call real `node:fs` functions directly rather than through an
 * injected seam, so this is the only way to prove a call touched nothing:
 * if some future edit added a reachable `writeFile`/`mkdir` anywhere in the
 * reused checks, the digest would differ (or a new path would appear) and
 * this would fail, unlike an argv allowlist or a single counter, which only
 * prove the ONE side effect they were built to watch.
 */
async function snapshotTree(rootDir: string): Promise<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(rootDir, { recursive: true, withFileTypes: true })
  } catch {
    return '<absent>'
  }

  const records: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = path.join(entry.parentPath, entry.name)
    const content = await readFile(fullPath)
    const rel = path.relative(rootDir, fullPath)
    records.push(`${rel}::${content.length}::${createHash('sha256').update(content).digest('hex')}`)
  }
  return records.sort().join('\n')
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

  describe('law: an assumed input is visible in the payload, not only a code comment (adversarial review item 3)', () => {
    it('flags the ladder check assumed: true, and says so in the message', async () => {
      await setup()
      try {
        const checks = await runServerDoctor(repoPath, {
          exec: healthyExec,
          claudeProjectsRoot,
          dataRoot,
          env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
        })

        const ladder = checkFor(checks, 'ladder')
        expect(ladder.assumed).toBe(true)
        expect(ladder.message).toContain('assumed')
      } finally {
        await teardown()
      }
    })

    it('flags every per-lane ladder entry too, not just the whole-repo fallback', async () => {
      await setup()
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
        await writeFile(
          path.join(repoPath, '.swarm', 'lanes.json'),
          JSON.stringify({ version: 1, lanes: [{ handle: 'a', branch: 'a', fence: [] }] }),
        )

        const checks = await runServerDoctor(repoPath, {
          exec: healthyExec,
          claudeProjectsRoot,
          dataRoot,
          env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
        })

        const laneLadder = checkFor(checks, 'ladder:a')
        expect(laneLadder.assumed).toBe(true)
        expect(laneLadder.message).toContain('assumed')
      } finally {
        await teardown()
      }
    })

    it('never appears on any of the other checks — only the ladder rests on the synthetic input', async () => {
      await setup()
      try {
        const checks = await runServerDoctor(repoPath, {
          exec: healthyExec,
          claudeProjectsRoot,
          dataRoot,
          env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
        })

        for (const check of checks) {
          if (check.id === 'ladder') continue
          expect(check.assumed).toBeUndefined()
        }
      } finally {
        await teardown()
      }
    })
  })

  describe("law: the route's telemetry status agrees with its own words (adversarial review item 4)", () => {
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

    it("NEVER reports ok from the route, even when this process's own env has the var set — status must agree with the words", async () => {
      await setup()
      try {
        const checks = await runServerDoctor(repoPath, {
          exec: healthyExec,
          claudeProjectsRoot,
          dataRoot,
          env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
        })

        const telemetry = checkFor(checks, 'telemetry')
        expect(telemetry.status).toBe('warn')
        expect(telemetry.message).toContain('cannot see')
      } finally {
        await teardown()
      }
    })

    it('does not let the ladder count this as proven OTel capability from the route — same rung whether the var is set or not', async () => {
      await setup()
      try {
        const withVarSet = await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } })
        const withVarUnset = await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot, env: {} })

        // L4 here comes from workmux's declared attention, not telemetry's cost
        // signal — proving the two runs land on the exact same rung either way
        // is exactly what shows telemetry never moved the needle from the route.
        expect(checkFor(withVarSet, 'ladder').message).toBe(checkFor(withVarUnset, 'ladder').message)
      } finally {
        await teardown()
      }
    })
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

  describe('law: replaying a finished record is never treated as a live repo (adversarial review item 5)', () => {
    it('labels session-boundary, lane-manifest and ladder as not applicable instead of probing the fictitious repoPath', async () => {
      await setup()
      try {
        const replayRepoPath = 'record:some-slug'
        const checks = await runServerDoctor(replayRepoPath, {
          exec: healthyExec,
          claudeProjectsRoot,
          dataRoot,
          replay: true,
        })

        const boundary = checkFor(checks, 'session-boundary')
        expect(boundary.status).toBe('ok')
        expect(boundary.message).toContain('not applicable')
        expect(boundary.message).toContain('replaying')
        // Never claims anything about the (nonexistent) session dir a real
        // `sessionDirFor(replayRepoPath, dataRoot)` would have resolved to.
        expect(boundary.message).not.toContain('first-run')
        expect(boundary.message).not.toContain('would resume')

        const laneManifest = checkFor(checks, 'lane-manifest')
        expect(laneManifest.status).toBe('ok')
        expect(laneManifest.message).toContain('not applicable')
        expect(laneManifest.message).not.toContain('.swarm/lanes.json')

        const ladder = checkFor(checks, 'ladder')
        expect(ladder.status).toBe('ok')
        expect(ladder.message).toContain('not applicable')
        expect(ladder.message).not.toContain('L0')
        expect(ladder.message).not.toContain('L4')
        expect(ladder.assumed).toBeUndefined()

        // The rest of the checks are still real, general facts about this
        // machine — untouched by replay.
        expect(checkFor(checks, 'tmux').status).toBe('ok')
        expect(checkFor(checks, 'node').id).toBe('node')
      } finally {
        await teardown()
      }
    })

    it('exits 1-shaped fictitious repoPath cleanly — no exception, no ladder crash, even with lanes/session-boundary skipped', async () => {
      await setup()
      try {
        await expect(
          runServerDoctor('record:another-slug', { exec: healthyExec, claudeProjectsRoot, dataRoot, replay: true }),
        ).resolves.toBeTruthy()
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

    it('a real write barrier (item 6): every fixture dir doctor can reach is byte-for-byte unchanged after a run', async () => {
      await setup()
      try {
        const sessionDir = sessionDirFor(repoPath, dataRoot)
        const filePath = sessionFilePath(sessionDir, '1000')
        await new SessionLogWriter(filePath).append(
          createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
        )
        const { mkdir: mkdirFixture, writeFile: writeFileFixture } = await import('node:fs/promises')
        await mkdirFixture(path.join(repoPath, '.swarm'), { recursive: true })
        await writeFileFixture(path.join(repoPath, '.swarm', 'lanes.json'), JSON.stringify({ version: 1, lanes: [] }))
        await writeFileFixture(path.join(claudeProjectsRoot, 'marker.txt'), 'present')

        const before = await Promise.all([snapshotTree(repoPath), snapshotTree(claudeProjectsRoot), snapshotTree(dataRoot)])

        await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot, now: () => 2000 })

        const after = await Promise.all([snapshotTree(repoPath), snapshotTree(claudeProjectsRoot), snapshotTree(dataRoot)])

        expect(after).toEqual(before)
      } finally {
        await teardown()
      }
    })
  })
})

describe('createRouteDoctorProbe (adversarial review item 2)', () => {
  let repoPath: string
  let claudeProjectsRoot: string
  let dataRoot: string

  async function setup(): Promise<void> {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-probe-repo-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-probe-claude-'))
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-probe-data-'))
  }

  async function teardown(): Promise<void> {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
    ])
  }

  it('(2a) passes ROUTE_EXEC_TIMEOUT_MS to every exec call, unlike the CLI path which never sets one', async () => {
    await setup()
    try {
      const seenTimeouts: Array<number | undefined> = []
      const spyExec: Exec = async (command, args, options) => {
        seenTimeouts.push(options?.timeoutMs)
        return healthyExec(command, args, options)
      }

      const probe = createRouteDoctorProbe(repoPath, { exec: spyExec, claudeProjectsRoot, dataRoot })
      await probe()

      expect(seenTimeouts).toHaveLength(3)
      for (const timeoutMs of seenTimeouts) {
        expect(timeoutMs).toBe(ROUTE_EXEC_TIMEOUT_MS)
      }
    } finally {
      await teardown()
    }
  })

  it('(2b) single-flights: two concurrent calls trigger exactly one underlying probe run (3 exec calls, not 6)', async () => {
    await setup()
    try {
      let callCount = 0
      const slowExec: Exec = async (command, args, options) => {
        callCount++
        await new Promise((resolve) => setTimeout(resolve, 10))
        return healthyExec(command, args, options)
      }

      const probe = createRouteDoctorProbe(repoPath, { exec: slowExec, claudeProjectsRoot, dataRoot })
      const [a, b] = await Promise.all([probe(), probe()])

      expect(callCount).toBe(3)
      expect(a).toBe(b) // the exact same resolved array — one shared promise, not two separate runs
    } finally {
      await teardown()
    }
  })

  it('(2b) reuses the cached answer within the TTL window, using an injectable clock', async () => {
    await setup()
    try {
      let callCount = 0
      const countingExec: Exec = async (command, args, options) => {
        callCount++
        return healthyExec(command, args, options)
      }

      let now = 1_000_000
      const probe = createRouteDoctorProbe(repoPath, { exec: countingExec, claudeProjectsRoot, dataRoot, now: () => now })

      await probe()
      expect(callCount).toBe(3)

      now += PROBE_CACHE_TTL_MS - 1 // still inside the window
      await probe()
      expect(callCount).toBe(3) // no new exec calls — the cached promise was reused
    } finally {
      await teardown()
    }
  })

  it('(2b) runs a fresh probe once the TTL window has passed', async () => {
    await setup()
    try {
      let callCount = 0
      const countingExec: Exec = async (command, args, options) => {
        callCount++
        return healthyExec(command, args, options)
      }

      let now = 2_000_000
      const probe = createRouteDoctorProbe(repoPath, { exec: countingExec, claudeProjectsRoot, dataRoot, now: () => now })

      await probe()
      expect(callCount).toBe(3)

      now += PROBE_CACHE_TTL_MS + 1 // past the window
      await probe()
      expect(callCount).toBe(6) // a second, fresh set of exec calls
    } finally {
      await teardown()
    }
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

  describe('law: the Host/loopback guard (adversarial review item 1)', () => {
    it('a loopback Host succeeds', async () => {
      await setup()
      try {
        const response = await makeApp().inject({ method: 'GET', url: '/api/doctor', headers: { host: '127.0.0.1:4321' } })
        expect(response.statusCode).toBe(200)
      } finally {
        await teardown()
      }
    })

    it('a non-loopback Host is refused, before any check runs', async () => {
      await setup()
      try {
        const response = await makeApp().inject({ method: 'GET', url: '/api/doctor', headers: { host: 'evil.example' } })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: expect.stringContaining('not loopback') })
      } finally {
        await teardown()
      }
    })
  })

  describe('the response labels replay honestly (adversarial review item 5, wired end to end)', () => {
    it('a readOnly (replay-shaped) context gets the not-applicable labels, not live-repo probes against its own sessionDir', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
        const app = buildApp({
          repoPath: 'record:test-slug',
          repoName: 'test-slug',
          sessionDir,
          recorder,
          readOnly: true,
        })

        const response = await app.inject({ method: 'GET', url: '/api/doctor' })
        const body = response.json()

        expect(checkFor(body, 'session-boundary').message).toContain('not applicable')
        expect(checkFor(body, 'lane-manifest').message).toContain('not applicable')
        expect(checkFor(body, 'ladder').message).toContain('not applicable')
      } finally {
        await teardown()
      }
    })
  })
})
