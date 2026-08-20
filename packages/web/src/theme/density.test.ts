import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { blockBody, declarationsOf } from './tokens.js'

/**
 * THE DENSITY LAWS (loop 10) — the tokens that finally read `data-density`.
 *
 * `settings/apply.ts` has written `data-density` to the root since #550, and
 * `registry.ts` carried a gap note ("nothing reads it yet") for exactly as
 * long. These laws hold the closure honest, in both directions:
 *
 *   1. Compact re-declares the SAME set of tokens the theme declares —
 *      no spacing token exists that compact forgets, and compact invents none.
 *   2. Compact only ever tightens. A "compact" that widens a row is a bug with
 *      no other test to fail.
 *   3. Every density token has a live consumer in the app source. A spacing
 *      token nothing reads is the age-pulse-seam bug inverted — the registry
 *      would claim an effect the page does not have, which is the exact state
 *      the gap note existed to confess.
 *
 * Deliberately absent: a law that density reaches the READING registers.
 * It must not — density is an instrument-surface service (rows, cells,
 * gutters); prose keeps its air at any density.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THEME = readFileSync(path.join(SRC, 'theme', 'theme.css'), 'utf8')

const DENSITY_TOKENS = ['--space-row-y', '--space-cell', '--space-gutter'] as const

function themeDefaults(): ReadonlyMap<string, string> {
  const theme = blockBody(THEME, '@theme')
  expect(theme).not.toBeNull()
  return declarationsOf(theme as string)
}

function compactOverrides(): ReadonlyMap<string, string> {
  const block = blockBody(THEME, "[data-density='compact']")
  expect(block, "theme.css has no [data-density='compact'] block").not.toBeNull()
  return declarationsOf(block as string)
}

describe('density: compact re-declares the spacing tokens, and only tightens', () => {
  it('overrides exactly the declared density tokens — none forgotten, none invented', () => {
    expect([...compactOverrides().keys()].sort()).toEqual([...DENSITY_TOKENS].sort())
  })

  it.each(DENSITY_TOKENS)('%s is strictly smaller in compact', (token) => {
    const comfortable = Number.parseFloat(themeDefaults().get(token) ?? 'NaN')
    const compact = Number.parseFloat(compactOverrides().get(token) ?? 'NaN')
    expect(comfortable).toBeGreaterThan(0)
    expect(compact).toBeGreaterThan(0)
    expect(compact, `${token} does not tighten under compact`).toBeLessThan(comfortable)
  })

  it.each(DENSITY_TOKENS)('%s has a live consumer — a token nothing reads is a confessed gap reopened', (token) => {
    const consumers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (full !== path.join(SRC, 'theme', 'theme.css') && readFileSync(full, 'utf8').includes(token)) {
            consumers.push(entry.name)
          }
        }
      }
    }
    walk(SRC)
    expect(consumers.length, `${token} is defined but nothing outside theme.css reads it`).toBeGreaterThan(0)
  })

  it('is rem in both densities — the OS text preference survives compaction', () => {
    for (const token of DENSITY_TOKENS) {
      expect(themeDefaults().get(token)).toMatch(/^[0-9.]+rem$/)
      expect(compactOverrides().get(token)).toMatch(/^[0-9.]+rem$/)
    }
  })
})
