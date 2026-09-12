import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The law for `scripts/pr-verdict.sh` — the mark a PR carries once GitHub
 * Actions is off and `scripts/ci-local.sh` is the only leg that runs.
 *
 * The thing being guarded is not "does it call gh". It is that the mark cannot
 * outlive the tree it was measured on. A LABEL is repo-level and pins to
 * nothing, so on its own "Passed local CI" keeps claiming a green leg for
 * every commit pushed after it; the COMMIT STATUS is per-sha and goes quiet on
 * the next push, which is what makes the pair honest. Three refusals hold the
 * rest — a PR that is not open, a HEAD that is not the PR's head sha, and a
 * dirty working tree each make the verdict belong to a different tree than the
 * one a reviewer will read.
 *
 * Driven for real with `spawnSync` against a scratch git repo and a stubbed
 * `gh` on PATH, the way `windows-suite-law.test.ts` drives
 * `scripts/windows-triage.sh` — a law that only grepped the script's text
 * would pass over a script whose guards had been reordered after the post.
 *
 * The stub records every argv it is handed, so the assertions are on what
 * would actually have reached GitHub, and a refusal is proven by an EMPTY log
 * rather than by an exit code alone: an exit 2 after the status was already
 * posted is the failure this shape catches.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'pr-verdict.sh')
const CI_LOCAL_PATH = path.join(REPO_ROOT, 'scripts', 'ci-local.sh')

/**
 * The label literal, stated once here and held against both scripts below.
 * It is also a live tracker object: renaming it in the script without renaming
 * it on GitHub leaves `gh pr edit --add-label` failing on every green run.
 */
const LABEL = 'Passed local CI'

interface Scratch {
  /** The scratch git repo the script runs in. Clean, one commit. */
  repo: string
  /** `bin/` and the gh log, deliberately OUTSIDE `repo` — the harness's own
   * files inside it would read as a dirty tree and refuse every case. */
  bin: string
  sha: string
  ghLog: string
}

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A one-commit git repo with a stubbed `gh` on PATH, standing in for a lane worktree. */
function scratch(): Scratch {
  const root = mkdtempSync(path.join(tmpdir(), 'pr-verdict-law-'))
  made.push(root)
  const dir = path.join(root, 'repo')
  mkdirSync(dir)

  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'law@example.invalid')
  git('config', 'user.name', 'Law')
  writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
  git('add', 'tracked.txt')
  git('commit', '--quiet', '-m', 'one')
  const sha = git('rev-parse', 'HEAD').trim()

  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const ghLog = path.join(root, 'gh.log')
  // Every invocation is appended verbatim before anything is answered, so the
  // log is a record of what the script tried to do and not of what succeeded.
  writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf "%s %s\\n" "$STUB_STATE" "$STUB_HEAD"; exit 0; fi',
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then printf "%s\\n" "$STUB_REPO"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(path.join(bin, 'gh'), 0o755)
  writeFileSync(ghLog, '')

  return { repo: dir, bin, sha, ghLog }
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
  /** Every `gh` argv the script produced, in order. Empty means it reported nothing. */
  gh: string[]
}

function run(s: Scratch, args: string[], stub: { state?: string; head?: string } = {}): Run {
  const env = {
    ...process.env,
    PATH: `${s.bin}${path.delimiter}${process.env.PATH ?? ''}`,
    GH_LOG: s.ghLog,
    STUB_STATE: stub.state ?? 'OPEN',
    STUB_HEAD: stub.head ?? s.sha,
    STUB_REPO: 'launchpad-26/rhizomorph',
  }
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], { cwd: s.repo, encoding: 'utf8', env })
  const log = readFileSync(s.ghLog, 'utf8').trim()
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, gh: log === '' ? [] : log.split('\n') }
}

/** The `gh api … statuses/<sha>` line, or undefined when none was attempted. */
function statusPost(r: Run): string | undefined {
  return r.gh.find((line) => line.includes('/statuses/'))
}

