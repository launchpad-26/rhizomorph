import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir as osTmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentProcess, Exec, ExecResult } from '@rhizomorph/core'
import {
  BEACON_LAPSE_MS,
  CONFIGURED_SILENT_REASON,
  CONFIGURED_SILENT_REMEDY,
  createEvent,
  lapsedVoice,
  reduceAll,
} from '@rhizomorph/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_TOKEN_HEADER } from '../api/security.js'
import { processWitnessCapabilitiesFor } from '../collectors/process/doctor-row.js'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { repoSlug, sessionDirFor } from '../log/paths.js'
import { canonicalize } from '../paths/containment.js'
import { exec as realExec } from '../server/exec.js'
import { writeSessionLock } from '../log/session-lock.js'
import { RESUME_WINDOW_MS, readResumedCount, recordResume, sessionFilePath } from '../log/session-log.js'
import { SessionLogWriter } from '../recorder/index.js'
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
  checkWatchedColonies,
  type DoctorCheck,
  declaredAttentionChecks,
  doctorHelpText,
  parseDoctorArgs,
  renderDoctorReport,
  runDoctor,
} from './doctor.js'
import { CAPABILITY_META_NAME } from './rotate.js'

/**
 * The temp root in the ONE spelling the product answers with (#644).
 *
 * `os.tmpdir()` is `/var/folders/…` on macOS and a symlink to
 * `/private/var/folders/…`; on Linux it is neither, so the two spellings are
 * one string there. Every repo path this instrument pins goes through
 * `canonicalizeRepoPath` (prd-58 ruling 1, `paths/containment.ts`) — so a
 * fixture built on the RAW spelling disagrees with the product on macOS and
 * agrees with it vacuously on Linux.
 *
 * **The disagreement hides.** `repoSlug` folds the path into an eight-hex
 * digest, so both sides still print `/var/folders/…` and only the hash moves:
 * `env-repo-a83137d0` against `env-repo-5ef4ef53`. Grepping the output for
 * `private/var` returns nothing. A digest of a path is a path comparison in
 * disguise.
 *
 * Shadowing the import beats rewriting every call site below: a fixture added
 * later is canonical without anyone having to remember. This only removes an
 * ambiguity from tests that are about something else — the canonicalisation
 * itself is witnessed by the symlink laws, which manufacture the divergence
 * instead of borrowing it from the platform and so bite on every OS
 * (`paths/repo-path-canonical.test.ts`, and for `runDoctor` the suite at the
 * foot of `cli/doctor.test.ts`).
 */
