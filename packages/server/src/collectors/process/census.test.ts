import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalize } from '../../paths/containment.js'
import { takeCensus } from './census.js'
import type { ProcessRow, ProcessTableReading } from './read-table.js'

/**
 * THE CENSUS — prd-58 ruling 1's machine-wide reading (#645).
 *
 * The property that matters, and the one no per-repo fixture can see: **the
 * census is not narrowed to any repo at all.** Discovery's whole job is to find
 * repos nobody named, so a census that had already filtered by one would make
 * the question circular.
 */

let root: string
const roots: string[] = []

beforeEach(() => {
  root = canonicalize(mkdtempSync(path.join(tmpdir(), 'rhizo-census-')))
  roots.push(root)
  mkdirSync(path.join(root, 'alpha'), { recursive: true })
  mkdirSync(path.join(root, 'beta'), { recursive: true })
})

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const noExec: Exec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

function row(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid: 100,
    argv: ['claude'],
    cwd: path.join(root, 'alpha'),
    startedAt: 1_788_000_000_000,
    cpuMs: 1,
    rssBytes: 1,
    parentPid: 1,
    ...overrides,
  }
}

function readerFor(reading: ProcessTableReading | null) {
  return async () => reading
}

const census = (rows: ProcessRow[]) => takeCensus(noExec, { readTable: readerFor({ rows }) })

describe('takeCensus — every agent on the machine, wherever it is', () => {
  it('reports agents in DIFFERENT repos, which is the whole point', async () => {
    // A census narrowed to one repo is the defect: discovery could then only
    // ever confirm the repo it was already watching.
    const sightings = await census([
      row({ pid: 1, cwd: path.join(root, 'alpha') }),
      row({ pid: 2, cwd: path.join(root, 'beta') }),
    ])

    expect(sightings?.map((s) => s.worktreePath).sort()).toEqual(
      [path.join(root, 'alpha'), path.join(root, 'beta')].sort(),
    )
  })

  it('a process that is NOT an agent is absent — both arms, or this asserts nothing', async () => {
    // "The census contains the agent" passes for a census that returns every
    // process on the machine. The second arm is what makes it a claim.
    const sightings = await census([
      row({ pid: 1, argv: ['claude'] }),
      row({ pid: 2, argv: ['vim', 'claude.md'] }),
      row({ pid: 3, argv: ['bash', '-lc', 'claude'] }),
    ])

    expect(sightings?.map((s) => s.pid)).toEqual([1])
  })

  it('names the dialect, so a reader can tell a claude from a codex', async () => {
    const sightings = await census([row({ pid: 1, argv: ['codex'] }), row({ pid: 2, argv: ['/usr/bin/node', 'claude'] })])
    expect(sightings?.map((s) => s.dialect)).toEqual(['codex', 'claude'])
  })

  it('canonicalises the cwd, because the resolver compares it by string equality', async () => {
    // Built by concatenation, NOT `path.join`: join collapses `..` itself, so a
    // fixture built with it hands the census an already-canonical path and
    // passes for a `canonicalCwdOf` that returns its argument untouched. Review
    // caught exactly that — the first version of this test asserted nothing.
    const indirect = `${path.join(root, 'alpha')}${path.sep}..${path.sep}alpha`
    expect(indirect).not.toBe(path.join(root, 'alpha')) // the control: it really is un-normalised

    const sightings = await census([row({ cwd: indirect })])
    expect(sightings?.[0]?.worktreePath).toBe(path.join(root, 'alpha'))
  })

  it('an agent the platform reports NO cwd for is a sighting with no path, never a dropped agent', async () => {
    // Windows reaches this for every process. The actor is real and its
    // placement is what is unknown — `doctor` counts these to state the gap,
    // and dropping them would turn a declared blindness into a silent zero.
    const sightings = await census([row({ pid: 7, cwd: null })])
    expect(sightings).toEqual([{ pid: 7, dialect: 'claude', worktreePath: null }])
  })

  it('a cwd that cannot be resolved is null rather than a throw out of the census', async () => {
    // A NUL byte makes `realpath` throw on every platform, which is the point:
    // the census must survive a row it cannot resolve rather than taking the
    // whole tick down with it. Built with `String.fromCharCode` rather than
    // written literally — `scripts/gate.sh` guards against a raw NUL in a
    // source file, and the first draft of this line put one there.
    const unresolvable = path.join(root, 'alpha', `${String.fromCharCode(0)}bad`)
    const sightings = await census([row({ pid: 9, cwd: unresolvable })])
    expect(sightings).toHaveLength(1)
    expect(sightings?.[0]?.worktreePath).toBeNull()
  })

  it('a table this build cannot read is NULL, and emphatically not an empty machine', async () => {
    // The process leg's third law. A caller that collapsed the two would retire
    // every colony on one unreadable tick.
    expect(await takeCensus(noExec, { readTable: readerFor(null) })).toBeNull()
    expect(await census([])).toEqual([])
  })
})

