import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { discloseText } from '../disclosure/testing.js'
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

const LAUNCHED = { migration: { kind: 'migrated', at: '/home/u/.claude/projects/-repo/s.jsonl' }, kind: 'launched', pid: 4242 }

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
      migration: { kind: 'migrated', at: '/home/u/.claude/projects/-repo/s.jsonl', message: null },
      // This fixture's answer says nothing about telemetry, and `null` is that
      // said as itself rather than as a claim either way (ledger #4).
      telemetry: null,
      spawn: { launched: true, via: 'detached', pid: 4242 },
    })
  })

  /**
   * #532's `via`, rendered. "There is a pid" and "there is a window you can
   * attach to and type into" are different facts about an interactive harness,
   * and this is the difference between telling an operator where to go and
   * telling them to watch and see.
   */
  it('names the tmux window to attach to when there is one', async () => {
    render(
      <InstrumentButton
        sessionId={SESSION_ID}
        fetchImpl={answering({ ...LAUNCHED, via: 'tmux', window: 'main:3' })}
      />,
    )

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    const where = screen.getByTestId('instrument-button-where').textContent ?? ''
    expect(where).toContain('main:3')
    expect(where).toContain('tmux attach -t main:3')
  })

  it('names the no-TTY gap when the process was started detached, rather than calling it a place', async () => {
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={answering(LAUNCHED)} />)

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    const where = screen.getByTestId('instrument-button-where').textContent ?? ''
    expect(where).toContain('no terminal attached')
    expect(where).toContain('may exit on its own')
  })

  it.each([
    ['already-present', 'already in this repo'],
    ['not-needed', 'no copy was needed'],
  ])('says what the copy actually did when it was %s', async (kind, sentence) => {
    render(
      <InstrumentButton
        sessionId={SESSION_ID}
        fetchImpl={answering({ ...LAUNCHED, migration: { kind, at: '/home/u/.claude/projects/-repo/s.jsonl' } })}
      />,
    )

    await click(screen.getByTestId('instrument-button-start'))
    await click(screen.getByTestId('instrument-button-confirm'))

    expect(screen.getByTestId('instrument-button-migration').textContent).toContain(sentence)
  })

  it('reports a spawn that failed beside the migration fact, not instead of it', async () => {
    render(
      <InstrumentButton
        sessionId={SESSION_ID}
        fetchImpl={answering({ migration: { kind: 'migrated', at: '/home/u/.claude/projects/-repo/s.jsonl' }, kind: 'error', message: 'ENOENT claude' })}
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

/**
 * THE CARD THIS BUTTON GREW (#389, prd-30 w4) — it explained itself with a
 * native `title=` until wave 4, which a keyboard never reached.
 *
 * `discloseText` is the assertion, not the read: it opens the card by mouse,
 * closes it, opens it again by focus, and throws unless the two markups are
 * identical. So each call below is charter §6 proven on this surface with this
 * surface's own data.
 */
describe('the start control discloses what the first press arms (#389, charter §6)', () => {
  it('says what the act is, and that the first press only arms it', () => {
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={answering(LAUNCHED)} />)

    const card = discloseText(screen.getByTestId('instrument-button-start'))

    expect(card).toContain('Relaunch this repo’s conductor, instrumented, on this same conversation.')
    expect(card).toContain('the first press only arms it')
    expect(card).toContain('the relaunch runs only after you confirm')
  })

  it('opens the same card the third time as the first — the senses do not stick', () => {
    // `Disclosure` tracks hovered/focused/tapped/dismissed as four booleans.
    // A single open-and-read cannot see a stuck `tapped` or `dismissed`, and a
    // reader who consults a mark three times is the ordinary case, not an edge.
    render(<InstrumentButton sessionId={SESSION_ID} fetchImpl={answering(LAUNCHED)} />)
    const mark = () => screen.getByTestId('instrument-button-start')

    const first = discloseText(mark())
    discloseText(mark())
    const third = discloseText(mark())

    expect(third).toBe(first)
  })
})
