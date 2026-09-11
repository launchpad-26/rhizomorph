import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { labHelpText } from './lab.js'

const CLI_INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts')

describe('labHelpText', () => {
  it('labHelpText documents every subcommand the namespace has', () => {
    const text = labHelpText()
    expect(text).toContain('checkpoint <lane>')
    expect(text).toContain('fork <lane>')
    expect(text).toContain('compare <fork-id>')
    expect(text).toContain('rd <lane>')
  })

  /**
   * DERIVED from `cli/index.ts`'s own dispatch, not from a list retyped beside
   * it. The namespace's index is the only place a reader learns `rd` exists,
   * and a row naming a subcommand `runLabCommand` does not dispatch is exactly
   * the stale-row failure `cli-surface-law.test.ts` catches for the TOP-level
   * surface — this is that check one level down, in both directions, which is
   * where `lab rd` lives and where that law cannot see.
   */
  it('names exactly the subcommands runLabCommand dispatches on, in both directions', () => {
    const source = readFileSync(CLI_INDEX, 'utf8')
    const body = source.slice(source.indexOf('async function runLabCommand'))
    const dispatched = new Set([...body.matchAll(/rest\[0\] === '([a-z][a-z0-9-]*)'/g)].map((m) => m[1] as string))
    expect(dispatched).toEqual(new Set(['checkpoint', 'fork', 'compare', 'rd']))

    const documented = new Set([...labHelpText().matchAll(/^ {2}([a-z][a-z0-9-]*) </gm)].map((m) => m[1] as string))
    expect(documented).toEqual(dispatched)
  })

  it('says whose money the R&D hand spends, in the one place an operator reads before typing it', () => {
    const text = labHelpText()
    expect(text).toContain("spawns the operator's own CLI and spends the operator's own money")
    expect(text).toContain('This instrument holds no credential')
    expect(text).toContain('ADR-0048')
  })
})
