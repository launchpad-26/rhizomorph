import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGitLog } from './parse-log.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/log/${name}`, import.meta.url), 'utf8')
}

describe('parseGitLog', () => {
  it('parses commits with modified, added and deleted files plus diffstat', () => {
    const { commits } = parseGitLog(fixture('feature-alpha.txt'))

    expect(commits).toHaveLength(2)

    expect(commits[0]).toEqual({
      sha: 'cc021f427ba6c9d563d90964a9e1e0696048a367',
      shortSha: 'cc021f4',
      author: { name: 'Ada Dev', email: 'dev@example.com' },
      authoredAt: 1785359400000,
      parents: ['d129e8d9ede5050302a93cd9d66ccadad0f2713d'],
      subject: 'feat: extend entry point and add util',
      files: [
        { path: 'src/index.js', status: 'modified', previousPath: undefined, insertions: 1, deletions: 0 },
        { path: 'src/lib/util.js', status: 'added', previousPath: undefined, insertions: 1, deletions: 0 },
      ],
      insertions: 2,
      deletions: 0,
    })

    expect(commits[1]).toEqual({
      sha: '6e164406fdc3e92168183601862506dbce13cec4',
      shortSha: '6e16440',
      author: { name: 'Ada Dev', email: 'dev@example.com' },
      authoredAt: 1785359520000,
      parents: ['cc021f427ba6c9d563d90964a9e1e0696048a367'],
      subject: 'chore: drop stale readme',
      files: [{ path: 'README.md', status: 'deleted', previousPath: undefined, insertions: 0, deletions: 1 }],
      insertions: 0,
      deletions: 1,
    })
  })

  it('parses a renamed file, carrying its previous path', () => {
    const { commits } = parseGitLog(fixture('renamed.txt'))
    const [commit] = commits

    expect(commit?.files).toEqual([
      {
        path: 'src/main.js',
        status: 'renamed',
        previousPath: 'src/index.js',
        insertions: 0,
        deletions: 0,
      },
    ])
  })

  it('unquotes a C-quoted rename path and its previous path', () => {
    const [commit] = parseGitLog(fixture('quoted-rename.txt'))

    expect(commit?.files).toEqual([
      {
        path: 'src/näme.js',
        status: 'renamed',
        previousPath: 'src/index.js',
        insertions: 0,
        deletions: 0,
      },
    ])
  })

  it('returns no commits for an empty range', () => {
    expect(parseGitLog(fixture('empty.txt')).commits).toEqual([])
    expect(parseGitLog('').commits).toEqual([])
  })

  it('skips an unparseable raw diff line, keeping the good files in the same commit', () => {
    const { commits, skipped } = parseGitLog(fixture('malformed-raw-line.txt'))

    expect(commits).toHaveLength(1)
    expect(commits[0]?.files).toEqual([
      { path: 'src/good-before.js', status: 'modified', previousPath: undefined, insertions: 1, deletions: 0 },
      { path: 'src/good-after.js', status: 'modified', previousPath: undefined, insertions: 2, deletions: 1 },
    ])
    expect(commits[0]?.insertions).toBe(3)
    expect(commits[0]?.deletions).toBe(1)
    expect(skipped).toEqual([
      { line: ':this-is-not-a-raw-diff-line', reason: 'unparseable git raw diff line (commit deadbee)' },
    ])
  })
})
