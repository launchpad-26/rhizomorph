import type { ObservatoryEvent } from '@observatory/core'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SceneView, detectWebgl } from './SceneView.js'
import { fixtureEvents } from './fixtures.js'

/**
 * Render smoke tests, deliberately thin — architecture.md says the scene is
 * verified by eyes, not units, and jsdom has no GPU. What is asserted here is
 * the contract the shell depends on: it mounts with fixture data, it degrades
 * instead of throwing when WebGL is missing, and every station stays reachable
 * as readable, focusable DOM text. The geometry itself is covered by
 * `layout.test.ts` and `sceneModel.test.ts`.
 */

afterEach(cleanup)

const NOW = 1_000_000_000
const EVENTS: ObservatoryEvent[] = fixtureEvents(NOW)

describe('detectWebgl', () => {
  it('is false under jsdom, which is why these tests exercise the text path', () => {
    expect(detectWebgl()).toBe(false)
  })
})

describe('SceneView', () => {
  it('renders the fixture swarm without a GPU', () => {
    render(<SceneView events={EVENTS} demo webgl={false} />)

    expect(screen.getByText('observatory')).toBeInTheDocument()
    expect(screen.getByText(/11 worktrees · \d+ commits/)).toBeInTheDocument()
    expect(screen.getByText('demo data — awaiting stream')).toBeInTheDocument()
    expect(screen.getByText('no webgl — text mode')).toBeInTheDocument()

    const list = screen.getByRole('list', { name: 'Constellation stations' })
    // Trunk plus every worktree, each one a focusable control.
    expect(within(list).getAllByRole('button')).toHaveLength(12)
    expect(within(list).getByText('12-scene')).toBeInTheDocument()
  })

  it('reveals a readable label for the station under the pointer', () => {
    render(<SceneView events={EVENTS} webgl={false} />)

    const button = screen.getByRole('button', { name: /4-git-collector/ })
    fireEvent.mouseEnter(button)

    // The readout repeats the label, so both copies must be present.
    expect(screen.getAllByText('4-git-collector')).toHaveLength(2)
    expect(screen.getByText(/27 commits · 27 ahead · 2 dirty/)).toBeInTheDocument()

    fireEvent.mouseLeave(button)
    expect(screen.getAllByText('4-git-collector')).toHaveLength(1)
  })

  it('reveals the same label on keyboard focus', () => {
    render(<SceneView events={EVENTS} webgl={false} />)

    const button = screen.getByRole('button', { name: /8-panel-ticker/ })
    fireEvent.focus(button)
    expect(screen.getAllByText('8-panel-ticker')).toHaveLength(2)

    fireEvent.blur(button)
    expect(screen.getAllByText('8-panel-ticker')).toHaveLength(1)
  })

  it('says so plainly when the log holds no worktrees', () => {
    render(<SceneView events={[]} webgl={false} />)

    expect(screen.getByText('no worktrees discovered yet')).toBeInTheDocument()
    expect(screen.getByText('constellation')).toBeInTheDocument()
  })
})
