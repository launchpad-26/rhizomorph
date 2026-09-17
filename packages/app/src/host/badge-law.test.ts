import { readFileSync } from 'node:fs'
import path from 'node:path'
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
      // And identical for the same FACTS, however they are supplied.
      expect(badgeFor(rank, 3)).toEqual(badgeFor(rank, 3))
    }

    /**
     * **Amended by prd-58 ruling 5 (#615): two arguments, both facts.**
     *
     * This read `expect(badgeFor.length).toBe(1)`, and the sentence beside it
     * said what it was really for: *"it is not a preference."* The arity was a
     * proxy for that, and the proxy stopped being true before the property did
     * — the second argument is how many lanes across every watched colony need
     * a person, which is a fact about the machine exactly as the rung is.
     *
     * So the law now asserts the property directly. A preference reaching this
     * function would have to arrive as a third argument or as a read of some
     * ambient state, and both of those move this number.
     */
    expect(badgeFor.length).toBe(2)
    // The real property: nothing but its arguments decides the badge. Called
    // twice in different orders, with nothing else changed, it answers the
    // same — which a function reading a preference could not promise.
    const forward = LADDER_ORDER.map((rank) => badgeFor(rank, 1))
    const backward = [...LADDER_ORDER].reverse().map((rank) => badgeFor(rank, 1)).reverse()
    expect(forward).toEqual(backward)
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

describe('the badge counts every colony (prd-58 ruling 5, #615)', () => {
  it('a waiting lane in a colony the scene is NOT showing still wants attention', () => {
    // The case ruling 5 exists for, at the surface where it matters most: the
    // tray is visible when the app is not. A badge counting only the rendered
    // colony would make ruling 1 unsafe in exactly the way ruling 5 prevents —
    // calm on screen, three lanes waiting in a repo nobody is looking at.
    const badge = badgeFor('calm', 3)
    expect(badge.rank).toBe('calm')
    expect(badge.wantsAttention).toBe(true)
    expect(badge.needsYouAcrossColonies).toBe(3)
    expect(badge.tooltip).toContain('3 lanes need you')
  })

  it('says "lane" for one and "lanes" for more', () => {
    expect(badgeFor('calm', 1).tooltip).toContain('1 lane need you')
    expect(badgeFor('calm', 2).tooltip).toContain('2 lanes need you')
  })

  it('a count of ZERO speaks like the rung alone, but is still REPORTED', () => {
    // Zero is a fact — "I looked at every colony and nothing needs you" — and
    // absent is a gap. They render the same and they are not the same, so the
    // count survives on the badge while the tooltip and the affordance stay
    // exactly what the rung says on its own.
    const zero = badgeFor('calm', 0)
    const none = badgeFor('calm')
    expect(zero.tooltip).toBe(none.tooltip)
    expect(zero.wantsAttention).toBe(none.wantsAttention)
    expect(zero.needsYouAcrossColonies).toBe(0)
    expect(none.needsYouAcrossColonies).toBeUndefined()
  })

  it('NO count is different from a count of zero, and is not rendered as 0', () => {
    // A server that predates prd-58, or a replay server, reports no colonies.
    // That is a gap, not a quiet machine, and the badge says nothing rather
    // than claiming nothing needs you.
    const badge = badgeFor('calm')
    expect(badge.needsYouAcrossColonies).toBeUndefined()
    expect(badge.tooltip).not.toContain('need you')
  })

  it('the rung still speaks on its own when the count is absent', () => {
    expect(badgeFor('broken').wantsAttention).toBe(true)
    expect(badgeFor('needs-you').wantsAttention).toBe(true)
    expect(badgeFor('calm').wantsAttention).toBe(false)
  })
})

describe('the colony count has a CALLER (review of #621)', () => {
  /**
   * The review's finding, kept as a permanent case.
   *
   * `badgeFor` gained the parameter and `entry.ts` called it with one argument,
   * so `needsYouAcrossColonies` was always `undefined` and `wantsAttention` was
   * byte-for-byte what it had been. A capability with no caller — the shape
   * prd-57's closeout names as its own most expensive defect, shipped three
   * times in prd-58.
   *
   * A source law rather than an Electron boot: the whole defect is one call
   * site, and reading it is exact where booting a tray is slow and flaky.
   */
  const ENTRY = path.join(import.meta.dirname, '..', 'main', 'entry.ts')
  const NEWLINE = String.fromCharCode(10)

  it('the shell passes the cross-colony count to badgeFor, not just a rank', () => {
    const source = readFileSync(ENTRY, 'utf8')
    const calls = source.split(NEWLINE).filter((line) => line.includes('badgeFor('))
    expect(calls.length, 'entry.ts no longer calls badgeFor — this law has lost its subject').toBeGreaterThan(0)
    // EVERY call site, not just one: a second that forgot the count would put
    // the tray back to rank-only on whichever path reached it first.
    for (const call of calls) expect(call).toContain('colonyNeedsYou')
  })

  it('the feed has somewhere to report it from', () => {
    // The other half of the seam. A call site that reads a variable nothing
    // ever assigns is the same defect wearing a different hat.
    const source = readFileSync(ENTRY, 'utf8')
    expect(source).toContain('onColonies:')
  })
})
