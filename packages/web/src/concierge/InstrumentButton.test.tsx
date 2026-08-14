import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { InstrumentButton } from './InstrumentButton.js'
import type { InstrumentFetchLike } from './instrument.js'

afterEach(cleanup)

/**
 * "instrument this session" — the one confirm, and what it says with each
 * answer. Two invariants worth stating plainly: ONE click never spawns
 * anything, and no success is ever reported without the two costs beside it
 * (prd-20 ruling 6) — the old process is still running, and measurement does
 * not back-fill.
 */

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

const SESSION_ID = 'sess-4210'

function answering(payload: unknown, status = 200): InstrumentFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

const LAUNCHED = { migration: 'migrated', kind: 'launched', pid: 4242 }

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('InstrumentButton', () => {
  it('does NOT instrument on the first click — it asks, and names what the act costs', async () => {
    const fetchImpl = vi.fn(answering(LAUNCHED))
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('instrument-button-start'))

    expect(fetchImpl).not.toHaveBeenCalled()
    const dialog = screen.getByTestId('instrument-button-confirm-dialog')
    expect(dialog.textContent).toContain(SESSION_ID)
    // The three honesties ruling 6 requires at the moment of the act.
    expect(dialog.textContent).toContain('same id')
    expect(dialog.textContent).toContain('never moved, never edited')
    expect(dialog.textContent).toContain('keeps running until you end')
  })

  it('cancelling puts it back where it started, having sent nothing', async () => {
    const fetchImpl = vi.fn(answering(LAUNCHED))
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={fetchImpl} />)

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-cancel'))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByTestId('instrument-button-start')).toBeTruthy()
  })

  it('the second click does it, and reports the migration fact, the pid and the fork it left behind', async () => {
    const fetchImpl = vi.fn(answering(LAUNCHED))
    const onInstrumented = vi.fn()
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={fetchImpl} onInstrumented={onInstrumented} />)

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const result = screen.getByTestId('instrument-button-result')
    expect(result.textContent).toContain('pid 4242')
    expect(result.textContent).toContain(SESSION_ID)
    expect(result.textContent).toContain('the same id, not a new one')
    expect(screen.getByTestId('instrument-button-migration').textContent).toContain('copied into this repo')
    // The two costs, every time — never conditional on the outcome being bad.
    expect(result.textContent).toContain('still running')
    expect(result.textContent).toContain('measurement starts now')
    expect(onInstrumented).toHaveBeenCalledWith({
      kind: 'instrumented',
      sessionId: SESSION_ID,
      migration: 'migrated',
      spawn: { launched: true, pid: 4242 },
    })
  })

  it.each([
    ['already-present', 'already in this repo'],
    ['not-needed', 'no copy was needed'],
  ])('says what the copy actually did when it was %s', async (migration, sentence) => {
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={answering({ ...LAUNCHED, migration })} />)

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    expect(screen.getByTestId('instrument-button-migration').textContent).toContain(sentence)
  })

  it('reports a spawn that failed beside the migration fact, not instead of it', async () => {
    render(
      <InstrumentButton
        sessionId={SESSION_ID}
        fetchImpl={answering({ migration: 'migrated', kind: 'error', message: 'ENOENT claude' })}
      />,
    )

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    expect(screen.getByTestId('instrument-button-spawn-error').textContent).toContain('ENOENT claude')
    expect(screen.getByTestId('instrument-button-migration').textContent).toContain('copied into this repo')
  })

  it('shows the copyable command, not an error, when no transcript is reachable', async () => {
    const onCopy = vi.fn(async () => {})
    render(
      <InstrumentButton
        sessionId={SESSION_ID}
        manualCommand="claude --resume sess-4210"
        onCopy={onCopy}
        fetchImpl={answering({ error: 'no transcript this instrument can read' }, 404)}
      />,
    )

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    const panel = screen.getByTestId('instrument-button-no-transcript')
    expect(panel.textContent).toContain('nothing was copied and nothing was started')
    expect(panel.textContent).toContain('no transcript this instrument can read')
    expect(screen.getByTestId('instrument-button-command').textContent).toBe('claude --resume sess-4210')
    // …and it is NOT the red failure path: nothing failed, there is just a
    // next step, so no error is rendered.
    expect(screen.queryByTestId('instrument-button-error')).toBeNull()

    await click(screen.getByTestId('instrument-button-copy'))
    expect(onCopy).toHaveBeenCalledWith('claude --resume sess-4210')
    expect(panel.textContent).toContain('copied to clipboard')
  })

  it('leaves the command selectable, and says so, when the clipboard refuses', async () => {
    render(
      <InstrumentButton
        sessionId={SESSION_ID}
        manualCommand="claude --resume sess-4210"
        onCopy={async () => Promise.reject(new Error('no clipboard'))}
        fetchImpl={answering({ error: 'no transcript this instrument can read' }, 404)}
      />,
    )

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))
    await click(screen.getByTestId('instrument-button-copy'))

    expect(screen.getByTestId('instrument-button-no-transcript').textContent).toContain('clipboard unavailable')
    expect(screen.getByTestId('instrument-button-command').textContent).toBe('claude --resume sess-4210')
  })

  it('says it has no command to hand over rather than inventing one', async () => {
    render(
      <InstrumentButton sessionId={SESSION_ID} fetchImpl={answering({ error: 'no transcript' }, 404)} />,
    )

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    const panel = screen.getByTestId('instrument-button-no-transcript')
    expect(panel.textContent).toContain('this page has no command to hand you')
    expect(screen.queryByTestId('instrument-button-command')).toBeNull()
  })

  it('shows the refusal sentence, and a way back, when the request fails', async () => {
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={answering({ error: 'nothing live to launch into' }, 409)} />)

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    expect(screen.getByTestId('instrument-button-error').textContent).toContain('nothing live to launch into')

    await click(screen.getByTestId('instrument-button-back'))
    expect(screen.getByTestId('instrument-button-start')).toBeTruthy()
  })

  it('takes its test ids from the page rather than owning them', async () => {
    render(
      <InstrumentButton sessionId={SESSION_ID} data-testid="conductor-relaunch" fetchImpl={answering(LAUNCHED)} />,
    )

    await click(screen.getByTestId('conductor-relaunch-start'))
    await click(screen.getByTestId('conductor-relaunch-confirm'))

    expect(screen.getByTestId('conductor-relaunch-result').textContent).toContain('pid 4242')
  })
})
