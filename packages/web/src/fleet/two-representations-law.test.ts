import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPRESENTATION_INSTANCES } from './TwoRepresentations.js'

/**
 * THE TWO-REPRESENTATION LAW (prd-36 S3's acceptance criterion, #555).
 *
 * S3 asks for "a law test [that] enumerates the registered instances and fails
 * on a toggle implemented outside the component — the same posture as the
 * mutating-calls law". Ruling 3's whole reason for one shared component is that
 * a second implementation is how the keyboard behaviour, the persistence shape
 * and the "state survives the switch" guarantee drift apart; a behavioural test
 * of `TwoRepresentations` cannot see a fourth instance that never imported it.
 *
 * Two claims, then:
 *
 * 1. **Every registered instance is real** — declared with two representations,
 *    a single-key verb, and either a persistence key or the honest gap saying
 *    it has none. The registry is of what is *implemented*, so an entry with no
 *    surface behind it is a lie the enumeration would carry.
 * 2. **The toggle chrome exists in exactly one file.** A surface that draws its
 *    own organism/list switch instead of importing this one fails, by the same
 *    marker-sweep `disclosure/one-card-law.test.ts` uses for card chrome.
 *
 * As with that law, every scanner here is a pure function over `{name, text}`
 * pairs and is tested against a rigged file that should trip it. A grep law
 * that has never been shown to fire is decoration: it passes on an empty walk,
 * on a typo'd regex, and on a directory it never reached.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(HERE, '..')
const COMPONENT = 'fleet/TwoRepresentations.tsx'

interface SourceFile {
  name: string
  text: string
}

/** Every `.ts`/`.tsx` under `web/src`, recursively — tests included, so a test cannot host a second toggle either. */
function sourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      files.push({ name: path.relative(root, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') })
    }
  }

  walk(root)
  return files
}

/**
 * Comments blanked rather than stripped, so a failure message's line count still
 * matches the file the reader opens. Same shape, and the same reason, as
 * `disclosure/one-card-law.test.ts`: this file's own prose names the marker it
 * forbids, and so does the component's.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

/**
 * Files that draw a representation toggle without being the one component.
 *
 * Test files are out of the sweep, and only test files are: a test has to be
 * able to *name* the marker it proves is absent, which this file's own fixtures
 * below do, and nothing a test renders reaches a reader's screen. `disclosure/`'s
 * card law buys the same exemption a different way — its law test lives inside
 * the directory it exempts — and this is the version that survives the law test
 * being moved.
 */
export function toggleChromeOutsideComponent(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.name !== COMPONENT && !/\.test\.tsx?$/.test(file.name))
    .filter((file) => /data-representation-toggle/.test(withoutComments(file.text)))
    .map((file) => file.name)
}

describe('the walk reaches the tree it claims to', () => {
  it('sees the whole of web/src, not one directory of it', () => {
    // An empty or shallow walk is how the law below passes vacuously.
    const files = sourceFiles(WEB_SRC)
    expect(files.length).toBeGreaterThan(50)
    expect(files.map((file) => file.name)).toEqual(
      expect.arrayContaining([COMPONENT, 'fleet/FleetSurface.tsx', 'app/PanelGrid.tsx']),
    )
  })
})

describe('one toggle, and it lives in the shared component', () => {
  it('finds representation-toggle chrome nowhere else in the package', () => {
    expect(toggleChromeOutsideComponent(sourceFiles(WEB_SRC))).toEqual([])
  })

  it('would name a surface that rolled its own instead of importing this one', () => {
    // The mutation, run as a fixture: without this, the assertion above is "no
    // file matched a regex nothing was ever checked against".
    expect(
      toggleChromeOutsideComponent([
        { name: 'trace/TraceSurface.tsx', text: '<div data-representation-toggle="trace">…</div>' },
        { name: COMPONENT, text: '<div data-representation-toggle={surface}>…</div>' },
      ]),
    ).toEqual(['trace/TraceSurface.tsx'])
  })

  it('does not count a toggle named in prose — the scanner reads code, not comments', () => {
    expect(
      toggleChromeOutsideComponent([
        { name: 'a.ts', text: '// a surface drawing data-representation-toggle itself would fail\nconst x = 1' },
      ]),
    ).toEqual([])
  })
})

describe('every registered instance is real', () => {
  it('enumerates the instances, each with the whole of S3’s contract', () => {
    expect(REPRESENTATION_INSTANCES.length).toBeGreaterThan(0)

    for (const instance of REPRESENTATION_INSTANCES) {
      expect(instance.representations, `${instance.surface} is not two representations`).toHaveLength(2)
      expect(new Set(instance.representations).size, `${instance.surface} repeats an id`).toBe(2)
      // One key, no modifiers — the instrument's other single-key verbs
      // (`n`, `f`, `a`, the scene's camera keys) are the register this joins.
      expect(instance.keystroke, `${instance.surface}'s keystroke is not one lowercase key`).toMatch(/^[a-z]$/)
      // A persistence key, or the honest reason there is none. Never neither:
      // silence is what prd-35's ruling 2 exists to stop, and never both,
      // because a declared key with a gap beside it is two answers.
      expect(
        (instance.persistence === null) !== (instance.gap === null),
        `${instance.surface} must declare a persistence key or the gap where one is missing, not both and not neither`,
      ).toBe(true)
      if (instance.persistence !== null) {
        expect(instance.persistence.key, `${instance.surface}'s key is not a registry id`).toMatch(/^[a-z]+\.\w+$/)
      }
    }
  })

  it('claims no keystroke twice — one key cannot switch two surfaces', () => {
    const keys = REPRESENTATION_INSTANCES.map((instance) => instance.keystroke)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leaves the instrument’s existing single-key verbs alone', () => {
    // `n`/`shift+n` are the page-global idle-worker jump (`app/keyboard.ts`),
    // `f`/`a` the fleet table's own row verbs. A representation keystroke that
    // collided with one of those would fire both handlers on one press.
    const taken = new Set(['n', 'f', 'a'])
    for (const instance of REPRESENTATION_INSTANCES) {
      expect(taken.has(instance.keystroke), `${instance.surface} claims a key already bound`).toBe(false)
    }
  })
})
