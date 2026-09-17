import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHOLOGY_KINDS, RUNGS, SIGNALS } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { SEVERITY_LADDER } from '../scene/palette.js'
import { SIGIL_KINDS } from './sigils.js'

/**
 * UNION TOTALITY LAW (#587) — a list meant to be total over a closed union
 * covers it exactly.
 *
 * ## The bug this exists for
 *
 * `readonly PathologyKind[]` constrains every element to be a MEMBER of the
 * union. It says nothing about every member being present, and `satisfies
 * readonly PathologyKind[]` is the same check. Only a `Record<Union, T>` is
 * exhaustive — and these are lists precisely because a Record cannot express
 * what they need: order (a priority, a ladder) or iteration.
 *
 * So a kind missing from one compiles, and then does nothing. Found by
 * @ciaran-slow reviewing #578, against a comment in
 * `scene/geometry/layout.ts` that described the failure exactly: he removed
 * `'crashed'` from `PATHOLOGY_PRIORITY` and the whole suite stayed green.
 * `find()` returns `undefined`, the node renders with no pathology label at
 * all, and nothing anywhere says so.
 *
 * ## Why a DECLARED set and not a sweep
 *
 * Because not every union-typed list wants to be total, and two in this tree
 * deliberately are not:
 *
 * - `ALARM_RANKS` (`scene/salience.ts`) — 2 of 4 rungs, because only those are
 *   exempt from the fade.
 * - `DIAGNOSED_KINDS` (`core/fleet/pathology.ts`) — 5 of 6 kinds, because
 *   `crashed` turns on a recorded edge in the fold and `fleet/diagnose.ts` can
 *   never emit it.
 *
 * A lint over every `readonly X[]` would convict both. So membership of
 * {@link TOTAL_LISTS} is the declaration, and a subset opts out by being
 * ABSENT from it rather than by a magic comment a reader has to trust.
 *
 * ## How the union is read at runtime
 *
 * Types are erased, so the union's members are parsed from **its own
 * declaration** — `export type PathologyKind = 'looping' | …` — rather than
 * inferred from some other structure that happens to be exhaustive. That is
 * the most direct witness there is: it reads the line a reader reads.
 *
 * A composed union (`SigilKind = PathologyKind | LaneActivity`) declares its
 * parts explicitly below rather than being resolved by recursion, so the
 * composition is visible here instead of being a property of the parser.
 *
 * ## Why one list is read from source and the rest are imported
 *
 * `PATHOLOGY_PRIORITY` is not exported. Exporting it is one word, and it is a
 * `packages/web/src/scene/` edit — a directory prd-57 was ruled out of, and the
 * ruling is the operator's rather than this law's to spend. Reading the array
 * literal out of the file needs no edit and is strictly the stronger form for
 * the same reason `cli-surface-law` reads the dispatch table rather than
 * importing it: it checks the file a reader actually reads.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.join(HERE, '..')
const CORE_SRC = path.join(HERE, '..', '..', '..', 'core', 'src')

const CORE_COLLECTOR = path.join(CORE_SRC, 'collector.ts')
const CORE_PATHOLOGY = path.join(CORE_SRC, 'fleet', 'pathology.ts')
const CORE_FLEET_TYPES = path.join(CORE_SRC, 'fleet', 'types.ts')
const SCENE_LAYOUT = path.join(WEB_SRC, 'scene', 'geometry', 'layout.ts')

/** A union's declaration, wherever it lives. */
interface UnionRef {
  type: string
  file: string
}

interface TotalList {
  /** As a reader would name it, for the failure message. */
  name: string
  /** Its members at runtime. */
  members: () => readonly string[]
  /** The union it must cover — several refs when the union is composed. */
  union: readonly UnionRef[]
  /** What breaks when a member goes missing. Never "it would be wrong". */
  cost: string
}

/**
 * Every string literal in a union type's declaration.
 *
 * Deliberately narrow: it matches `export type X = 'a' | 'b' | …` up to the
 * first line that is not a continuation. A union built from other named types
 * yields NOTHING here, which is why {@link TOTAL_LISTS} names the parts of a
 * composed union itself — a parser that silently returned an empty set for a
 * shape it could not read would make every comparison below vacuous.
 */
