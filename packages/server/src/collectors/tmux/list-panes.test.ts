import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseListPanes } from './list-panes.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

describe('parseListPanes', () => {
  it('parses real captured tmux list-panes -a -F output', () => {
    const { panes } = parseListPanes(fixture('list-panes.real.txt'))

    expect(panes.length).toBeGreaterThan(0)
    expect(panes[0]).toEqual({
      paneId: '%0',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'bash',
      currentPath: '/repo',
      currentCommand: 'bash',
      title: 'HOST-REDACTED',
    })

    for (const pane of panes) {
      expect(pane.paneId).toMatch(/^%\d+$/)
      expect(pane.currentPath.length).toBeGreaterThan(0)
    }
  })

  it('ignores blank lines', () => {
    const { panes } = parseListPanes('\n\n')
    expect(panes).toEqual([])
  })

  it('maps an empty session name field to null', () => {
    const { panes } = parseListPanes('%1\t\t0\twin\t/tmp\tbash\ttitle')
    expect(panes[0]?.sessionName).toBeNull()
  })

  it('skips a line with the wrong field count, and counts it', () => {
    const { panes, skipped } = parseListPanes('%1\tobs\t0')
    expect(panes).toEqual([])
    expect(skipped).toEqual([{ line: '%1\tobs\t0', reason: 'expected 7 tab-separated fields, got 3' }])
  })

  it('skips a missing pane id, and counts it', () => {
    const line = '\tobs\t0\twin\t/tmp\tbash\ttitle'
    const { panes, skipped } = parseListPanes(line)
    expect(panes).toEqual([])
    expect(skipped).toEqual([{ line, reason: 'missing pane id or path' }])
  })

  it('skips a line with a tab in pane_current_path instead of throwing it away', () => {
    const line = '%2\tobs\t1\twin\t/tmp/weird\tpath\tbash\ttitle'
    const { panes, skipped } = parseListPanes(line)
    expect(panes).toEqual([])
    expect(skipped).toEqual([{ line, reason: 'expected 7 tab-separated fields, got 8' }])
  })

  it('keeps every good line when one line in the batch is unparseable', () => {
    const goodA = '%1\tobs\t0\twin-a\t/tmp/a\tbash\ttitle-a'
    const bad = '%1\tobs\t0'
    const goodB = '%2\tobs\t1\twin-b\t/tmp/b\tbash\ttitle-b'
    const { panes, skipped } = parseListPanes([goodA, bad, goodB].join('\n'))

    expect(panes.map((pane) => pane.paneId)).toEqual(['%1', '%2'])
    expect(skipped).toEqual([{ line: bad, reason: 'expected 7 tab-separated fields, got 3' }])
  })
})
