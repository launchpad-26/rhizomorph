import { beforeEach, describe, expect, it } from 'vitest'
import { isPanelCollapsed, setPanelCollapsed } from './panelPrefs.js'

beforeEach(() => {
  localStorage.clear()
})

describe('panelPrefs', () => {
  it('defaults every panel to expanded, including collisions (deliberate ruling)', () => {
    expect(isPanelCollapsed('collisions')).toBe(false)
    expect(isPanelCollapsed('fleet')).toBe(false)
    expect(isPanelCollapsed('feed')).toBe(false)
    expect(isPanelCollapsed('some-future-panel')).toBe(false)
  })

  it('round-trips a collapsed state through localStorage', () => {
    setPanelCollapsed('fleet', true)

    expect(isPanelCollapsed('fleet')).toBe(true)
    expect(isPanelCollapsed('collisions')).toBe(false)

    const stored = JSON.parse(localStorage.getItem('observatory.panelCollapsed.v1') ?? '{}')
    expect(stored).toEqual({ fleet: true })
  })

  it('round-trips back to expanded', () => {
    setPanelCollapsed('feed', true)
    setPanelCollapsed('feed', false)

    expect(isPanelCollapsed('feed')).toBe(false)
  })

  it('keeps per-panel state independent', () => {
    setPanelCollapsed('fleet', true)
    setPanelCollapsed('collisions', true)

    expect(isPanelCollapsed('fleet')).toBe(true)
    expect(isPanelCollapsed('collisions')).toBe(true)
    expect(isPanelCollapsed('feed')).toBe(false)
  })

  it('falls back to the default when stored JSON is malformed', () => {
    localStorage.setItem('observatory.panelCollapsed.v1', '{not json')

    expect(isPanelCollapsed('collisions')).toBe(false)
  })
})
