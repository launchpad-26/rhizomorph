import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUTTON, BUTTON_PRIMARY, BUTTON_QUIET, FIELD } from './controls.js'

/**
 * THE CONTROL LAWS (loop 11) — what makes a primitive a primitive.
 *
 * Before this module, four components each declared their own button classes
 * and differed only in what each forgot (a focus ring, an opacity, a target
 * size). These laws hold the two properties that stop that from regrowing:
 * the floors are on every variant, and the vocabulary has exactly one home.
 */

const CONTROLS = [
  ['BUTTON', BUTTON],
  ['BUTTON_QUIET', BUTTON_QUIET],
  ['BUTTON_PRIMARY', BUTTON_PRIMARY],
  ['FIELD', FIELD],
] as const

const FLOORS = ['focus-ring', 'min-h-6', 'rounded-none'] as const

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(): { name: string; text: string }[] {
  const files: { name: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push({ name: path.relative(SRC, full), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(SRC)
  return files
}

describe('every control carries the floors', () => {
  it.each(CONTROLS)('%s has the focus ring, the 24px target, and the square corner', (_name, cls) => {
    for (const floor of FLOORS) expect(cls, `missing ${floor}`).toContain(floor)
  })

  it.each([['BUTTON', BUTTON], ['BUTTON_QUIET', BUTTON_QUIET], ['BUTTON_PRIMARY', BUTTON_PRIMARY]] as const)(
    '%s moves at the theme touch speed',
    (_name, cls) => {
      expect(cls).toContain('duration-(--duration-touch)')
    },
  )

  it('wears no status hue — a control is chrome, colour that means something belongs to facts', () => {
    // The armed confirm included: the house style renders "about to do
    // something consequential" as emphasis, not alarm. A red button would be
    // a status word spoken by chrome, which law 9a exists to forbid.
    for (const [name, cls] of CONTROLS) {
      expect(cls, `${name} wears a status colour`).not.toMatch(/broken|waiting|done|stuck|attention/)
    }
  })
})

describe('the vocabulary has one home', () => {
  it('no component declares its own button/field class constant any more', () => {
    // The four local vocabularies this module replaced, banned by name — plus
    // the sibling spellings a fifth would most plausibly take.
    const local = /\b(BUTTON|PRIMARY|CONFIRM|ARMED|FIELD)_CLASS\s*=/
    const offenders = sourceFiles()
      .filter((file) => !file.name.startsWith('ui/'))
      .filter((file) => local.test(file.text))
    expect(offenders.map((file) => file.name), 'a local control vocabulary regrew — import ui/controls').toEqual([])
  })
})
