import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../../replay/api.js'
import { labTranscriptUrl, TraceDiff } from './TraceDiff.js'

afterEach(cleanup)

function entry(role: string, text: string) {
  return { role, blocks: [{ kind: 'text', text }] }
}

const HISTORY = [entry('user', 'fix it'), entry('assistant', 'reading /home/x/repo/a.ts')]
/** The arm's restored copy of HISTORY — the parent's lines, path-rewritten to the arm's worktree (`lab/restore.ts`). */
const RESTORED = HISTORY.map((e) => ({ ...e, blocks: [{ kind: 'text', text: e.blocks[0]!.text.replace('/home/x/repo', '/data/lab/worktrees/fork-1-arm-1') }] }))
/** The route's own words for an arm whose session holds exactly what the restore copied (`api/lab-transcript.ts`). */
const NOT_LAUNCHED = "not launched — its restored session ends where the parent's was cut"

/** `GET /api/lab/transcript?lane=<parent>&arm=<handle>`'s answer. */
function parent(entries: unknown[]) {
  return { available: true, side: 'parent', entries }
}
/** `GET /api/lab/transcript?lane=<handle>`'s answer. */
function arm(entries: unknown[], launched: boolean | null = true, note: string | null = null) {
  return { available: true, side: 'arm', launched, note, entries }
}