const CANONICAL_TMP_ROOT = canonicalize(osTmpdir())
function tmpdir(): string {
  return CANONICAL_TMP_ROOT
}


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
      // prd-58 ruling 1 (#610): the watched set, and one row per colony. The
      // pinned colony is always present, so there is always at least one row
      // and a reader never has to decide what an empty list meant.
      'colonies',
      `colony:${repoSlug(repoPath)}`,
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
    // `--extra-sessions` is retired (prd-57 ruling 8) — the remedy is now the
    // one thing a reader can act on without a flag that no longer parses.
    expect(sessionLogs.message).not.toContain('--extra-sessions')
    expect(sessionLogs.message).toContain('has run at least once here')
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
        `no Claude Code session logs at ${missingRoot} — per-agent history stays empty until \`claude\` has run at least once here`,
      )
    })
  })

  /**
   * SUCCESS 1's FALSIFIER, live — prd-57 ruling 8.
   *
   * These read `warn` before this change, and the message apologised for itself
   * in the same breath: "optional and will be degraded, not fatal". A warning
   * that has to say it is not a problem is not a warning. What it cost is the
   * whole reason the ruling exists — the honest reading of a warning is that
   * you are expected to act on it, so a first run answered "what do I install
   * to use this?" with "tmux and workmux", which was never true.
   */
  it('a machine with no tmux reads ok — an enrichment that is not present, never a warning', async () => {
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
    expect(tmux.status).toBe('ok')
    expect(tmux.message).toContain('not installed')
    // Never a requirement, in either direction: the word an operator would act
    // on must not appear at all.
    expect(tmux.message).not.toMatch(/install tmux|not found|degraded/)
    expect(report.exitCode).toBe(0)
  })

  it('a machine with no workmux reads ok too — the sibling, asserted rather than assumed', async () => {
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
    expect(workmux.status).toBe('ok')
    expect(workmux.message).toContain('not installed')
    expect(workmux.message).not.toMatch(/install workmux|not found|degraded/)
    expect(report.exitCode).toBe(0)
  })

  /**
   * SUCCESS 7 — the two configurations differ in NOTHING else.
   *
   * The stronger form of the pair above, and the one that would catch a fix
   * that merely downgraded the status while leaving the rest of the report
   * describing a lesser machine. Run the whole doctor twice, once with the rig
   * and once without, and diff every check.
   */
  it('a machine with the rig and a machine without differ in the rig lines and nothing else', async () => {
    const withoutRig: Exec = async (command, args) => {
      if (command === 'tmux' || command === 'workmux') return missingBinary(command)
      return healthyExec(command, args)
    }
    const options = { path: repoPath, port: 0, webDistDir, claudeProjectsRoot, dataRoot }

    const rigged = await runDoctor({ ...options, exec: healthyExec })
    const bare = await runDoctor({ ...options, exec: withoutRig })

    // Same checks, in the same order, with the same verdicts.
    expect(bare.checks.map((check) => check.id)).toEqual(rigged.checks.map((check) => check.id))
    expect(bare.checks.map((check) => check.status)).toEqual(rigged.checks.map((check) => check.status))
    expect(bare.exitCode).toBe(rigged.exitCode)

    // And the only messages that differ are the rig's own two. The LADDER line
    // is deliberately excluded from that claim and tested separately: it names
    // what the rig adds when the rig is there, which is the one place an
    // enrichment is allowed to show up.
    const differing = bare.checks
      .filter((check, i) => check.message !== rigged.checks[i]?.message)
      .map((check) => check.id)
      .filter((id) => !id.startsWith('ladder'))
    expect(differing.sort()).toEqual(['tmux', 'workmux'])
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

    it('never declared: every present lane says so, and the ladder reads L2 on a healthy machine', async () => {
      await seed(worktrees())
      const report = await run()

      expect(checkFor(report.checks, 'attention:2-core').message).toContain('never declared')
      expect(checkFor(report.checks, 'attention:3-web').message).toContain('never declared')
      expect(checkFor(report.checks, 'attention:2-core').status).toBe('ok')
      expect(checkFor(report.checks, 'ladder').message).toContain('L2')
    })

    it('configured but silent: a lane with no beacon beside one that has reads the reason, and the other reads declared', async () => {
      await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
      const report = await run()

      expect(checkFor(report.checks, 'attention:3-web').message).toContain(CONFIGURED_SILENT_REASON)
      expect(checkFor(report.checks, 'attention:3-web').status).toBe('ok')
      expect(checkFor(report.checks, 'attention:2-core').message).toContain('declared waiting 30s ago')
    })

    it('live declaration on a workmux-less machine: still L2, reached by the beacon alone', async () => {
      const noWorkmuxExec: Exec = async (command, args) => {
        if (command === 'workmux') return missingBinary('workmux')
        return healthyExec(command, args)
      }
      await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
      const report = await run(noWorkmuxExec)

      const ladder = checkFor(report.checks, 'ladder')
      expect(ladder.message).toContain('L2')
      // It no longer names WHICH witness, and that is prd-57 ruling 8 rather
      // than a loss. `deriveRung` split them (L2 beacon, L4 rig) because it
      // answers "what is providing this", which a fold needs. A person climbing
      // is asking whether attention is declared or guessed, and both witnesses
      // answer that identically — so naming one here would be re-introducing a
      // distinction the level deliberately does not make.
      expect(ladder.message).not.toContain('L4')
    })

    it('with NEITHER rig tool present, the enrichment is not claimed at all', () => {
      // The `pane previews` clause appears when EITHER tool is there, so the
      // test above (which mocks only workmux missing, and still has tmux)
      // cannot make this claim — it would have been asserting the absence of a
      // sentence that was legitimately present. Its own case, with both gone.
      return (async () => {
        const noRig: Exec = async (command, args) => {
          if (command === 'tmux' || command === 'workmux') return missingBinary(command)
          return healthyExec(command, args)
        }
        await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
        const ladder = checkFor((await run(noRig)).checks, 'ladder')

        expect(ladder.message).toContain('L2')
        expect(ladder.message).not.toContain('pane previews')
      })()
    })

    it('live declaration on a healthy machine: the SAME level, because there is no longer a tie to win', async () => {
      // The pair this makes with the test above is the whole of the re-cut.
      // Two machines, two different declaring witnesses, one level — where the
      // old ladder put them a rung apart and told the beacon-only one it had
      // further to climb.
      await seed([...worktrees(), beaconFor('2-core', 'waiting', NOW - 30_000)])
      const report = await run()

      const ladder = checkFor(report.checks, 'ladder')
      expect(ladder.message).toContain('L2')
      expect(ladder.message).not.toContain('L4')
      // The rig IS named here — as what it adds, which is the one place an
      // enrichment is allowed to appear.
      expect(ladder.message).toContain('pane previews')
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
      expect(checkFor(report.checks, 'ladder').message).toContain('L2')
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
      expect(checkFor(report.checks, 'ladder').message).toContain('L2')
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

    /**
     * DOCTOR AND THE CARD READ THE SAME DECLARATION, including one the hook
     * placed by pid (prd-57 ruling 3, #589).
     *
     * `attentionReading` looked the lane up by id alone, so a lane whose only
     * declaration arrived through `rhizomorph hook` — which cannot name a lane,
     * and is therefore recorded under the worktree its pid resolved to — read
     * `declares waiting (joined by pid)` on its card and `configured-silent`
     * here, on the same tick, about the same lane. Two surfaces contradicting
     * each other about one fact, which is exactly what prd-27's "the condition
     * is assembled once" exists to prevent. Found in adversarial review.
     */
    it('a declaration the hook placed BY PID is read here too, not reported configured-silent', () => {
      const log = [
        ...worktrees(),
        // Ruling 1's process witness places the actor …
        evt(
          'process.seen',
          {
            pid: 4321,
            dialect: 'claude',
            startedAt: NOW - 300_000,
            worktreePath: '/repo-wt/2-core',
            placement: 'rooted',
            parentPid: null,
          } as never,
          NOW - 300_000,
        ),
        // … and the hook declares, naming no lane, exactly as `cli/hook.ts` writes it.
        evt(
          'beacon.received',
          {
            writer: WRITER,
            kind: 'waiting',
            lane: null,
            pid: 4321,
            detail: 'hook: Notification',
            digest: DIGEST,
            file: 'claude-hook.jsonl',
            offset: 0,
          } as never,
          NOW - 30_000,
        ),
      ]

      const checks = declaredAttentionChecks(reduceAll(log), NOW)
      const core = checks.find((check) => check.id === 'attention:2-core')
      expect(core?.message).toBe(`lane 2-core: declared waiting 30s ago (beacon ${WRITER})`)
      expect(core?.message).not.toContain(CONFIGURED_SILENT_REASON)

      // And the lane that got no declaration still reads silent — the fallback
      // finds the declaration it should and invents none.
      expect(checks.find((check) => check.id === 'attention:3-web')?.message).toContain(CONFIGURED_SILENT_REASON)
    })
  })

  describe('the enrichment ladder (prd15 ruling 5)', () => {
    it('names L2 and says there is nothing further to climb on a fully healthy machine', async () => {
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
      expect(ladder.message).toContain('L2')
      expect(ladder.message).toContain('nothing further to climb')
      // The CLI's own `target-path` is always a real, measured `checkTargetPath`
      // run — never the route's synthetic entry — so nothing here is `assumed`
      // (adversarial review item 3; `assumed` only ever appears from the route).
      expect(ladder.assumed).toBeUndefined()
      expect(ladder.message).not.toContain('assumed')
    })

    /**
      * THE TEST WHOSE PREMISE RULING 8 REMOVED.
      *
      * It was called "drops a rung — the direction's own example — when workmux
      * is missing", and it was right about the old ladder: L4 was the top and
      * removing the rig cost you rungs. That is the claim the ruling deletes, so
      * the test is inverted rather than retitled — removing the rig must now
      * cost NOTHING, and the level must be decided entirely by what the
      * instrument can see.
      *
      * The L0 here comes from the env being empty, not from the missing
      * workmux, and the pair below is what proves the difference.
      */
     it('a bare machine is told what it CAN see and one command — never that a multiplexer is missing', async () => {
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
      // ONE command, and it reaches the top — ruling 4 made the climb a single
      // act rather than two, because `enlist` writes the variables and the
      // hooks together.
      expect(ladder.message).toContain('rhizomorph enlist claude')
      expect(ladder.status).toBe('ok')
      // Nothing about the rig, in either direction. This machine has no
      // workmux and is never told so.
      expect(ladder.message).not.toMatch(/workmux|tmux/)

      // WHAT THE RIG STILL DOES, stated rather than wished away — and this is
      // the correction that matters, because the first version of this test
      // asserted the opposite and was wrong.
      //
      // The same machine WITH the rig reads L2, because a rig genuinely
      // DECLARES attention: workmux says what a lane is doing, and that is the
      // same kind of fact a hook declares. Ruling 8 does not take that away and
      // must not be read as saying the rig contributes nothing.
      //
      // What it takes away is the other three things, all asserted above: the
      // warning, the rung ABOVE declared attention, and the instrument telling
      // you to go and install one. A bare machine is never told it is missing
      // something; it is told what it can see and the one command that changes
      // that, and that command is never `install tmux`.
      const withRig = await runDoctor({
        path: repoPath,
        port: 0,
        exec: healthyExec,
        webDistDir,
        claudeProjectsRoot,
        dataRoot,
        env: {},
      })
      const rigged = checkFor(withRig.checks, 'ladder')
      expect(rigged.message).toContain('L2')
      // And even at the top, the climb line never sends anyone to a multiplexer.
      expect(rigged.message).not.toMatch(/install (tmux|workmux)/)
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
        expect(check.message).toContain('L2')
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

type Report = Awaited<ReturnType<typeof runDoctor>>

const countOf = (report: Report, status: DoctorCheck['status']): number =>
  report.checks.filter((check) => check.status === status).length

/**
 * THE SUMMARY OVER A WARN-CARRYING REPORT (#603).
 *
 * The case directly above is the whole reason this defect survived: it is the only
 * assertion of the all-clear string in this file and it builds a report of exactly one
 * `ok` check — the single state in which the old `fail`-only count could not be wrong.
 * Seventeen sites in `doctor.ts` can emit a `warn`, and none of them was ever rendered
 * into a summary here without a failure standing beside it.
 *
 * So every case below goes through `runDoctor` rather than a hand-built report — the
 * status mix is one the CLI actually produces — and **every case asserts its own
 * premise**, the warn count and the fail count read off the report. A case that passes
 * because it accidentally built an all-ok report is this exact defect one level in.
 *
 * Assertions are on the FINAL LINE, not `toContain`: a substring assertion lets an
 * appended clause hide inside it, which #592 proved on its own sibling.
 */
describe('the summary speaks for every check it prints (#603)', () => {
  let repoPath: string
  let webDistDir: string
  let claudeProjectsRoot: string
  let dataRoot: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-summary-repo-'))
    webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-summary-web-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-summary-claude-'))
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-summary-data-'))
    await writeFile(path.join(webDistDir, 'index.html'), '<html></html>')
    const slugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
    await mkdir(slugDir, { recursive: true })
    await writeFile(path.join(slugDir, 'session-1.jsonl'), '')
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(webDistDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
    ])
  })

  /**
   * The options that make every check `ok` — the same set the "fully healthy machine"
   * case at the top of this file uses. Each test below moves exactly one lever off it,
   * so the status mix it produces is stated by the test rather than inherited.
   */
  const options = (overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) => ({
    path: repoPath,
    port: 0,
    exec: healthyExec,
    webDistDir,
    claudeProjectsRoot,
    dataRoot,
    nodeVersion: 'v22.5.0',
    rootPackageJsonPath: path.join(repoPath, 'does-not-exist.json'),
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
    ...overrides,
  })

  /** Present: `lane-manifest` is `ok`. Absent: it is the one `warn`. */
  const writeLaneManifest = async (): Promise<void> => {
    await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
    await writeFile(path.join(repoPath, '.swarm', 'lanes.json'), JSON.stringify({ version: 1, lanes: [] }))
  }

  /** Removes the built `index.html`, which is the one lever here that reaches a `fail`. */
  const breakWebBuild = (): Promise<void> => rm(path.join(webDistDir, 'index.html'))

  const WARN_ONLY_SUFFIX =
    ' warned — that is not the same as a clean run. Each [warn] line above says what is degraded and how to fix it.'

  /**
   * THE ASSERTION THE ISSUE CALLS THE ONE THAT MATTERS, AND IT IS THE NEGATIVE.
   *
   * `not.toContain('All required checks passed.')` reddens when the summary regresses to
   * SILENCE; asserting the new sentence reddens only on a REWORD. Both are here — the case
   * below is the positive — and the negative is not to be traded for it.
   */
  it('a report carrying a warning does not claim all required checks passed', async () => {
    const report = await runDoctor(options())

    expect(countOf(report, 'warn')).toBe(1)
    expect(countOf(report, 'fail')).toBe(0)

    expect(renderDoctorReport(report)).not.toContain('All required checks passed.')
    // The exit code is not this renderer's business and does not move (`FAILING_CHECK_IDS`).
    expect(report.exitCode).toBe(0)
  })

  it('…and names how many were flagged, as the final line', async () => {
    const report = await runDoctor(options())

    expect(countOf(report, 'warn')).toBe(1)
    expect(renderDoctorReport(report).split('\n').at(-1)).toBe(`No check failed, but 1 check${WARN_ONLY_SUFFIX}`)
  })

  it('two warns are counted as two, so the count is not a hard-coded one', async () => {
    const report = await runDoctor(options({ env: {} }))

    expect(countOf(report, 'warn')).toBe(2)
    expect(countOf(report, 'fail')).toBe(0)
    expect(renderDoctorReport(report).split('\n').at(-1)).toBe(`No check failed, but 2 checks${WARN_ONLY_SUFFIX}`)
  })

  /**
   * THE FALSE BRANCH OF THE WARN CLAUSE, WHICH IS WHERE #592's ONE SURVIVING MUTANT LIVED.
   *
   * Every failing case in that file drove a report carrying warns, so making the clause
   * unconditional left the whole suite green and "the old wording is preserved exactly"
   * was true of the code and asserted by nothing. A broken web build over an otherwise
   * healthy machine is the shape that reaches it here: one `fail`, no `warn`.
   */
  it('a failure with nothing warning keeps the line the doctor has always printed', async () => {
    await writeLaneManifest()
    await breakWebBuild()
    const report = await runDoctor(options())

    expect(countOf(report, 'fail')).toBe(1)
    expect(countOf(report, 'warn')).toBe(0)

    expect(renderDoctorReport(report).split('\n').at(-1)).toBe('1 check failed — fix these before rhizomorph can run.')
    expect(report.exitCode).toBe(1)
  })

  /**
   * The `fail` arm had the same silence the clean arm did, and it is the commoner report:
   * a machine that has never built the web bundle has usually never dispatched either. The
   * warn count is read off the report rather than retyped, so this asserts the summary
   * agrees with the lines above it rather than with a literal.
   */
  it('a report carrying both failures and warnings says both', async () => {
    await breakWebBuild()
    const report = await runDoctor(options())
    const warns = countOf(report, 'warn')

    expect(countOf(report, 'fail')).toBe(1)
    expect(warns).toBe(1)

    expect(renderDoctorReport(report).split('\n').at(-1)).toBe(
      `1 check failed — fix these before rhizomorph can run. ${warns} check also warned — ` +
        'each [warn] line above says what is degraded and how to fix it.',
    )
    expect(report.exitCode).toBe(1)
  })

  it('a clean report still ends in exactly "All required checks passed."', async () => {
    await writeLaneManifest()
    const report = await runDoctor(options())

    expect(report.checks.every((check) => check.status === 'ok')).toBe(true)
    expect(renderDoctorReport(report).split('\n').at(-1)).toBe('All required checks passed.')
  })
})

/**
 * THE SAMPLE RUN IN THE USER GUIDE IS WHERE THIS DEFECT WAS PUBLISHED (#603).
 *
 * `docs/user-guide/getting-started.md` pastes an elided run against this repo. It carries
 * a `[warn] no lane manifest …` line and used to close with `All required checks passed.`,
 * so the one page a stranger reads first taught them that a warning still means a clean
 * run. Nothing pinned that line, so nothing would have gone red.
 *
 * The expected sentence is RENDERED from a report built out of the block's own status
 * labels rather than retyped, which is what makes this a law rather than a second copy of
 * the string: reword the summary and this reddens, and paste a block whose closing line
 * disagrees with the lines above it and this reddens too. #592 did the same for the team
 * server runbook, under prd-51 ruling 12.
 */
describe('the getting-started sample block is the output this code produces', () => {
  const GUIDE = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'docs',
      'user-guide',
      'getting-started.md',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n')

  it('ends in the summary this code produces for its own status mix', () => {
    const start = GUIDE.indexOf('[ok  ] Node ')
    expect(start).toBeGreaterThan(-1)
    const block = GUIDE.slice(start, GUIDE.indexOf('```', start)).trimEnd()

    const BY_LABEL: Record<string, DoctorCheck['status']> = { 'ok  ': 'ok', warn: 'warn', FAIL: 'fail' }
    const statuses = [...block.matchAll(/^\[(ok {2}|warn|FAIL)\] /gm)].map(
      (match) => BY_LABEL[match[1] as string] as DoctorCheck['status'],
    )

    expect(statuses.length).toBeGreaterThan(1)
    expect(statuses, 'the premise: the sample is a run with no failure that still carries a warning').toContain('warn')
    expect(statuses).not.toContain('fail')

    const asReport: Report = {
      checks: statuses.map((status, index) => ({ id: `line-${index}`, status, message: 'x' })),
      exitCode: 0,
    }
    expect(block.split('\n').at(-1)).toBe(renderDoctorReport(asReport).split('\n').at(-1))
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

/**
 * THE BLAST RADIUS, held as a law rather than a grep I ran once — the issue's
 * own sibling case.
 *
 * `checkOptionalTool` is shared, and ruling 8 changed what its verdict MEANS:
 * absent is now `ok`. That is right for an enrichment and wrong for anything
 * the instrument actually needs. The reason it could be changed in place, with
 * no second function and no file outside the fence, is that every call site is
 * tmux or workmux — so this pins that, and a third tool routed through it
 * reddens here rather than silently inheriting a verdict nobody chose for it.
 */
describe('only enrichments go through checkOptionalTool (prd-57 ruling 8)', () => {
  const SERVER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full))
        continue
      }
      if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full)
    }
    return out
  }

  it('every call names tmux or workmux, and nothing else', () => {
    const calls = sourceFiles(SERVER_SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/checkOptionalTool\('([a-z-]+)'/g)].map((m) => m[1]!),
    )

    // The control first: a regex that matched nothing would make the set check
    // below pass vacuously, which is how a law like this stops biting.
    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect([...new Set(calls)].sort()).toEqual(['tmux', 'workmux'])
  })
})

