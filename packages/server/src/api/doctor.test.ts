import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
import { checkClaudeProjects, runDoctor, type DoctorCheck } from '../cli/doctor.js'
import { sessionDirFor } from '../log/paths.js'
import { readResumedCount, sessionFilePath } from '../log/session-log.js'
import { SessionLogWriter } from '../recorder/index.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { createRouteDoctorProbe, PROBE_CACHE_TTL_MS, ROUTE_EXEC_TIMEOUT_MS, runServerDoctor } from './doctor.js'
import { capabilityHeaders } from './test-support.js'
import type * as ExecModule from '../server/exec.js'

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
/**
 * The one machine fact the route's own wiring tests need to vary (#307): a
 * beacon-only machine has no `workmux` on PATH, and the L2 reading is what the
 * route could not produce before it was handed the recorder's fold. The mock
 * factory above is module-scoped and cannot close over a `let` in a test, so
 * the switch is a hoisted flag — default `false`, so every pre-existing test in
 * this file sees exactly the healthy stub it always did.
 */
const execState = vi.hoisted(() => ({ workmuxMissing: false }))

vi.mock('../server/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>()
  return {
    ...actual,
    exec: (async (command: string, args: readonly string[]) => {
      if (command === 'tmux' && args[0] === '-V') return okResult('tmux 3.3a\n')
      if (command === 'workmux' && args[0] === 'status') {
        return execState.workmuxMissing
          ? { stdout: '', stderr: '', code: null, failed: true, errorMessage: 'spawn workmux ENOENT' }
          : okResult('handle  status\n')
      }
      if (command === 'claude' && args[0] === '--version') return okResult('2.1.220 (Claude Code)\n')
      return { stdout: '', stderr: 'not stubbed', code: 1, failed: true, errorMessage: 'not stubbed' }
    }) satisfies Exec,
  }
})

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
        'harness-roster',
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

  describe('harness roster check (#325 — GET /api/doctor reads the one registry too)', () => {
    it('reports the real registry split, same as the CLI', async () => {
      await setup()
      try {
        const checks = await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot })

        const harnessRoster = checkFor(checks, 'harness-roster')
        expect(harnessRoster.status).toBe('ok')
        expect(harnessRoster.message).toContain('2 implemented (claude, codex)')
        expect(harnessRoster.message).toContain('3 declared not-implemented (openclaw, pi, shell)')
      } finally {
        await teardown()
      }
    })

    it('still reports it during a replay — it names no repo fact, unlike session-boundary/lane-manifest', async () => {
      const checks = await runServerDoctor('record:some-slug', {
        exec: healthyExec,
        claudeProjectsRoot: await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-claude-')),
        dataRoot: await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-data-')),
        replay: true,
      })

      const harnessRoster = checkFor(checks, 'harness-roster')
      expect(harnessRoster.status).toBe('ok')
    })
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
    /**
     * #288 deepened `checkClaudeProjects` (`cli/doctor.ts`) to answer for the
     * watched repo's own slug dir, not just the global root, and both call
     * sites pass `repoPath` through: `runDoctor`'s and — after this issue's
     * fence was widened by one file, recorded on #288 — `runServerDoctor`'s
     * here in `api/doctor.ts`.
     *
     * That widening is what these assertions guard. The route and the CLI
     * share one function, so the only way they can disagree is a call site
     * dropping the argument; comparing the route's message to the same
     * function called the same way catches exactly that, character for
     * character, which is this issue's own Done-when.
     */
    it("the route's deepened call agrees with `checkClaudeProjects` called the same way", async () => {
      await setup()
      try {
        const serverChecks = await runServerDoctor(repoPath, { exec: healthyExec, claudeProjectsRoot, dataRoot })
        expect(checkFor(serverChecks, 'session-logs').message).toBe(checkClaudeProjects(claudeProjectsRoot, repoPath).message)
      } finally {
        await teardown()
      }
    })

    it("the route's deepened warn branch agrees with `checkClaudeProjects` called the same way", async () => {
      await setup()
      try {
        const missingClaudeProjectsRoot = path.join(claudeProjectsRoot, 'does-not-exist')

        const serverChecks = await runServerDoctor(repoPath, {
          exec: healthyExec,
          claudeProjectsRoot: missingClaudeProjectsRoot,
          dataRoot,
        })

        const serverCheck = checkFor(serverChecks, 'session-logs')
        expect(serverCheck.status).toBe('warn')
        expect(serverCheck.message).toBe(checkClaudeProjects(missingClaudeProjectsRoot, repoPath).message)
      } finally {
        await teardown()
      }
    })

    it('the shared function agrees with the CLI on the deepened answer, given the same repoPath', async () => {
      await setup()
      try {
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

          // The answer both call sites must land on. `api/doctor.ts` threads
          // `repoPath` through as well, since #288 (`api/doctor.ts:97`), so
          // this is the route's message too and not merely a prospective one —
          // the two tests above drive the route itself; this one drives the
          // CLI leg.
          const sharedMessage = checkClaudeProjects(claudeProjectsRoot, repoPath).message
          expect(sharedMessage).toBe(checkFor(cliReport.checks, 'session-logs').message)
        } finally {
          await rm(webDistDir, { recursive: true, force: true })
        }
      } finally {
        await teardown()
      }
    })

    it('the CLI call site passes repoPath on the named-miss warn branch too', async () => {
      await setup()
      try {
        const missingClaudeProjectsRoot = path.join(claudeProjectsRoot, 'does-not-exist')
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

          const cliCheck = checkFor(cliReport.checks, 'session-logs')
          expect(cliCheck.status).toBe('warn')
          expect(checkClaudeProjects(missingClaudeProjectsRoot, repoPath).message).toBe(cliCheck.message)
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

  /**
   * #344 — THE BOUNDARY ITSELF, WHICH THE TWO TESTS ABOVE STEP OVER. They
   * probe at `TTL - 1` and `TTL + 1` and leave exactly `TTL` untested, so
   * relaxing the comparison to `<=` keeps both of them green — and moves the
   * poll sequence `connect/index.tsx` and this file both document in words
   * from miss/hit/hit/miss (one probe in three, the claim) to
   * miss/hit/hit/hit/miss (one in four). A poll lands on the boundary exactly
   * because the interval divides the TTL, so this is the ordinary case here,
   * not a corner.
   */
  it('(#344) treats exactly the TTL as expired, since the connect page polls onto that boundary', async () => {
    await setup()
    try {
      let callCount = 0
      const countingExec: Exec = async (command, args, options) => {
        callCount++
        return healthyExec(command, args, options)
      }

      let now = 3_000_000
      const probe = createRouteDoctorProbe(repoPath, { exec: countingExec, claudeProjectsRoot, dataRoot, now: () => now })

      await probe()
      expect(callCount).toBe(3)

      now += PROBE_CACHE_TTL_MS // exactly the window, not one tick either side
      await probe()
      expect(callCount).toBe(6) // expired: the third poll pays for a fresh probe
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

  it('serves the server-relevant checks as a JSON array, GET-only, gated by the capability token (prd-29 ruling 7, #59)', async () => {
    await setup()
    try {
      const app = makeApp()
      const response = await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })

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
      const app = makeApp()
      const response = await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })
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

  describe('law: the Host/loopback guard (adversarial review item 1, now the app-wide mutation guard)', () => {
    it('a loopback Host succeeds', async () => {
      await setup()
      try {
        const app = makeApp()
        const response = await app.inject({
          method: 'GET',
          url: '/api/doctor',
          headers: { host: '127.0.0.1:4321', ...capabilityHeaders(app) },
        })
        expect(response.statusCode).toBe(200)
      } finally {
        await teardown()
      }
    })

    // Pinned to the exact GLOBAL refusal, not `stringContaining('not loopback')`
    // — this route's own (now-deleted) route-local message contained that same
    // phrase, so a substring match would stay green even if the app-wide guard
    // stopped running before this route (prd-23 #307: the route-local
    // `preHandler` is gone; this is the sentence that survives it). No
    // capability header here on purpose: the Host guard is an `onRequest` hook
    // and must refuse before the route's own `preHandler` capability gate ever
    // runs, so this stays a bare request to prove that ordering.
    it('a non-loopback Host is refused, before any check runs', async () => {
      await setup()
      try {
        const response = await makeApp().inject({ method: 'GET', url: '/api/doctor', headers: { host: 'evil.example' } })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({
          error: 'refused: Host "evil.example" is not loopback — this instrument only accepts requests addressed to 127.0.0.1/localhost',
        })
      } finally {
        await teardown()
      }
    })
  })

  describe('the invalidation hook (prd20 retarget spike Q1, gap d)', () => {
    it("re-points at the NEW repo on the very next request — a mutated ctx.repoPath is never served the OLD repo's cached (or stale-closed-over) answer", async () => {
      await setup()
      const otherRepoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-api-doctor-route-repo-b-'))
      try {
        const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
        const ctx = { repoPath, repoName: 'repo', sessionDir, recorder }
        const app = buildApp(ctx)

        const before = (await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })).json()
        expect(checkFor(before, 'session-boundary').message).toContain(repoPath)

        // The retarget mutation — no re-registration, no new buildApp call, and
        // well inside `PROBE_CACHE_TTL_MS`: without the hook this would still
        // be serving the single-flight cache built for the OLD repo.
        ctx.repoPath = otherRepoPath

        const after = (await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })).json()
        expect(checkFor(after, 'session-boundary').message).toContain(otherRepoPath)
        expect(checkFor(after, 'session-boundary').message).not.toContain(repoPath)
      } finally {
        await rm(otherRepoPath, { recursive: true, force: true })
        await teardown()
      }
    })

    it('still single-flights concurrent requests for the SAME repoPath — the hook only rebuilds on an actual change', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
        const ctx = { repoPath, repoName: 'repo', sessionDir, recorder }
        const app = buildApp(ctx)

        const [a, b] = await Promise.all([
          app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) }),
          app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) }),
        ])

        expect(a.statusCode).toBe(200)
        expect(b.statusCode).toBe(200)
        expect(a.json()).toEqual(b.json())
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

        const response = await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })
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

