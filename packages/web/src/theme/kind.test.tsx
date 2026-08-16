import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityView } from '../drawer/Activity.js'
import type { ActivityEntry } from '../drawer/foldActivity.js'
import { ink, luminance, type Rgb } from '../scene/palette.js'
import { CALM_CEILING } from '../scene/salience.js'
import { KindTag } from '../trace/glyphs.js'
import { capViolations, type CategoryWorld } from './category.js'
import {
  CATEGORY_EDGE,
  CATEGORY_TINT,
  KIND_APPEARANCE,
  kindEdgeClass,
  kindLawViolations,
  kindTagClass,
  NO_EDGE,
  WORK_KINDS,
  type CategoryToken,
  type KindAppearance,
  type KindWorld,
} from './kind.js'
import { rgbFromHex } from './oklch.js'
import { resolve, themesOf } from './tokens.js'

/**
 * A KIND IS NOT A STATUS — the law of prd-31 ruling 1, and the proof each half
 * of it bites.
 *
 * The ruling has two halves and they fail differently, so they are checked
 * differently:
 *
 *   1. **A kind is not a status.** That is a property of the *source* — of
 *      which token a kind's class names — and a rendered-output test cannot
 *      hold it, because a kind added tomorrow wearing `text-needs-you` would
 *      pass every behavioural assertion in this repo and still be lying in
 *      colour. So `kindLawViolations` reads the table, and this file hands it
 *      rigged tables that break one clause each.
 *
 *   2. **A tint is capped.** That is a property of the *hexes*, and prd-32
 *      ruling 8 already owns it: `theme/category.ts` states five caps as five
 *      functions and `category.test.ts` rigs each one. Nothing here redefines
 *      any of that. What this file adds is the join — it resolves the tints
 *      this module actually spends off the real stylesheet and feeds them
 *      straight into `capViolations`, so lifting a kind's tint over
 *      `CALM_CEILING` turns *that* law red rather than quietly passing here.
 *
 * The second half is the one worth being pedantic about. The 0.06 between
 * `CALM_CEILING` (0.78) and `ALARM_FLOOR` (0.84) is the entire salience
 * mechanism that makes a death win the eye. A kind tint that climbed into that
 * band would steal attention from an alarm while carrying no state at all —
 * which is the exact failure the caps were written to make impossible, and a
 * cap that has only ever been shown passing is a cap nobody has checked.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THEME = readFileSync(path.join(SRC, 'theme', 'theme.css'), 'utf8')
const DARK = themesOf(THEME)[0]?.tokens ?? new Map<string, string>()

function token(name: string): Rgb {
  const literal = resolve(name, DARK)
  expect(literal, `theme.css has no ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
  return rgbFromHex(literal as string)
}

/**
 * The six hues that mean *state*. Named here rather than derived because there
 * is no marker in the sheet that says "this one is a status" — but each is
 * resolved off the real stylesheet below, so a rename upstream fails loudly
 * instead of silently shortening the list the law walks.
 */
const STATUS_TOKENS = [
  '--color-working',
  '--color-done',
  '--color-waiting-benign',
  '--color-needs-you',
  '--color-broken',
  '--color-notice',
] as const

/** prd9's legibility floor: `ice-500` and dimmer measure under 4.5:1 and are not text. */
const INK_ALLOWED = ['text-ice-100', 'text-ice-200', 'text-ice-300', 'text-ice-400'] as const

const WORLD: KindWorld = { statusTokens: STATUS_TOKENS, inkAllowed: INK_ALLOWED }

const CATEGORY_WORLD: CategoryWorld = {
  statusHues: STATUS_TOKENS.map(token),
  notice: token('--color-notice'),
  calmCeiling: CALM_CEILING,
  css: THEME,
}

/** Every tint the kind table actually spends, resolved off the real sheet. */
const SPENT: readonly CategoryToken[] = [...new Set(Object.values(CATEGORY_TINT))]
const SPENT_RGB: readonly Rgb[] = SPENT.map(token)

afterEach(cleanup)

