import { describe, expect, it } from 'vitest'
import { EVENT_TYPES } from '../events/index.js'
import { ERA_CORPUS } from './corpus.js'
import { ERAS, canonicalStateJson, foldEraRecording } from './fold.js'

/**
 * THE GOLDEN ERA CORPUS LAW — prd17 ruling 3, item 2.
 *
 * Every era recording is folded by whatever the reducer has become, and the
 * result must equal the committed snapshot BYTE FOR BYTE. A reducer change that
 * alters the meaning of a past era's log fails the build here, before it can
 * quietly rewrite history that has already been exported, merged and read.
 *
 * **Re-blessing is a deliberate act, never automatic — and it cannot happen
 * from inside this suite at all.** Three things enforce that:
 *
 * 1. Nothing here can write. Core has no `node:*` in scope (see `fold.ts`), so
 *    the recordings and snapshots arrive as `?raw` text through `corpus.ts` and
 *    there is no file handle in this file to misuse. The blessing procedure in
 *    `CAPTURE.md` is a command a human runs from the repo root, outside vitest.
 * 2. The comparison is plain string equality, deliberately NOT
 *    `expect(...).toMatchFileSnapshot(...)` — `vitest -u` rewrites those, and
 *    `-u` is something people run to fix an unrelated snapshot. The permanent
 *    record must not be collateral damage of that habit.
 * 3. A commit that moves a snapshot has to say why (`CAPTURE.md`).
 */
describe('the golden era corpus', () => {
  it('holds at least one era — every sweep below would pass vacuously otherwise', () => {
    expect(ERA_CORPUS.length).toBeGreaterThan(0)
  })

  it('numbers its eras 1..N with no gaps and no repeats', () => {
    expect(ERAS.map((era) => era.era)).toEqual(ERAS.map((_, at) => at + 1))
  })

  it('binds every registered era\'s bytes — a registry entry nothing reads guards nothing', () => {
    expect(ERA_CORPUS.map((era) => era.name)).toEqual(ERAS.map((era) => era.name))
    for (const era of ERA_CORPUS) {
      expect(era.recordingText.length).toBeGreaterThan(0)
      expect(era.snapshotText.length).toBeGreaterThan(0)
    }
  })

  for (const era of ERA_CORPUS) {
    describe(era.name, () => {
      it('folds byte-identically to its committed snapshot', () => {
        expect(canonicalStateJson(foldEraRecording(era.recordingText).state)).toBe(era.snapshotText)
      })

      it('folds to the same bytes twice — the fold of a past era is deterministic', () => {
        expect(canonicalStateJson(foldEraRecording(era.recordingText).state)).toBe(
          canonicalStateJson(foldEraRecording(era.recordingText).state),
        )
      })

      it('is understood in full — nothing in a past era of our own log reads as unknown', () => {
        // If this ever fails, an event family was removed from the union and a
        // recording the instrument itself wrote can no longer be folded. The
        // lenient boundary means that is now VISIBLE rather than a silently
        // shorter history (prd17 ruling 3, item 1), which is the only reason
        // this assertion can exist at all.
        const fold = foldEraRecording(era.recordingText)
        expect(fold.unknown).toEqual([])
        expect(fold.events.length).toBeGreaterThan(0)
      })

      it('is a recording, not a stub — its fold moved real state', () => {
        const { state, events } = foldEraRecording(era.recordingText)
        expect(state.eventCount).toBe(events.length)
        expect(state.firstEventTs).not.toBeNull()
        expect(state.lastEventTs).not.toBeNull()
      })
    })
  }

  it('names exactly which event families the corpus does and does not reach', () => {
    const covered = new Set<string>()
    for (const era of ERA_CORPUS) {
      for (const event of foldEraRecording(era.recordingText).events) covered.add(event.type)
    }

    // A real slice contains what actually happened in it, so the corpus's
    // coverage is a fact to state rather than a target to hit. Stated as the
    // exact GAP, not a floor: adding an era, or losing an arm from an existing
    // one, changes this list and has to be acknowledged here — which is the
    // point. What era-1 misses is the rare and the deliberately-invoked:
    // `session.started`/`session.closed` bracket a log rather than living
    // mid-flight, the four `collector.*` families only fire when a collector is
    // unhealthy, `telemetry.refused` needs a misconfigured lane, and
    // `fork.*`/`judge.finding` need the lab and the judge to have run.
    expect(EVENT_TYPES.filter((type) => !covered.has(type)).sort()).toEqual([
      'collector.degraded',
      'collector.disabled',
      'collector.error',
      'collector.recovered',
      'fork.checkpoint',
      'fork.dispatched',
      'judge.finding',
      'session.closed',
      'session.started',
      'telemetry.refused',
    ])
  })
})

/**
 * FIXTURE HYGIENE, era corpus edition — the same law
 * `collectors/otel/fixture-hygiene-law.test.ts` states for OTel captures, and
 * the same one `collectors/sessionlog/fixtures/CAPTURE.md` names: a real capture
 * checked into a repo that is going public must carry no identity and no host.
 *
 * Grep-law style, over the raw source text rather than the parsed shape, so it
 * also catches a leak in a field no reducer reads and no schema mentions — and
 * over the SNAPSHOT too, since a fold copies payload strings into state.
 */
describe('era corpus fixture hygiene', () => {
  const BANNED: readonly (readonly [string, RegExp])[] = [
    ['a host home directory', /\/(home|Users)\//],
    ['a NUL byte', /\0/],
    ['the source repo\'s real basename', /worktrees-challenge/],
    ['the operator\'s username', /lachlan/i],
  ]

  for (const era of ERA_CORPUS) {
    describe(era.name, () => {
      for (const [what, pattern] of BANNED) {
        it(`carries no ${what}`, () => {
          expect(era.recordingText).not.toMatch(pattern)
          expect(era.snapshotText).not.toMatch(pattern)
        })
      }

      it('carries no email address outside example.com', () => {
        for (const text of [era.recordingText, era.snapshotText]) {
          const emails = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []
          expect(emails.filter((email) => !email.endsWith('@example.com'))).toEqual([])
        }
      })

      it('is newline-terminated JSONL with no blank lines — one event per line', () => {
        expect(era.recordingText.endsWith('\n')).toBe(true)
        expect(
          era.recordingText.slice(0, -1).split('\n').filter((line) => line.trim().length === 0),
        ).toEqual([])
      })
    })
  }

  it('the detector bites — a rigged line would fail the sweep above', () => {
    const rigged = '{"payload":{"path":"/home/someone/repo"}}'
    expect(BANNED.some(([, pattern]) => pattern.test(rigged))).toBe(true)
  })
})
