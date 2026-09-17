import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentProcess } from '@rhizomorph/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalize } from '../paths/containment.js'
import { createRepoRootResolver } from '../paths/repo-root.js'
import { createColonyDiscovery } from './colonies.js'
import { exec as realExec } from './exec.js'

/**
 * THE PER-COLONY COST OF DISCOVERY — prd-58 ruling 7 and Success 7.
 *
 * > The per-colony tick cost is measured on a machine watching at least three
 * > repos, and the support envelope names a watched-repo ceiling with a number
 * > behind it. **Not met while the ceiling is reasoned rather than measured.**
 *
 * Reported, never asserted as a threshold — the same posture as
 * `reduce.bench.test.ts`. A number that fails a build on a slow runner teaches
 * everyone to raise the number; a number printed every run is one somebody
 * reads.
 *
 * **What this measures and what it does not.** It measures DISCOVERY: turning a
 * process table into a watched set, which is the only per-colony cost this PRD
 * adds to a tick. It does not measure the collectors themselves, because those
 * are unchanged — ruling 2 gives each colony its own poll loop rather than
 * teaching one loop to count, so a colony's collector cost is exactly the
 * one-repo cost this instrument has always paid, N times. That is the honest
 * frame for the ceiling: **N colonies cost N instruments plus this.**
 *
 * Three real repositories and a linked worktree, built here rather than assumed
 * on the host, so the grouping claim is exercised by the measurement and not
 * only by the unit tests — and so the soak is one anybody can repeat.
 */

let root: string
let dirs: string[]

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function actorAt(pid: number, worktreePath: string): AgentProcess {
  return {
    pid,
    dialect: 'claude',
    startedAt: 1,
    worktreePath,
    placement: 'rooted',
    parentPid: null,
    cpuMsDelta: null,
    rssBytes: null,
    seenAt: 1,
    goneAt: null,
    goneReason: null,
  }
}

beforeAll(async () => {
  // CANONICAL, like the pin `cli/run.ts` hands discovery. `os.tmpdir()` is a
  // symlink on macOS (`/var/...` → `/private/var/...`), and the root resolver
  // canonicalises — so a raw spelling here makes `alpha` both the pin and a
  // separately discovered colony, and the grouping assertion below sees FOUR.
  // Green on Linux, red on macOS, for a reason that is not about this bench.
  // `repo-root.test.ts` and `e2e-prd5758.test.ts` already do this.
  root = canonicalize(await mkdtemp(path.join(tmpdir(), 'prd58-soak-')))
  for (const name of ['alpha', 'beta', 'gamma']) {
    const dir = path.join(root, name)
    await mkdir(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'f.txt'), 'v1\n')
    git(dir, ['add', '.'])
    git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  }
  // A linked worktree of alpha: four cwds, three colonies.
  git(path.join(root, 'alpha'), ['worktree', 'add', '-q', path.join(root, 'alpha-wt'), '-b', 'side'])
  dirs = [path.join(root, 'alpha'), path.join(root, 'alpha-wt'), path.join(root, 'beta'), path.join(root, 'gamma')]
}, 60_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('colony discovery — the per-tick cost of watching N repos (prd-58 ruling 7)', () => {
  it('reports the cold and warm cost over three colonies, and pins the grouping', async () => {
    const actors = dirs.map((dir, i) => actorAt(9_000 + i, dir))
    const discovery = createColonyDiscovery({
      pinnedRepoPath: path.join(root, 'alpha'),
      resolver: createRepoRootResolver(realExec),
    })

    // COLD: first sighting of each cwd — one `git` per distinct directory, and
    // the only tick that spawns any.
    const coldStart = process.hrtime.bigint()
    const colonies = await discovery.discover(actors)
    const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6

    // WARM: the steady state. Every cwd is resolved, so this is what the
    // instrument actually pays on every tick after the first sighting.
    const warm: number[] = []
    for (let i = 0; i < 200; i += 1) {
      const start = process.hrtime.bigint()
      await discovery.discover(actors)
      warm.push(Number(process.hrtime.bigint() - start) / 1e6)
    }
    warm.sort((a, b) => a - b)
    const at = (q: number) => warm[Math.min(warm.length - 1, Math.floor(warm.length * q))] ?? 0

    const INTERVAL_MS = 2_000
    // A bench reports; this is its output. `noConsole` is not enabled for test
    // files, so a suppression here is one biome itself flags as having no effect.
    console.log(
      [
        `prd-58 discovery · ${colonies.length} colonies from ${dirs.length} placed actors (one linked worktree)`,
        `  cold (first sighting, ${dirs.length} git calls): ${coldMs.toFixed(2)} ms`,
        `  warm, 200 ticks: p50 ${at(0.5).toFixed(4)} ms · p95 ${at(0.95).toFixed(4)} ms · max ${(warm.at(-1) ?? 0).toFixed(4)} ms`,
        `  warm p95 as a share of the ${INTERVAL_MS} ms interval: ${((at(0.95) / INTERVAL_MS) * 100).toFixed(4)}%`,
        '  NOT measured here: the collectors themselves. Ruling 2 gives each colony its own',
        '  poll loop, so a colony costs one instrument. N colonies cost N instruments plus the above.',
      ].join('\n'),
    )

    // THE GROUPING, measured rather than only unit-tested: four placed actors,
    // one of them in a linked worktree, and three colonies.
    expect(colonies).toHaveLength(3)
    expect(colonies.map((c) => path.basename(c.path)).sort()).toEqual(['alpha', 'beta', 'gamma'])

    // The cache is what makes the warm number the real one. Not a threshold —
    // a factor, so a slow runner cannot redden it while a cache regression
    // (which would put a `git` spawn back on every tick) still would.
    expect(at(0.5)).toBeLessThan(coldMs)
  }, 120_000)
})
