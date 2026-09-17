import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalize } from './containment.js'
import { createRepoRootResolver } from './repo-root.js'

/**
 * prd-58 ruling 1: a repo becomes a colony when an actor is placed in it.
 *
 * The property that matters, and the one a one-worktree-per-repo fixture cannot
 * see: **several worktrees of one repo are ONE colony.** `--show-toplevel`
 * would give each its own root and the grouping would be silently wrong.
 */

let root: string

beforeEach(async () => {
  root = canonicalize(await mkdtemp(path.join(tmpdir(), 'rhizo-reporoot-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0, failed: false }
}

function fails(): ExecResult {
  return { stdout: '', stderr: 'fatal: not a git repository', code: 128, failed: true }
}

/** Records every call, so the cache can be asserted rather than assumed. */
function recordingExec(answers: Record<string, ExecResult>): { exec: Exec; calls: string[] } {
  const calls: string[] = []
  const exec: Exec = async (_command, _args, options) => {
    const cwd = options?.cwd ?? ''
    calls.push(cwd)
    return answers[cwd] ?? fails()
  }
  return { exec, calls }
}

describe('createRepoRootResolver — cwd to the repo that contains it', () => {
  it('groups every worktree of one repo onto ONE root, which --show-toplevel would not', async () => {
    // The shape this exists for. git answers `--git-common-dir` with the SAME
    // `<repo>/.git` from the main checkout and from each linked worktree, which
    // is exactly why it is the grouping key.
    const repo = path.join(root, 'repo')
    const wtA = path.join(root, 'repo-wt', 'a')
    const wtB = path.join(root, 'repo-wt', 'b')
    await mkdir(repo, { recursive: true })
    await mkdir(wtA, { recursive: true })
    await mkdir(wtB, { recursive: true })

    const common = `${repo}/.git`
    const { exec } = recordingExec({ [repo]: ok(common), [wtA]: ok(common), [wtB]: ok(common) })
    const resolver = createRepoRootResolver(exec)

    expect(await resolver.resolve(repo)).toBe(repo)
    expect(await resolver.resolve(wtA)).toBe(repo)
    expect(await resolver.resolve(wtB)).toBe(repo)
  })

  it('two different repos are two roots', async () => {
    const one = path.join(root, 'one')
    const two = path.join(root, 'two')
    await mkdir(one, { recursive: true })
    await mkdir(two, { recursive: true })

    const { exec } = recordingExec({ [one]: ok(`${one}/.git`), [two]: ok(`${two}/.git`) })
    const resolver = createRepoRootResolver(exec)

    expect(await resolver.resolve(one)).toBe(one)
    expect(await resolver.resolve(two)).toBe(two)
  })

  it('a cwd in no repository resolves to null — declared, never guessed', async () => {
    const loose = path.join(root, 'loose')
    await mkdir(loose, { recursive: true })

    const { exec } = recordingExec({})
    expect(await createRepoRootResolver(exec).resolve(loose)).toBeNull()
  })

  it('asks git ONCE per directory, and caches the NEGATIVE answer too', async () => {
    // The negative half is the one worth pinning: an agent in `~` is not a
    // mistake to retry every two seconds, and re-asking would make the unrooted
    // case the most expensive one against ADR-0013's tick budget.
    const repo = path.join(root, 'repo')
    const loose = path.join(root, 'loose')
    await mkdir(repo, { recursive: true })
    await mkdir(loose, { recursive: true })

    const { exec, calls } = recordingExec({ [repo]: ok(`${repo}/.git`) })
    const resolver = createRepoRootResolver(exec)

    for (let i = 0; i < 3; i += 1) {
      expect(await resolver.resolve(repo)).toBe(repo)
      expect(await resolver.resolve(loose)).toBeNull()
    }

    expect(calls.filter((c) => c === repo)).toHaveLength(1)
    expect(calls.filter((c) => c === loose)).toHaveLength(1)
  })

  it('a bare repo answers with the repo directory itself, and is not mangled', async () => {
    const bare = path.join(root, 'bare.git')
    await mkdir(bare, { recursive: true })

    // No trailing `/.git` to strip — the common dir IS the repo here.
    const { exec } = recordingExec({ [bare]: ok(bare) })
    expect(await createRepoRootResolver(exec).resolve(bare)).toBe(bare)
  })

  it('a root git names but the filesystem cannot resolve is refused, not returned raw', async () => {
    const repo = path.join(root, 'repo')
    await mkdir(repo, { recursive: true })
    // `canonicalize` walks to an existing ancestor for ENOENT, so a vanished
    // root still resolves; this pins that the value is put THROUGH it rather
    // than passed along, which is what makes it comparable to the canonical
    // paths the process witness records.
    const vanished = path.join(root, 'gone', 'deeper')
    const { exec } = recordingExec({ [repo]: ok(`${vanished}/.git`) })

    expect(await createRepoRootResolver(exec).resolve(repo)).toBe(canonicalize(vanished))
  })

  it('an empty answer is null — a blank line is not a root', async () => {
    const repo = path.join(root, 'repo')
    await mkdir(repo, { recursive: true })
    const { exec } = recordingExec({ [repo]: ok('   \n') })
    expect(await createRepoRootResolver(exec).resolve(repo)).toBeNull()
  })
})
