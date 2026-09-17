import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, rhizomorphEventSchema } from './index.js'

/**
 * NO EVENT SCHEMA CARRIES A COLONY — prd-58 ruling 3 and Success 5's falsifier.
 *
 * > An event says what happened; the frame says which colony it happened in.
 *
 * This is the law that keeps the era from moving. If any event gained a colony
 * or project field, an old recording would fold to a different `SessionState`
 * than it used to, `packages/core/src/eras/` would owe a new corpus, and
 * `docs/record-format.md` — which this PRD may not touch — would be describing
 * a shape the tree no longer writes.
 *
 * **Two arms, because either alone is a law with half an edge.** The schema arm
 * asks the runtime shapes what keys they accept, which catches a field added to
 * a schema. The source arm greps the declarations, which catches a field added
 * somewhere the runtime probe cannot reach (a passthrough, a union member built
 * elsewhere, a schema composed at a call site).
 *
 * **And it proves it READ something first.** This repo has now been bitten four
 * separate times by a law that reported success having checked nothing — a
 * lint whose heading parsed as empty, a parser that required a line-initial
 * `]`, a name pattern that matched a longer sibling, and a member list that
 * counted commented-out entries. `expect(violations).toEqual([])` over a sweep
 * that found no files is not a law, it is a sentence.
 */

const EVENTS_DIR = import.meta.dirname
const FORBIDDEN = ['colony', 'colonyId', 'project', 'projectId', 'repoSlug'] as const

/**
 * The ONE pre-existing `repoSlug` on an event, allowed by name and with its
 * reason — not by dropping the term from {@link FORBIDDEN}, which would stop
 * this law seeing the next one.
 *
 * `session.link` (#384) is the run pointer across a retarget: a rotation's
 * successor normally sits in the same directory, and prd-20 ruling 5's retarget
 * breaks that inference, so the two logs name each other by the slug that IS
 * their directory. It points at ANOTHER log; it does not attribute the event it
 * rides on. That is the opposite of what ruling 3 forbids, which is an event
 * you can read a colony off.
 *
 * The entry is checked for staleness below. An allowlist whose exception has
 * since been deleted is a law that has quietly widened — the failure
 * `doc-citation-law`'s `[renamed-away]` rows exist to refuse.
 */
const ALLOWED = [{ file: 'system.ts', key: 'repoSlug', schema: 'sessionLinkSchema', reason: '#384 run pointer' }] as const

/**
 * Every event type's payload keys, read off the discriminated union itself.
 *
 * Walks zod's internals defensively — `.options` or `.def.options`, `.shape` or
 * `.def.shape` — because the shape of those is a library detail, not a contract.
 * That would normally be a way to pass vacuously, which is exactly why the
 * control below asserts this found a payload for nearly every event type before
 * anything trusts it. A version bump that moved the internals reddens the
 * control rather than quietly emptying the law.
 */
function payloadKeysByType(): Map<string, string[]> {
  const schema = rhizomorphEventSchema as unknown as Record<string, unknown>
  const options = (schema.options ?? (schema.def as Record<string, unknown> | undefined)?.options) as
    | unknown[]
    | undefined
  const out = new Map<string, string[]>()
  if (!Array.isArray(options)) return out

  for (const option of options) {
    const member = option as Record<string, unknown>
    const shape = (member.shape ?? (member.def as Record<string, unknown> | undefined)?.shape) as
      | Record<string, unknown>
      | undefined
    if (shape === undefined) continue

    const typeNode = shape.type as Record<string, unknown> | undefined
    const literal =
      (typeNode?.value as string | undefined) ??
      ((typeNode?.def as Record<string, unknown> | undefined)?.values as string[] | undefined)?.[0]
    if (typeof literal !== 'string') continue

    const payload = shape.payload as Record<string, unknown> | undefined
    const payloadShape = (payload?.shape ?? (payload?.def as Record<string, unknown> | undefined)?.shape) as
      | Record<string, unknown>
      | undefined
    if (payloadShape === undefined) continue

    out.set(literal, Object.keys(payloadShape))
  }
  return out
}