/** The lab's transcript route stubbed: `lane → body`, recording every URL it was asked for. */
function transcripts(bodies: Record<string, unknown>, urls: string[] = []): FetchLike {
  return (async (input: string | URL | Request) => {
    const href = String(input)
    urls.push(href)
    const lane = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('lane') ?? ''
    const body = bodies[lane]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as FetchLike
}

describe('TraceDiff (prd53 S3, #327; prd-55 ruling 6 / S3′, #384)', () => {
  it("reads both sides from the lab's own route — the parent cut at the arm's checkpoint, the arm by its handle — never the fleet's tail, never a page", async () => {
    const urls: string[] = []
    const fetchImpl = transcripts(
      { feature: parent([...HISTORY, entry('assistant', 'parent continues')]), 'fork-1-arm-1': arm([...RESTORED, entry('assistant', 'arm goes elsewhere')]) },
      urls,
    )
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" armLabel="arm 1 · run 1" fetchImpl={fetchImpl} />)

    await waitFor(() => expect(screen.getByTestId('trace-diff').dataset.state).toBe('ready'))
    expect(labTranscriptUrl('feature', { arm: 'fork-1-arm-1' })).toBe('/api/lab/transcript?lane=feature&arm=fork-1-arm-1')
    expect(labTranscriptUrl('fork-1-arm-1')).toBe('/api/lab/transcript?lane=fork-1-arm-1')
    expect([...urls].sort()).toEqual([labTranscriptUrl('feature', { arm: 'fork-1-arm-1' }), labTranscriptUrl('fork-1-arm-1')].sort())
    for (const url of urls) expect(url).not.toContain('offset=')
    // Row 0 is the fork row, `same`; the next is where the arm left.
    expect(screen.getByTestId('trace-row-0').dataset.kind).toBe('same')
    expect(screen.getByTestId('trace-row-1').dataset.kind).toBe('diverged')
  })

  it('a transcript longer than one 64 KiB page is diffed to its last step — the route serves the whole span, and nothing here pages', async () => {
    const shared = Array.from({ length: 1_400 }, (_, i) => entry(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} — 日本`))
    const parentEntries = [...shared, entry('assistant', 'the parent went on at turn 1400')]
    const armEntries = [...shared, entry('assistant', 'the arm went elsewhere at turn 1400')]
    // Past one page as the fleet tail pages it — the span the wave-3 review found diffing as entirely `same`.
    expect(new TextEncoder().encode(JSON.stringify(parentEntries)).length).toBeGreaterThan(64 * 1024)
    const urls: string[] = []
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={transcripts({ feature: parent(parentEntries), 'fork-1-arm-1': arm(armEntries) }, urls)} />)

    await waitFor(() => expect(screen.getByTestId('trace-diff').dataset.state).toBe('ready'))
    expect(urls).toHaveLength(2)
    expect(screen.getByTestId('trace-row-0').dataset.kind).toBe('same')
    expect(screen.getByTestId('trace-row-0').textContent).toContain('turn 1399')
    expect(screen.getByTestId('trace-row-1').dataset.kind).toBe('diverged')
    expect(screen.getByTestId('trace-row-1').textContent).toContain('the arm went elsewhere at turn 1400')
    expect(screen.queryByTestId('trace-row-2')).toBeNull()
  })

  it("an arm whose restored session has not grown past the cut renders the route's own words — not launched — and the divergence reading still arrives", async () => {
    const onDiff = vi.fn()
    const fetchImpl = transcripts({ feature: parent([...HISTORY, entry('assistant', 'parent continues')]), 'fork-1-arm-1': arm(RESTORED, false, NOT_LAUNCHED) })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" armLabel="arm 1 · run 1" fetchImpl={fetchImpl} onDiff={onDiff} />)

    await waitFor(() => expect(screen.getByTestId('trace-diff').dataset.state).toBe('not-launched'))
    expect(screen.getByTestId('trace-not-launched').textContent).toContain(NOT_LAUNCHED)
    expect(screen.queryByTestId('trace-arm-unreadable')).toBeNull()
    // Its rows are honest: the fork row, then the parent's step the arm never took.
    expect(screen.getByTestId('trace-row-0').dataset.kind).toBe('same')
    expect(screen.getByTestId('trace-row-1').dataset.kind).toBe('absent')
    expect(onDiff).toHaveBeenLastCalledWith({ rows: 2, diverged: 0, added: 0, absent: 1 })
  })

  it("when the record cannot tell whether the arm launched, the route's own reason renders — never a guess", async () => {
    const note = 'whether "fork-1-arm-1" launched cannot be told — the parent\'s session no longer matches checkpoint ckpt-1 before the cut'
    const fetchImpl = transcripts({ feature: parent(HISTORY), 'fork-1-arm-1': arm(RESTORED, null, note) })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-launch-unknown').textContent).toContain('cannot be told'))
    expect(screen.queryByTestId('trace-not-launched')).toBeNull()
  })

  it('an arm with no steps yet says so — never a blank table', async () => {
    const fetchImpl = transcripts({ feature: parent(HISTORY), 'fork-1-arm-1': arm([]) })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-empty')).toBeInTheDocument())
    expect(screen.getByTestId('trace-empty').textContent).toContain('no steps recorded — the arm has not begun')
  })

  it("a failed parent read renders its copy, and the arm's own rows still render — never as `absent`", async () => {
    const fetchImpl = transcripts({ 'fork-1-arm-1': arm([...RESTORED, entry('assistant', 'more')]) })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-parent-unreadable')).toBeInTheDocument())
    expect(screen.getByTestId('trace-parent-unreadable').textContent).toMatch(/the parent's transcript cannot be read — the lab transcript route answered 404/)
    expect(screen.getByTestId('trace-row-0').dataset.kind).toBe('unclassified')
    expect(screen.getByTestId('trace-row-2')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-kind="absent"]')).toHaveLength(0)
  })

  it("an unavailable parent — the route's own reason, a refused digest say — reads the same way, verbatim", async () => {
    const reason = 'SESSION DIGEST REFUSED for "feature" — the first 512 bytes no longer digest to what checkpoint ckpt-1 recorded'
    const fetchImpl = transcripts({ feature: { available: false, side: 'parent', lane: 'feature', reason }, 'fork-1-arm-1': arm(RESTORED) })
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-1" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('trace-parent-unreadable').textContent).toContain(reason))
  })

  it('a failed arm has no trace, and says so — and makes no request at all', async () => {
    const fetchImpl = vi.fn(transcripts({}))
    render(<TraceDiff parentLane="feature" laneHandle="fork-1-arm-3" armLabel="arm 3" failed="workmux: tmux server not running" fetchImpl={fetchImpl} />)
    expect(screen.getByTestId('trace-failed-arm').textContent).toContain('a failed arm has no trace')
    expect(screen.getByTestId('trace-failed-arm').textContent).toContain('tmux server not running')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('↑/↓ move the focused row, Enter opens the focus panel for one step, Esc goes back', async () => {
    const fetchImpl = transcripts({ feature: parent([...HISTORY, entry('assistant', 'p1')]), 'fork-1-arm-1': arm([...RESTORED, entry('assistant', 'a1')]) })
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
