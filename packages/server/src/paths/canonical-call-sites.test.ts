import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE CALL SITES, not only the helper.
 *
 * Its own file rather than a block inside `repo-path-canonical.test.ts`,
 * because that suite builds a symlink and **skips entirely on Windows**, where
 * creating one needs elevation. A law that disappears on a platform is a law
 * with a hole the size of that platform — and these assertions need no symlink
 * at all, only the one line each file uses to decide.
 */
describe('the CALL SITE, not only the helper (review of the review of #621)', () => {
  /**
   * Reverting `cli/run.ts`'s pin to `path.resolve` reddened **nothing**, across
   * every suite. The cases above prove the helper resolves a symlink and prove
   * a raw pin splits a repo in two — and neither asserts that the boot calls
   * the helper. That is the shape this PRD has met at every size: an assertion
   * about a well-formed input standing in for one that something reads it.
   *
   * Booting a server against a symlinked repo to prove it end to end is heavy
   * and slow; reading the one line that decides it is cheap and exact. So this
   * is a source law, with a control, rather than a pretend integration test.
   */
  const RUN_TS = path.join(import.meta.dirname, '..', 'cli', 'run.ts')

  it('`cli/run.ts` pins through canonicalizeRepoPath, never a bare path.resolve', () => {
    const source = readFileSync(RUN_TS, 'utf8')
    const pin = source.split('\n').find((line) => /^\s*const repoPath =/.test(line))
    expect(pin, 'cli/run.ts no longer has a `const repoPath =` pin — this law has lost its subject').toBeDefined()
    expect(pin).toContain('canonicalizeRepoPath(')
  })

  it('CONTROL: the law catches the raw form it exists to refuse', () => {
    // A hole nothing currently falls into is still a hole, and a control that
    // waits for the regression is not a control.
    const raw = '  const repoPath = path.resolve(args.path ?? process.cwd())'
    expect(/^\s*const repoPath =/.test(raw)).toBe(true)
    expect(raw).not.toContain('canonicalizeRepoPath(')
  })

  it('`api/retarget.ts` compares canonical spellings on BOTH sides', () => {
    // The same gap, one file over: reverting retarget's comparison to a raw
    // `path.resolve` also reddened nothing.
    const source = readFileSync(path.join(import.meta.dirname, '..', 'api', 'retarget.ts'), 'utf8')
    const requested = source.split('\n').find((line) => line.includes('const requestedPath ='))
    expect(requested).toContain('canonicalizeRepoPath(')
    // And the other side of the comparison, which is the half a one-sided fix
    // would leave behind.
    expect(source).toMatch(/requestedPath !== canonicalizeRepoPath\(/)
  })
})
