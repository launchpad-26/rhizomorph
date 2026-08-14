import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingTokenMessage, staleTokenMessage } from './capability-guidance.js'

/**
 * #406. The copy these two functions hold was duplicated byte-for-byte across
 * `replay/rotate.ts` and `lab/launch/launch.ts`, and absent from the third
 * caller. This file pins what the copy must SAY, and the law at the bottom
 * pins that no caller has quietly grown its own version again.
 */

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('missingTokenMessage', () => {
  it('names the action, the cause, and a command that fixes it', () => {
    const message = missingTokenMessage('save the label')

    expect(message).toContain('could not save the label')
    // The remedy is the whole point of the message — #406 exists because the
    // caller that lacked it said only that a token was missing.
    expect(message).toContain('npm run dev:web')
    expect(message).toContain('npm run build')
    expect(message).toMatch(/reload this page/i)
  })

  it('is the same sentence for every caller but the verb', () => {
    const [save, launch] = [missingTokenMessage('save the label'), missingTokenMessage('launch')]

    expect(save.replace('save the label', 'launch')).toBe(launch)
  })
})

describe('staleTokenMessage', () => {
  it("keeps the instrument's own account and adds the remedy after it", () => {
    const message = staleTokenMessage('end the session', 'missing or invalid x-rhizomorph-capability header')

    expect(message).toContain('missing or invalid x-rhizomorph-capability header')
    expect(message).toMatch(/reload this page/i)
    // Order matters: the true account first, the advice second. A message
    // leading with advice reads as if the tool is guessing.
    expect(message.indexOf('x-rhizomorph-capability')).toBeLessThan(message.indexOf('Reload this page'))
  })

  it('does not swallow a server sentence it does not recognise', () => {
    expect(staleTokenMessage('launch', 'the server answered 401')).toContain('the server answered 401')
  })
})

/**
 * THE LAW. Two callers held identical copies and a third held none; the fix
 * is only durable if a fourth caller cannot reintroduce the split by pasting
 * the sentence in. The distinctive clause is the dev-mode one — it is
 * specific enough that no unrelated file would contain it by accident.
 *
 * Asserted with a count, not just a set: a law that swept an empty tree, or
 * whose glob quietly stopped matching, would otherwise agree that nothing
 * violates it forever (ruling 5).
 */
describe('the guidance copy lives in exactly one module (#406)', () => {
  /**
   * ONE CLAUSE PER EXPORTED MESSAGE. The first version of this law checked
   * only the dev-mode clause, which belongs to `missingTokenMessage` — so
   * `staleTokenMessage`'s body was pinned by nothing, and a caller with a 401
   * path and no pre-flight path (precisely the asymmetry `label.ts` itself
   * had, in mirror image) could inline the stale-token sentence and leave
   * this law green. Verified by execution before the fix: an inline duplicate
   * of the stale-token copy in `replay/rotate.ts` left all six tests here
   * passing.
   *
   * That is this repo's named defect shape #1 — a guard that handles the case
   * its author considered and misses the structurally identical sibling —
   * occurring inside the guard written against that shape. Adding a message
   * to `capability-guidance.ts` means adding its clause here.
   */
  const DISTINCTIVE: ReadonlyArray<{ clause: string; from: string }> = [
    { clause: 'serves it through vite, which skips that step', from: 'missingTokenMessage' },
    { clause: 'mints that token fresh every time it starts', from: 'staleTokenMessage' },
  ]

  /** Every source file under `WEB_SRC` containing `needle` — or all of them, when `needle` is null. */
  function sourceFilesContaining(needle: string | null): string[] {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        // Source only: this file quotes the clause itself, and a law that
        // counted its own fixture would be counting itself.
        if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue
        if (full.endsWith('.test.ts') || full.endsWith('.test.tsx')) continue
        // `path.sep` normalised so this reads the same on the windows-latest
        // leg (prd-25's named CI gap) as on ubuntu.
        if (needle === null || readFileSync(full, 'utf8').includes(needle)) {
          hits.push(path.relative(WEB_SRC, full).split(path.sep).join('/'))
        }
      }
      return
    }
    walk(WEB_SRC)
    return hits.sort()
  }

  it.each(DISTINCTIVE)('$from is written out in capability-guidance.ts and nowhere else', ({ clause }) => {
    const hits = sourceFilesContaining(clause)

    expect(hits).toEqual(['recordings/capability-guidance.ts'])
    expect(hits).toHaveLength(1)
  })

  it('the sweep actually finds things — it is not passing by matching nothing', () => {
    // The mutation guard on the law above: if the walk were broken, the
    // assertion that only one file matches would pass for the wrong reason.
    //
    // Deliberately keyed to the WALK, not to the subject. An earlier version
    // counted callers of `missingTokenMessage` and required more than three —
    // there are exactly four, so legitimately removing one caller would have
    // failed this test with "the sweep is not finding things", misdiagnosing
    // a caller change as a broken walk.
    expect(sourceFilesContaining(null).length).toBeGreaterThan(50)
  })
})
