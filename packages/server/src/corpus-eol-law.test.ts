import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * prd-25 ruling 4's law — a CRLF checkout cannot change what the era corpus says (#210).
 *
 * The era corpus is bound into `@rhizomorph/core` as TEXT through Vite's `?raw`
 * (`packages/core/src/eras/corpus.ts`), and `eras.test.ts` compares the fold to the
 * committed snapshot byte for byte — and deliberately cannot re-bless it from inside
 * the suite. So the corpus is INPUT, not something the suite can repair: under
 * `core.autocrlf=true` (the Git-for-Windows default) a checkout rewrites every LF to
 * CRLF, the input lies, and the golden law fails on a tree nobody changed. The only
 * native Windows run this project has ever done lost the eras golden byte-identity to
 * exactly this. The same failure reaches every JSON / JSONL / text fixture a collector
 * test reads off disk.
 *
 * `.gitattributes` at the repo root is the pin (`text eol=lf`). This law is what holds
 * it: for every file the suite reads as text, ask `git check-attr` — the effective
 * attribute git will actually apply, never a re-implementation of the pattern syntax —
 * and fail if the answer is not `eol: lf`.
 *
 * **Scoped by what a file IS, not by what it is called** (AGENTS.md's #649 lesson: a
 * guard keyed on a filename prefix missed three older captures). Three derived sets,
 * none of them a maintained list:
 *   1. every file `corpus.ts` imports with `?raw` — parsed from the importer itself;
 *   2. every tracked file under `packages/core/src/eras/` that is not source or prose —
 *      the place a NEW corpus file lands before anyone imports it;
 *   3. every tracked file under a collector's `fixtures/` directory.
 *
 * Lives under `packages/server/` rather than beside the corpus in `packages/core/src/eras/`
 * — where #210's boundary first put it — because `@rhizomorph/core` has no Node type
 * definitions in scope at all (`packages/core/src/eras/fold.ts` says so, and says why:
 * a `readFileSync` there would not typecheck). A law that asks `git` needs `node:child_process`,
 * so it sits with the other repo-root laws here (`no-personal-paths-law`,
 * `doc-citation-law`, `runbook-delivery-law`), for the same reason they do.
 *
 * Grep-law style, matching those siblings: real `git` output, no mocks. Half the tests
 * below exist to prove the detector bites, since a law asserting an attribute is set is
 * exactly the shape that passes vacuously when its own probe is broken.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const ERAS_DIR = 'packages/core/src/eras'
const CORPUS_IMPORTER = `${ERAS_DIR}/corpus.ts`

function trackedFiles(pattern: string): string[] {
  return execFileSync('git', ['ls-files', '--', pattern], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Set 1 — what `corpus.ts` binds in as text. Derived from the importer; a maintained list is what would go stale. */
export function rawImportedCorpusFiles(importerText: string): string[] {
  const out: string[] = []
  for (const match of importerText.matchAll(/from\s+'(\.[^'\n]+?)\?raw'/g)) {
    const rel = match[1]
    if (rel === undefined) continue
    out.push(path.posix.normalize(path.posix.join(ERAS_DIR, rel)))
  }
  return out
}

/** Set 2 — a new corpus file under eras/ lands here before anyone imports it. Source and prose are not corpus. */
function trackedEraDataFiles(): string[] {
  return trackedFiles(`${ERAS_DIR}/**`).filter((file) => !/\.(?:ts|md)$/.test(file))
}

/** Set 3 — every fixture a collector test reads off disk. */
function trackedFixtureFiles(): string[] {
  return trackedFiles('packages/server/src/collectors/*/fixtures/**')
}

interface EolAttrs {
  eol: string
  text: string
}

/**
 * `git check-attr eol text -- <files>` prints one line per (file, attribute):
 * `<file>: eol: lf` / `<file>: text: set`. `unspecified` means no rule covers the
 * file — which is precisely the condition this law exists to fail on.
 */
export function parseCheckAttr(output: string): Map<string, EolAttrs> {
  const out = new Map<string, EolAttrs>()
  for (const line of output.split('\n')) {
    const match = line.match(/^(.*): (eol|text): (.+)$/)
    if (!match) continue
    const [, file, attr, value] = match
    if (file === undefined || attr === undefined || value === undefined) continue
    const entry = out.get(file) ?? { eol: 'unspecified', text: 'unspecified' }
    if (attr === 'eol') entry.eol = value
    else entry.text = value
    out.set(file, entry)
  }
  return out
}

function attrsOf(files: readonly string[]): Map<string, EolAttrs> {
  if (files.length === 0) return new Map()
  const output = execFileSync('git', ['check-attr', 'eol', 'text', '--', ...files], { cwd: REPO_ROOT, encoding: 'utf8' })
  return parseCheckAttr(output)
}

/** `git ls-files -s` — the blob id each pinned file has IN THE INDEX, keyed by path. */
function indexBlobIds(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (files.length === 0) return out
  const output = execFileSync('git', ['ls-files', '-s', '--', ...files], { cwd: REPO_ROOT, encoding: 'utf8' })
  // `<mode> <blob> <stage>\t<path>` — the path is everything after the ONE tab.
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const blob = line.slice(0, tab).split(/\s+/)[1]
    const file = line.slice(tab + 1)
    if (blob !== undefined && file.length > 0) out.set(file, blob)
  }
  return out
}

