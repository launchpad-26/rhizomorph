import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootExplanation } from '../app/StatusBar.js'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { RotateButton } from './RotateButton.js'
import type { RotateFetchLike } from './rotate.js'

afterEach(cleanup)

/**
 * "end session · start fresh" — the one confirm, and what it does with each
 * answer. The invariant worth stating plainly: ONE click never rotates.
 */

/**
 * Stands in for what `server/static.ts` stamps into `index.html` on a real
 * boot (ADR-0012). Needed since #234 gated `POST /api/rotate`: `rotate.ts`
 * reads the token off the page and refuses before the wire if there is none,
 * so without this the button below would be exercising that refusal rather
 * than the confirm it exists to test. `rotate.test.ts` is where the
 * missing-token path is asserted on purpose.
 */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

const ROTATION = {
  closed: { sessionId: '1000', filePath: '/data/repo/session-1000.jsonl', eventCount: 4321 },
  opened: { sessionId: '5000', filePath: '/data/repo/session-5000.jsonl', startedAt: 5000 },
}

function answering(payload: unknown, status = 200): RotateFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

function theButton(): HTMLElement {
  return screen.getByTestId('rotate-button')
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('RotateButton', () => {
  it('does NOT rotate on the first click — it arms, and says so', async () => {
    const fetchImpl = vi.fn(answering(ROTATION))
    render(<RotateButton fetchImpl={fetchImpl} />)

    expect(theButton()).toHaveTextContent('end session · start fresh')

    await click(theButton())

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(theButton()).toHaveTextContent('confirm: end session')
    expect(theButton().dataset.armed).toBe('true')
  })

  it('rotates on the second click, and reports what closed and what opened', async () => {
    const onRotated = vi.fn()
    const fetchImpl = vi.fn(answering(ROTATION))
    render(<RotateButton fetchImpl={fetchImpl} onRotated={onRotated} />)

    await click(theButton())
    await click(theButton())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('rotate-result')).toHaveTextContent(
      'closed session 1000 (4,321 events) · now recording 5000',
    )
    // The picker is told to re-read the listing, with the rotation in hand.
    expect(onRotated).toHaveBeenCalledWith({
      closed: { sessionId: '1000', eventCount: 4321 },
      opened: { sessionId: '5000' },
    })
  })

  /**
   * #592. The `rotated` boot-reason voice already existed and was already well
   * written — but it renders in the provenance bar at the foot of the page,
   * and only as the session line's `title`, so the operator who pressed THIS
   * button never encountered it. The acknowledgement now reaches the surface
   * the act happened on.
   *
   * Asserted against `bootExplanation`'s own output rather than against a
   * copy of the sentence, which is the whole point: prd-30 forbids two
   * surfaces phrasing one condition differently, so a test holding a literal
   * here would be the second phrasing. Change the wording in `StatusBar` and
   * both surfaces move together, with this test following rather than
   * blocking.
   */
  it('acknowledges the rotation in the one voice that already owns the word (#592)', async () => {
    render(<RotateButton fetchImpl={answering(ROTATION)} />)

    expect(screen.queryByTestId('rotate-acknowledgement')).toBeNull()

    await click(theButton())
    await click(theButton())

    const voice = bootExplanation({ lastBootReason: 'rotated', resumedCount: 0, resumeWindowMs: 0 })
    // Not vacuous: the sentence really does say something about the rotation.
    expect(voice).toContain('you ended the previous session here')
    expect(screen.getByTestId('rotate-acknowledgement')).toHaveTextContent(voice)
  })

  it('can be cancelled while armed, and then needs both clicks again', async () => {
    const fetchImpl = vi.fn(answering(ROTATION))
    render(<RotateButton fetchImpl={fetchImpl} />)

    await click(theButton())
    await click(screen.getByRole('button', { name: 'cancel' }))

    expect(theButton()).toHaveTextContent('end session · start fresh')
    expect(theButton().dataset.armed).toBe('false')
    expect(screen.queryByRole('button', { name: 'cancel' })).toBeNull()

    await click(theButton())
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('shows the refusal instead of claiming a rotation that did not happen', async () => {
    const onRotated = vi.fn()
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)
    render(<RotateButton fetchImpl={fetchImpl} onRotated={onRotated} />)

    await click(theButton())
    await click(theButton())

    expect(screen.getByTestId('rotate-error')).toHaveTextContent('this server is replaying a session record')
    expect(screen.queryByTestId('rotate-result')).toBeNull()
    expect(onRotated).not.toHaveBeenCalled()
  })

  it('is disabled while the rotation is in flight — one boundary per confirm', async () => {
    let release: (() => void) | undefined
    const fetchImpl: RotateFetchLike = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ROTATION })
      })
    render(<RotateButton fetchImpl={fetchImpl} />)

    await click(theButton())
    await click(theButton())

    expect(theButton()).toBeDisabled()
    expect(theButton()).toHaveTextContent('ending session…')

    await act(async () => {
      release?.()
    })
    expect(screen.getByTestId('rotate-result')).toBeInTheDocument()
  })
})