describe('checkWatchedColonies — doctor names every colony (prd-58 ruling 1, #610)', () => {
  // `path.resolve`d, because `canonicalize` resolves before it walks: on
  // Windows a bare '/repo/main' becomes 'C:\repo\main', so an unresolved pin
  // and a resolved discovery would be two different colonies and this whole
  // suite would count one too many.
  const R = (p: string) => path.resolve(p)
  const PINNED = R('/repo/main')

  function actor(pid: number, worktreePath: string | null): AgentProcess {
    return {
      pid,
      dialect: 'claude',
      startedAt: 1_000,
      worktreePath,
      placement: worktreePath === null ? 'unknown' : 'rooted',
      parentPid: null,
      cpuMsDelta: null,
      rssBytes: null,
      seenAt: 1_000,
      goneAt: null,
      goneReason: null,
    }
  }

  /** A `git rev-parse --git-common-dir` that answers from a fixed table. */
  function execOver(table: Record<string, string>): Exec {
    return async (_cmd, _args, options) => {
      const root = table[options?.cwd ?? '']
      if (root === undefined) return { stdout: '', stderr: 'not a git repo', code: 128, failed: true }
      return { stdout: `${root}/.git`, stderr: '', code: 0, failed: false }
    }
  }

  it('names THREE colonies when agents are in three repos — Success 1 falsifier', async () => {
    // The whole criterion: "not met while any agent facts are discarded for
    // being outside a chosen repo". An operator cannot tell "watching three"
    // from "watching one and dropping two" except by a report that names them.
    const processes = {
      a: actor(1, R('/repo/main')),
      b: actor(2, R('/work/beta')),
      c: actor(3, R('/work/gamma')),
    }
    const checks = await checkWatchedColonies(
      processes,
      PINNED,
      execOver({ [R('/repo/main')]: R('/repo/main'), [R('/work/beta')]: R('/work/beta'), [R('/work/gamma')]: R('/work/gamma') }),
    )

    expect(checks[0]?.message).toBe('watching 3 colonies')
    const named = checks.filter((c) => c.id.startsWith('colony:')).map((c) => c.message)
    expect(named).toHaveLength(3)
    expect(named.join(' ')).toContain(R('/work/beta'))
    expect(named.join(' ')).toContain(R('/work/gamma'))
  })

  it('groups several worktrees of one repo into ONE colony', async () => {
    // A resolver answering with the worktree root would report three here, and
    // every other assertion in this file would still pass.
    const processes = { a: actor(1, R('/work/beta')), b: actor(2, R('/work/beta-wt/x')), c: actor(3, R('/work/beta-wt/y')) }
    const checks = await checkWatchedColonies(
      processes,
      PINNED,
      execOver({ [R('/work/beta')]: R('/work/beta'), [R('/work/beta-wt/x')]: R('/work/beta'), [R('/work/beta-wt/y')]: R('/work/beta') }),
    )

    // The pin, plus one for beta.
    expect(checks[0]?.message).toBe('watching 2 colonies')
  })

  it('names the pinned colony even with no agents anywhere', async () => {
    const checks = await checkWatchedColonies({}, PINNED, execOver({}))
    expect(checks[0]?.message).toBe('watching 1 colony')
    expect(checks[1]?.message).toContain('pinned')
    expect(checks[1]?.message).toContain('no agent placed here right now')
  })

  it('an agent in NO repository yields no colony, and is counted rather than dropped', async () => {
    // ADR-0010: the gap is declared. A shorter list with no explanation is the
    // reading that hides it.
    const checks = await checkWatchedColonies({ a: actor(1, R('/home/operator')) }, PINNED, execOver({}))
    expect(checks[0]?.message).toBe('watching 1 colony')
    expect(checks.some((c) => c.id === 'colonies:unplaced')).toBe(false)
  })

  it('states the WINDOWS gap when the witness could place nothing', async () => {
    // The platform yields a command line and not a working directory, so every
    // actor is unplaced and only the pin is found. Said out loud rather than
    // left as a short list nobody can account for.
    const checks = await checkWatchedColonies({ a: actor(1, null), b: actor(2, null) }, PINNED, execOver({}))
    const gap = checks.find((c) => c.id === 'colonies:unplaced')
    expect(gap?.message).toContain('2 agents')
    expect(gap?.message).toContain('could not place')
  })

  it('never fails the run — a colony report is a reading, not a gate', async () => {
    const checks = await checkWatchedColonies({ a: actor(1, null) }, PINNED, execOver({}))
    expect(checks.every((c) => c.status === 'ok')).toBe(true)
  })
})

