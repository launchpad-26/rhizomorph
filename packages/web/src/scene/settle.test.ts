import { createEvent, createIdFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { SETTLE_MS } from './geometry.js'
import type { LaneIndex } from './resolve.js'
import { SettleRegistry } from './settle.js'

/**
 * THE SETTLE (graft g3) — and the reason it is allowed back.
 *
 * Spike B cut the grow-in for screenshot determinism, not on principle, so the
 * fix is determinism rather than abstinence: every clock is injected, and a
 * pinned one produces a still image at a known stage. That is what these tests
 * are — the same growth, driven by a number this file chose.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const nextId = createIdFactory('s')

const INDEX: LaneIndex = {
  byBranch: new Map([['77-strip', 'lane-a']]),
  byWorktree: new Map([
    ['/repo__worktrees/77-strip', 'lane-a'],
    ['/repo__worktrees/78-table', 'lane-b'],
  ]),
  byHandle: new Map(),
  mainBranch: 'main',
  mainWorktree: '/repo',
}

function discovered(path: string, branch: string | null, isMain = false): RhizomorphEvent {
  return createEvent(
    'worktree.discovered',
    { path, branch, head: 'sha-000', isMain },
    { id: nextId(), ts: NOW },
  )
}

describe('a new lane grows out of the root-mass', () => {
  it('starts growing on worktree.discovered, and only on that', () => {
    const settle = new SettleRegistry()
    const started = settle.note([discovered('/repo__worktrees/77-strip', '77-strip')], INDEX, NOW)

    expect(started).toEqual(['lane-a'])
    expect(settle.progress(NOW).get('lane-a')).toBe(0)
    expect(settle.settling(NOW)).toBe(true)
  })

  it('is deterministic under a pinned clock — a known stage, not a race', () => {
    const settle = new SettleRegistry()
    settle.note([discovered('/repo__worktrees/77-strip', '77-strip')], INDEX, NOW)

    expect(settle.progress(NOW + SETTLE_MS * 0.25).get('lane-a')).toBeCloseTo(0.25, 10)
    expect(settle.progress(NOW + SETTLE_MS * 0.5).get('lane-a')).toBeCloseTo(0.5, 10)
    // Twice with the same clock is the same picture.
    expect(settle.progress(NOW + 300).get('lane-a')).toBe(settle.progress(NOW + 300).get('lane-a'))
  })

  it('drops a finished thread from the map rather than pinning it at 1', () => {
    // An absent entry means "already grown", so a settled fleet costs nothing
    // per frame — which is the common case by a wide margin.
    const settle = new SettleRegistry()
    settle.note([discovered('/repo__worktrees/77-strip', '77-strip')], INDEX, NOW)

    expect(settle.progress(NOW + SETTLE_MS).size).toBe(0)
    expect(settle.settling(NOW + SETTLE_MS)).toBe(false)
  })

  it('fires once per discovery, however often the collector re-reports it', () => {
    const settle = new SettleRegistry()
    const event = discovered('/repo__worktrees/77-strip', '77-strip')

    expect(settle.note([event], INDEX, NOW)).toEqual(['lane-a'])
    // The git collector re-reports every worktree it can see whenever it
    // restarts. A lane already growing keeps its original start instant.
    expect(settle.note([event], INDEX, NOW + 400)).toEqual([])
    expect(settle.note([event], INDEX, NOW + 5_000)).toEqual([])
    expect(settle.progress(NOW + 400).get('lane-a')).toBeCloseTo(400 / SETTLE_MS, 10)
  })

  it('does not sprout the root-mass as a thread', () => {
    const settle = new SettleRegistry()
    expect(settle.note([discovered('/repo', 'main', true)], INDEX, NOW)).toEqual([])
    expect(settle.settling(NOW)).toBe(false)
  })

  it('ignores a discovery for a lane the fleet does not have', () => {
    const settle = new SettleRegistry()
    expect(settle.note([discovered('/elsewhere/99-ghost', '99-ghost')], INDEX, NOW)).toEqual([])
  })

  it('grows several lanes at once, each from its own instant', () => {
    const settle = new SettleRegistry()
    settle.note([discovered('/repo__worktrees/77-strip', '77-strip')], INDEX, NOW)
    settle.note([discovered('/repo__worktrees/78-table', null)], INDEX, NOW + 400)

    const progress = settle.progress(NOW + 400)
    expect(progress.get('lane-a')).toBeCloseTo(400 / SETTLE_MS, 10)
    expect(progress.get('lane-b')).toBe(0)
  })
})


/**
 * THICKEN WHILE ALIVE (prd-33 ruling 9's third verb; growth class, cause
 * 'work'). The tracker is pure arithmetic on injected clocks, so every law is
 * a table: only change animates, understatement only, gentleness as numbers,
 * and a held clock holds the width.
 */
describe('the thicken tracker', () => {
  const fleetOf = (lanes: ReadonlyArray<{ id: string; outputTokens: number }>) =>
    ({ lanes }) as unknown as Parameters<SettleRegistry['sizes']>[0]
  const T0 = 1_000_000

  it('initialises AT the target — a fleet appearing at size does not thicken from zero', () => {
    const settle = new SettleRegistry()
    const sizes = settle.sizes(fleetOf([{ id: 'a', outputTokens: 50_000 }]), T0)
    const again = settle.sizes(fleetOf([{ id: 'a', outputTokens: 50_000 }]), T0 + 10_000)
    expect(sizes.get('a')).toBe(again.get('a'))
  })

  it('approaches a raised target monotonically and never exceeds it', () => {
    const settle = new SettleRegistry()
    settle.sizes(fleetOf([{ id: 'a', outputTokens: 1_000 }]), T0)
    const grown = fleetOf([{ id: 'a', outputTokens: 200_000 }])
    const target = settle.sizes(fleetOf([{ id: 'b', outputTokens: 200_000 }]), T0).get('b') as number
    let prev = 0
    for (let step = 1; step <= 20; step += 1) {
      const value = settle.sizes(grown, T0 + step * 5_000).get('a') as number
      expect(value).toBeGreaterThanOrEqual(prev)
      expect(value).toBeLessThanOrEqual(target)
      prev = value
    }
    // …and genuinely converges: two minutes in, it is essentially there.
    const late = settle.sizes(grown, T0 + 240_000).get('a') as number
    expect(late).toBeCloseTo(target, 2)
  })

  it('is rate-capped — gentle stated as a number', () => {
    const settle = new SettleRegistry()
    settle.sizes(fleetOf([{ id: 'a', outputTokens: 1_000 }]), T0)
    const before = settle.sizes(fleetOf([{ id: 'a', outputTokens: 1_000 }]), T0).get('a') as number
    const target = new SettleRegistry().sizes(fleetOf([{ id: 'x', outputTokens: 500_000 }]), T0).get('x') as number
    const after = settle
      .sizes(fleetOf([{ id: 'a', outputTokens: 500_000 }]), T0 + 1_000)
      .get('a') as number
    // One second of travel gains at most maxRatePerS of the target.
    expect(after - before).toBeLessThanOrEqual(target * 0.35 + 1e-9)
  })

  it('holds still on a held clock — thicken freezes with the picture', () => {
    const settle = new SettleRegistry()
    settle.sizes(fleetOf([{ id: 'a', outputTokens: 1_000 }]), T0)
    const first = settle.sizes(fleetOf([{ id: 'a', outputTokens: 300_000 }]), T0 + 2_000).get('a')
    const held = settle.sizes(fleetOf([{ id: 'a', outputTokens: 300_000 }]), T0 + 2_000).get('a')
    expect(held).toBe(first)
  })

  it('forgets a departed lane — a returning handle initialises at its own target', () => {
    const settle = new SettleRegistry()
    settle.sizes(fleetOf([{ id: 'a', outputTokens: 1_000 }]), T0)
    settle.sizes(fleetOf([{ id: 'a', outputTokens: 400_000 }]), T0 + 1_000)
    // The lane leaves…
    settle.sizes(fleetOf([]), T0 + 2_000)
    // …and comes back at size: no animation, straight to target.
    const back = settle.sizes(fleetOf([{ id: 'a', outputTokens: 400_000 }]), T0 + 3_000).get('a') as number
    const fresh = new SettleRegistry().sizes(fleetOf([{ id: 'a', outputTokens: 400_000 }]), T0).get('a') as number
    expect(back).toBe(fresh)
  })
})
