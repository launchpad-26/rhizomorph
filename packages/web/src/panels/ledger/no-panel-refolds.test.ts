import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE FOLD LAW, ASSERTED AT THE LEVEL OF THE SOURCE TEXT (#171, the audit's
 * P1 — same style as the drawer's `readonly.test.ts`).
 *
 * `streamState.ts`'s own doc comment states it: "Keeping the fold here rather
 * than re-reducing per panel is also what lets four surfaces read one derived
 * fleet object." The ledger was the one panel that didn't — it called
 * `reduceAll(state.events)` and threw away the shell's incrementally
 * maintained `state.session`. That is a property a behavioural test can't
 * pin (a panel added tomorrow can re-fold in a component nothing here
 * renders), so this greps every panel's own source instead: no panel may
 * import `reduceAll` at all. The shell owns the fold; a panel reads
 * `state.session` (or a selector over it) and nothing else.
 *
 * Deliberately crude, deliberately loud: a future panel that has a genuine
 * reason to fold events itself (there isn't one today — `reduceAll` exists
 * for the shell, replay, and tests, not for panels) fails here and has to say
 * so in a diff a reviewer reads.
 */

const PANELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function panelSourceFiles(dir: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...panelSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    files.push({ path: path.relative(PANELS_DIR, full), text: readFileSync(full, 'utf8') })
  }
  return files
}

describe('no panel re-folds the log itself — the shell owns the fold', () => {
  it('has panel source files to check at all — an empty grep proves nothing', () => {
    expect(panelSourceFiles(PANELS_DIR).length).toBeGreaterThan(10)
  })

  it('names no `reduceAll` in any panel source file', () => {
    for (const file of panelSourceFiles(PANELS_DIR)) {
      expect(
        file.text,
        `${file.path} re-folds the log itself (reduceAll) instead of reading state.session`,
      ).not.toMatch(/\breduceAll\b/)
    }
  })
})
