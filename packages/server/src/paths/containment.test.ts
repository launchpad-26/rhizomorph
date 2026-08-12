import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalize, isInside } from './containment.js'

/**
 * Direct unit tests of the shared containment primitive (#401). The
 * macOS-shape and Node-version-disagreement scenarios already have thorough
 * coverage in `lab/paths.test.ts` (through `lab/paths.ts`'s re-exported
 * `isInside`) and `cli/export-record-containment.test.ts` (through
 * `runExportRecord`'s real symlinked-`--out` scenarios) — this file is not a
 * second copy of either. It covers what neither call site tested in
 * isolation: the dangling-symlink chase this merge added so `export-record`'s
 * coverage would not quietly regress, plus the "no second definition" law
 * that is this issue's own step 5.
 */
describe('the containment primitive (#401)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-containment-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('an ordinary, non-symlinked path is contained — the regression case, not vacuous', async () => {
    const parent = path.join(root, 'parent')
    await mkdir(parent, { recursive: true })
    const candidate = path.join(parent, 'child', 'grandchild.txt') // does not exist yet

    expect(isInside(parent, candidate)).toBe(true)
  })

  it('an ordinary, non-symlinked path outside the parent is refused', async () => {
    const parent = path.join(root, 'parent')
    await mkdir(parent, { recursive: true })
    const escapee = path.join(root, 'elsewhere', 'file.txt')

    expect(isInside(parent, escapee)).toBe(false)
  })

  it(
    'a DANGLING symlink whose target resolves inside the parent is contained — the case ' +
      "export-record.ts's canonicalizeExistingAncestor existed for, and lab/paths.ts's " +
      'original canonicalize never needed (#299)',
    async () => {
      const parent = path.join(root, 'parent')
      const outsideDir = path.join(root, 'outside')
      await mkdir(parent, { recursive: true })
      await mkdir(outsideDir, { recursive: true })

      const linkTarget = path.join(parent, 'not-written-yet.json') // does not exist
      const link = path.join(outsideDir, 'dangling-link')
      await symlink(linkTarget, link)

      expect(isInside(parent, link)).toBe(true)
      expect(canonicalize(link)).toBe(canonicalize(linkTarget))
    },
  )

  it('a DANGLING symlink whose target resolves outside the parent is NOT contained', async () => {
    const parent = path.join(root, 'parent')
    const outsideDir = path.join(root, 'outside')
    await mkdir(parent, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const linkTarget = path.join(outsideDir, 'not-written-yet.json') // does not exist, and is outside parent
    const link = path.join(parent, 'looks-contained-but-isnt')
    await symlink(linkTarget, link)

    expect(isInside(parent, link)).toBe(false)
  })

  it('the macOS Node-version canonicalizer disagreement (#228), simulated: an inconsistent realpath reports a false escape', () => {
    const parent = '/simulated/data-link'
    const candidate = path.join(parent, 'child')

    // Same shape as lab/paths.test.ts's #228 reproduction: candidate arrives
    // already /private-prefixed (as if resolved by some other tool), but this
    // fake canonicalizer leaves the parent plain — the exact disagreement
    // that made a contained path look like an escape.
    const inconsistentRealpath = (p: string) => p
    const candidateAlreadyResolved = `/private${candidate}`
    expect(isInside(parent, candidateAlreadyResolved, inconsistentRealpath)).toBe(false)

    // A canonicalizer that agrees with itself resolves the same inputs correctly.
    const consistentRealpath = (p: string) => (p.startsWith('/private') ? p : `/private${p}`)
    expect(isInside(parent, candidateAlreadyResolved, consistentRealpath)).toBe(true)
  })
})

/**
 * The chase bound (#401 verify pass). Not a hypothetical: `realpath` reports
 * this shape as ENOENT rather than ELOOP, so the dangling-symlink chase
 * resolves it back to itself forever. The loop is SYNCHRONOUS — it blocks the
 * event loop, so vitest's own per-test timeout cannot fire on it and the run
 * has to be killed from outside. That is why this is bounded in code rather
 * than left to the OS.
 */
