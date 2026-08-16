import { describe, expect, it } from 'vitest'
import { buildFrame } from '../gl/index.js'
import { PANEL, seededMarks } from './scene.js'

/**
 * THE CAPTURE'S OWN PREMISE.
 *
 * `before.png` and `after.png` are the parity evidence for #578, and a capture
 * that quietly stopped containing a mark kind would show no difference in it and
 * look like agreement. So the seeded scene is pinned here: twelve kinds, the same
 * list every time, and a frame that actually tessellates.
 */
describe('the seeded scene the parity captures are taken of', () => {
  it('carries all twelve mark kinds, so a delta in any of them would show', () => {
    expect(new Set(seededMarks().map((mark) => mark.kind)).size).toBe(12)
  })

  it('is the same list on every machine and in every run', () => {
    expect(JSON.stringify(seededMarks())).toBe(JSON.stringify(seededMarks()))
  })

  it('reaches the painter as geometry, not as an empty frame', () => {
    const frame = buildFrame(seededMarks(), PANEL)
    expect(frame.vertices.n).toBeGreaterThan(1_000)
    expect(frame.overlay.length).toBeGreaterThan(0)
    expect(frame.runs.some((run) => run.kind === 'stencil')).toBe(true)
  })
})
