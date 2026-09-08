import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * EVERY LAB SURFACE READING %-OF-SESSION CALLS ONE FUNCTION (prd53 S1
 * acceptance — a grep law). Two surfaces that each divide `sessionCutByte`
 * by the session length are two surfaces that can disagree about where 46 %
 * is. So the division lives in `axis/position.ts` alone; every other source
 * file under `lab/` that mentions the cut byte must import from the axis.
 */
const LAB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THE_ONE = path.join(LAB_ROOT, 'axis', 'position.ts')

/** Files that CARRY the byte facts without positioning by them: the type, the wire parser, and their tests. */
const CARRIERS = new Set(['types.ts', 'api.ts'].map((name) => path.join(LAB_ROOT, name)))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const DIVIDES_BY_SESSION = /sessionCutByte[^\n]*\/[^\n]*(sessionByteLength|byteLength|length)|(sessionByteLength|byteLength)[^\n]*\/[^\n]*sessionCutByte/
const IMPORTS_THE_AXIS = /from ['"](?:\.\.?\/)+axis\/(?:index|position)(?:\.js)?['"]|from ['"]\.\/(?:position)(?:\.js)?['"]/

describe('one function positions on the session (prd53 ruling 4, S1)', () => {
  const files = walk(LAB_ROOT)

  it('the sweep walks the real lab tree — surfaces, compare, trace, metrics, axis, frame', () => {
    const dirs = new Set(files.map((file) => path.relative(LAB_ROOT, file).split(path.sep)[0]))
    expect([...dirs]).toEqual(expect.arrayContaining(['axis', 'frame', 'compare', 'trace', 'metrics']))
  })

  it('no source file but axis/position.ts divides the cut byte by the session length', () => {
    for (const file of files) {
      if (file === THE_ONE) continue
      expect(readFileSync(file, 'utf8'), `${path.relative(LAB_ROOT, file)} positions by its own arithmetic`).not.toMatch(DIVIDES_BY_SESSION)
    }
  })

  it('every source file that mentions sessionCutByte, other than the carriers, imports the axis', () => {
    for (const file of files) {
      if (file === THE_ONE || CARRIERS.has(file)) continue
      const source = readFileSync(file, 'utf8')
      if (!source.includes('sessionCutByte')) continue
      expect(source, `${path.relative(LAB_ROOT, file)} reads the cut byte without importing the axis`).toMatch(IMPORTS_THE_AXIS)
    }
  })

  it('bites: a local division is caught', () => {
    expect('const x = checkpoint.sessionCutByte / checkpoint.sessionByteLength').toMatch(DIVIDES_BY_SESSION)
  })
})
