import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE GREP LAWS OF THE DRAWING (prd-55 ruling 11 and its DoD), over every
 * source file under `lab/canvas/` and `lab/branching/`:
 *
 * - **no ink but the palette's** — a literal hex, or a literal `rgb(`/`hsl(`,
 *   anywhere in code goes red. Comments are stripped first, so an issue
 *   number like `#329` in prose is not mistaken for a colour;
 * - **no native tooltip** — a `title` attribute is unreachable from a
 *   keyboard; the facts panel is where a label lives;
 * - **type through the tokens, never a face name** — no `fillText`, no
 *   `ctx.font`, no `fontFamily`, no face or generic family spelled in code;
 * - **no clock, no random, no loop** — the drawing is a pure function of the
 *   record, painted when its inputs change: no `Date.now`, no
 *   `requestAnimationFrame`, no timers, no `Math.random`, and no
 *   `matchMedia`, because a picture with no motion has nothing to ask a
 *   motion preference.
 *
 * Same tactic as `no-live-fleet-law.test.ts`: grep the source, because a
 * violation added tomorrow would pass every behavioural test and still be the
 * thing the law forbids. Each detector is shown to bite on a probe below.
 */

const CANVAS_DIR = path.dirname(fileURLToPath(import.meta.url))
const GOVERNED = [CANVAS_DIR, path.join(CANVAS_DIR, '..', 'branching')]

interface SourceFile {
  name: string
  code: string
}

/** Block and line comments removed — the laws read code, not prose. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = []
  for (const dir of GOVERNED) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) continue
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      out.push({ name: path.relative(path.join(CANVAS_DIR, '..'), full), code: stripComments(readFileSync(full, 'utf8')) })
    }
  }
  return out
}

export const LITERAL_COLOUR = /['"`]#[0-9a-fA-F]{3,8}\b|['"`](?:rgba?|hsla?|oklch|color)\(/
export const NATIVE_TITLE = /\btitle\s*=|<title\b|\.title\s*=|setAttribute\(\s*['"]title['"]/
export const LITERAL_TYPE = /\b(?:fillText|strokeText)\s*\(|\.font\s*=|\bfontFamily\b|font-family|['"](?:Inter|JetBrains|Consolas|Segoe|Menlo|SFMono)|\b(?:ui-)?(?:monospace|sans-serif|serif)\b/
export const CLOCK_OR_LOOP = /\b(?:Date\.now|performance\.now|requestAnimationFrame|setInterval|setTimeout|Math\.random)\s*\(|\bmatchMedia\b/

const LAWS: ReadonlyArray<[string, RegExp]> = [
  ['a literal colour — every ink is a palette constant', LITERAL_COLOUR],
  ['a native title attribute — the facts panel is the label', NATIVE_TITLE],
  ['type set outside the theme\'s tokens — a face name, a generic family, or text painted on the canvas', LITERAL_TYPE],
  ['a clock, a random, a loop or a motion query — the drawing is a pure function of the record', CLOCK_OR_LOOP],
]

describe('the drawing\'s grep laws — canvas/ and branching/ (prd-55 ruling 11)', () => {
  it('has source files to check at all, from both governed directories', () => {
    const names = sourceFiles().map((file) => file.name)
    expect(names).toContain(path.join('canvas', 'organism.ts'))
    expect(names).toContain(path.join('canvas', 'paint.ts'))
    expect(names).toContain(path.join('canvas', 'LaneCanvas.tsx'))
    expect(names).toContain(path.join('branching', 'geometry.ts'))
  })

  for (const [what, pattern] of LAWS) {
    it(`no source file carries ${what}`, () => {
      for (const file of sourceFiles()) {
        const hit = pattern.exec(file.code)
        expect(hit, `${file.name} carries ${what}: ${hit?.[0] ?? ''}`).toBeNull()
      }
    })
  }

  it('the detectors bite — each on a spelling a drift would actually produce', () => {
    expect(LITERAL_COLOUR.test("ctx.fillStyle = '#ff3d68'")).toBe(true)
    expect(LITERAL_COLOUR.test('fill="#fff"')).toBe(true)
    expect(LITERAL_COLOUR.test("stroke: 'rgba(255, 61, 104, 0.9)'")).toBe(true)
    expect(LITERAL_COLOUR.test("const ink = cssColour(BROKEN) // was '#ff3d68'".replace(/\/\/.*$/, ''))).toBe(false)
    expect(NATIVE_TITLE.test('<g title={`arm ${arm}`}>')).toBe(true)
    expect(NATIVE_TITLE.test('<title>arm 3 never dispatched</title>')).toBe(true)
    expect(NATIVE_TITLE.test("button.setAttribute('title', error)")).toBe(true)
    expect(LITERAL_TYPE.test("ctx.font = '10px monospace'")).toBe(true)
    expect(LITERAL_TYPE.test("ctx.fillText('46 %', x, y)")).toBe(true)
    expect(LITERAL_TYPE.test("style={{ fontFamily: 'JetBrains Mono' }}")).toBe(true)
    expect(LITERAL_TYPE.test("const face = 'Inter'")).toBe(true)
    expect(CLOCK_OR_LOOP.test('const now = Date.now()')).toBe(true)
    expect(CLOCK_OR_LOOP.test('frame = requestAnimationFrame(tick)')).toBe(true)
    expect(CLOCK_OR_LOOP.test("window.matchMedia('(prefers-reduced-motion: reduce)')")).toBe(true)
    expect(CLOCK_OR_LOOP.test('const salt = Math.random()')).toBe(true)
  })

  it('the comment stripper reads prose out of the way — an issue number in a doc comment is not a colour, and a `//` inside a string is not a comment', () => {
    expect(stripComments("/** see #329 and '#fff' in the old file */ const a = 1")).toBe(' const a = 1')
    expect(stripComments("const a = 1 // '#ff3d68' used to live here")).toBe('const a = 1 ')
    expect(stripComments("const url = 'https://example.test/x'")).toBe("const url = 'https://example.test/x'")
    expect(LITERAL_COLOUR.test(stripComments("/* '#ff3d68' */ const ok = cssColour(ink)"))).toBe(false)
  })
})