describe('the symlink chase is bounded (#401)', () => {
  let root: string

  beforeEach(async () => {
    // CANONICALIZED at creation, deliberately. `os.tmpdir()` is itself a
    // symlink on macOS (`/var` -> `/private/var`) and is not on Linux, so a
    // test that compares this function's (canonical) output against a raw
    // `tmpdir()`-derived path passes vacuously on ubuntu and fails only on
    // macOS. This test did exactly that and CI caught it on the macOS leg —
    // a raw-vs-canonical comparison inside a test about canonicalization,
    // which is the trap AGENTS.md names as the whole reason that leg exists.
    //
    // Not self-referential: `realpathSync.native` is applied to a directory
    // that EXISTS, while what is under test below is the chase across
    // symlinks that do not. A broken chase still fails — see the mutation
    // note on that test.
    root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rhizomorph-containment-loop-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('throws ELOOP instead of spinning when a dangling symlink resolves to itself', async () => {
    const dir = path.join(root, 'x')
    await mkdir(dir, { recursive: true })
    const link = path.join(dir, 'link')
    // Traverses a MISSING directory back to itself. `realpath` stats
    // `x/missing`, fails ENOENT, and never gets far enough to detect a loop.
    await symlink(path.join('.', 'missing', '..', 'link'), link)

    expect(() => canonicalize(link)).toThrow(/ELOOP/)
    expect(() => isInside(dir, link)).toThrow(/ELOOP/)
  })

  it('still resolves a legitimate chain shorter than the bound', async () => {
    const target = path.join(root, 'real-target')
    let previous = target
    for (let hop = 0; hop < 5; hop += 1) {
      const link = path.join(root, `hop-${hop}`)
      await symlink(previous, link)
      previous = link
    }

    // The chain is dangling (no `real-target` on disk) but finite, so it must
    // resolve rather than trip the bound — the guard must not make ordinary
    // dangling symlinks unusable.
    //
    // Mutation that proves this is not vacuous: set MAX_SYMLINK_HOPS to 0 and
    // the chase stops at the first link, so this returns `<root>/hop-4` and
    // the assertion fails. Executed.
    expect(canonicalize(previous)).toBe(target)
  })

  /**
   * The macOS shape, simulated so LINUX can catch it too.
   *
   * The test above originally compared this function's canonical output to a
   * raw `tmpdir()` path. That passes on ubuntu, where `os.tmpdir()` is not a
   * symlink, and fails only on macOS, where `/var` -> `/private/var`. CI found
   * it; nothing local could have.
   *
   * So the condition is reproduced here rather than left to one CI leg: a root
   * reached THROUGH a symlink, which is precisely what makes macOS's tmpdir
   * different. Same technique `lab/paths.test.ts` uses to reproduce #228's
   * canonicalizer disagreement without needing a macOS host. If someone
   * reintroduces a raw-vs-canonical comparison here, this goes red everywhere.
   */
  it('resolves the same way when the root itself is reached through a symlink (the macOS tmpdir shape)', async () => {
    const real = path.join(root, 'private-tmp')
    await mkdir(real, { recursive: true })
    const viaLink = path.join(root, 'tmp') // stands in for /var -> /private/var
    await symlink(real, viaLink)

    const rawTarget = path.join(viaLink, 'real-target')
    let previous = rawTarget
    for (let hop = 0; hop < 3; hop += 1) {
      const link = path.join(viaLink, `hop-${hop}`)
      await symlink(previous, link)
      previous = link
    }

    // The raw spelling and the canonical one genuinely differ here — the
    // premise of the whole test. Asserted, so it cannot quietly stop being a
    // symlinked root and leave the case below passing for the wrong reason.
    expect(rawTarget).not.toBe(path.join(real, 'real-target'))
    expect(canonicalize(previous)).toBe(path.join(real, 'real-target'))
  })
})

/**
 * Step 5 of #401: a law asserting `isInside`/`canonicalize` are defined in
 * exactly one place under `packages/server/src/` — the thing that stops a
 * third copy the way this issue found a second one. Grep-law style, per
 * `lab/namespace-law.test.ts`/`api/route-class-law.test.ts`: real source
 * text, no AST, count-based so it cannot pass by matching nothing.
 */
describe('no second definition of isInside/canonicalize exists (#401 step 5)', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  // packages/server/src/paths -> packages/server/src
  const SERVER_SRC = path.resolve(HERE, '..')

  const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

  function walkSourceFiles(dir: string): string[] {
    const out: string[] = []
    const visit = (current: string) => {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = path.join(current, entry)
        const info = statSync(full)
        if (info.isDirectory()) {
          visit(full)
        } else if (SOURCE_EXTENSIONS.has(path.extname(full)) && !full.endsWith('.test.ts')) {
          out.push(full)
        }
      }
    }
    visit(dir)
    return out
  }

  // Matches a function declaration or a const-arrow/function-expression
  // assignment naming the symbol — either style would count as "a
  // definition" for the law's purposes.
  /**
   * `\w*` after the name is load-bearing, not defensive padding. Without it
   * this law was GREEN on the exact two-copy state #401 was filed to fix: the
   * duplicate #299 actually produced was named `canonicalizeExistingAncestor`,
   * so `canonicalize\s*\(` never matched it — the next character was `E`.
   * Verified by re-adding that declaration verbatim; all ten tests passed.
   *
   * A name-keyed law can never be shape-proof, but it must at least catch the
   * name it was written about. Prefix-matching also covers the other spellings
   * this primitive keeps attracting: `canonicalizeUnderRoot`, `isInsideRepo`.
   */
  function definitionPattern(name: string): RegExp {
    return new RegExp(`\\bfunction\\s+${name}\\w*\\s*\\(|\\bconst\\s+${name}\\w*\\s*[:=]`)
  }

  function filesDefining(name: string, files: readonly string[]): string[] {
    const pattern = definitionPattern(name)
    return files.filter((file) => pattern.test(readFileSync(file, 'utf8')))
  }

  it('the sweep is non-empty — the count assertions below would pass vacuously otherwise', () => {
    expect(walkSourceFiles(SERVER_SRC).length).toBeGreaterThan(0)
  })

  it('exactly one file under packages/server/src defines isInside', () => {
    const files = walkSourceFiles(SERVER_SRC)
    const defining = filesDefining('isInside', files)
    expect(defining.map((f) => path.relative(SERVER_SRC, f))).toEqual([path.join('paths', 'containment.ts')])
  })

  it('exactly one file under packages/server/src defines canonicalize', () => {
    const files = walkSourceFiles(SERVER_SRC)
    const defining = filesDefining('canonicalize', files)
    expect(defining.map((f) => path.relative(SERVER_SRC, f))).toEqual([path.join('paths', 'containment.ts')])
  })

  it('the detector fires on a deliberately-duplicated definition — proving it bites', () => {
    const rigged = `export function isInside(parent: string, candidate: string): boolean {\n  return true\n}\n`
    expect(definitionPattern('isInside').test(rigged)).toBe(true)
  })

  it('the detector does not fire on a mere call or import — not vacuously true', () => {
    const usage = `import { isInside } from '../paths/containment.js'\n\nif (!isInside(root, candidate)) {\n  throw new Error('nope')\n}\n`
    expect(definitionPattern('isInside').test(usage)).toBe(false)
  })

  /**
   * THE REGRESSION CASE. This law was green on the real duplication it exists
   * to prevent, because #299's copy was named `canonicalizeExistingAncestor`
   * rather than `canonicalize`. A bite-test that only exercises the exact name
   * is why that narrowness survived authoring — so the near-miss spelling is
   * pinned here permanently.
   */
  it('fires on a differently-suffixed copy — the spelling #299 actually used', () => {
    const real = `async function canonicalizeExistingAncestor(target: string): Promise<string> {\n  return target\n}\n`
    expect(definitionPattern('canonicalize').test(real)).toBe(true)

    const arrow = `const isInsideRepo = (a: string, b: string): boolean => a === b\n`
    expect(definitionPattern('isInside').test(arrow)).toBe(true)
  })
})
