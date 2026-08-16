import { describe, expect, it } from 'vitest'
import { emptyDigest, type AttentionRef, type FleetDigest } from './digest.js'
import { decideNotifications } from './notify.js'
import { DEFAULT_PREFERENCES, type HostPreferences } from './prefs.js'

const WAITING: AttentionRef = { id: 'waiting:lane-07', label: 'lane-07', kind: 'waiting' }
const LOOPING: AttentionRef = { id: 'looping:lane-03', label: 'lane-03', kind: 'looping' }
const FROZEN: AttentionRef = { id: 'frozen:lane-02', label: 'lane-02', kind: 'frozen' }

function digest(overrides: Partial<FleetDigest>): FleetDigest {
  return { ...emptyDigest(), ...overrides }
}

function withPrefs(overrides: Partial<HostPreferences>): HostPreferences {
  return { ...DEFAULT_PREFERENCES, ...overrides }
}

describe('the four conditions (ruling 8)', () => {
  it('raises one when a lane reaches the rung that wants a human', () => {
    const notifications = decideNotifications(
      digest({}),
      digest({ rank: 'needs-you', needsYou: [WAITING] }),
      DEFAULT_PREFERENCES,
    )
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.kind).toBe('needs-human')
    expect(notifications[0]?.body).toContain('lane-07')
    expect(notifications[0]?.ref).toEqual(WAITING)
  })

  it('raises one when a lane dies', () => {
    const notifications = decideNotifications(digest({}), digest({ rank: 'broken', broken: [FROZEN] }), DEFAULT_PREFERENCES)
    expect(notifications.map((entry) => entry.kind)).toEqual(['died'])
  })

  it('raises one when work lands, and says how much', () => {
    expect(decideNotifications(digest({ landings: 2 }), digest({ landings: 3 }), DEFAULT_PREFERENCES)[0]?.body).toBe(
      'a lane landed and folded',
    )
    expect(decideNotifications(digest({ landings: 0 }), digest({ landings: 3 }), DEFAULT_PREFERENCES)[0]?.body).toBe(
      '3 lanes landed and folded',
    )
  })

  it('raises one when spend crosses the threshold a person set', () => {
    const preferences = withPrefs({ 'notifications.spendThresholdUsd': 10 })
    const notifications = decideNotifications(
      digest({ costUsd: 9.5, costIsAuthoritative: true }),
      digest({ costUsd: 10.25, costIsAuthoritative: true }),
      preferences,
    )
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.body).toBe('$10.25 this session — your threshold is $10.00')
  })
})

describe('transitions, not states', () => {
  it('raises nothing for a lane that was already waiting a tick ago', () => {
    const before = digest({ rank: 'needs-you', needsYou: [WAITING] })
    const after = digest({ rank: 'needs-you', needsYou: [WAITING] })
    expect(decideNotifications(before, after, DEFAULT_PREFERENCES)).toEqual([])
  })

  it('raises one for the SECOND way a lane needs you, because it is a different ladder item', () => {
    const before = digest({ rank: 'needs-you', needsYou: [WAITING] })
    const after = digest({ rank: 'needs-you', needsYou: [WAITING, LOOPING] })
    expect(decideNotifications(before, after, DEFAULT_PREFERENCES).map((entry) => entry.ref?.id)).toEqual([
      'looping:lane-03',
    ])
  })

  it('raises nothing on the first digest, however alarming it is', () => {
    // The common case is a RESUMED session: the shell folds a whole day of
    // history in its first second. Notifying on it would open the app with
    // twenty toasts about lanes that were dealt with yesterday.
    const first = digest({ rank: 'broken', needsYou: [WAITING, LOOPING], broken: [FROZEN], landings: 9, costUsd: 400 })
    expect(decideNotifications(null, first, withPrefs({ 'notifications.spendThresholdUsd': 1 }))).toEqual([])
  })

  it('does not raise a second time for a threshold already crossed', () => {
    const preferences = withPrefs({ 'notifications.spendThresholdUsd': 10 })
    const crossed = digest({ costUsd: 10.5, costIsAuthoritative: true })
    const later = digest({ costUsd: 12, costIsAuthoritative: true })
    expect(decideNotifications(crossed, later, preferences)).toEqual([])
  })

  it('raises nothing when landings go down — a fold that shrank is not a landing', () => {
    expect(decideNotifications(digest({ landings: 3 }), digest({ landings: 1 }), DEFAULT_PREFERENCES)).toEqual([])
  })
})

describe('each condition is individually mutable (S2\'s acceptance)', () => {
  const before = digest({ landings: 0, costUsd: 0, costIsAuthoritative: true })
  const after = digest({
    rank: 'broken',
    needsYou: [WAITING],
    broken: [FROZEN],
    landings: 1,
    costUsd: 50,
    costIsAuthoritative: true,
  })
  const preferences = withPrefs({ 'notifications.spendThresholdUsd': 10 })

  it('raises all four when all four are on', () => {
    expect(decideNotifications(before, after, preferences).map((entry) => entry.kind)).toEqual([
      'needs-human',
      'died',
      'landed',
      'spend',
    ])
  })

  it.each([
    ['notifications.needsHuman', 'needs-human'],
    ['notifications.died', 'died'],
    ['notifications.landed', 'landed'],
    ['notifications.spend', 'spend'],
  ] as const)('drops only %s when it is off', (id, kind) => {
    const muted = decideNotifications(before, after, { ...preferences, [id]: false })
    expect(muted.map((entry) => entry.kind)).not.toContain(kind)
    expect(muted).toHaveLength(3)
  })
})

describe('the threshold is a value a person owns', () => {
  it('is silent until one is set, however much is spent', () => {
    const notifications = decideNotifications(
      digest({ costUsd: 0, costIsAuthoritative: true }),
      digest({ costUsd: 900, costIsAuthoritative: true }),
      withPrefs({ 'notifications.spendThresholdUsd': null }),
    )
    expect(notifications).toEqual([])
  })

  it('never fires on unmeasured cost — an unknown is not a dollar (prd-9 ruling 7)', () => {
    const notifications = decideNotifications(
      digest({ costUsd: 0, costIsAuthoritative: null }),
      digest({ costUsd: 40, costIsAuthoritative: null }),
      withPrefs({ 'notifications.spendThresholdUsd': 10 }),
    )
    expect(notifications).toEqual([])
  })

  it('fires exactly on the boundary, not one cent past it', () => {
    const preferences = withPrefs({ 'notifications.spendThresholdUsd': 10 })
    expect(
      decideNotifications(
        digest({ costUsd: 9.99, costIsAuthoritative: true }),
        digest({ costUsd: 10, costIsAuthoritative: true }),
        preferences,
      ),
    ).toHaveLength(1)
  })
})
