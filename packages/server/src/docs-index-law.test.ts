import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #469's law — the documentation tree has one way in, and it stays complete.
 *
 * This repository tracked 260 markdown files when this law was written, and the
 * figure moves with every merge — it is scene-setting here, not a claim this file
 * holds. Before this law, three of the nine
 * `docs/` subdirectories carried an index — `adr/`, `prds/` and `review/` — and
 * the tree as a whole carried none. There was no document a newcomer could open
 * to find out what else there was.
 *
 * That is not only a navigation cost. The 2026-09-14 audit
 * (`docs/review/2026-09-14-documentation-audit.md`) found a README promising CI
 * that had not run for two days, a roadmap still reasoning from a private repo,
 * and 45 dead path citations — none of them noticed, because nothing gave anyone
 * a reason to walk the tree. An index is the cheapest thing that does.
 *
 * ## Why a law and not just an index
 *
 * An index is prose. Nothing rebuilds it, so the first document added after it is
 * written is the one it stops describing — silently, and in the direction that
 * matters, since a reader cannot miss what they are not told exists. This is the
 * same argument `adr-log-law.test.ts` makes for the ADR log beside it, and this
 * law is deliberately built in that file's shape: the checks are functions over
 * data, so the live tests and the detector-bite test call the SAME code. A bite
 * test that re-implements the matching over synthetic fixtures cannot observe an
 * inverted production check, which is the second defect shape this repo names.
 *
 * ## Scoped by what git tracks, not by what is on disk
 *
 * Membership is read from `git ls-files`, so an untracked scratch file in `docs/`
 * does not demand a row, and a tracked document cannot hide from one. The
 * alternative — `readdirSync` — would have made every local working file a
 * failure, which is the fastest way to teach people to ignore a law.
 *
 * Lives under `packages/server/` for the reason every sibling repo-scope law here
 * records: the root vitest config globs `packages/*`, so a root-level test would
 * never run and would be its own vacuous law.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const DOCS_DIR = path.join(REPO_ROOT, 'docs')
const INDEX_FILE = 'docs/README.md'

/** Every tracked path under `docs/`, repo-rooted, forward-slashed on every platform. */
function trackedUnderDocs(): string[] {
  return execFileSync('git', ['ls-files', '--', 'docs/'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'))
}

/**
 * The top-level documents — `docs/*.md`, excluding the index itself.
 *
 * The index does not carry a row for itself; a document that is the map is not
 * also a destination on it.
 */
function documents(): string[] {
  return trackedUnderDocs()
    .filter((file) => file !== INDEX_FILE)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => file.split('/').length === 2)
    .map((file) => file.slice('docs/'.length))
    .sort()
}

/** Every subdirectory of `docs/` that git tracks something in. */
function directories(): string[] {
  const found = new Set<string>()
  for (const file of trackedUnderDocs()) {
    const rest = file.slice('docs/'.length)
    const slash = rest.indexOf('/')
    if (slash > 0) found.add(rest.slice(0, slash))
  }
  return [...found].sort()
}

function indexText(): string {
  return readFileSync(path.join(DOCS_DIR, 'README.md'), 'utf8')
}

/**
 * Link targets in the FIRST cell of a table row — the index proper, not prose.
 *
 * `adr-log-law.test.ts` records why membership is read from rows rather than from
 * any link anywhere: this file's prose genuinely does link to documents it is
 * describing, and "a link exists somewhere" was never the same question as "the
 * table lists it". Deleting a row while prose still linked the same target would
 * otherwise pass.
 */
function indexRows(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => /^\|\s*\[[^\]]+\]\(([^)]+)\)/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!)
}

/** Every link target anywhere in the index, rows and prose alike. */
function allLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]!)
}

/**
 * The directory a row's target sits in, or `''` for a top-level document.
 *
 * Both forms a row may legitimately use resolve to the same directory: a link
 * INTO the directory (`adr/README.md`) and a link AT it (`design-notes/`). The
 * first draft stripped the trailing slash before looking for a separator, so
 * `design-notes/` became `design-notes`, contained no slash, and was reported as
 * a top-level document — which left four real directories reading as unindexed
 * while their rows were sitting right there. Caught by this law's own run before
 * it landed.
 */
