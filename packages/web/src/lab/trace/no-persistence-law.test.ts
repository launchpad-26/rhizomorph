import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE PARENT IS READ, NEVER COPIED (prd53 S3, acceptance: "no lab source file
 * contains transcript text"). Trace holds two transcripts in memory for as
 * long as it is mounted and writes neither anywhere: no browser storage, no
 * artifact, no serialiser. The check is over the SOURCE of this directory —
 * a persistence call that does not exist cannot be reached — and it names
 * every spelling this app has for putting bytes somewhere.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

const PERSISTENCE: readonly RegExp[] = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bdocument\.cookie\b/,
  /from ['"][^'"]*compare\/artifact(?:\.js)?['"]/,
  /\bserialiseComparison\b/,
  /\bwritePreference\b/,
]

function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
    .map((name) => path.join(HERE, name))
}

describe('lab/trace persists nothing (prd53 S3)', () => {
  it('the sweep sees the surface, the diff and the steps — not an empty directory', () => {
    const names = sourceFiles().map((file) => path.basename(file))
    expect(names).toEqual(expect.arrayContaining(['TraceDiff.tsx', 'diff.ts', 'steps.ts']))
  })

  it('no source file in lab/trace reaches for browser storage, the comparison artifact, or a preference write', () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of PERSISTENCE) {
        expect(source, `${path.basename(file)} matches ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('bites: a fixture that stores a transcript entry is caught', () => {
    const offending = "const remembered = localStorage.setItem('trace', JSON.stringify(entries))"
    expect(PERSISTENCE.some((pattern) => pattern.test(offending))).toBe(true)
  })
})
