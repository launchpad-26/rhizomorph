import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import { SaveComparisonControl } from './SaveComparisonControl.js'
import type { SaveComparisonFetchLike } from './save.js'
import type { ComparisonInput } from './types.js'

afterEach(cleanup)

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

const INPUT: ComparisonInput = { arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [] }] }

function answering(payload: unknown, status = 200): SaveComparisonFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('SaveComparisonControl', () => {
  it('renders idle and sends nothing before any click', () => {
    const fetchImpl = vi.fn(answering({ id: 'c1', savedAt: '2026-09-01T00:00:00.000Z' }))
    render(<SaveComparisonControl input={INPUT} fetchImpl={fetchImpl} />)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByTestId('comparison-save')).toHaveTextContent('save this comparison')
  })

  /**
   * Review round 2 (finding 3): the module doc used to claim "arm, then act"
   * — `RenameControl`'s edit-then-save, `RotateButton`'s armed-then-confirmed
   * shape — while `onClick` sent on the very first click. A test asserting
   * only "nothing sent before any click" cannot tell those two shapes apart
   * (it is true of both), so it survived the false claim. This one can: it
   * asserts the SEND and the confirmation both land after exactly ONE click,
   * which is the property "arm, then act" would have broken — an armed
   * control would still show no confirmation and no call here, and this
   * assertion would redden.
   */
  it('a single click sends the save and confirms it — never a second "are you sure" click, because a save is additive (see the module doc)', async () => {
    const fetchImpl = vi.fn(answering({ id: 'c1', savedAt: '2026-09-01T00:00:00.000Z' }))
    render(<SaveComparisonControl input={INPUT} fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('comparison-save'))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('comparison-save-confirmation')).toHaveTextContent('saved')
  })

  it('a failed save says so instead of silently discarding what the operator asked to keep', async () => {
    const fetchImpl = vi.fn(answering({ error: 'this server is replaying a session record' }, 409))
    render(<SaveComparisonControl input={INPUT} fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('comparison-save'))

    expect(screen.getByTestId('comparison-save-error')).toHaveTextContent('this server is replaying a session record')
    expect(screen.queryByTestId('comparison-save-confirmation')).toBeNull()
  })
})