describe('checkWatchedColonies counts agents where agents actually are (review of #621)', () => {
  let laneRoot: string
  let laneRepo: string
  let lane: string

  const actorInLane = (pid: number, worktreePath: string | null): AgentProcess => ({
    pid,
    dialect: 'claude',
    startedAt: 1,
    worktreePath,
    placement: worktreePath === null ? 'unknown' : 'rooted',
    parentPid: null,
    cpuMsDelta: null,
    rssBytes: null,
    seenAt: 1,
    goneAt: null,
    goneReason: null,
  })

  beforeAll(async () => {
    laneRoot = canonicalize(await mkdtemp(path.join(tmpdir(), 'rhizo-doctor-lane-')))
    laneRepo = path.join(laneRoot, 'repo')
    await mkdir(laneRepo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: laneRepo })
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: laneRepo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: laneRepo })
    await writeFile(path.join(laneRepo, 'f.txt'), 'v1\n')
    execFileSync('git', ['add', '.'], { cwd: laneRepo })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: laneRepo })
    // A LANE, laid out the way `git worktree add` normally does: OUTSIDE the
    // repo directory. This is where every agent this instrument watches works,
    // and it is the layout prd-57's own end-to-end fixture did not have.
    lane = path.join(laneRoot, 'worktrees', 'lane-a')
    execFileSync('git', ['worktree', 'add', '-q', lane, '-b', 'lane-a'], { cwd: laneRepo })
  }, 60_000)

  afterAll(async () => {
    await rm(laneRoot, { recursive: true, force: true })
  })

  it('an agent in a linked worktree is an agent placed in its colony', async () => {
    const checks = await checkWatchedColonies({ '1': actorInLane(1, lane) }, laneRepo, realExec)
    const row = checks.find((check) => check.id.startsWith('colony:'))
    // Before this fix the count was `actor.worktreePath === colony.path`, so a
    // colony discovered BECAUSE an agent was working in it reported zero.
    expect(row?.message).toContain('1 agent placed here')
    expect(row?.message).not.toContain('no agent placed here')
  }, 60_000)

  it('an agent at the repo root still counts, and two agents count as two', async () => {
    const checks = await checkWatchedColonies(
      { '1': actorInLane(1, lane), '2': actorInLane(2, laneRepo) },
      laneRepo,
      realExec,
    )
    const row = checks.find((check) => check.id.startsWith('colony:'))
    expect(row?.message).toContain('2 agents placed here')
  }, 60_000)

  it('an agent in no repository is still reported as unplaced, not as placed here', async () => {
    const checks = await checkWatchedColonies(
      { '1': actorInLane(1, lane), '2': actorInLane(2, null) },
      laneRepo,
      realExec,
    )
    expect(checks.find((check) => check.id.startsWith('colony:'))?.message).toContain('1 agent placed here')
    expect(checks.find((check) => check.id === 'colonies:unplaced')?.message).toContain('1 agent')
  }, 60_000)
})

