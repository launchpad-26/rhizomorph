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