describe('the sweep reads the census — a source law, because no unit test sees the wiring', () => {
  /**
   * `cli/run.ts`'s colony sweep is a `setInterval` inside a boot function, and
   * nothing in this suite can reach it. So the defect it carried was invisible
   * to every test: `discover(Object.values(recorder.foldSoFar().processes))`
   * type-checks, runs, and answers "one colony" forever.
   *
   * This asserts the SOURCE, which is the weaker claim honestly made rather
   * than a behavioural one faked. It fails for exactly one edit — pointing the
   * sweep back at a colony's own fold — which is the edit that would restore
   * the bug.
   */
  const runSource = readFileSync(new URL('../../cli/run.ts', import.meta.url), 'utf8')

  it('hands discovery the census, not a fold', () => {
    expect(runSource).toContain('discovery.discover(census)')
  })

  it('and the collector is actually asked to publish one — the law that was missing', () => {
    /**
     * Review's sharpest finding: every other assertion here survives deleting
     * `census = sightings` from the collector's config. `census` would stay `[]`
     * for the life of the process, `discovery.discover(census)` would still be
     * the source text, and the watched set would be the pin forever — the exact
     * defect, with the law green above it.
     */
    const wiring = runSource.slice(runSource.indexOf('const collectors ='), runSource.indexOf('const pollLoop ='))
    expect(wiring).toContain('onCensus:')
    expect(wiring).toContain('census = sightings')
  })

  it('and no longer derives the watched set from any recorder fold', () => {
    // The circular question: a repo was discoverable only once an actor in it
    // had been recorded, and it was recorded only once its repo had been
    // discovered.
    const sweep = runSource.slice(runSource.indexOf('const syncColonies'), runSource.indexOf('const colonySweep'))
    expect(sweep).not.toContain('foldSoFar')
  })

  it('doctor asks the same question of the same reading, not of a fold', () => {
    // `checkWatchedColonies`'s own docblock: `doctor` and the running
    // instrument disagreeing about which repos are watched is the class of
    // defect prd-27's "assembled once" exists to prevent. Its unit tests take a
    // census as an argument, so nothing else notices if the caller goes back to
    // handing it `attention.processes`.
    const doctorSource = readFileSync(new URL('../../cli/doctor.ts', import.meta.url), 'utf8')
    expect(doctorSource).toContain('checkWatchedColonies(await takeCensus(')
    expect(doctorSource).not.toContain('checkWatchedColonies(attention.processes')
  })

  it('and the control: the sweep this reads is really there', () => {
    // Without this, both assertions above pass against a `run.ts` that has been
    // renamed, moved or emptied — a law asserting the absence of a string is
    // vacuous the moment the file it reads stops containing anything.
    expect(runSource).toContain('const syncColonies')
    expect(runSource).toContain('const colonySweep')
    expect(runSource).toContain('const collectors =')
    expect(runSource).toContain('const pollLoop =')
  })
})