/**
 * `runDoctor` PINS THE CANONICAL PATH — the third call site, which had no law
 * of either kind (#644).
 *
 * `cli/doctor.ts:289` canonicalises exactly as `cli/run.ts` does, because a
 * doctor reporting a different watched set from the server it is diagnosing is
 * the disagreement that check exists to make visible. Nothing asserted it.
 * `paths/canonical-call-sites.test.ts` reads the deciding line out of
 * `cli/run.ts` and `api/retarget.ts` and stops there; `repo-path-canonical.test.ts`
 * covers the helper and `run.ts`'s effect. Measured before this suite existed,
 * on macOS at `51e681cd`: reverting `cli/doctor.ts`'s pin to a bare
 * `path.resolve` reddened **nothing** across `cli/doctor.test.ts`,
 * `api/doctor.test.ts` and all of `src/paths` — 210 passed either way.
 *
 * **Why the 54 fixture repairs above cannot be this law.** They hand `runDoctor`
 * an already-canonical path, so `canonicalizeRepoPath` is a no-op on that input
 * and a revert passes all of them. They were never a witness: before the repair
 * they failed for encoding a raw path, not for asserting a canonical one, and
 * on Linux they passed without exercising the canonicalisation at all.
 *
 * So this suite MANUFACTURES the divergence with a symlink of its own instead
 * of borrowing the ambient one `os.tmpdir()` happens to have on macOS. That is
 * the whole difference between a law that bites on one platform and a law that
 * bites on every platform — on Linux the raw and canonical spellings of a temp
 * path are one string, so a fixture that leans on the platform is vacuous
 * there by construction.
 *
 * Both failure shapes the defect wears are covered, because they hide
 * differently:
 *   - the SLUG (`worktreePathToProjectSlug`) flattens the path into a directory
 *     name, so `-var-folders-…` against `-private-var-folders-…` is legible in
 *     a diff;
 *   - the DIGEST (`repoSlug`) folds it into eight hex characters, so every
 *     printed path is identical and only `…-a83137d0` against `…-5ef4ef53`
 *     moves. Grep the output for `private/var` and there are zero hits.
 */