describe('the kind table, against its own law', () => {
  it('resolves every status token it claims to avoid', () => {
    // The law is a list of names, and a list of names that no longer exist is a
    // law that permits everything. Nothing below means anything without this.
    for (const name of STATUS_TOKENS) {
      expect(resolve(name, DARK), `theme.css has no ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('breaks no clause of it', () => {
    expect(kindLawViolations(KIND_APPEARANCE, WORLD)).toEqual([])
  })

  it('covers every kind, and gives each one a word and a name', () => {
    expect(WORK_KINDS.length).toBeGreaterThan(0)
    for (const kind of WORK_KINDS) {
      const look = KIND_APPEARANCE[kind]
      expect(look.word, `${kind} has no tag word`).not.toBe('')
      expect(look.label, `${kind} has no accessible name`).not.toBe('')
    }
  })

  it('spends the whole bounded family and invents no fifth member', () => {
    // Bounded is half of ruling 8. Under-spending is the pressure that grows a
    // palette later ("we only had two, so we added one"); over-spending is the
    // palette itself. Four declared, four spent, and the declared four are read
    // off the sheet rather than restated.
    const declared = [...THEME.matchAll(/(--category-[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string)
    expect(new Set(SPENT)).toEqual(new Set(declared))
    expect(SPENT).toHaveLength(4)
  })

  it('carries lightness as the primary signal, so a kind survives greyscale', () => {
    // Law 9 restated at the table: colour is never the sole carrier. Strip the
    // tint and the kinds must still sort, which means the ink column is not one
    // value repeated.
    const inks = new Set(WORK_KINDS.map((kind) => KIND_APPEARANCE[kind].ink))
    expect(inks.size).toBeGreaterThan(1)
    for (const kind of WORK_KINDS) {
      expect(INK_ALLOWED, `${kind} is under the legibility floor`).toContain(KIND_APPEARANCE[kind].ink)
    }
  })
})

/**
 * THE RIGGED TABLES — one clause each, and each one changes the least it can so
 * the failure it produces is attributable. A rig that broke three clauses would
 * prove only that the law returns something.
 */
describe('a rigged kind turns the suite red', () => {
  const real = KIND_APPEARANCE.tool

  function rig(patch: Partial<KindAppearance>): Record<string, KindAppearance> {
    return { tool: { ...real, ...patch } }
  }

  /**
   * Assembled rather than written whole, and that is not fussiness: Tailwind
   * scans every source file in the package including this one, so writing the
   * class whole — even inside a comment — compiles a real rule for a variable
   * that does not exist straight into the shipped stylesheet. (It did, on the
   * first build of this work; the built sheet is where that was caught, which
   * is why the build was read rather than assumed.) A rig belongs in the test,
   * not in the bundle.
   */
  const INVENTED_TINT = `border-(${'--category-9'})`

  /** The four clauses, so a rig's failure can be named rather than counted. */
  const CLAUSES = ['a kind is not a status', 'no glow', 'legibility floor', 'bounded family'] as const

  function clausesOf(messages: readonly string[]): Set<string> {
    return new Set(
      messages.map((message) => {
        const clause = CLAUSES.find((candidate) => message.startsWith(candidate))
        expect(clause, `unattributable violation: ${message}`).toBeDefined()
        return clause as string
      }),
    )
  }

  // The expected set is exact, not a floor. Some rigs trip two clauses
  // unavoidably — a status hue spent as ink is also under the legibility floor,
  // and any wrong edge is also off its category — so "at least one thing
  // failed" would not distinguish a law that bites from a law that complains.
  it.each([
    ['a status hue as ink', rig({ ink: 'text-needs-you' }), ['a kind is not a status', 'legibility floor']],
    ['a status hue as the edge', rig({ edge: 'border-broken' }), ['a kind is not a status', 'bounded family']],
    [
      'a raw reach for a status token',
      rig({ edge: 'border-(--color-working)' }),
      ['a kind is not a status', 'bounded family'],
    ],
    ['a halo, which is alarm grammar', rig({ edge: 'glow-notice' }), ['no glow', 'bounded family']],
    ['ink under the legibility floor', rig({ ink: 'text-ice-600' }), ['legibility floor']],
    ['a tint that is not its category’s', rig({ edge: CATEGORY_EDGE.change }), ['bounded family']],
    ['a tint invented outside the family', rig({ edge: INVENTED_TINT }), ['bounded family']],
    ['a category dropped but the tint kept', rig({ category: null }), ['bounded family']],
  ])('catches %s', (_name, table, expected) => {
    const broken = kindLawViolations(table, WORLD)
    expect(broken.length, 'nothing failed at all').toBeGreaterThan(0)
    expect(clausesOf(broken), broken.join('\n')).toEqual(new Set(expected))
  })
})

describe('the tints the kinds spend, against prd-32 ruling 8’s caps', () => {
  it('breaks none of them', () => {
    expect(capViolations(SPENT_RGB, CATEGORY_WORLD)).toEqual([])
  })

  it('sits under CALM_CEILING with headroom a retune can see', () => {
    const lit = SPENT_RGB.map((tint) => luminance(ink(tint, 1)))
    expect(Math.max(...lit)).toBeLessThan(CALM_CEILING)
  })

  it('turns red when a kind’s tint is lifted over CALM_CEILING', () => {
    // The rig: the family's own violet at its own chroma, raised to 0.864 — into
    // the band the alarms own. The 0.06 gap above the calm ceiling is what makes
    // a death win the eye, and a kind carries no state at all, so a kind in that
    // band is attention stolen from a summons.
    const rigged: readonly Rgb[] = [...SPENT_RGB.slice(0, -1), rgbFromHex('#e0d8fc')]
    const broken = capViolations(rigged, CATEGORY_WORLD)
    expect(broken.length, 'a tint above the calm ceiling passed').toBeGreaterThan(0)
    expect(broken.some((message) => message.startsWith('cap 3 (calm ceiling)')), broken.join('\n')).toBe(true)
  })

  it('turns red when a kind’s tint drifts into the notice hue', () => {
    // The other way a category stops being a category: it keeps every number and
    // walks round the wheel into the cyan that prompts already carry.
    const rigged: readonly Rgb[] = [...SPENT_RGB.slice(0, -1), rgbFromHex('#99c7cf')]
    const broken = capViolations(rigged, CATEGORY_WORLD)
    expect(broken.some((message) => message.startsWith('cap 4 (notice clearance)')), broken.join('\n')).toBe(true)
  })
})

describe('a kind is rendered as a kind, not as a status', () => {
  /** Every status hue, in every spelling a class could reach it by. */
  const STATUS_CLASS = new RegExp(
    `(?:text|bg|border|ring|fill|stroke|decoration|outline)-(?:${STATUS_TOKENS.map((t) =>
      t.replace('--color-', ''),
    ).join('|')})\\b|glow-`,
  )

  const SPAN_KINDS = [
    'interaction',
    'llm_request',
    'tool',
    'tool_blocked',
    'tool_execution',
    'hook',
    'other',
  ] as const

  it.each(SPAN_KINDS)('renders the %s span with no status hue on it', (kind) => {
    render(<KindTag kind={kind} />)
    const tag = screen.getByTestId('trace-kind')
    expect(tag.getAttribute('data-kind')).toBe(kind)
    expect(tag.className).not.toMatch(STATUS_CLASS)
  })

  it('renders the ledger’s three kinds with no status hue on any of them', () => {
    const entries: ActivityEntry[] = [
      { id: 'a', ts: 10, kind: 'tool', tool: 'Read', count: 1, thread: null },
      { id: 'b', ts: 9, kind: 'file', path: 'src/x.ts', status: 'modified' },
      { id: 'c', ts: 8, kind: 'commit', sha: 'abc1234', subject: 'x', fileCount: 1, insertions: 1, deletions: 0 },
    ]
    render(<ActivityView entries={entries} now={20} />)
    const rows = screen.getAllByTestId('activity-entry')
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.outerHTML, `${row.getAttribute('data-kind')} wears a status hue`).not.toMatch(STATUS_CLASS)
    }
  })

  it('paints the tint on the row’s edge, never on its text', () => {
    // The channel matters, not just the cap. Ink is lightness; the tint is
    // material (D24), and the family's dark half cannot legally carry text at
    // all — `--category-1` measures 1.98:1 against the page floor.
    for (const kind of WORK_KINDS) {
      const look = KIND_APPEARANCE[kind]
      expect(look.ink, `${kind} spends a tint as ink`).not.toContain('--category-')
      expect(look.edge, `${kind}'s tint is not a border`).toMatch(/^border-/)
    }
    expect(kindTagClass('tool')).toContain(CATEGORY_EDGE.tool)
    expect(kindEdgeClass('other')).toContain(NO_EDGE)
  })
})

describe('there is exactly one kind module', () => {
  const FILES = walk(SRC).filter((file) => /\.tsx?$/.test(file))

  /**
   * The plurality *was* the defect — one sentence in three files, already
   * disagreeing about `tool`. So the grep is the law: a fourth surface that
   * spells a tint for itself fails by diff, which is what ruling 1 asks for.
   *
   * `theme/` is exempt because the family is declared and capped there, and
   * tests are exempt because rigging an illegal tint is how the caps are shown
   * to bite.
   */
  it('is the only file outside theme/ that names a category tint', () => {
    const offenders = FILES.filter((file) => {
      const rel = path.relative(SRC, file)
      if (rel.startsWith('theme/') || /\.test\.tsx?$/.test(rel)) return false
      return readFileSync(file, 'utf8').includes('--category-')
    }).map((file) => path.relative(SRC, file))

    expect(offenders, 'a kind’s look is spelled outside theme/kind.ts').toEqual([])
  })

  it('is what all three of ruling 1’s surfaces read their kind look from', () => {
    for (const rel of ['trace/glyphs.tsx', 'drawer/Activity.tsx', 'drawer/Conversation.tsx']) {
      const source = readFileSync(path.join(SRC, rel), 'utf8')
      expect(source, `${rel} does not consume theme/kind.ts`).toMatch(
        /from '\.\.\/theme\/kind\.js'/,
      )
    }
  })

  /**
   * The three ruling 1 names are done. `why/WhySurface.tsx` holds two more —
   * a fallback `tool` tag for a call with no span, and a hardcoded `commit` tag
   * — and it is outside #553's fence, so they are pinned rather than fixed: a
   * widening is recorded on a PR before the change, never after.
   *
   * Pinned the way `tokens.test.ts` pins its pixel literals, and for the same
   * reason: the number may only go down. Naming the residue is what stops it
   * being rediscovered as a surprise, and stops a sixth copy landing quietly
   * beside it.
   */
  const HAND_SPELLED_TAGS = 2

  it(`leaves ${HAND_SPELLED_TAGS} hand-spelled kind tags outside the module, and not one more`, () => {
    const sites = FILES.flatMap((file) => {
      const rel = path.relative(SRC, file)
      if (rel === 'theme/kind.ts' || /\.test\.tsx?$/.test(rel)) return []
      const hits = readFileSync(file, 'utf8').match(/shrink-0 text-\[10px\] uppercase tracking-wider/g) ?? []
      return hits.map(() => rel)
    })

    expect(
      sites.length,
      sites.length > HAND_SPELLED_TAGS
        ? `a kind tag was spelled by hand again — call kindTagClass() instead: ${sites.join(', ')}`
        : `${HAND_SPELLED_TAGS - sites.length} retired: lower HAND_SPELLED_TAGS to ${sites.length} and take the credit`,
    ).toBe(HAND_SPELLED_TAGS)
    expect(new Set(sites)).toEqual(new Set(['why/WhySurface.tsx']))
  })

  it('leaves no kind→class map behind in those surfaces', () => {
    // The specific shape of the old defect: `const KIND_CLASS = { tool:
    // 'text-ice-300', … }`, three times over. `trace/glyphs.tsx` still
    // *exports* `KIND_CLASS` — #439 reads that furniture and this work is
    // additive — but it is derived from the table now, so no object literal of
    // classes may sit behind that name anywhere.
    for (const rel of ['trace/glyphs.tsx', 'drawer/Activity.tsx', 'drawer/Conversation.tsx']) {
      const source = readFileSync(path.join(SRC, rel), 'utf8')
      expect(source, `${rel} still declares a kind→class map`).not.toMatch(/KIND_CLASS[^\n]*=\s*\{/)
    }
  })
})

/** Every file under `dir`, recursively. `node_modules` never appears under `src/`. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
