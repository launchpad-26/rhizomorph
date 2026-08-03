import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LEGIBILITY FLOOR, ASSERTED AT THE LEVEL OF THE SOURCE TEXT.
 *
 * prd9's operator ruling (2026-08-03, after reviewing the live UI: "blue text
 * on dark blue is hard to read") re-roles the ice ramp's dim end rather than
 * re-tinting it: every hex in `theme.css` stays exactly as it was, but text
 * may not wear anything dimmer than `ice-400` (5.1:1 against the `ice-1000`
 * page floor). `ice-500` (3.3:1), `ice-600` (2.4:1) and every step dimmer than
 * that measure below WCAG's 4.5:1 body-text threshold, so they are
 * structure-and-disabled-marks tokens now, never text.
 *
 * That is not a property a rendered-output test can hold onto — a component
 * added tomorrow that reaches for `text-ice-600` on a label would pass every
 * behavioural test and still be unreadable. So, same tactic
 * `drawer/readonly.test.ts` uses for the read-only constitution: grep the
 * source directly, loudly, in a diff a reviewer reads, rather than trust a
 * rendered assertion a differently-shaped regression could slip past.
 *
 * Scoped to the ice ramp specifically — the register this ruling is about.
 * `panels/ledger/index.tsx` still paints in stock Tailwind `slate-*` and the
 * pre-prd3 `void`/`neon-cyan` aliases; `theme.css`'s own "legacy aliases"
 * comment already tracks that debt for #77–#83's dissolution to retire, and
 * re-theming it wholesale here would be exactly the "organs, not air and ink"
 * this issue's brief rules out. It is out of this law's pattern by
 * construction, not by a silent allowlist.
 *
 * `scene/` is excluded by the fence (#136 never touches canvas geometry), so
 * nothing under it is walked here either — the gate's own `git diff --stat`
 * is the proof for that half, this file is the proof for everything else.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The ice ramp's sub-floor steps, and the hex each is defined as in theme.css. */
const SUB_FLOOR_HEX: Record<string, string> = {
  '500': '#4c6289',
  '600': '#364768',
  '700': '#26334d',
  '800': '#1b2438',
  '850': '#131a2b',
  '900': '#0d1220',
  '950': '#080b14',
  '1000': '#04060c',
}

const SUB_FLOOR_CLASS = new RegExp(`text-ice-(${Object.keys(SUB_FLOOR_HEX).join('|')})\\b`)
const SUB_FLOOR_ARBITRARY = new RegExp(
  `text-\\[(${Object.values(SUB_FLOOR_HEX).join('|')})\\]`,
  'i',
)

/**
 * Genuinely decorative uses: an `aria-hidden` glyph that carries no
 * information of its own — a screen reader never reaches it, and what it
 * marks is already said in words beside it. Each entry names the file and a
 * snippet unique enough to anchor it, so a *new* sub-floor line landing in the
 * same file still fails loudly, and a stale entry (the snippet moves or is
 * deleted) fails loudly too, in the test right below this one.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; snippet: string; reason: string }> = [
  {
    file: 'drawer/Conversation.tsx',
    snippet: '<span aria-hidden className="text-ice-600">',
    reason: 'the ● before a tool call — decorative line-start mark, aria-hidden, says nothing on its own',
  },
  {
    file: 'drawer/Conversation.tsx',
    snippet: '<span aria-hidden className="text-ice-700">',
    reason: 'the ⎿ before a tool result — decorative line-start mark, aria-hidden, says nothing on its own',
  },
]

function sourceFiles(): { name: string; text: string }[] {
  const files: { name: string; text: string }[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'scene') continue // the fence: #136 never touches canvas geometry
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
      files.push({ name: path.relative(SRC_DIR, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') })
    }
  }

  walk(SRC_DIR)
  return files
}

describe('no text wears ink dimmer than the legibility floor', () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(20)
  })

  it('keeps every allowlist entry honest — a stale snippet hides nothing', () => {
    const files = sourceFiles()
    for (const entry of ALLOWLIST) {
      const file = files.find((f) => f.name === entry.file)
      expect(file, `allowlisted file is gone: ${entry.file}`).toBeDefined()
      expect(
        file?.text.includes(entry.snippet),
        `allowlisted snippet no longer appears in ${entry.file} — remove or update the entry: "${entry.snippet}"`,
      ).toBe(true)
    }
  })

  it('names no text-ice class or arbitrary hex dimmer than ice-400, allowlist aside', () => {
    for (const file of sourceFiles()) {
      const lines = file.text.split('\n')
      lines.forEach((line, index) => {
        if (!SUB_FLOOR_CLASS.test(line) && !SUB_FLOOR_ARBITRARY.test(line)) return

        const allowed = ALLOWLIST.some((entry) => entry.file === file.name && line.includes(entry.snippet))
        expect(
          allowed,
          `${file.name}:${index + 1} wears ink dimmer than the floor, outside the allowlist:\n  ${line.trim()}`,
        ).toBe(true)
      })
    }
  })
})

describe('theme.css states the floor rather than just following it', () => {
  it('documents that text may not go dimmer than ice-400', () => {
    const theme = readFileSync(path.join(SRC_DIR, 'theme', 'theme.css'), 'utf8')
    expect(theme).toMatch(/anything\s+dimmer than `ice-400`/)
  })
})