/**
 * `git hash-object --stdin-paths` — the blob id git WOULD store for each file if it
 * were committed right now, with that path's own attributes applied (the clean
 * filter, i.e. exactly the pin under test). One spawn for every file. A CRLF
 * checkout cannot fool this: the filter is what strips the CR, so a pinned file
 * hashes back to its LF blob — which is the pin doing its job, and the point.
 */
function cleanedBlobIds(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (files.length === 0) return out
  const output = execFileSync('git', ['hash-object', '--stdin-paths'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: `${files.join('\n')}\n`,
  })
  const ids = output.split('\n').filter((line) => line.length > 0)
  files.forEach((file, i) => {
    const id = ids[i]
    if (id !== undefined) out.set(file, id)
  })
  return out
}

function everyPinnedFile(): string[] {
  const importer = readFileSync(path.join(REPO_ROOT, CORPUS_IMPORTER), 'utf8')
  return [...new Set([...rawImportedCorpusFiles(importer), ...trackedEraDataFiles(), ...trackedFixtureFiles()])].sort()
}

describe('corpus line-endings law: a CRLF checkout cannot change what the era corpus says (prd-25 ruling 4, #210)', () => {
  it('.gitattributes exists at the repo root and is tracked — a pin in an untracked file pins nobody else', () => {
    expect(trackedFiles('.gitattributes')).toEqual(['.gitattributes'])
  })

  it('the corpus set is derived from corpus.ts and names both era-1 files — an empty derivation would pass everything below vacuously', () => {
    const importer = readFileSync(path.join(REPO_ROOT, CORPUS_IMPORTER), 'utf8')
    const corpus = rawImportedCorpusFiles(importer)
    expect(corpus).toContain(`${ERAS_DIR}/era-1/recording.jsonl`)
    expect(corpus).toContain(`${ERAS_DIR}/era-1/session-state.snapshot.json`)
    for (const file of corpus) expect(trackedFiles(file), `${file} is imported ?raw but not tracked`).toEqual([file])
  })

  it('the three derived sets are each non-empty — the sweep has something to hold', () => {
    expect(trackedEraDataFiles().length).toBeGreaterThan(0)
    expect(trackedFixtureFiles().length).toBeGreaterThan(20)
    expect(everyPinnedFile().length).toBeGreaterThan(20)
  })

  it('every file the suite reads as text is pinned `text eol=lf` — asked of git, not of the pattern file', () => {
    const files = everyPinnedFile()
    const attrs = attrsOf(files)
    const unpinned = files.filter((file) => attrs.get(file)?.eol !== 'lf' || attrs.get(file)?.text !== 'set')
    expect(
      unpinned,
      'these files are read as text by the suite and .gitattributes does not pin them to LF — a CRLF checkout will change what they say',
    ).toEqual([])
  })

  it('the pin changed no committed byte — every pinned file re-hashes to its own index blob under the pin', () => {
    // The property this law is named for, asserted directly: commit each pinned
    // file under the pin and you get the blob already in the index. The first
    // form of this test read `git ls-files --eol` and accepted only `i/lf` /
    // `i/none` — and reported four git-log fixtures as "CRLF or mixed". They
    // were `i/-text`: git's BINARY heuristic firing on parse-log's `\x01` / `\x1f`
    // record and field separators, with zero CR bytes in any of them. The eol
    // column was a proxy for the claim; this is the claim.
    const files = everyPinnedFile()
    const index = indexBlobIds(files)
    const cleaned = cleanedBlobIds(files)
    expect(index.size, 'ls-files -s answered for every file').toBe(files.length)
    expect(cleaned.size, 'hash-object answered for every file').toBe(files.length)
    const rewritten = files.filter((file) => index.get(file) !== cleaned.get(file))
    expect(
      rewritten,
      'committing this file under the pin would store a different blob — the pin rewrites its bytes, and that rewrite must be its own explained commit',
    ).toEqual([])
  })

  it('the blob comparison bites — CRLF bytes under a pinned path hash differently from the same bytes unfiltered', () => {
    // Rigged without touching the tree: hash `a\r\nb\r\n` AS IF it sat at a pinned
    // `.jsonl` path (the clean filter applies, CR is stripped) and again with
    // `--no-filters`. If the pin is real, the two ids differ; if `--path` were
    // silently ignored, they would be equal and the test above would pass over
    // anything. Also proves the clean filter is what the previous test measures.
    const crlf = 'a\r\nb\r\n'
    const asPinned = execFileSync('git', ['hash-object', '--stdin', `--path=${ERAS_DIR}/era-1/rigged.jsonl`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: crlf,
    }).trim()
    const raw = execFileSync('git', ['hash-object', '--stdin', '--no-filters'], { cwd: REPO_ROOT, encoding: 'utf8', input: crlf }).trim()
    const lf = execFileSync('git', ['hash-object', '--stdin', '--no-filters'], { cwd: REPO_ROOT, encoding: 'utf8', input: 'a\nb\n' }).trim()
    expect(asPinned).not.toBe(raw)
    expect(asPinned, 'the pin cleans CRLF to exactly the LF blob').toBe(lf)
  })

  it('the detector bites — an extension no rule covers is reported unspecified, not silently lf', () => {
    // `check-attr` answers for paths that do not exist, which is what makes a
    // rigged probe possible without touching the tree.
    const probe = attrsOf([`${ERAS_DIR}/era-1/rigged-unpinned.xyz`, `${ERAS_DIR}/era-1/rigged-pinned.jsonl`])
    expect(probe.get(`${ERAS_DIR}/era-1/rigged-unpinned.xyz`)).toEqual({ eol: 'unspecified', text: 'unspecified' })
    expect(probe.get(`${ERAS_DIR}/era-1/rigged-pinned.jsonl`)).toEqual({ eol: 'lf', text: 'set' })
    // …and the fixtures rule is directory-shaped, so a fixture of ANY extension is covered.
    const fixture = attrsOf(['packages/server/src/collectors/tmux/fixtures/rigged-capture.txt'])
    expect(fixture.get('packages/server/src/collectors/tmux/fixtures/rigged-capture.txt')?.eol).toBe('lf')
  })

  it('the check-attr parser reads the real output shape and ignores noise — proving the sweep above parsed something', () => {
    const rigged = ['a/b.jsonl: eol: lf', 'a/b.jsonl: text: set', 'a/c.xyz: eol: unspecified', 'a/c.xyz: text: unspecified', 'garbage line', ''].join('\n')
    expect(parseCheckAttr(rigged)).toEqual(
      new Map([
        ['a/b.jsonl', { eol: 'lf', text: 'set' }],
        ['a/c.xyz', { eol: 'unspecified', text: 'unspecified' }],
      ]),
    )
    expect(rawImportedCorpusFiles("import x from './era-9/thing.jsonl?raw'\nimport y from './not-raw.ts'")).toEqual([
      `${ERAS_DIR}/era-9/thing.jsonl`,
    ])
  })
})