describe('runDoctor pins the CANONICAL repo path, on every platform (prd-58 ruling 1, #644)', () => {
  let realRoot: string
  let realRepo: string
  let linkedRoot: string
  let linkedRepo: string
  let claudeProjectsRoot: string
  let webDistDir: string

  /**
   * Every data root the cases below mint, so `afterAll` can remove them.
   *
   * Each case needs its OWN — the digest case plants a session and the naming
   * case asserts first-run, so one shared root would make them order-dependent.
   * Minting them inline left them uncaptured and so unremoved: **36 directories
   * after twelve runs**, all three of these kinds and none of the four the
   * teardown already named. A suite that litters the machine running it is what
   * `packages/contract/src/retarget.contract.test.ts`'s own teardown comment
   * exists to prevent.
   */
  const dataRoots: string[] = []
  async function freshDataRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'rhizo-doctor-canon-data-'))
    dataRoots.push(dir)
    return dir
  }

  beforeAll(async () => {
    realRoot = canonicalize(await mkdtemp(path.join(tmpdir(), 'rhizo-doctor-canon-real-')))
    realRepo = path.join(realRoot, 'repo')
    await mkdir(realRepo, { recursive: true })

    // The macOS filesystem's own shape, built by hand so it exists on Linux and
    // Windows too: a symlink standing in front of the real directory.
    //
    // `mkdtemp` mints a fresh name every time; this one does not. Pids are
    // reused, and a run killed before `afterAll` leaves the link behind — so
    // the next `beforeAll` dies on EEXIST and takes the whole file with it.
    // Clearing first makes the fixture re-runnable; `force` keeps the ordinary
    // case, where nothing is there, silent.
    linkedRoot = path.join(tmpdir(), `rhizo-doctor-canon-link-${process.pid}`)
    await rm(linkedRoot, { force: true })
    await symlink(realRoot, linkedRoot)
    linkedRepo = path.join(linkedRoot, 'repo')

    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizo-doctor-canon-claude-'))
    webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizo-doctor-canon-web-'))
    await writeFile(path.join(webDistDir, 'index.html'), '<html></html>')
  }, 60_000)

  afterAll(async () => {
    // The symlink first, and WITHOUT `recursive`, so this unlinks the link
    // rather than walking through it into `realRoot`.
    await rm(linkedRoot, { force: true })
    await Promise.all([
      ...dataRoots.map((dir) => rm(dir, { recursive: true, force: true })),
      rm(realRoot, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
      rm(webDistDir, { recursive: true, force: true }),
    ])
  })

  it('CONTROL: the two spellings really do derive two different names, or every case below is vacuous', () => {
    // Without this, a platform that silently resolved the symlink at `path.join`
    // time would make the whole suite pass while proving nothing — which is the
    // exact failure mode the fixtures above were in.
    expect(linkedRepo).not.toBe(realRepo)
    expect(canonicalize(linkedRepo)).toBe(realRepo)
    // The two shapes the defect wears, both confirmed to actually differ here.
    expect(repoSlug(linkedRepo)).not.toBe(repoSlug(realRepo))
    expect(worktreePathToProjectSlug(linkedRepo)).not.toBe(worktreePathToProjectSlug(realRepo))

    // And the divergence is OURS, not the platform's. Both spellings sit under
    // the SAME canonical temp root, so nothing here turns on `/var` and
    // `/private/var` being two names for one directory — the only difference
    // between them is the symlink this suite created. That is precisely what
    // makes the three cases below redden on Linux, where the ambient tmpdir
    // symlink the five repaired fixtures above used to lean on does not exist.
    expect(realRoot.startsWith(CANONICAL_TMP_ROOT)).toBe(true)
    expect(linkedRoot.startsWith(CANONICAL_TMP_ROOT)).toBe(true)

    /**
     * THE ROOT IS ALREADY FULLY RESOLVED — the premise the three cases below
     * are platform-blind *because of*. Breaking it is not failing an
     * assertion; it is making this suite macOS-only. The cases would then be
     * riding the ambient `/var` → `/private/var` symlink again instead of the
     * one `beforeAll` builds: passing here, vacuous everywhere else, which is
     * the defect this issue exists to remove, reintroduced inside the law that
     * removes it.
     *
     * **What it uniquely catches, stated honestly.** For a plainly raw root
     * the two `startsWith` assertions above fire first — measured, both of
     * them, so for that case this is defence in depth and not the only net.
     * What it catches ALONE is a canonicalizer that does not agree with
     * itself: `canonicalize` applied twice answering differently than once.
     * `startsWith` is blind to that, because every path here would still share
     * the root. Not hypothetical — it is #228's shape, the macOS Node-version
     * disagreement `paths/containment.test.ts` simulates on purpose, and it is
     * precisely the condition under which `realpath` stops being trustworthy.
     *
     * It is also cheap to break by accident from the top of this very file:
     * the shadowed `tmpdir()` is four lines of easily-edited plumbing, and
     * `/var` against `/private/var` going unpinned is why 54 tests failed at
     * all (#644). Pinned here rather than argued.
     */
    expect(canonicalize(CANONICAL_TMP_ROOT)).toBe(CANONICAL_TMP_ROOT)
  })

  it('the SLUG shape: the session-log dir planted for the REAL path is found through the symlinked one', async () => {
    const realSlugDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(realRepo))
    await mkdir(realSlugDir, { recursive: true })
    await writeFile(path.join(realSlugDir, 'session-1.jsonl'), '')

    const report = await runDoctor({
      path: linkedRepo, // what the operator typed
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot: await freshDataRoot(),
    })

    const logs = checkFor(report.checks, 'session-logs')
    // A raw pin looks under `…/-var-folders-…-repo`, which nothing created, and
    // this warns instead — on Linux and macOS alike.
    expect(logs.status).toBe('ok')
    expect(logs.message).toContain(realSlugDir)
    expect(logs.message).not.toContain(worktreePathToProjectSlug(linkedRepo))
  })

  it('the DIGEST shape: the session recorded under the REAL path resumes through the symlinked one', async () => {
    const dataRoot = await freshDataRoot()
    // Planted under the REAL spelling's digest. `repoSlug` is a sha1 of the
    // path, so this directory name and the one a raw pin computes differ in
    // eight hex characters and in nothing else that is printed anywhere.
    const realSessionDir = sessionDirFor(realRepo, dataRoot)
    await new SessionLogWriter(sessionFilePath(realSessionDir, '1000')).append(
      createEvent('session.started', { sessionId: '1000', repoPath: realRepo, repoName: 'repo' }, { id: 'evt-1', ts: 1000 }),
    )

    const report = await runDoctor({
      path: linkedRepo,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot,
      now: () => 1000 + 5000, // inside the resume window
    })

    const boundary = checkFor(report.checks, 'session-boundary')
    expect(boundary.status).toBe('ok')
    // A raw pin keys on `repoSlug(linkedRepo)`, finds an empty directory, and
    // reports first-run — so this exact sentence is what the digest buys.
    expect(boundary.message).toContain('session 1000 would resume')
    expect(boundary.message).not.toContain('no rhizomorph session recorded yet')
  })

  it('the report NAMES the canonical spelling, never the symlinked one it was handed', async () => {
    const report = await runDoctor({
      path: linkedRepo,
      port: 0,
      exec: healthyExec,
      webDistDir,
      claudeProjectsRoot,
      dataRoot: await freshDataRoot(),
    })

    // An operator reading this report must be able to compare it to the server's
    // own boot line without doing symlink arithmetic in their head.
    const boundary = checkFor(report.checks, 'session-boundary')
    expect(boundary.message).toContain(`no rhizomorph session recorded yet for ${realRepo}`)
    expect(boundary.message).not.toContain(linkedRoot)
  })
})
