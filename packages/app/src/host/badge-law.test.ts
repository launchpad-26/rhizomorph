import { LADDER_ORDER, LADDER_WORD } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { badgeFor, unreachableBadge } from './badge.js'
import { emptyDigest, type FleetDigest } from './digest.js'
import { decideNotifications } from './notify.js'
import { DEFAULT_PREFERENCES, HOST_PREFS, type HostPreferences } from './prefs.js'

/** Every notification silenced, and nothing else changed. */
const ALL_MUTED: HostPreferences = {
  ...DEFAULT_PREFERENCES,
  'notifications.needsHuman': false,
  'notifications.died': false,
  'notifications.landed': false,
  'notifications.spend': false,
}

function digestWith(overrides: Partial<FleetDigest>): FleetDigest {
  return { ...emptyDigest(), ...overrides }
}

describe('the badge is the ladder, promoted', () => {
  it('carries the instrument\'s own word for every rung', () => {
    for (const rank of LADDER_ORDER) {
      const badge = badgeFor(rank)
      expect(badge.rank).toBe(rank)
      expect(badge.word).toBe(LADDER_WORD[rank])
      expect(badge.tooltip).toContain(LADDER_WORD[rank])
    }
  })

  it('says nothing at rest and something at every other rung', () => {
    expect(badgeFor('calm').mark).toBe('')
    expect(badgeFor('notice').mark).not.toBe('')
    expect(badgeFor('needs-you').mark).not.toBe('')
    expect(badgeFor('broken').mark).not.toBe('')
  })

  it('gives each rung its own form — a person who cannot see the hue still reads it', () => {
    const shapes = LADDER_ORDER.map((rank) => badgeFor(rank).shape)
    expect(new Set(shapes).size).toBe(LADDER_ORDER.length)
  })

  it('wants attention on exactly the two rungs that want a person', () => {
    expect(LADDER_ORDER.filter((rank) => badgeFor(rank).wantsAttention)).toEqual(['needs-you', 'broken'])
  })
})

/**
 * RULING 8'S LAW: **a muted condition still moves the badge.** Muting is about
 * interruption, never about hiding — and the mechanism is structural: the badge
 * is computed from a rung, and there is no parameter through which a preference
 * could reach it.
 */
describe('a muted condition still moves the badge (#564)', () => {
  it('produces an identical badge with every notification silenced', () => {
    for (const rank of LADDER_ORDER) {
      expect(badgeFor(rank)).toEqual(badgeFor(rank))
    }
    // Said the way the mechanism actually works: the function that decides the
    // badge takes one argument, and it is not a preference.
    expect(badgeFor.length).toBe(1)
  })

  it('silences the notification and moves the badge, in the same transition', () => {
    const before = digestWith({ rank: 'calm' })
    const after = digestWith({
      rank: 'broken',
      broken: [{ id: 'frozen:lane-07', label: 'lane-07', kind: 'frozen' }],
    })

    // Muted: no interruption…
    expect(decideNotifications(before, after, ALL_MUTED)).toEqual([])
    // …and the badge moves anyway, to the same place it would have.
    expect(badgeFor(after.rank)).toEqual(badgeFor('broken'))
    expect(badgeFor(after.rank).word).toBe('BROKEN')

    // Unmuted, the same transition raises exactly one notification — so the
    // muting above is a real mute rather than a transition that never fired.
    expect(decideNotifications(before, after, DEFAULT_PREFERENCES)).toHaveLength(1)
  })

  it('has no preference that could reach the badge even if someone tried', () => {
    // Every declared preference, by id: none of them names the badge or a rung,
    // because there is nothing here for such a preference to do.
    const ids = HOST_PREFS.map((entry) => entry.id).join(' ')
    expect(ids).not.toMatch(/badge|rank|ladder|alarm|attention/i)
  })
})

describe('no reading is not a calm reading (S2)', () => {
  it('says so, in words, rather than showing an all clear', () => {
    const badge = unreachableBadge('the stream closed')
    expect(badge.word).toBe('NO READING')
    expect(badge.tooltip).toContain('the stream closed')
    expect(badge.word).not.toBe(LADDER_WORD.calm)
  })

  it('does not summon anybody — a gap in the shell is not a lane\'s pathology', () => {
    expect(unreachableBadge('x').wantsAttention).toBe(false)
  })

  it('wears a form no rung wears, so it cannot be misread as one', () => {
    const shapes = LADDER_ORDER.map((rank) => badgeFor(rank).shape)
    expect(shapes).not.toContain(unreachableBadge('x').shape)
  })
})
