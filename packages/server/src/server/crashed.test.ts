import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type CrashActor, type CrashCandidate, crashedConditions, SESSION_END_STATUSES } from './crashed.js'

/**
 * CRASHED — prd-57 ruling 5 and its 2026-09-15 amendment.
 *
 * The claim these hold is two halves, and the second is the one that matters:
 * a vanished agent reaches `crashed`, **and `crashed` is never reachable from
 * silence.** The first half alone would pass a raiser that fired on anything
 * quiet, which is the exact failure prd-15 ruling 1 sent this call downstream
 * to avoid — and which `collectors/sessionlog/lane-state.ts` has been
 * withholding a word for ever since.
 */

const actor = (over: Partial<CrashActor> = {}): CrashActor => ({
  key: '4242:1000',
  seenAt: 1000,
  goneAt: 5000,
  goneReason: 'absent',
  ...over,
})

const lane = (over: Partial<CrashCandidate> = {}): CrashCandidate => ({
  lane: 'feature',
  actors: [actor()],
  declared: null,
  ...over,
})

describe('a vanished agent reaches crashed', () => {
  it('raises for an actor that was seen and is now gone, naming the instant it went', () => {
    const [condition, ...rest] = crashedConditions([lane()])

    expect(rest).toEqual([])
    expect(condition).toMatchObject({ lane: 'feature', kind: 'crashed' })
    // `since` is when the RUN ended, not when this tick noticed. A raiser that
    // used the tick's clock would report every crash as having just happened,
    // however long the server had been down.
    expect(condition?.since).toBe(5000)
  })

  it('states the recorded facts, never a bare label', () => {
    const detail = crashedConditions([lane()])[0]?.detail ?? ''

    expect(detail).toContain('without a session end')
    expect(detail).toContain('nothing ever declared a status')
    // And it says what the lane DID declare when there was one, because "it
    // crashed after saying it was working" and "it crashed having said nothing"
    // are different situations for whoever is about to restart it.
    const said = crashedConditions([lane({ declared: { status: 'working', at: 2000 } })])[0]?.detail ?? ''
    expect(said).toContain('last declared "working"')
  })

  it('raises once per lane, not once per actor — a conductor and its subagents die together', () => {
    const conditions = crashedConditions([
      lane({
        actors: [
          actor({ key: '1:1000', goneAt: 5000 }),
          actor({ key: '2:1000', goneAt: 5001 }),
          actor({ key: '3:1000', goneAt: 5002 }),
        ],
      }),
    ])

    // Three dead actors, one interruption. Six summons for one event is six
    // times the cost and none of the extra information.
    expect(conditions).toHaveLength(1)
    expect(conditions[0]?.since).toBe(5000)
  })

  it('judges each lane on its own actors', () => {
    const conditions = crashedConditions([
      lane({ lane: 'alive', actors: [actor({ goneAt: null, goneReason: null })] }),
      lane({ lane: 'dead' }),
    ])

    expect(conditions.map((c) => c.lane)).toEqual(['dead'])
  })
})

describe('THE LAW: crashed is never reachable from silence', () => {
  /**
   * The falsifier the issue names, and it is structural rather than tested
   * around: {@link crashedConditions} takes no clock and no threshold, so it
   * cannot express "it has been quiet for N minutes" at all. These prove the
   * shape holds rather than that one duration happens to be handled.
   */
  it('an actor still alive raises nothing, whatever else is true of its lane', () => {
    const conditions = crashedConditions([
      lane({ actors: [actor({ goneAt: null, goneReason: null })], declared: { status: 'working', at: 1 } }),
      lane({ lane: 'b', actors: [actor({ goneAt: null, goneReason: null })], declared: null }),
    ])

    expect(conditions).toEqual([])
  })

  it('a lane with NO actors raises nothing — absence of a witness is not evidence of death', () => {
    // The commonest shape in a real fold: a lane the process witness cannot see
    // at all, because the platform has no probe or the roster did not match it.
    // ADR-0010 declares the gap; it does not fill it with an alarm.
    expect(crashedConditions([lane({ actors: [] })])).toEqual([])
  })

  it('takes no clock and no threshold — asserted against the signature, so the shape cannot drift', () => {
    // A raiser with a `now` could grow an age check in a later edit and nothing
    // above would catch it. This is the assertion that would.
    expect(crashedConditions).toHaveLength(1)
    // And the whole judgement is reproducible from the same input, forever:
    // called twice with identical rows, it answers identically, because there
    // is no time for it to read.
    const rows = [lane()]
    expect(crashedConditions(rows)).toEqual(crashedConditions(rows))
  })

  it('a `gone` for an actor never seen alive is not a death this witness can attest to', () => {
    expect(crashedConditions([lane({ actors: [actor({ seenAt: 9000, goneAt: 5000 })] })])).toEqual([])
  })
})

