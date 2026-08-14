import { describe, expect, it } from 'vitest'
import { findUnpinnedFixtures, isVersionPinned } from './version-pinning.js'

describe('isVersionPinned', () => {
  it('accepts a harness-and-version-prefixed name, single or multi-word harness', () => {
    expect(isVersionPinned('claude-code-2.1.222-tail-turn-complete.jsonl')).toBe(true)
    expect(isVersionPinned('codex-1.0.0-session-basic.jsonl')).toBe(true)
  })

  it('rejects a name with no version segment at all', () => {
    expect(isVersionPinned('logs-basic.json')).toBe(false)
    expect(isVersionPinned('metrics-token-and-cost.json')).toBe(false)
    expect(isVersionPinned('worker-4-tmux-collector.jsonl')).toBe(false)
  })

  it('rejects a name whose digits are not shaped like a version', () => {
    expect(isVersionPinned('worker-2-core.jsonl')).toBe(false)
  })
})

describe('findUnpinnedFixtures', () => {
  it('reports every unpinned name not covered by an exemption', () => {
    const names = ['claude-code-2.1.222-tail-turn-complete.jsonl', 'logs-basic.json', 'metrics-conductor.json']
    expect(findUnpinnedFixtures(names)).toEqual(['logs-basic.json', 'metrics-conductor.json'])
  })

  it('drops an exempted name from the report, by exact name match', () => {
    const names = ['logs-basic.json', 'metrics-conductor.json']
    const exemptions = [{ name: 'logs-basic.json', reason: 'predates the pinning discipline' }]
    expect(findUnpinnedFixtures(names, exemptions)).toEqual(['metrics-conductor.json'])
  })

  it('matches an exemption by exact name, never by substring — an unpinned superstring of an exempt name stays reported', () => {
    // The old form of this test used a PINNED name, which `isVersionPinned`
    // excluded before the exemption set was ever consulted — a substring-
    // matching exemption regression survived all six of these tests (review
    // of #319, finding 3). An unpinned superstring is the case that bites.
    const names = ['x-logs-basic.json']
    const exemptions = [{ name: 'logs-basic.json', reason: 'predates the pinning discipline' }]
    expect(findUnpinnedFixtures(names, exemptions)).toEqual(['x-logs-basic.json'])
  })
})
