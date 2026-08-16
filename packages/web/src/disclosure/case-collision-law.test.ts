import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * NO TWO MODULES MAY DIFFER ONLY BY CASE (the #584 scar, turned into a law).
 *
 * **What happened.** This directory landed with `Disclosure.tsx` and
 * `disclosure.ts` side by side, and `Disclosure.tsx` importing
 * `'./disclosure.js'`. The resolver expands a `.js` specifier to `./disclosure.ts`
 * *and* `./disclosure.tsx`. On a case-sensitive filesystem only the first
 * exists, so Linux resolved it correctly and both ubuntu legs passed. On a
 * case-INsensitive one — macOS, and Windows, which prd-34 ships a desktop app
 * to — `./disclosure.tsx` also matches `Disclosure.tsx`, the importing file
 * itself, so the module self-resolved and `DisclosureCard` came back
 * `undefined`: all 16 tests in `Disclosure.test.tsx` failed on macos-latest
 * with "Element type is invalid". A user's machine would have failed the same
 * way. Fixed by renaming the vocabulary module to `vocabulary.ts` — the
 * ambiguity itself was the defect, so neither a re-cased specifier nor a
 * resolver alias would have been a fix.
 *
 * **Two laws, because the obvious one does not catch it.** The natural law to
 * write is "no two tracked paths differ only by case", and it is worth having:
 * on a case-insensitive checkout git cannot materialise both, so one silently
 * clobbers the other. But run it against the commit CI actually failed on and
 * it returns **empty** — `Disclosure.tsx` and `disclosure.ts` do not differ
 * only by case, they differ by case *and* extension, and lowercased they are
 * still two distinct paths. It is {@link moduleStemCollisions} that names the
 * pair, because the thing the resolver is ambiguous about is the base name with
 * the extension taken off. Both are asserted below; the second is the one with
 * the bite, and the first would have passed the whole way through this defect.
 *
 * **Why it lives in `disclosure/`.** It is a repo-wide law in a fenced
 * directory, which is not where it belongs — but #554's fence is
 * `packages/web/src/disclosure/**`, this is where the scar is, and a law
 * written now beats a law filed for later. It walks `git ls-files` from the
 * repo root, so it covers every package regardless of where it sits, and it
 * moves to a repo-level home the first time anything else needs it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** Every tracked path, repo-root-relative, forward-slashed on every platform. */
function trackedFiles(): string[] {
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return listing.split('\0').filter((entry) => entry !== '')
}

function groupsOf(paths: readonly string[], keyOf: (p: string) => string | null): string[][] {
  const byKey = new Map<string, string[]>()
  for (const entry of paths) {
    const key = keyOf(entry)
    if (key === null) continue
    const group = byKey.get(key)
    if (group === undefined) byKey.set(key, [entry])
    else group.push(entry)
  }
  return [...byKey.values()].filter((group) => group.length > 1).map((group) => [...group].sort())
}

/**
 * Paths that are the same file to a case-insensitive filesystem. A checkout on
 * macOS or Windows can only materialise one of them.
 */
export function caseCollisions(paths: readonly string[]): string[][] {
  return groupsOf(paths, (entry) => entry.toLowerCase())
}

/** The extensions a `.js` import specifier resolves across in this repo. */
const MODULE_EXTENSION = /\.(m|c)?(ts|js)x?$/

/**
 * Modules in one directory whose names collide once the extension is off and
 * the case is flattened — the ambiguity #584 was. Same-case pairs (`foo.ts`
 * beside `foo.tsx`) are collisions too, and are ambiguous on *every* platform
 * rather than only the case-insensitive ones.
 */
export function moduleStemCollisions(paths: readonly string[]): string[][] {
  return groupsOf(paths, (entry) =>
    MODULE_EXTENSION.test(entry) ? entry.replace(MODULE_EXTENSION, '').toLowerCase() : null,
  )
}

describe('the walk reaches the repo it claims to', () => {
  it('lists the whole tracked tree, from the root, not this package', () => {
    // Both laws below pass on an empty list, so the list is checked first.
    const files = trackedFiles()

    expect(files.length).toBeGreaterThan(300)
    expect(files).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'packages/web/src/disclosure/vocabulary.ts',
        'packages/core/src/collector.ts',
      ]),
    )
  })
})

describe('no two tracked paths differ only by case', () => {
  it('holds across the repo', () => {
    expect(caseCollisions(trackedFiles())).toEqual([])
  })

  it('would name a pair a case-insensitive checkout could not hold', () => {
    expect(
      caseCollisions(['packages/web/src/tide/Loupe.tsx', 'packages/web/src/tide/loupe.tsx', 'AGENTS.md']),
    ).toEqual([['packages/web/src/tide/Loupe.tsx', 'packages/web/src/tide/loupe.tsx']])
  })

  it('is not the law that catches #584 — recorded so nobody trusts it to', () => {
    // The pair CI actually failed on, run through this scanner: clean. This
    // assertion exists to keep that fact from being rediscovered the hard way.
    expect(
      caseCollisions([
        'packages/web/src/disclosure/Disclosure.tsx',
        'packages/web/src/disclosure/disclosure.ts',
      ]),
    ).toEqual([])
  })
})

describe('no two modules in one directory differ only by case (#584)', () => {
  it('holds across the repo', () => {
    expect(moduleStemCollisions(trackedFiles())).toEqual([])
  })

  it('names the exact pair that broke macos-latest', () => {
    expect(
      moduleStemCollisions([
        'packages/web/src/disclosure/Disclosure.tsx',
        'packages/web/src/disclosure/disclosure.ts',
        'packages/web/src/disclosure/index.ts',
      ]),
    ).toEqual([
      ['packages/web/src/disclosure/Disclosure.tsx', 'packages/web/src/disclosure/disclosure.ts'],
    ])
  })

  it('names a same-case `foo.ts` beside `foo.tsx` too — that one is ambiguous everywhere', () => {
    expect(moduleStemCollisions(['a/foo.ts', 'a/foo.tsx'])).toEqual([['a/foo.ts', 'a/foo.tsx']])
  })

  it('leaves the same name in two different directories alone', () => {
    // `fleet/index.ts` and `panels/fleet/index.ts` are not a collision, and a
    // law that said they were would be unlandable rather than strict.
    expect(moduleStemCollisions(['packages/web/src/fleet/index.ts', 'packages/web/src/panels/fleet/index.ts'])).toEqual(
      [],
    )
  })

  it('leaves non-modules alone — two docs may differ by case', () => {
    expect(moduleStemCollisions(['docs/adr/README.md', 'docs/adr/readme.md'])).toEqual([])
  })
})
