import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  escapeShouldExitFocus,
  isPanelCollapsed,
  isScenePref,
  requestPanelFocus,
  setPanelCollapsed,
  setScenePref,
  useFocusRequest,
} from './panelPrefs.js'

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

describe('panelPrefs', () => {
  it('defaults every panel to expanded, including collisions (deliberate ruling)', () => {
    expect(isPanelCollapsed('collisions')).toBe(false)
    expect(isPanelCollapsed('fleet')).toBe(false)
    expect(isPanelCollapsed('feed')).toBe(false)
    expect(isPanelCollapsed('scene')).toBe(false)
    expect(isPanelCollapsed('some-future-panel')).toBe(false)
  })

  it('round-trips the scene\'s own collapse toggle (prd4 ruling 2 — one mechanism, not two)', () => {
    setPanelCollapsed('scene', true)

    expect(isPanelCollapsed('scene')).toBe(true)
    expect(isPanelCollapsed('fleet')).toBe(false)

    setPanelCollapsed('scene', false)
    expect(isPanelCollapsed('scene')).toBe(false)
  })

  it('round-trips a collapsed state through localStorage', () => {
    setPanelCollapsed('fleet', true)

    expect(isPanelCollapsed('fleet')).toBe(true)
    expect(isPanelCollapsed('collisions')).toBe(false)

    const stored = JSON.parse(localStorage.getItem('rhizomorph.panelCollapsed.v1') ?? '{}')
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
    localStorage.setItem('rhizomorph.panelCollapsed.v1', '{not json')

    expect(isPanelCollapsed('collisions')).toBe(false)
  })
})

describe('the scene prefs — hide-finished (prd5 ruling 3)', () => {
  it('shows scars by default, which is the ruling and not a fallback', () => {
    // Invisible completion is indistinguishable from a render bug: the operator
    // cannot tell "that lane landed" from "the scene stopped drawing it". So the
    // shipped reading is *visible*, and hiding is an operator's own decision.
    expect(isScenePref('hideFinished')).toBe(false)
  })

  it('round-trips through localStorage, and back again', () => {
    setScenePref('hideFinished', true)
    expect(isScenePref('hideFinished')).toBe(true)

    setScenePref('hideFinished', false)
    expect(isScenePref('hideFinished')).toBe(false)
  })

  it('keeps its own key, so a scene pref is never mistaken for a collapsed panel', () => {
    // A key called `panelCollapsed` holding a scene preference is the kind of
    // small lie that makes the next person delete the wrong thing.
    setScenePref('hideFinished', true)
    setPanelCollapsed('fleet', true)

    expect(JSON.parse(localStorage.getItem('rhizomorph.scenePrefs.v1') ?? '{}')).toEqual({
      hideFinished: true,
    })
    expect(JSON.parse(localStorage.getItem('rhizomorph.panelCollapsed.v1') ?? '{}')).toEqual({
      fleet: true,
    })
  })

  it('falls back to visible when the stored JSON is malformed', () => {
    localStorage.setItem('rhizomorph.scenePrefs.v1', 'not json at all')
    expect(isScenePref('hideFinished')).toBe(false)
  })
})

describe('requestPanelFocus / useFocusRequest (prd9 B1a — FOCUS TRACE\'s own trigger)', () => {
  function Listener({ id, onRequest }: { id: string; onRequest: () => void }) {
    useFocusRequest(id, onRequest)
    return null
  }

  it('reaches a listener registered for that id, and no other', () => {
    const heard: string[] = []
    render(createElement(Listener, { id: 'trace', onRequest: () => heard.push('trace') }))
    render(createElement(Listener, { id: 'fleet', onRequest: () => heard.push('fleet') }))

    requestPanelFocus('trace')

    expect(heard).toEqual(['trace'])
  })

  it('is inert when nobody is listening for that id — a request with no owner is not an error', () => {
    expect(() => requestPanelFocus('nobody-home')).not.toThrow()
  })

  it('stops hearing once its component unmounts', () => {
    const heard: string[] = []
    const { unmount } = render(createElement(Listener, { id: 'trace', onRequest: () => heard.push('trace') }))

    unmount()
    requestPanelFocus('trace')

    expect(heard).toEqual([])
  })
})

describe('escapeShouldExitFocus (ruling 6 — Esc precedence)', () => {
  it('exits focus once nothing is selected', () => {
    expect(escapeShouldExitFocus(null)).toBe(true)
  })

  it('defers to an open selection — a drawer closes first, not focus', () => {
    expect(escapeShouldExitFocus('42-otel-receiver')).toBe(false)
  })
})