function unionMembers(file: string, type: string): string[] {
  const source = readFileSync(file, 'utf8')
  const declaration = new RegExp(`^export type ${type} =([\\s\\S]*?)(?:\\n\\n|\\n[A-Za-z/*])`, 'm').exec(source)
  if (declaration === null) return []
  return [...(declaration[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
}

/**
 * Every string literal in a `const NAME … = [ … ]` array literal.
 *
 * Used for the lists that are not exported. Stops at the first `]`, wherever it
 * falls.
 *
 * **It does NOT count a commented-out member, and the sentence that used to sit
 * here claimed the opposite outcome from the same premise**: *"ignores comment
 * text because the literals it collects are quoted."* The literals in a comment
 * are quoted too. So commenting out `'crashed',` in `PATHOLOGY_PRIORITY` left
 * this parser returning the identical six members while the runtime array had
 * five — and every check below kept its passing input. That is exactly the
 * regression #587 was filed to catch, defeated by the law written to catch it.
 * Found by a blind adversarial pass over #618 and reproduced against the real
 * file before this was written.
 *
 * The scanner is STRING-AWARE rather than a comment-stripping regex, which is
 * the other half of the same lesson: #595 is open on `doc-citation-law` for a
 * stripper that has no string-literal awareness, so a `/*` bigram inside a
 * string opens a phantom comment and the law judges a file against a mangled
 * view of its own source. A parser that fixes one vacuity by introducing
 * another is not a fix.
 *
 * It used to require the `]` at the START of a line — "which is how every array
 * in this tree is formatted", which is not true: `ALARM_RANKS` is one line, and
 * the counter-example pin below was passing on a read that returned NOTHING
 * (review of #588). Worse than nothing, on a one-line array that has another
 * array after it: the old shape ran past the end and returned `LADDER_ORDER` as
 * 21 members collected from the three declarations following it. A parser that
 * answers plausibly for a shape it cannot read is the exact vacuity the module
 * doc above refuses, so it is fixed here rather than in the caller.
 *
 * **The name is anchored, and that was a third instance of the same hole.** The
 * pattern read `const ${name}[^=]*=`, where `[^=]*` happily swallows the rest
 * of a LONGER identifier — so a `const ALARM_RANKS_LEGEND` declared above
 * `ALARM_RANKS` would be matched first and this law would pin the wrong array,
 * plausibly and silently. Found in adversarial review of #589. A list this law
 * governs is one where order or totality matters, which is exactly the kind of
 * constant that acquires an `_ORDER`, `_LEGEND` or `_BY_KIND` sibling.
 */
function arrayMembers(file: string, name: string): string[] {
  return arrayMembersIn(readFileSync(file, 'utf8'), name)
}

/**
 * The reading half, over a source STRING rather than a path — so the controls
 * below can hand it a shape that does not exist in the tree. A control that can
 * only use real files cannot test the case nothing has hit yet, which is the
 * case a law is for.
 */
export function arrayMembersIn(source: string, name: string): string[] {
  const declaration = new RegExp(`const ${name}(?![A-Za-z0-9_$])[^=]*= \\[([^\\]]*)\\]`, 'm').exec(source)
  if (declaration === null) return []
  return quotedOutsideComments(declaration[1] ?? '')
}

/**
 * Every single-quoted literal in `body` that is not inside a comment.
 *
 * One left-to-right pass with three states, because the three ways to get this
 * wrong are all live in this repo: collect from inside a comment (the defect
 * above), treat a `//` or `/*` inside a STRING as opening one (#595), or strip
 * with a regex that cannot tell the two apart.
 */
function quotedOutsideComments(body: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    const two = body.slice(i, i + 2)
    if (two === '//') {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    if (two === '/*') {
      const end = body.indexOf('*/', i + 2)
      i = end === -1 ? body.length : end + 2
      continue
    }
    if (body[i] === "'") {
      const end = body.indexOf("'", i + 1)
      if (end === -1) break // unterminated: collect nothing rather than guess
      out.push(body.slice(i + 1, end))
      i = end + 1
      continue
    }
    i += 1
  }
  return out
}

/**
 * THE DECLARATION. A list here is a promise that it covers its union.
 *
 * Absent from this table means "deliberately partial" — see the module doc for
 * the two that are, and why a sweep would convict them.
 */
const TOTAL_LISTS: readonly TotalList[] = [
  {
    name: 'SIGNALS (core/src/collector.ts)',
    members: () => SIGNALS,
    union: [{ type: 'Signal', file: CORE_COLLECTOR }],
    // The nastiest of the six, and the reason this law is not only about
    // rendering: `collector.test.ts` iterates `3 ** SIGNALS.length`
    // combinations, so an under-covering list shows nothing wrong at all — it
    // quietly tests fewer combinations and stays green.
    cost: 'the capability-combination sweep silently tests fewer combinations',
  },
  {
    name: 'RUNGS (core/src/collector.ts)',
    members: () => RUNGS,
    union: [{ type: 'Rung', file: CORE_COLLECTOR }],
    cost: 'a rung nothing can enumerate — `doctor` and `/api/meta` both read this order',
  },
  {
    name: 'PATHOLOGY_KINDS (core/src/fleet/pathology.ts)',
    members: () => PATHOLOGY_KINDS,
    union: [{ type: 'PathologyKind', file: CORE_PATHOLOGY }],
    cost: 'every law that iterates the kinds goes quietly vacuous for the missing one',
  },
  {
    name: 'SIGIL_KINDS (web/src/fleet/sigils.tsx)',
    members: () => SIGIL_KINDS,
    // Composed, and named in parts rather than resolved — see the module doc.
    union: [
      { type: 'PathologyKind', file: CORE_PATHOLOGY },
      { type: 'LaneActivity', file: CORE_FLEET_TYPES },
    ],
    cost: 'a state with no mark in the legend, which is law 9a’s whole subject',
  },
  {
    name: 'SEVERITY_LADDER (web/src/scene/palette.ts)',
    members: () => SEVERITY_LADDER,
    union: [{ type: 'LadderRank', file: CORE_PATHOLOGY }],
    cost: 'a rung with no severity position in the scene',
  },
  {
    name: 'PATHOLOGY_PRIORITY (web/src/scene/geometry/layout.ts)',
    // Read from source: not exported, and exporting it is a scene edit this
    // law does not need. See the module doc.
    members: () => arrayMembers(SCENE_LAYOUT, 'PATHOLOGY_PRIORITY'),
    union: [{ type: 'PathologyKind', file: CORE_PATHOLOGY }],
    // The instance that started this: `find()` returns undefined and the node
    // renders with no pathology label at all.
    cost: 'a lane carrying that pathology renders with no label in the scene',
  },
]

describe('union totality law: a list meant to be total over a closed union covers it (#587)', () => {
  it('the parsers actually parse — a law that read nothing would pass vacuously', () => {
    // The control this repo has been bitten without: `fence-lint`'s `## Fence`
    // heading parsed as EMPTY for a month and the lint passed while checking
    // nothing. Every mechanism below is exercised here on a known answer.
    expect(unionMembers(CORE_PATHOLOGY, 'PathologyKind')).toContain('crashed')
    expect(unionMembers(CORE_COLLECTOR, 'Signal')).toHaveLength(6)
    expect(unionMembers(CORE_FLEET_TYPES, 'LaneActivity')).toContain('unknown')
    expect(arrayMembers(SCENE_LAYOUT, 'PATHOLOGY_PRIORITY')).toContain('crashed')

    // And a shape the union parser CANNOT read returns empty rather than
    // something plausible — which is why a composed union names its parts in
    // the table instead of relying on the parser.
    expect(unionMembers(path.join(WEB_SRC, 'fleet', 'sigils.tsx'), 'SigilKind')).toEqual([])

    /**
     * CONTROL: a COMMENTED-OUT member is not a member.
     *
     * The blocking finding of #618's blind review, reproduced against the real
     * `PATHOLOGY_PRIORITY` before it was fixed: the parser returned the same six
     * members with `'crashed',` commented out, so this law passed while the
     * runtime list was missing the kind it was written for.
     *
     * Fabricated rather than mutated in place, because the tree contains no such
     * comment today and a control that waits for one is not a control.
     */
    const commented = [
      "const FIXTURE_LIST: readonly string[] = [",
      "  'alpha',",
      "  // 'beta',",
      "  /* 'gamma', */",
      "  'delta', // not 'epsilon' either",
      ']',
    ].join('\n')
    expect(arrayMembersIn(commented, 'FIXTURE_LIST')).toEqual(['alpha', 'delta'])

    // CONTROL: and a `//` INSIDE a literal does not open a comment — the
    // failure #595 is open on for `doc-citation-law`'s stripper. Fixing one
    // vacuity by introducing another is not a fix.
    const urlish = "const URL_LIST: readonly string[] = ['http://a', 'b/*c', 'd']"
    expect(arrayMembersIn(urlish, 'URL_LIST')).toEqual(['http://a', 'b/*c', 'd'])

    // CONTROL: a name that is a PREFIX of another constant does not capture it.
    // `arrayMembers` used to read `const NAME[^=]*=`, and `[^=]*` swallows the
    // rest of a longer identifier — so this law would have pinned a sibling
    // array, plausibly and silently (review of #589). There is no such pair in
    // the tree today, which is precisely why the control fabricates one: a hole
    // nothing currently falls into is still a hole, and the lists this law
    // governs are the kind that acquire `_ORDER` and `_LEGEND` siblings.
    expect(arrayMembers(SCENE_LAYOUT, 'PATHOLOGY_PRIO')).toEqual([])
  })

  it('every declared list is non-empty and every union resolves — no entry checks nothing', () => {
    for (const entry of TOTAL_LISTS) {
      expect(entry.members(), `${entry.name} resolved to no members`).not.toHaveLength(0)
      for (const ref of entry.union) {
        expect(unionMembers(ref.file, ref.type), `${ref.type} resolved to no members`).not.toHaveLength(0)
      }
    }
  })

  it.each(TOTAL_LISTS.map((entry) => [entry.name, entry] as const))('%s covers its union exactly', (_name, entry) => {
    const union = entry.union.flatMap((ref) => unionMembers(ref.file, ref.type))
    const members = entry.members()

    // Sets, both directions, rather than a length check: a list with one member
    // duplicated and another missing has the right length and the wrong
    // contents, which is the mutation a count would survive.
    const missing = union.filter((member) => !members.includes(member))
    const unknown = members.filter((member) => !union.includes(member))

    expect(missing, `${entry.name} is missing ${missing.join(', ')} — ${entry.cost}`).toEqual([])
    expect(unknown, `${entry.name} names ${unknown.join(', ')}, which is not in its union`).toEqual([])
    // No duplicates: a member listed twice passes both checks above.
    expect(new Set(members).size, `${entry.name} lists a member twice`).toBe(members.length)
  })

  /**
   * THE COUNTER-EXAMPLES, asserted rather than described.
   *
   * If either of these ever became total, the reason this law is a declared set
   * rather than a sweep would quietly stop being true — and the next person to
   * read the module doc would find it arguing against a case that no longer
   * exists. So the partial-ness itself is pinned.
   */
  it('the deliberately partial lists are still partial, and still absent from the table', () => {
    const names = TOTAL_LISTS.map((entry) => entry.name)
    expect(names.some((name) => name.startsWith('ALARM_RANKS'))).toBe(false)
    expect(names.some((name) => name.startsWith('DIAGNOSED_KINDS'))).toBe(false)

    // NON-EMPTY FIRST, both of them: `0 < 4` is true of a list that was never
    // read, so a partial-ness pin whose read fails reports success having
    // checked nothing. That is not hypothetical — it is how this test passed
    // for `ALARM_RANKS` before `arrayMembers` could parse a one-line array
    // (review of #588), which is the same shape as `fence-lint`'s empty
    // `## Fence` heading cited in the control above.
    const ladder = unionMembers(CORE_PATHOLOGY, 'LadderRank')
    const alarms = arrayMembers(path.join(WEB_SRC, 'scene', 'salience.ts'), 'ALARM_RANKS')
    // EXACT members, not merely non-empty: `toBeLessThan` passes as happily on a
    // TRUNCATED read as on a correct one — the same vacuity shape this pin
    // exists to refuse, one size smaller (review of #589).
    expect(alarms, 'ALARM_RANKS was not read at all — the pin below would pass vacuously').toEqual([
      'needs-you',
      'broken',
    ])
    expect(alarms.length, 'ALARM_RANKS is no longer partial — the module doc argues from it').toBeLessThan(ladder.length)

    const kinds = unionMembers(CORE_PATHOLOGY, 'PathologyKind')
    const diagnosed = arrayMembers(CORE_PATHOLOGY, 'DIAGNOSED_KINDS')
    expect(diagnosed, 'DIAGNOSED_KINDS was not read at all').toEqual([
      'looping',
      'frozen',
      'waiting',
      'expensive',
      'off-fence',
    ])
    expect(diagnosed.length, 'DIAGNOSED_KINDS is no longer partial').toBeLessThan(kinds.length)
  })
})