/**
 * #307 — the follow-up #218 left behind. `checkEnrichmentLadder` gained its
 * optional `declared` parameter so this route would keep compiling, and the
 * route passed nothing: a beacon-only machine read **L4** here and **L2** from
 * `rhizomorph doctor`, two surfaces answering "what rung is this repo at" two
 * different ways for the same repo. `ServerDoctorOptions.foldSoFar` is the seam
 * that closes it, and the per-lane `attention` lines come with it — phrased by
 * `cli/doctor.ts`'s `declaredAttentionChecks`, never restated here.
 *
 * The rung parity test below is the sibling case: `/api/meta` was already
 * reading `beaconCapabilitiesFor(folded.declared)` off the same recorder
 * (#218), so after this change all three readers (CLI doctor, this route,
 * `/api/meta`) derive the rung from one fold, and a fourth phrasing has
 * somewhere to fail.
 */
describe('declared attention and the L2 rung reach the route (#307)', () => {
  let repoPath: string
  let sessionDir: string
  let claudeProjectsRoot: string
  let dataRoot: string

  async function setup(): Promise<void> {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-fold-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-fold-session-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-fold-claude-'))
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-fold-data-'))
  }

  async function teardown(): Promise<void> {
    execState.workmuxMissing = false
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
    ])
  }

  /**
   * A recorder holding one present lane, and optionally a declaration for it.
   *
   * `workmuxDisabled` is what makes the parity test meaningful rather than
   * lucky: the two readers learn about an absent workmux through DIFFERENT
   * honest seams — this route probes the binary (`checkOptionalTool`),
   * `/api/meta` reads the fold's `collector.disabled` — so a beacon-only
   * machine has to be described to both, and the flag is that machine's second
   * half. Setting only one of the two is the state where they legitimately
   * disagree, and neither reader is wrong about what it measured.
   */
  async function recorderWith(options: {
    declaredAt?: number
    workmuxDisabled?: boolean
  }): Promise<SessionRecorder> {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    let seq = 0
    const next = () => {
      seq += 1
      return `evt-${seq}`
    }
    await recorder.record(
      createEvent('session.started', { sessionId: '1000', repoPath, repoName: 'repo' }, { id: next(), ts: 1_000 }),
    )
    await recorder.record(
      createEvent(
        'worktree.discovered',
        { path: '/repo-wt/2-core', branch: '2-core', head: 'sha-2', isMain: false },
        { id: next(), ts: 2_000 },
      ),
    )
    if (options.workmuxDisabled === true) {
      await recorder.record(
        createEvent(
          'collector.disabled',
          { collector: 'workmux', reason: 'workmux not found on PATH' },
          { id: next(), ts: 3_000 },
        ),
      )
    }
    if (options.declaredAt !== undefined) {
      await recorder.record(
        createEvent(
          'beacon.received',
          {
            writer: 'claude-hook',
            kind: 'waiting',
            lane: '2-core',
            digest: 'a'.repeat(64),
            file: 'claude-hook.jsonl',
            offset: 0,
          },
          { id: next(), ts: options.declaredAt },
        ),
      )
    }
    return recorder
  }

  /** The rung word the ladder line names — the same token `/api/meta` returns as `rung`. */
  function rungIn(message: string): string {
    const match = message.match(/L[0-4]/)
    if (match === null) throw new Error(`no rung in ladder message: ${message}`)
    return match[0]
  }

  it("the route reads L2 off the recorder's fold when the beacon is the only declaring witness", async () => {
    await setup()
    try {
      execState.workmuxMissing = true
      const recorder = await recorderWith({ declaredAt: Date.now() - 30_000, workmuxDisabled: true })
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const body = (await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })).json()

      const ladder = checkFor(body, 'ladder')
      expect(ladder.message).toContain('L2')
      expect(ladder.message).toContain('beacon')

      const lane = checkFor(body, 'attention:2-core')
      expect(lane.status).toBe('ok')
      expect(lane.message).toContain('declared waiting')
      expect(lane.message).toContain('beacon claude-hook')
    } finally {
      await teardown()
    }
  })

  it('…and L4 when workmux is present — the rig still wins the tie (ADR-0039)', async () => {
    await setup()
    try {
      const recorder = await recorderWith({ declaredAt: Date.now() - 30_000 })
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const body = (await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })).json()

      expect(checkFor(body, 'ladder').message).toContain('L4')
      expect(checkFor(body, 'attention:2-core').message).toContain('declared waiting')
    } finally {
      await teardown()
    }
  })

  it('the route and /api/meta derive the same rung from the same recorder, on both machines', async () => {
    for (const machine of [{ beaconOnly: true }, { beaconOnly: false }]) {
      await setup()
      try {
        execState.workmuxMissing = machine.beaconOnly
        const recorder = await recorderWith({
          declaredAt: Date.now() - 30_000,
          workmuxDisabled: machine.beaconOnly,
        })
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const doctorBody = (
          await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })
        ).json()
        const metaBody = (await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).json()

        expect(rungIn(checkFor(doctorBody, 'ladder').message)).toBe(metaBody.rung)
        expect(metaBody.rung).toBe(machine.beaconOnly ? 'L2' : 'L4')
      } finally {
        await teardown()
      }
    }
  })

  it('no beacon: every present lane reads never declared, and the ladder is unchanged from before #307', async () => {
    await setup()
    try {
      const recorder = await recorderWith({})
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const body = (await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })).json()

      expect(checkFor(body, 'attention:2-core').message).toContain('never declared')
      expect(checkFor(body, 'ladder').message).toContain('L4')
    } finally {
      await teardown()
    }
  })

  it('replay: attention is not applicable, and the fold thunk is never called', async () => {
    await setup()
    try {
      let reads = 0
      const checks = await runServerDoctor('record:some-slug', {
        exec: healthyExec,
        claudeProjectsRoot,
        dataRoot,
        replay: true,
        foldSoFar: () => {
          reads += 1
          throw new Error('must not be read during replay')
        },
      })

      const attention = checkFor(checks, 'attention')
      expect(attention.status).toBe('ok')
      expect(attention.message).toContain('not applicable')
      expect(checks.some((check) => check.id.startsWith('attention:'))).toBe(false)
      expect(reads).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('no fold seam: no attention lines at all, and the ladder still answers from the static manifest', async () => {
    await setup()
    try {
      const checks = await runServerDoctor(repoPath, {
        exec: healthyExec,
        claudeProjectsRoot,
        dataRoot,
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      })

      expect(checks.some((check) => check.id.startsWith('attention'))).toBe(false)
      expect(checkFor(checks, 'ladder').message).toContain('L4')
    } finally {
      await teardown()
    }
  })

  /**
   * The SIBLING CALL SITE. `registerDoctorRoute` builds the prober twice — once
   * at registration, once when a retarget re-points `ctx.repoPath` — and the
   * fold seam has to be on both. Dropping it from the rebuild alone leaves
   * every other test in this file green (EXECUTED: 38/38 still passed) while
   * `/api/doctor` silently stops reporting L2 and the per-lane readings for the
   * rest of the process's life. That is exactly the defect #307 closed,
   * re-opened in the one path this route exists to survive — and the retarget
   * test above pins `repoPath` through that rebuild without pinning the seam
   * added to the same literal.
   */
  it('keeps the fold seam across a retarget — the REBUILT prober still reads L2 and still names the lane', async () => {
    await setup()
    const otherRepoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-fold-repo-b-'))
    try {
      execState.workmuxMissing = true
      const recorder = await recorderWith({ declaredAt: Date.now() - 30_000, workmuxDisabled: true })
      const ctx = { repoPath, repoName: 'repo', sessionDir, recorder }
      const app = buildApp(ctx)

      const before: DoctorCheck[] = (
        await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })
      ).json()
      expect(rungIn(checkFor(before, 'ladder').message)).toBe('L2')
      expect(before.some((check) => check.id === 'attention:2-core')).toBe(true)

      // The retarget mutation — no re-registration, so the prober this serves
      // from is the one built by the SECOND `createRouteDoctorProbe` literal.
      ctx.repoPath = otherRepoPath

      const after: DoctorCheck[] = (
        await app.inject({ method: 'GET', url: '/api/doctor', headers: capabilityHeaders(app) })
      ).json()
      expect(checkFor(after, 'session-boundary').message).toContain(otherRepoPath)
      expect(rungIn(checkFor(after, 'ladder').message)).toBe('L2')
      expect(after.some((check) => check.id === 'attention:2-core')).toBe(true)
    } finally {
      await rm(otherRepoPath, { recursive: true, force: true })
      await teardown()
    }
  })
})
