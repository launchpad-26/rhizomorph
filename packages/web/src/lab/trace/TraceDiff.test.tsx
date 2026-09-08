import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../../replay/api.js'
import { TraceDiff } from './TraceDiff.js'

afterEach(cleanup)

function entry(role: string, text: string) {
  return { role, blocks: [{ kind: 'text', text }] }
}

const HISTORY = [entry('user', 'fix it'), entry('assistant', 'reading /home/x/repo/a.ts')]

/** A transcript route stub: `lane → body`, recording every URL it was asked for. */
function transcripts(bodies: Record<string, unknown>, urls: string[] = []): FetchLike {
  return (async (input: string | URL | Request) => {
    const href = String(input)
    urls.push(href)
    const lane = decodeURIComponent(href.replace('/api/transcript/', '').split('?')[0] ?? '')
    const body = bodies[lane]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as FetchLike
}

describe('TraceDiff (prd53 S3, #327)', () => {
  it('fetches both transcripts by byte offset — every request carries offset= — and renders the rows', async () => {
    const urls: string[] = []
    const fetchImpl = transcripts(
      {
        feature: { available: true, entries: [...HISTORY, entry('assistant', 'parent continues')] },
        'fork-1-arm-1': { available: true, entries: [...HISTORY.map((e) => ({ ...e, blocks: [{ kind: 'text', text: e.blocks[0]!.text.replace('/home/x/repo', '/data/lab/worktrees/fork-1-arm-1') }] })), entry('assistant', 'arm goes elsewhere')] },
      },
      urls,
    )
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" armLabel="arm 1 · run 1" fetchImpl={fetchImpl} />)

    await waitFor(() => expect(screen.getByTestId('trace-diff').dataset.state).toBe('ready'))
    expect(urls.every((url) => url.includes('offset='))).toBe(true)
    expect(urls.some((url) => url.startsWith('/api/transcript/feature?'))).toBe(true)
    // Row 0 is the fork row, `same`; the next is where the arm left.
    expect(screen.getByTestId('trace-row-0').dataset.kind).toBe('same')
    expect(screen.getByTestId('trace-row-1').dataset.kind).toBe('diverged')
  })

  it('an arm with no steps yet says so — never a blank table', async () => {
    const fetchImpl = transcripts({ feature: { available: true, entries: HISTORY }, 'fork-1-arm-1': { available: true, entries: [] } })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-empty')).toBeInTheDocument())
    expect(screen.getByTestId('trace-empty').textContent).toContain('no steps recorded — the arm has not begun')
  })

  it("a failed parent read renders its copy, and the arm's own rows still render — never as `absent`", async () => {
    const fetchImpl = transcripts({ 'fork-1-arm-1': { available: true, entries: [...HISTORY, entry('assistant', 'more')] } })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-parent-unreadable')).toBeInTheDocument())
    expect(screen.getByTestId('trace-parent-unreadable').textContent).toMatch(/the parent's transcript cannot be read — the transcript route answered 404/)
    expect(screen.getByTestId('trace-row-0').dataset.kind).toBe('unclassified')
    expect(screen.getByTestId('trace-row-2')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-kind="absent"]')).toHaveLength(0)
  })

  it("an unavailable parent (the route's own reason) reads the same way", async () => {
    const fetchImpl = transcripts({ feature: { available: false, reason: 'lane "feature" has no session file' }, 'fork-1-arm-1': { available: true, entries: HISTORY } })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-parent-unreadable').textContent).toContain('has no session file'))
  })

  it('a failed arm has no trace, and says so — and makes no request at all', async () => {
    const fetchImpl = vi.fn(transcripts({}))
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-3" armLabel="arm 3" failed="workmux: tmux server not running" fetchImpl={fetchImpl} />)
    expect(screen.getByTestId('trace-failed-arm').textContent).toContain('a failed arm has no trace')
    expect(screen.getByTestId('trace-failed-arm').textContent).toContain('tmux server not running')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('↑/↓ move the focused row, Enter opens the focus panel for one step, Esc goes back', async () => {
    const fetchImpl = transcripts({
      feature: { available: true, entries: [...HISTORY, entry('assistant', 'p1')] },
      'fork-1-arm-1': { available: true, entries: [...HISTORY, entry('assistant', 'a1')] },
    })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-rows')).toBeInTheDocument())
    const rows = screen.getByTestId('trace-rows')
    fireEvent.keyDown(rows, { key: 'ArrowDown' })
    expect(screen.getByTestId('trace-row-1').dataset.focused).toBe('true')
    fireEvent.keyDown(rows, { key: 'Enter' })
    expect(screen.getByTestId('trace-focus').textContent).toContain('a1')
    fireEvent.keyDown(rows, { key: 'Escape' })
    expect(screen.queryByTestId('trace-focus')).toBeNull()
    fireEvent.keyDown(rows, { key: 'ArrowUp' })
    expect(screen.getByTestId('trace-row-0').dataset.focused).toBe('true')
  })
})
