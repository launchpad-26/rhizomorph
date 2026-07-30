import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseListPanes } from './list-panes.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

describe('parseListPanes', () => {
  it('parses real captured tmux list-panes -a -F output', () => {
    const panes = parseListPanes(fixture('list-panes.real.txt'))

    expect(panes.length).toBeGreaterThan(0)
    expect(panes[0]).toEqual({
      paneId: '%0',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'bash',
      currentPath: '/home/operator/worktrees-challenge',
      currentCommand: 'bash',
      title: 'HOST-REDACTED',
    })

    for (const pane of panes) {
      expect(pane.paneId).toMatch(/^%\d+$/)
      expect(pane.currentPath.length).toBeGreaterThan(0)
    }
  })

  it('ignores blank lines', () => {
    const panes = parseListPanes('\n\n')
    expect(panes).toEqual([])
  })

  it('maps an empty session name field to null', () => {
    const panes = parseListPanes('%1\t\t0\twin\t/tmp\tbash\ttitle')
    expect(panes[0]?.sessionName).toBeNull()
  })

  it('throws on a line with the wrong field count', () => {
    expect(() => parseListPanes('%1\tobs\t0')).toThrow(/expected 7 tab-separated fields/)
  })

  it('throws on a missing pane id', () => {
    expect(() => parseListPanes('\tobs\t0\twin\t/tmp\tbash\ttitle')).toThrow(/malformed/)
  })
})