describe('pr-verdict law: preflight refuses anything it cannot stand behind', () => {
  it('a clean tree at the PR head passes, and echoes the sha it pinned', () => {
    const s = scratch()
    const r = run(s, ['preflight', '7'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(s.sha)
  })

  it('a dirty working tree refuses — the leg would measure a tree the sha does not name', () => {
    const s = scratch()
    writeFileSync(path.join(s.repo, 'tracked.txt'), 'two\n')
    const r = run(s, ['preflight', '7'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('dirty')
    expect(r.stderr).toContain('tracked.txt')
  })

  it('an untracked file is dirt too — a new source file is exactly what a green leg would be lying about', () => {
    const s = scratch()
    writeFileSync(path.join(s.repo, 'untracked.ts'), 'export const x = 1\n')
    const r = run(s, ['preflight', '7'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('dirty')
  })

  it('a HEAD that is not the PR head refuses, and names both shas', () => {
    const other = 'a'.repeat(40)
    const s = scratch()
    const r = run(s, ['preflight', '7'], { head: other })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(s.sha)
    expect(r.stderr).toContain(other)
  })

  it('a PR that is not open refuses — a verdict on a merged PR marks nothing anyone reads', () => {
    const s = scratch()
    for (const state of ['MERGED', 'CLOSED']) {
      const r = run(s, ['preflight', '7'], { state })
      expect(r.status, `state=${state}`).not.toBe(0)
      expect(r.stderr).toContain(state)
    }
  })

  it('a headRefOid that is not a sha refuses rather than comparing HEAD against a word', () => {
    const s = scratch()
    const r = run(s, ['preflight', '7'], { head: 'null' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('headRefOid')
  })
})

describe('pr-verdict law: the two marks, and which of them is pinned to a commit', () => {
  it('pass posts a success status ON THE HEAD SHA and adds the label', () => {
    const s = scratch()
    const r = run(s, ['report', '7', 'pass', 'green on Darwin'])
    expect(r.status, r.stderr).toBe(0)

    const post = statusPost(r)
    expect(post).toBeDefined()
    // The sha is in the URL, not a field: this is the half that cannot go
    // stale, and it is stale-proof only because the path names the commit.
    expect(post).toContain(`repos/launchpad-26/rhizomorph/statuses/${s.sha}`)
    expect(post).toContain('state=success')
    expect(post).toContain('description=green on Darwin')

    expect(r.gh.some((line) => line === `pr edit 7 --add-label ${LABEL}`)).toBe(true)
    expect(r.gh.some((line) => line.includes('--remove-label'))).toBe(false)
  })

  it('the status context names the platform, so the two legs nobody ran are visible as silence', () => {
    const s = scratch()
    const r = run(s, ['report', '7', 'pass', 'green'])
    const post = statusPost(r)
    const platform = execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim()
    expect(post).toContain(`context=local-ci (${platform})`)
  })

  it('fail posts a failure status and CLEARS the label — a stale green is the lie the pair exists to stop', () => {
    const s = scratch()
    const r = run(s, ['report', '7', 'fail', 'red on Darwin: Test'])
    expect(r.status, r.stderr).toBe(0)
    expect(statusPost(r)).toContain('state=failure')
    expect(r.gh.some((line) => line === `pr edit 7 --remove-label ${LABEL}`)).toBe(true)
    expect(r.gh.some((line) => line.includes('--add-label'))).toBe(false)
  })

  it('report re-runs preflight: a tree dirtied DURING the leg posts nothing at all', () => {
    const s = scratch()
    writeFileSync(path.join(s.repo, 'tracked.txt'), 'edited mid-run\n')
    const r = run(s, ['report', '7', 'pass', 'green'])
    expect(r.status).not.toBe(0)
    // Not just a non-zero exit — nothing reached GitHub beyond the read.
    expect(statusPost(r)).toBeUndefined()
    expect(r.gh.some((line) => line.includes('--add-label'))).toBe(false)
  })

  it('a description longer than GitHub accepts is cut, not 422d away with the leg green', () => {
    const s = scratch()
    const r = run(s, ['report', '7', 'pass', 'x'.repeat(300)])
    expect(r.status, r.stderr).toBe(0)
    const description = statusPost(r)?.match(/description=(x+)/)?.[1] ?? ''
    expect(description.length).toBe(140)
  })

  it('an unknown verdict word refuses instead of guessing which way it meant', () => {
    const s = scratch()
    const r = run(s, ['report', '7', 'green', 'whatever'])
    expect(r.status).not.toBe(0)
    expect(statusPost(r)).toBeUndefined()
  })
})

describe('pr-verdict law: ci-local.sh cannot publish a verdict wider than the leg it ran', () => {
  function ciLocal(s: Scratch, args: string[]): Run {
    const env = {
      ...process.env,
      PATH: `${s.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_LOG: s.ghLog,
      STUB_STATE: 'OPEN',
      STUB_HEAD: s.sha,
      STUB_REPO: 'launchpad-26/rhizomorph',
    }
    // cwd is the real repo — ci-local.sh cds to its own toplevel regardless —
    // but every case here exits during argument handling, before npm runs.
    const r = spawnSync('bash', [CI_LOCAL_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 30_000 })
    const log = readFileSync(s.ghLog, 'utf8').trim()
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, gh: log === '' ? [] : log.split('\n') }
  }

  it.each(['--no-install', '--no-pack-smoke'])('--pr with %s is refused before a single step runs', (skip) => {
    const s = scratch()
    const r = ciLocal(s, ['--pr', '7', skip])
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toContain('FULL leg')
    expect(r.gh).toEqual([])
    // The refusal is an argument check, not a late one: nothing was built.
    expect(r.stdout).not.toContain('Build')
  })

  it('--pr with no number is refused rather than swallowing the next flag as one', () => {
    const s = scratch()
    const r = ciLocal(s, ['--pr'])
    expect(r.status).toBe(2)
    expect(r.gh).toEqual([])
  })
})

describe('pr-verdict law: the label literal is stated in one place', () => {
  const verdict = readFileSync(SCRIPT_PATH, 'utf8')
  const ciLocal = readFileSync(CI_LOCAL_PATH, 'utf8')

  it('pr-verdict.sh assigns exactly this label, and assigns it once', () => {
    expect([...verdict.matchAll(/^LABEL="(.*)"$/gm)].map((m) => m[1])).toEqual([LABEL])
  })

  it("ci-local.sh's own help names the same label, so the two files cannot drift apart", () => {
    expect(ciLocal).toContain(`"${LABEL}"`)
  })
})
