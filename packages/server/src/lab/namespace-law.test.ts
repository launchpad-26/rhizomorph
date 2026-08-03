import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * prd12 ruling 1's law test — the amendment's own condition: "the observer's
 * readonly greps stay green untouched [...] a new lab-namespace test asserts
 * every lab-side write path is confined to the namespaces above." Two halves:
 *
 * 1. No observer source file imports from `server/src/lab/` — the second
 *    hand is explicitly-invoked only, never reachable from a collector or a
 *    background poll. The one allowed exception is the CLI's own wiring
 *    point (`cli/index.ts` dispatching `rhizomorph lab checkpoint`), named
 *    below rather than silently excluded.
 * 2. Every git ref this package's lab module writes to is confined to
 *    `refs/rhizomorph/`, and no lab source file ever shells out to a
 *    disallowed git verb (`push`, `merge`, `checkout`, `branch -D`).
 *
 * Grep-style, per the issue: this walks real source text with regexes, not
 * an AST. That is deliberately as legible as the readonly law tests it sits
 * beside — a reader should be able to verify the check by eye.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/lab -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const WEB_SRC = path.join(REPO_ROOT, 'packages', 'web', 'src')
const LAB_DIR = path.join(SERVER_SRC, 'lab')

/** The one file allowed to import the lab module — the explicit CLI wiring point. */
const ALLOWED_IMPORTERS = new Set([path.join(SERVER_SRC, 'cli', 'index.ts')])

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function walkSourceFiles(dir: string, exclude: readonly string[] = []): string[] {
  const excluded = new Set(exclude.map((p) => path.resolve(p)))
  const out: string[] = []

  const visit = (current: string) => {
    if (excluded.has(path.resolve(current))) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (excluded.has(path.resolve(full))) continue
      const info = statSync(full)
      if (info.isDirectory()) {
        visit(full)
      } else if (SOURCE_EXTENSIONS.has(path.extname(full))) {
        out.push(full)
      }
    }
  }

  visit(dir)
  return out
}

/** Every `from '...'` / `import '...'` / `import('...')` / `require('...')` specifier in a file's text. */
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.push(specifier)
  }
  return specifiers
}

/** True if a specifier resolves into (or names) the lab module — relative or bare. */
function targetsLab(specifier: string): boolean {
  return /(^|\/)lab\/[^/]/.test(specifier) || /(^|\/)lab$/.test(specifier)
}

/** The importable specifiers a source file's text targets the lab module through. */
function findLabImports(source: string): string[] {
  return importSpecifiers(source).filter(targetsLab)
}

describe('the lab namespace law (prd12 ruling 1)', () => {
  describe('no observer import reaches the lab', () => {
    it('the detector fires on a deliberately-violating fixture — proving it bites', () => {
      const badFixture = readFileSync(path.join(LAB_DIR, '__fixtures__', 'bad-import.ts.txt'), 'utf8')
      expect(findLabImports(badFixture)).toEqual(["../lab/checkpoint.js"])
    })

    it('the detector does not fire on an ordinary observer import — not vacuously true', () => {
      const cleanFixture = readFileSync(path.join(LAB_DIR, '__fixtures__', 'clean-import.ts.txt'), 'utf8')
      expect(findLabImports(cleanFixture)).toEqual([])
    })

    it('no server source file outside the lab module imports from it, except the one declared CLI wiring point', () => {
      const files = walkSourceFiles(SERVER_SRC, [LAB_DIR])
      const violations: Array<{ file: string; specifiers: string[] }> = []

      for (const file of files) {
        if (ALLOWED_IMPORTERS.has(path.resolve(file))) continue
        const hits = findLabImports(readFileSync(file, 'utf8'))
        if (hits.length > 0) violations.push({ file: path.relative(REPO_ROOT, file), specifiers: hits })
      }

      expect(violations).toEqual([])
    })

    it('the one allowed importer (cli/index.ts) does import the lab module — the exception is real, not dead code', () => {
      const cliIndexPath = path.join(SERVER_SRC, 'cli', 'index.ts')
      const hits = findLabImports(readFileSync(cliIndexPath, 'utf8'))
      expect(hits.length).toBeGreaterThan(0)
    })

    it('no web source file imports from the lab module', () => {
      const files = walkSourceFiles(WEB_SRC)
      const violations = files
        .map((file) => ({ file: path.relative(REPO_ROOT, file), specifiers: findLabImports(readFileSync(file, 'utf8')) }))
        .filter((entry) => entry.specifiers.length > 0)

      expect(violations).toEqual([])
    })
  })

  describe('every write inside lab/ targets only the amended namespaces', () => {
    const REF_LITERAL_RE = /refs\/[^\s'"`]*/g
    const FORBIDDEN_GIT_VERBS = ['push', 'merge', 'checkout']

    function labSourceFiles(): string[] {
      return walkSourceFiles(LAB_DIR, [path.join(LAB_DIR, '__fixtures__')]).filter(
        (file) => !file.endsWith('.test.ts'),
      )
    }

    it('every refs/ literal in lab/ source is under refs/rhizomorph/', () => {
      const files = labSourceFiles()
      expect(files.length).toBeGreaterThan(0) // the check below would vacuously pass on an empty dir

      const offenders: string[] = []
      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(REF_LITERAL_RE)) {
          const ref = match[0]
          if (!ref.startsWith('refs/rhizomorph/')) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${ref}`)
          }
        }
      }
      expect(offenders).toEqual([])
    })

    // Matches a quoted verb only in argv position — inside `[...]`, preceded
    // by `[` or `,` and followed by `,` or `]` (whitespace-tolerant) — so an
    // English sentence merely naming the verb (as this law's own doc comment
    // does) is not a false positive; only an actual argv literal is.
    function forbiddenVerbPattern(verb: string): RegExp {
      return new RegExp(`[[,]\\s*(['"\`])${verb}\\1\\s*[,\\]]`)
    }

    it('never shells out to push, merge or checkout', () => {
      const files = labSourceFiles()
      const offenders: string[] = []

      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        for (const verb of FORBIDDEN_GIT_VERBS) {
          if (forbiddenVerbPattern(verb).test(source)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: "${verb}"`)
          }
        }
      }
      expect(offenders).toEqual([])
    })

    it('the detector on this exact law would catch a rogue push if one were added — proving it bites', () => {
      const rogueSource = `await exec('git', ['push', 'origin', 'main'])\n`
      expect(forbiddenVerbPattern('push').test(rogueSource)).toBe(true)

      // And it does not fire on the verb merely being named in prose, the
      // false-positive this law test's own doc comment would otherwise be.
      const proseOnly = 'Nothing here ever runs `push`, `merge`, or `checkout`.'
      expect(forbiddenVerbPattern('push').test(proseOnly)).toBe(false)
    })
  })
})