/** Every event-schema module — the sources this law reads. */
function schemaSources(): { file: string; text: string }[] {
  return readdirSync(EVENTS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    // `index.ts` composes and `upcast.ts` migrates; neither declares a payload.
    // The FRAME is not excluded here because it is not in this directory at
    // all — `stream-frame.ts` sits beside `events/`, which is where
    // `no-open-payload-law` put it by catching its `z.unknown()`.
    .filter((name) => name !== 'index.ts' && name !== 'upcast.ts')
    .map((name) => ({ file: name, text: readFileSync(path.join(EVENTS_DIR, name), 'utf8') }))
}

describe('no event schema carries a colony (prd-58 ruling 3, Success 5)', () => {
  it('the sweep is non-empty and reaches the schemas everyone knows are there', () => {
    // The control this repo has been bitten without, four times. Every
    // mechanism below is exercised on a known answer before it is trusted.
    const sources = schemaSources()
    expect(sources.length).toBeGreaterThan(8)
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['beacon.ts', 'process.ts', 'telemetry.ts']))

    // And the runtime arm reaches real schemas, not an empty map. This is the
    // assertion that makes walking zod's internals safe: if a version bump
    // moves them, THIS reddens instead of the law silently checking nothing.
    const byType = payloadKeysByType()
    expect(EVENT_TYPES.length).toBeGreaterThan(20)
    expect(byType.size).toBeGreaterThanOrEqual(EVENT_TYPES.length - 2)
    expect(byType.get('beacon.received')).toEqual(expect.arrayContaining(['writer', 'kind', 'lane']))
  })

  it('no payload schema DECLARES a colony key', () => {
    const violations: string[] = []
    const allowedKeys = new Set<string>(ALLOWED.map((entry) => entry.key))

    for (const [type, keys] of payloadKeysByType()) {
      for (const key of FORBIDDEN) {
        // `session.link` is nested inside `session.started`'s payload rather
        // than being a top-level key, so this arm does not see it today. The
        // allowance is stated anyway: a law whose two arms disagree about what
        // is permitted is one nobody can reason about.
        if (allowedKeys.has(key)) continue
        if (keys.includes(key)) violations.push(`${type}.${key}`)
      }
    }

    expect(violations, 'an event may not carry the colony — ruling 3 puts it on the frame').toEqual([])
  })

  it('no schema SOURCE declares a colony field', () => {
    const violations: string[] = []

    for (const { file, text } of schemaSources()) {
      for (const key of FORBIDDEN) {
        // A declaration, not a mention: `colony: z.…` or `colony?: string`, so
        // prose about the word in a docblock is not a violation. The same
        // distinction `fence-lint` learned the hard way between a path a
        // document CLAIMS and a path it merely names.
        if (ALLOWED.some((entry) => entry.file === file && entry.key === key)) continue
        if (new RegExp(`^\\s*${key}\\??\\s*:\\s*(z\\.|string|nonEmptyString)`, 'm').test(text)) {
          violations.push(`${file}:${key}`)
        }
      }
    }

    expect(violations, 'no event schema declares a colony field').toEqual([])
  })

  it('CONTROL: both arms catch a colony where one is fabricated', () => {
    // A hole nothing currently falls into is still a hole, and a control that
    // waits for a real violation is not a control.
    const fabricated = "  colony: nonEmptyString.max(256),\n  lane: nonEmptyString,"
    const sourceArm = new RegExp(`^\\s*colony\\??\\s*:\\s*(z\\.|string|nonEmptyString)`, 'm')
    expect(sourceArm.test(fabricated)).toBe(true)

    // And prose naming the word is NOT a violation — the arm distinguishes a
    // declaration from a mention, which is what stops it convicting this file's
    // own docblock.
    expect(sourceArm.test(' * The colony rides the frame, never the event.\n')).toBe(false)
    expect(sourceArm.test(' * `colony` is not a field here.\n')).toBe(false)
  })

  it('every ALLOWED entry is still real — a stale exception widens the law silently', () => {
    // The failure `doc-citation-law`'s `[renamed-away]` rows exist to refuse:
    // an allowlist entry whose field has since been deleted is a hole nobody
    // opened on purpose. Each entry must still be findable, and must still be
    // the thing it claims to be.
    for (const entry of ALLOWED) {
      const text = readFileSync(path.join(EVENTS_DIR, entry.file), 'utf8')
      expect(text, `${entry.file} no longer declares ${entry.key} — drop the allowance`).toMatch(
        new RegExp(`^\\s*${entry.key}\\??\\s*:\\s*(z\\.|string|nonEmptyString)`, 'm'),
      )
      expect(text, `${entry.file}'s ${entry.key} is no longer on ${entry.schema}`).toContain(entry.schema)
    }
  })

  it('the FRAME carries it instead, which is what makes this law a boundary and not a ban', () => {
    // If nothing carried the colony, this law would pass on a tree where the
    // feature does not exist — true, and vacuous. Assert the other side of the
    // boundary: `stream-frame.ts`, one directory up, declares it.
    const frame = readFileSync(path.join(EVENTS_DIR, '..', 'stream-frame.ts'), 'utf8')
    expect(frame).toMatch(/colony:\s*z\.string\(\)/)
  })
})
