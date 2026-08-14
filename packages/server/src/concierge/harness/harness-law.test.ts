import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HARNESS_ADAPTERS, detectAll, harnessById } from './registry.js'
import { HarnessNotImplementedError, type HarnessAdapter, type HarnessId } from './types.js'

/**
 * THE HARNESS REGISTRY LAW — ADR-0010 ("every collector declares what it cannot
 * do, and the ladder is named, not ranked") applied to harnesses, and asserted
 * rather than described.
 *
 * Two failures this registry could drift into, both of which look like
 * improvements at the time:
 *
 * 1. **Becoming a ranking.** ADR-0010 rejected option D, the ranked tier list,
 *    and superseded its framing: ranking encodes "our setup is the real one and
 *    yours is degraded" into the type system, which is untrue and unhelpful.
 *    The moment an adapter grows a `tier` or a `preferred`, something will sort
 *    on it and the picker starts having opinions about the operator's tools.
 * 2. **Guessing.** A plausible argv array for a harness nobody has captured is
 *    indistinguishable from a real one until it fails on someone's machine.
 *    ADR-0010's "never a flattering guess" is enforced here by making the
 *    unimplemented adapters throw rather than answer.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..')

/** Source with comments removed — this file's own prose names every word it forbids. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function harnessSourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(HERE, name))
}

const EVERY_ID: readonly HarnessId[] = ['claude', 'codex', 'openclaw', 'pi', 'shell']

function declaredAdaptersOf(): HarnessAdapter[] {
  return HARNESS_ADAPTERS.filter((adapter) => adapter.implementation.status === 'declared')
}

describe('the registry is named, not ranked (ADR-0010)', () => {
  it('has source files to check at all — an empty grep proves nothing', () => {
    expect(harnessSourceFiles().length).toBeGreaterThan(3)
  })

  it('no adapter carries a field anything could rank on', () => {
    // Asserted over the live objects, not the types: a field added as `any`,
    // or spread in from a config, would pass the compiler and fail here.
    const forbidden = ['rank', 'tier', 'score', 'priority', 'preferred', 'recommended', 'quality', 'weight']
    const offenders: string[] = []
    for (const adapter of HARNESS_ADAPTERS) {
      for (const key of Object.keys(adapter)) {
        if (forbidden.includes(key.toLowerCase())) offenders.push(`${adapter.id}.${key}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no source file in the module declares a ranking field either', () => {
    const offenders: string[] = []
    for (const file of harnessSourceFiles()) {
      const code = codeOf(readFileSync(file, 'utf8'))
      for (const pattern of [/\b(?:rank|tier|score|priority)\s*[?:]/, /\bpreferred\s*[?:]/]) {
        if (pattern.test(code)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('that detector bites on the field it is meant to catch', () => {
    expect(/\b(?:rank|tier|score|priority)\s*[?:]/.test('readonly tier: number')).toBe(true)
    expect(/\bpreferred\s*[?:]/.test('preferred?: boolean')).toBe(true)
    // And does not fire on the prose that explains why they are banned.
    expect(/\b(?:rank|tier|score|priority)\s*[?:]/.test(codeOf('// the ladder is named, not ranked\n'))).toBe(false)
  })

  it('is ordered by the spelling of the id, which carries no judgement', () => {
    const ids = HARNESS_ADAPTERS.map((adapter) => adapter.id)

    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)))
  })

  it('claude coming first is the alphabet, not a verdict', () => {
    // If a harness whose name sorts before "claude" is ever added, it goes
    // first and nothing about claude changes. That is the property being kept.
    expect(HARNESS_ADAPTERS[0]?.id).toBe('claude')
    expect('claude'.localeCompare('codex')).toBeLessThan(0)
  })
})

describe('the registry lists every harness it knows the name of', () => {
  it('covers the whole HarnessId union — a harness is never omitted to tidy the list', () => {
    expect(HARNESS_ADAPTERS.map((adapter) => adapter.id).sort()).toEqual([...EVERY_ID].sort())
  })

  it('has no duplicate ids', () => {
    const ids = HARNESS_ADAPTERS.map((adapter) => adapter.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('finds an adapter by id, and does not guess for an unknown one', () => {
    expect(harnessById('codex')?.id).toBe('codex')
    expect(harnessById('nope' as HarnessId)).toBeUndefined()
  })

  it('every adapter answers all five members of the seam', () => {
    for (const adapter of HARNESS_ADAPTERS) {
      for (const member of ['detect', 'envRecipe', 'launchArgv', 'continueArgv', 'resumeArgv'] as const) {
        expect(typeof adapter[member], `${adapter.id}.${member}`).toBe('function')
      }
    }
  })
})

describe('resumeArgv — resume-by-id, distinct from continueArgv\'s "most recent"', () => {
  it('claude’s resume is PROVEN, citing the cross-host resume spike', () => {
    const claude = harnessById('claude')
    if (claude === undefined) throw new Error('expected claude')

    const plan = claude.resumeArgv({ lane: 'lane-a', role: 'worker', port: 7317, instance: 'abc' }, 'a-session-id')
    expect(plan.kind).toBe('proven')
    if (plan.kind !== 'proven') throw new Error('expected proven')
    expect(plan.argv).toEqual(['--resume', 'a-session-id'])
    expect(plan.evidence).toMatch(/cross-host-resume/)
  })

  it('resume for an id-shaped nothing still carries a reason', () => {
    // codex has no captured resume-by-id form at all — "a-session-id" here is
    // a perfectly id-shaped string, and codex still has nothing to do with it.
    // ADR-0010: a `kind: 'none'` answer is compiler-required to say why, and
    // this is the case that proves it is not just claude's proven path that
    // gets a reason.
    const codex = harnessById('codex')
    if (codex === undefined) throw new Error('expected codex')

    const plan = codex.resumeArgv({ lane: 'lane-a', role: 'worker', port: 7317, instance: 'abc' }, 'a-session-id')
    expect(plan.kind).toBe('none')
    if (plan.kind !== 'none') throw new Error('expected none')
    expect(plan.reason.length).toBeGreaterThan(20)
    expect(plan.reason).toMatch(/resume --last|no session id|ADR-0010/)
  })
})

describe('declared-not-implemented harnesses are listed with their reason, never guessed at', () => {
  it('there are some — otherwise this whole describe proves nothing', () => {
    expect(declaredAdaptersOf().map((adapter) => adapter.id)).toEqual(['openclaw', 'pi', 'shell'])
  })

  it('each carries a real reason and what it would take — never "coming soon"', () => {
    for (const adapter of declaredAdaptersOf()) {
      const implementation = adapter.implementation
      if (implementation.status !== 'declared') throw new Error('filtered wrong')

      expect(implementation.reason.length, adapter.id).toBeGreaterThan(20)
      expect(implementation.whatItWouldTake.length, adapter.id).toBeGreaterThan(20)
      expect(implementation.reason.toLowerCase(), adapter.id).not.toContain('coming soon')
    }
  })

  it.each(['envRecipe', 'launchArgv', 'continueArgv', 'resumeArgv'] as const)(
    'refuses to answer %s, rather than returning something plausible',
    (member) => {
      const context = { lane: 'lane-a', role: 'worker' as const, port: 7317, instance: 'abc' }
      for (const adapter of declaredAdaptersOf()) {
        const call = adapter[member] as (launchContext: typeof context, sessionId?: string) => unknown
        expect(() => call(context, 'fake-session-id'), `${adapter.id}.${member}`).toThrow(HarnessNotImplementedError)
      }
    },
  )

  it('the refusal carries the reason, so a caller learns why and not just no', () => {
    const [openclaw] = declaredAdaptersOf()
    if (openclaw === undefined) throw new Error('expected a declared adapter')

    expect(() => openclaw.launchArgv({ lane: 'a', role: 'worker', port: 1, instance: 'i' })).toThrow(/no capture/)
  })

  it('still DETECTS — knowing pi is installed is true even though instrumenting it is not built', async () => {
    const pi = harnessById('pi')
    if (pi === undefined) throw new Error('expected pi')

    // Detection and launching are separate powers; refusing to look would lose
    // a true fact along with the untrue one.
    const detection = await pi.detect({ platform: 'linux', env: { PATH: '/nonexistent-bin' } })
    expect(detection.harness).toBe('pi')
    expect(detection.onPath.state).toBe('absent')
  })

  it('answers UNKNOWN where even the executable name is unverified', async () => {
    // OpenClaw's binary name is recorded nowhere in this repo. Searching PATH
    // for a name this lane invented would report a confident "absent" about a
    // spelling nobody checked — the same lie as a blind platform saying absent.
    const openclaw = harnessById('openclaw')
    if (openclaw === undefined) throw new Error('expected openclaw')

    const detection = await openclaw.detect({ platform: 'linux', env: { PATH: '/usr/bin' } })
    expect(detection.onPath.state).toBe('unknown')
    expect(detection.running.state).toBe('unknown')
  })

  it('a bare shell is declared as not-a-conductor, not as a missing feature', async () => {
    const shell = harnessById('shell')
    if (shell === undefined) throw new Error('expected shell')
    const implementation = shell.implementation
    if (implementation.status !== 'declared') throw new Error('expected declared')

    expect(implementation.reason).toMatch(/no continuity verb|not a conductor/i)
  })
})

describe('detectAll', () => {
  it('answers for every harness, and never invents an absent on a blind platform', async () => {
    const detections = await detectAll({ platform: 'darwin', env: { PATH: '/nonexistent-bin' } })

    expect(detections).toHaveLength(HARNESS_ADAPTERS.length)
    // macOS cannot read the process table, so no harness may be reported as
    // not-running. This is the lane's central claim, asserted across the whole
    // registry rather than one adapter at a time.
    expect(detections.map((detection) => detection.running.state)).toEqual(detections.map(() => 'unknown'))
  })

  it('returns them in registry order', async () => {
    const detections = await detectAll({ platform: 'linux', env: { PATH: '/nonexistent-bin' } })

    expect(detections.map((detection) => detection.harness)).toEqual(HARNESS_ADAPTERS.map((adapter) => adapter.id))
  })
})

describe('the module ships no route, and that is load-bearing', () => {
  it('imports nothing from api/, and defines no handler', () => {
    // prd-20 ruling 2 gates every concierge route on #234, and the concierge
    // law's declared-importer set is empty. #263 is the lane that adds a route;
    // this one must not, and the namespace law would fail if it did.
    const offenders: string[] = []
    for (const file of harnessSourceFiles()) {
      const code = codeOf(readFileSync(file, 'utf8'))
      if (/from\s*['"][^'"]*\/api\//.test(code)) offenders.push(`${path.basename(file)}: imports from api/`)
      if (/\b(?:fastify|app)\s*\.\s*(?:get|post|put|delete|register)\s*\(/.test(code)) {
        offenders.push(`${path.basename(file)}: registers a route`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never reaches a shell, and never spawns anything at all in this lane', () => {
    // ADR-0019 clause 4 forbids the shell; this lane goes further and spawns
    // nothing, because it only ever *produces* an argv array for the launch
    // power #263 will hold.
    const offenders: string[] = []
    for (const file of harnessSourceFiles()) {
      const code = codeOf(readFileSync(file, 'utf8'))
      for (const pattern of [/\bexecSync\s*\(/, /\bchild_process\b/, /\bshell\s*:\s*(?:true|['"])/]) {
        if (pattern.test(code)) offenders.push(`${path.basename(file)}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