function targetDirectory(target: string): string {
  const clean = target.split('#')[0]!
  const stripped = clean.replace(/\/$/, '')
  const slash = stripped.indexOf('/')
  if (slash > 0) return stripped.slice(0, slash)
  return clean.endsWith('/') ? stripped : ''
}

function documentsMissingRow(docs: string[], text: string): string[] {
  const rowed = new Set(indexRows(text).map((t) => t.split('#')[0]!))
  return docs.filter((doc) => !rowed.has(doc))
}

function directoriesMissingRow(dirs: string[], text: string): string[] {
  const covered = new Set(indexRows(text).map(targetDirectory))
  return dirs.filter((dir) => !covered.has(dir))
}

/**
 * Every link whose target does not exist. Resolved against `docs/`, because the
 * index lives there and its links are relative to it.
 *
 * External links are skipped; a dead URL is a different law's problem and this
 * one must not pretend to check the network.
 */
function deadLinks(text: string): string[] {
  return allLinks(text)
    .filter((target) => !/^(https?:|mailto:)/.test(target))
    .filter((target) => {
      const clean = target.split('#')[0]!
      if (clean === '') return false
      // `path.join` walks a leading `../` out of `docs/` on its own, so a link up
      // to the repo root needs no separate arm. An earlier draft branched on it and
      // both arms were the same expression.
      const resolved = path.join(DOCS_DIR, clean)
      return !existsSync(resolved)
    })
}

describe('the documentation tree has one index, and it stays complete (#469)', () => {
  it('has documents and directories to check at all — an empty sweep would prove nothing', () => {
    // Both sides asserted independently. A sweep that silently matched nothing
    // passes every membership check below for the wrong reason, and this repo
    // has already shipped one guard whose probe matched nothing for a month.
    expect(documents().length).toBeGreaterThan(5)
    expect(directories().length).toBeGreaterThan(5)
  })

  it('the index itself is tracked — an untracked map reaches no other checkout', () => {
    expect(trackedUnderDocs()).toContain(INDEX_FILE)
  })

  it('every top-level document has a TABLE ROW — the tree has no other discovery surface', () => {
    expect(documentsMissingRow(documents(), indexText())).toEqual([])
  })

  it('every subdirectory has a TABLE ROW — a whole directory is the easiest thing to lose', () => {
    expect(directoriesMissingRow(directories(), indexText())).toEqual([])
  })

  it('every link in the index resolves to something that exists', () => {
    expect(deadLinks(indexText())).toEqual([])
  })

  it('the detectors bite — each failure this law exists to catch, run through the same code the checks above use', () => {
    const docs = documents()
    const dirs = directories()
    const text = indexText()
    const firstDoc = docs[0]!
    const firstDir = dirs[0]!

    // A document whose table row is gone, even though prose elsewhere still
    // links the same target. This is the case a bare "a link exists" membership
    // check cannot see, and the reason rows are read separately from links.
    const rowGone = text.replace(new RegExp(`^\\|\\s*\\[[^\\]]+\\]\\(${firstDoc.replace('.', '\\.')}\\).*$`, 'm'), `see [it](${firstDoc}) in prose`)
    expect(documentsMissingRow(docs, rowGone)).toEqual([firstDoc])

    // A new document nobody indexed — the drift this law exists for.
    expect(documentsMissingRow([...docs, 'a-document-nobody-indexed.md'], text)).toEqual(['a-document-nobody-indexed.md'])

    // A whole subdirectory dropped from the map.
    expect(directoriesMissingRow([...dirs, 'a-directory-nobody-indexed'], text)).toEqual(['a-directory-nobody-indexed'])

    // A row pointing at a document that does not exist, which is what a rename
    // leaves behind.
    expect(deadLinks(`| [x](this-document-does-not-exist.md) | y |`)).toEqual(['this-document-does-not-exist.md'])

    // And the control: the real index is not dead-linked, so the check above is
    // reporting a planted fault rather than a standing one.
    expect(deadLinks(text)).toEqual([])

    // An external link is not a dead link — the law must not pretend to reach
    // the network.
    expect(deadLinks(`| [x](https://example.com/nothing) | y |`)).toEqual([])

    // The directory check reads the row's directory, not the whole target, so a
    // row pointing INTO a directory covers it.
    expect(targetDirectory(`${firstDir}/README.md`)).toBe(firstDir)
    expect(targetDirectory(`${firstDir}/`)).toBe(firstDir)
    expect(targetDirectory('architecture.md')).toBe('')
  })
})
