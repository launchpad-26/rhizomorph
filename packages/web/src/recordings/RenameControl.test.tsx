import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from './capability.js'
import { RenameControl } from './RenameControl.js'
import type { LabelFetchLike } from './label.js'

afterEach(cleanup)

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): LabelFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

async function type(input: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } })
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('RenameControl', () => {
  it('shows the current title as a button, and does not send anything until save', async () => {
    const fetchImpl = vi.fn(answering({ sessionId: '1000', label: 'renamed' }))
    render(<RenameControl sessionId="1000" title="the morning run" fetchImpl={fetchImpl} />)

    expect(screen.getByTestId('rename-start-1000')).toHaveTextContent('the morning run')
    await click(screen.getByTestId('rename-start-1000'))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByTestId('rename-input-1000')).toHaveValue('the morning run')
  })

  it('saves the edited draft, and reports the label the server actually saved', async () => {
    const onRenamed = vi.fn()
    const fetchImpl = vi.fn(answering({ sessionId: '1000', label: 'renamed' }))
    render(<RenameControl sessionId="1000" title="the morning run" fetchImpl={fetchImpl} onRenamed={onRenamed} />)

    await click(screen.getByTestId('rename-start-1000'))
    await type(screen.getByTestId('rename-input-1000'), 'renamed')
    await click(screen.getByTestId('rename-save-1000'))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onRenamed).toHaveBeenCalledWith('renamed')
    // Back to the idle button, now showing the saved title's own callback value.
    expect(screen.getByTestId('rename-start-1000')).toBeInTheDocument()
  })

  it('can be cancelled without saving anything', async () => {
    const fetchImpl = vi.fn(answering({ sessionId: '1000', label: 'x' }))
    render(<RenameControl sessionId="1000" title="the morning run" fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('rename-start-1000'))
    await type(screen.getByTestId('rename-input-1000'), 'discarded')
    await click(screen.getByTestId('rename-cancel-1000'))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByTestId('rename-start-1000')).toHaveTextContent('the morning run')
  })

  it('refuses to save an empty label, client-side, without a round trip', async () => {
    const fetchImpl = vi.fn(answering({ sessionId: '1000', label: 'x' }))
    render(<RenameControl sessionId="1000" title="the morning run" fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('rename-start-1000'))
    await type(screen.getByTestId('rename-input-1000'), '   ')
    await click(screen.getByTestId('rename-save-1000'))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByTestId('rename-error-1000')).toHaveTextContent('label must not be empty')
  })

  it('shows the refusal rather than silently keeping the old title', async () => {
    const fetchImpl = answering({ error: 'no session with id "1000"' }, 404)
    render(<RenameControl sessionId="1000" title="the morning run" fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('rename-start-1000'))
    await type(screen.getByTestId('rename-input-1000'), 'renamed')
    await click(screen.getByTestId('rename-save-1000'))

    expect(screen.getByTestId('rename-error-1000')).toHaveTextContent('no session with id "1000"')
    // Still editing — the operator's typed text is not thrown away on a failure.
    expect(screen.getByTestId('rename-input-1000')).toHaveValue('renamed')
  })

  it('disables the input and buttons while the save is in flight', async () => {
    let release: (() => void) | undefined
    const fetchImpl: LabelFetchLike = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ sessionId: '1000', label: 'x' }) })
      })
    render(<RenameControl sessionId="1000" title="the morning run" fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('rename-start-1000'))
    await type(screen.getByTestId('rename-input-1000'), 'x')
    await click(screen.getByTestId('rename-save-1000'))

    expect(screen.getByTestId('rename-input-1000')).toBeDisabled()
    expect(screen.getByTestId('rename-save-1000')).toBeDisabled()
    expect(screen.getByTestId('rename-save-1000')).toHaveTextContent('saving…')

    await act(async () => {
      release?.()
    })
  })
})
