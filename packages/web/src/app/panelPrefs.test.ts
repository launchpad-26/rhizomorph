import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNADOPTED_REPO } from '../settings/registry.js'
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
  it('defaults every panel to expanded — no panel starts hidden any more (#552)', () => {
    expect(isPanelCollapsed('fleet')).toBe(false)
    expect(isPanelCollapsed('dock')).toBe(false)
    expect(isPanelCollapsed('scene')).toBe(false)
    expect(isPanelCollapsed('some-future-panel')).toBe(false)
    // The feed used to be the one exception (prd9 legibility: a history stream
    // that started as a peek). prd-32 ruling 5 made it a dock TAB, and S3
    // forbids a hidden tab outright, so the exception has no subject left —
    // `appearance.panelsCollapsed`'s declared default is empty and every panel
    // that still has a collapse starts open.
    expect(isPanelCollapsed('feed')).toBe(false)
    expect(isPanelCollapsed('collisions')).toBe(false)
  })

  it('round-trips the scene\'s own collapse toggle (prd4 ruling 2 — one mechanism, not two)', () => {
    setPanelCollapsed('scene', true)

    expect(isPanelCollapsed('scene')).toBe(true)
    expect(isPanelCollapsed('fleet')).toBe(false)

    setPanelCollapsed('scene', false)
    expect(isPanelCollapsed('scene')).toBe(false)
  })

  /**
   * AMENDED for #550: the collapse map lives in the preference registry now
   * (`appearance.panelsCollapsed`, repo-scoped per prd-35 ruling 3), so the key
   * it lands under is the registry's repo bag rather than this file's own. What
   * is deliberately unchanged is the SHAPE stored — only the panels a person
   * actually touched, never the defaults merged in, so a later change to a
   * declared default still reaches an operator who has collapsed something.
   */
  it('round-trips a collapsed state through the registry, storing the overlay and not the defaults', () => {
    setPanelCollapsed('fleet', true)

    expect(isPanelCollapsed('fleet')).toBe(true)
    expect(isPanelCollapsed('collisions')).toBe(false)

    const stored = JSON.parse(localStorage.getItem('rhizomorph.prefs.repo.v1') ?? '{}')
    expect(stored).toEqual({ [UNADOPTED_REPO]: { 'appearance.panelsCollapsed': { fleet: true } } })
  })

  /**
   * The migration, proven rather than asserted (#550). An operator who collapsed
   * a panel before the registry existed has a `rhizomorph.panelCollapsed.v1` and
   * nothing else; the registry declares that key as this entry's legacy fallback,
   * so the state answers until the first write supersedes it — and the write
   * really does supersede it, rather than the two disagreeing forever.
   */
  it('still reads the pre-registry key, and supersedes it on the first write', () => {
    localStorage.setItem('rhizomorph.panelCollapsed.v1', JSON.stringify({ fleet: true, feed: false }))

    expect(isPanelCollapsed('fleet')).toBe(true)
    expect(isPanelCollapsed('feed')).toBe(false)

    setPanelCollapsed('fleet', false)
    expect(isPanelCollapsed('fleet')).toBe(false)
    // …and the panel the write never named keeps the value the legacy key gave it.
    expect(isPanelCollapsed('feed')).toBe(false)
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
    // Untouched by either explicit set — falls back to its own default.
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

  it('keeps its own key AND its own scope, so a scene pref is never mistaken for a collapsed panel', () => {
    // A key called `panelCollapsed` holding a scene preference is the kind of
    // small lie that makes the next person delete the wrong thing. Since #550
    // the two are further apart than that: different registry ids, and
    // different scopes — how you like to read a picture is yours (machine),
    // which panels you folded belongs to the repo whose panels they are.
    setScenePref('hideFinished', true)
    setPanelCollapsed('fleet', true)

    expect(JSON.parse(localStorage.getItem('rhizomorph.prefs.machine.v1') ?? '{}')).toEqual({
      'appearance.hideFinished': true,
    })
    expect(JSON.parse(localStorage.getItem('rhizomorph.prefs.repo.v1') ?? '{}')).toEqual({
      [UNADOPTED_REPO]: { 'appearance.panelsCollapsed': { fleet: true } },
    })
  })

  it('still reads the pre-registry scene key (#550 migration), and falls back to visible when it is malformed', () => {
    localStorage.setItem('rhizomorph.scenePrefs.v1', JSON.stringify({ hideFinished: true }))
    expect(isScenePref('hideFinished')).toBe(true)

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
