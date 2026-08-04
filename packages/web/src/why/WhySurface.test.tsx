import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createEventFactory, reduceAll } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../fleet/manifest.js'
import { WhySurface } from './WhySurface.js'

afterEach(cleanup)

const NOW = Date.UTC(2026, 6, 30, 10, 0, 0)

const noTranscript: FetchLike = async () => ({
  ok: false,
  json: async () => ({ available: false, lane: 'feature', reason: 'NO SESSION LOG for this fixture' }),
})

let f = createEventFactory()

describe('WhySurface', () => {
  it('says so when the lane spans more than one telemetry handle', () => {
    render(
      <WhySurface
        state={reduceAll([])}
        laneLabel="my-lane"
        laneHandle={null}
        now={NOW}
        fetchTranscript={noTranscript}
      />,
    )
    expect(screen.getByTestId('why-multi-handle').textContent).toContain('my-lane');
    expect(screen.queryByTestId('why-file-list')).toBeNull()
  })

  it('says so, honestly, when the lane has touched nothing yet', () => {
    render(
      <WhySurface
        state={reduceAll([])}
        laneLabel="my-lane"
        laneHandle="my-lane"
        now={NOW}
        fetchTranscript={noTranscript}
      />,
    )
    expect(screen.getByTestId('why-empty').textContent).toContain('NO FILES TOUCHED YET')
  })

  it('lists the files a lane touched, selects the first by default, and switches on click', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' }),
      f.toolActivity({ lane: 'feature', tool: 'Write', branch: 'feature', filePath: 'src/b.ts', toolUseId: 'toolu_2' }),
    ])

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={noTranscript} />,
    )

    const files = screen.getAllByTestId('why-file')
    expect(files.map((el) => el.textContent)).toEqual([
      expect.stringContaining('src/b.ts'),
      expect.stringContaining('src/a.ts'),
    ])
    // b.ts was touched last, so it is the default selection.
    expect(files[0]!.getAttribute('data-active')).toBe('true')
    expect(within(screen.getByTestId('why-chain')).getByText('Write')).toBeInTheDocument()

    fireEvent.click(files[1]!)
    expect(within(screen.getByTestId('why-chain')).getByText('Edit')).toBeInTheDocument()
  })

  it('joins a tool call to its trace span and shows the kind glyph', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' }),
      f.traceSpan({
        lane: 'feature',
        traceId: 'trace-1',
        spanId: 'span-1',
        kind: 'tool',
        name: 'claude_code.tool',
        toolName: 'Edit',
        toolUseId: 'toolu_1',
      }),
    ])

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={noTranscript} />,
    )

    expect(screen.getByTestId('trace-kind').getAttribute('data-kind')).toBe('tool')
  })

  it('shows the commits that landed the file', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      // Establishes the lane's branch attribution, so the commit below joins it.
      f.toolActivity({ lane: 'feature', tool: 'Bash', branch: 'feature', filePath: null }),
      f.commitLanded({
        sha: 'sha-abc1234',
        branch: 'feature',
        message: 'feat: add a',
        files: [{ path: 'src/a.ts', status: 'added' }],
      }),
    ])

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={noTranscript} />,
    )

    const commit = screen.getByTestId('why-commit')
    expect(commit.textContent).toContain('sha-abc')
    expect(commit.textContent).toContain('feat: add a')
  })

  it('flags the honest gap when a commit landed a file with no joinable tool call', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: null }),
      f.commitLanded({
        sha: 'sha-def',
        branch: 'feature',
        files: [{ path: 'src/a.ts', status: 'modified' }],
      }),
    ])

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={noTranscript} />,
    )

    expect(screen.getByTestId('why-gap').textContent).toContain('TOOL DETAIL UNAVAILABLE')
  })

  it('the conversation deep-link is off by default and mounts only on click', async () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' }),
    ])
    let fetchCount = 0
    const fetchTranscript: FetchLike = async () => {
      fetchCount += 1
      return { ok: true, json: async () => ({ available: true, lane: 'feature', sessionId: 's', offset: 0, nextOffset: 0, size: 0, eof: true, restarted: false, entries: [] }) }
    }

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={fetchTranscript} />,
    )

    expect(screen.queryByTestId('why-nearest-entry')).toBeNull()
    expect(fetchCount).toBe(0)

    fireEvent.click(screen.getByTestId('why-tool-call-jump'))
    await waitFor(() => expect(fetchCount).toBeGreaterThan(0))
  })

  /**
   * FILL MODE (#163) — what the drawer's own WHY tab passes: no self
   * max-height, since the tab body is the drawer's one scroll region now.
   * `LanePage` (outside this issue's fence) never sets `fill`, so its own
   * bounded strip stays exactly as it was — covered by every test above,
   * none of which pass `fill`.
   */
  it('fill mode carries no self max-height and fills its container instead', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' }),
    ])

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={noTranscript} fill />,
    )

    const surface = screen.getByTestId('why-surface')
    expect(surface.className).not.toMatch(/max-h-\d+/)
    expect(surface.className).not.toContain('overflow-auto')
    expect(surface.className).toContain('flex-1')
    expect(surface.className).toContain('min-h-0')
  })

  /**
   * CAUSALITY SURVIVES TABBING (#163) — `onJumpToActivity` is the drawer's
   * own navigation across the tab boundary; absent (as every `LanePage` call
   * leaves it), the affordance simply does not render.
   */
  it('offers no "activity ↗" jump when onJumpToActivity is not given', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' }),
    ])

    render(
      <WhySurface state={state} laneLabel="feature" laneHandle="feature" now={NOW} fetchTranscript={noTranscript} fill />,
    )

    expect(screen.queryByTestId('why-open-in-activity')).toBeNull()
  })

  it('the "activity ↗" jump names the active file', () => {
    f = createEventFactory({ startTs: NOW - 60_000 })
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' }),
      f.toolActivity({ lane: 'feature', tool: 'Write', branch: 'feature', filePath: 'src/b.ts', toolUseId: 'toolu_2' }),
    ])
    const jumped: string[] = []

    render(
      <WhySurface
        state={state}
        laneLabel="feature"
        laneHandle="feature"
        now={NOW}
        fetchTranscript={noTranscript}
        fill
        onJumpToActivity={(path) => jumped.push(path)}
      />,
    )

    // b.ts was touched last, so it is the default selection (same rule the
    // file-list test above pins).
    fireEvent.click(screen.getByTestId('why-open-in-activity'))
    expect(jumped).toEqual(['src/b.ts'])

    fireEvent.click(screen.getAllByTestId('why-file')[1]!) // src/a.ts
    fireEvent.click(screen.getByTestId('why-open-in-activity'))
    expect(jumped).toEqual(['src/b.ts', 'src/a.ts'])
  })
})