describe('an expected death is not a crash', () => {
  it.each(SESSION_END_STATUSES)('a lane that declared "%s" before it went raises nothing', (status) => {
    expect(crashedConditions([lane({ declared: { status, at: 4000 } })])).toEqual([])
  })

  it('a session end declared AFTER the death does NOT absolve it', () => {
    // The clause a reader is most likely to write backwards. A `done` that
    // arrives after the process is already gone is a later fact about a
    // different thing — a stale roster entry, a replayed line — and treating it
    // as absolution would erase a real crash.
    const conditions = crashedConditions([lane({ declared: { status: 'done', at: 6000 } })])

    expect(conditions).toHaveLength(1)
  })

  it('a NON-ending word before the death absolves nothing', () => {
    // The control that makes the cases above mean something: it is the WORD
    // that matters, not merely that something was declared.
    for (const status of ['working', 'waiting', 'tool-running', 'waiting-permission']) {
      expect(crashedConditions([lane({ declared: { status, at: 4000 } })]), status).toHaveLength(1)
    }
  })

  it('`recycled` raises nothing — the witness stopped being able to tell, which is not a death it saw', () => {
    // NOT "the run survived" — the run is over either way. The pid came back
    // under a different `startedAt`, so what was observed is pid reuse rather
    // than an observed death, and a crash summons is an interruption: the one
    // thing that must not be raised on a maybe (ADR-0010).
    expect(crashedConditions([lane({ actors: [actor({ goneReason: 'recycled' })] })])).toEqual([])
    // The control: the identical actor with the identical timing, classified
    // `absent`, does raise. So this is about the reason and nothing else.
    expect(crashedConditions([lane({ actors: [actor({ goneReason: 'absent' })] })])).toHaveLength(1)
  })
})

/**
 * THE CALLER, asserted rather than assumed — ADR-0038's shape, which the issue
 * names: a pure edge-triggering function over the fold, called from the poll
 * loop, **never a collector**.
 *
 * That is not a style preference. The collector contract hands a collector
 * `repoPath`, `now`, `exec`, `nextId` and `emit` — never folded state. A
 * collector that reached this would need the fold, and a collector with the
 * fold is a collector that can see its own output, which is the loop ADR-0038
 * exists to prevent. `summons.ts` is held to the identical rule for the
 * identical reason.
 */
describe('THE SHAPE: the poll loop is the only caller', () => {
  const SERVER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full))
        continue
      }
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  it('exactly one non-test file in the package imports crashed.js, and it is poll-loop.ts', () => {
    const importers = sourceFiles(SERVER_SRC)
      .filter((file) => /from '[^']*\/crashed\.js'|from '\.\/crashed\.js'/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SERVER_SRC, file).split(path.sep).join('/'))

    expect(importers).toEqual(['server/poll-loop.ts'])
  })

  it('and no collector reaches it — the sweep really covered collectors/, so an empty result means something', () => {
    const files = sourceFiles(SERVER_SRC).map((file) => path.relative(SERVER_SRC, file).split(path.sep).join('/'))

    expect(files.some((file) => file.startsWith('collectors/'))).toBe(true)
    expect(files.filter((file) => file.startsWith('collectors/') && readFileSync(path.join(SERVER_SRC, file), 'utf8').includes('crashed.js'))).toEqual([])
  })
})
