import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type TranscriptFileListing,
  type TranscriptFileRead,
  type TranscriptReadFs,
  disambiguateSlugByCwd,
  findRecordedCwd,
} from './slug-disambiguate.js'

/**
 * An in-memory `TranscriptReadFs`. `files[dir]` is the list of `*.jsonl`
 * filenames directly inside `dir` — absent means "no transcript recorded",
 * matching real `ENOENT` behaviour (see `findRecordedCwd`'s own doc).
 * `contents[filePath]` is the raw file text. `unreadableDirs`/
 * `unreadableFiles` mark a genuine read failure, distinct from absence.
 */
function fixtureTranscriptFs(
  files: Record<string, string[]>,
  contents: Record<string, string> = {},
  options: { unreadableDirs?: ReadonlySet<string>; unreadableFiles?: ReadonlySet<string> } = {},
): TranscriptReadFs {
  const unreadableDirs = options.unreadableDirs ?? new Set<string>()
  const unreadableFiles = options.unreadableFiles ?? new Set<string>()
  return {
    listTranscriptFiles: async (slugDir): Promise<TranscriptFileListing> => {
      if (unreadableDirs.has(slugDir)) return { readable: false, reason: `permission denied reading ${slugDir}` }
      return { readable: true, files: files[slugDir] ?? [] }
    },
    readTranscriptFile: async (filePath): Promise<TranscriptFileRead> => {
      if (unreadableFiles.has(filePath)) return { readable: false, reason: `permission denied reading ${filePath}` }
      return { readable: true, content: contents[filePath] ?? '' }
    },
  }
}

function jsonLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`
}

const ROOT = path.join('/', 'claude-projects')
const SLUG = '-repo-packages-web'
const SLUG_DIR = path.join(ROOT, SLUG)

describe('findRecordedCwd', () => {
  it('reads the cwd off the one record that carries it', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const fs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      { [filePath]: jsonLine({ type: 'user', cwd: path.join('/', 'repo', 'packages', 'web') }) },
    )

    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBe(path.join('/', 'repo', 'packages', 'web'))
  })

  it('takes the LAST cwd WITHIN one file — the file is append-only, so line order is time order', async () => {
    const file = path.join(SLUG_DIR, 'c9d4e5f6-0000-4000-8000-000000000000.jsonl')
    const fs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['c9d4e5f6-0000-4000-8000-000000000000.jsonl'] },
      {
        [file]:
          jsonLine({ type: 'user', cwd: path.join('/', 'repo', 'packages-web') }) +
          jsonLine({ type: 'assistant', cwd: path.join('/', 'repo', 'packages', 'web') }),
      },
    )

    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBe(path.join('/', 'repo', 'packages', 'web'))
  })

  /**
   * The revision before this one took the last cwd ACROSS files too, in
   * name-sorted order, and called it "newest wins". Its fixture used
   * `session1.jsonl` / `session2.jsonl` — names where sort order happens to
   * agree with the claim — so it could not fail for the reason it named.
   * Real transcripts are UUID-named, where sort order says nothing about
   * recency: EXECUTED in review of #142, swapping ONLY the two filenames
   * changed which real directory the walk returned. These two tests are the
   * pair that makes that impossible to reintroduce — the first proves the
   * per-file rule still holds, the second proves disagreement refuses.
   */
  it('REFUSES when two files disagree, naming both — sort order must not decide it', async () => {
    const early = path.join(SLUG_DIR, '00000000-0000-4000-8000-000000000000.jsonl')
    const late = path.join(SLUG_DIR, 'ffffffff-0000-4000-8000-000000000000.jsonl')
    const fs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['00000000-0000-4000-8000-000000000000.jsonl', 'ffffffff-0000-4000-8000-000000000000.jsonl'] },
      {
        [early]: jsonLine({ type: 'user', cwd: path.join('/', 'repo', 'packages-web') }),
        [late]: jsonLine({ type: 'user', cwd: path.join('/', 'repo', 'packages', 'web') }),
      },
    )

    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBeNull()
    expect(result.reason).toContain('disagree')
    expect(result.reason).toContain(path.join('/', 'repo', 'packages-web'))
    expect(result.reason).toContain(path.join('/', 'repo', 'packages', 'web'))
  })

  it('CONTROL — swapping ONLY the filenames changes nothing, because sort order no longer decides', async () => {
    const build = (cwdForFirst: string, cwdForSecond: string) =>
      fixtureTranscriptFs(
        { [SLUG_DIR]: ['00000000-0000-4000-8000-000000000000.jsonl', 'ffffffff-0000-4000-8000-000000000000.jsonl'] },
        {
          [path.join(SLUG_DIR, '00000000-0000-4000-8000-000000000000.jsonl')]: jsonLine({ cwd: cwdForFirst }),
          [path.join(SLUG_DIR, 'ffffffff-0000-4000-8000-000000000000.jsonl')]: jsonLine({ cwd: cwdForSecond }),
        },
      )
    const a = path.join('/', 'repo', 'packages', 'web')
    const b = path.join('/', 'repo', 'packages-web')
    const oneWay = await findRecordedCwd(SLUG, ROOT, build(a, b))
    const other = await findRecordedCwd(SLUG, ROOT, build(b, a))
    expect(oneWay.cwd).toBeNull()
    expect(other.cwd).toBeNull()
  })

  it('reports "no transcript recorded" when the slug directory does not exist, rather than a bare null', async () => {
    const fs = fixtureTranscriptFs({})
    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBeNull()
    expect(result.reason).toContain('no transcript recorded')
    expect(result.reason).toContain(SLUG_DIR)
  })

  it('reports an unreadable transcript DIRECTORY honestly, not as "no transcript"', async () => {
    const fs = fixtureTranscriptFs({}, {}, { unreadableDirs: new Set([SLUG_DIR]) })
    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBeNull()
    expect(result.reason).toContain('permission denied')
    expect(result.reason).not.toContain('no transcript recorded')
  })

  it('reports every transcript FILE unreadable, distinct from a directory read failure', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const fs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      {},
      { unreadableFiles: new Set([filePath]) },
    )
    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBeNull()
    expect(result.reason).toContain('unreadable')
    expect(result.reason).toContain(filePath)
  })

  it('reports a MALFORMED transcript (no line parses as JSON) rather than silently finding no cwd', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const fs = fixtureTranscriptFs({ [SLUG_DIR]: ['session1.jsonl'] }, { [filePath]: 'not json at all\n{also not json\n' })
    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBeNull()
    expect(result.reason).toContain('malformed')
  })

  it('reports "no record carries a cwd field" when every line parses but none names one', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const fs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      { [filePath]: jsonLine({ type: 'system' }) + jsonLine({ type: 'user', message: 'hi' }) },
    )
    const result = await findRecordedCwd(SLUG, ROOT, fs)
    expect(result.cwd).toBeNull()
    expect(result.reason).toContain('cwd')
    expect(result.reason).not.toContain('malformed')
  })
})

describe('disambiguateSlugByCwd', () => {
  const candidates = [path.join('/', 'repo', 'packages', 'web'), path.join('/', 'repo', 'packages-web')]

  it('resolves to the candidate the transcript recorded cwd for', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const transcriptFs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      { [filePath]: jsonLine({ type: 'user', cwd: candidates[1] }) },
    )

    const result = await disambiguateSlugByCwd(SLUG, candidates, {
      claudeProjectsRoot: ROOT,
      pathExists: async () => true,
      transcriptFs,
    })

    expect(result).toEqual({ path: candidates[1] })
  })

  it('matches a recorded cwd against a candidate through path.normalize, not bare string equality — a redundant "." segment is not a different path', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const transcriptFs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      { [filePath]: jsonLine({ type: 'user', cwd: `${candidates[1]}${path.sep}.` }) },
    )

    const result = await disambiguateSlugByCwd(SLUG, candidates, {
      claudeProjectsRoot: ROOT,
      pathExists: async () => true,
      transcriptFs,
    })

    expect(result).toEqual({ path: candidates[1] })
  })

  it('refuses, naming every candidate, when no evidence settles it', async () => {
    const transcriptFs = fixtureTranscriptFs({})

    const result = await disambiguateSlugByCwd(SLUG, candidates, {
      claudeProjectsRoot: ROOT,
      pathExists: async () => true,
      transcriptFs,
    })

    expect(result.path).toBeNull()
    const reason = (result as { reason: string }).reason
    expect(reason).toContain('ambiguous')
    expect(reason).toContain(candidates[0] as string)
    expect(reason).toContain(candidates[1] as string)
    expect(reason).toContain('no transcript recorded')
  })

  it('refuses when the recorded cwd names a real directory that is NONE of the candidates', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const elsewhere = path.join('/', 'somewhere', 'else')
    const transcriptFs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      { [filePath]: jsonLine({ type: 'user', cwd: elsewhere }) },
    )

    const result = await disambiguateSlugByCwd(SLUG, candidates, {
      claudeProjectsRoot: ROOT,
      pathExists: async () => true,
      transcriptFs,
    })

    expect(result.path).toBeNull()
    const reason = (result as { reason: string }).reason
    expect(reason).toContain(elsewhere)
    expect(reason).toContain('names none of them')
  })

  it('refuses, distinctly, when the recorded cwd names a path that no longer exists on disk', async () => {
    const filePath = path.join(SLUG_DIR, 'session1.jsonl')
    const gone = path.join('/', 'repo', 'renamed-away')
    const transcriptFs = fixtureTranscriptFs(
      { [SLUG_DIR]: ['session1.jsonl'] },
      { [filePath]: jsonLine({ type: 'user', cwd: gone }) },
    )

    const result = await disambiguateSlugByCwd(SLUG, candidates, {
      claudeProjectsRoot: ROOT,
      pathExists: async () => false,
      transcriptFs,
    })

    expect(result.path).toBeNull()
    const reason = (result as { reason: string }).reason
    expect(reason).toContain(gone)
    expect(reason).toContain('no longer exists on disk')
  })
})
