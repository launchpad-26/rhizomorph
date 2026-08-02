import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseElapsed, parseListTable, parseStatusTable } from './parse.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

describe('parseStatusTable', () => {
  it('parses real captured `workmux status` output', () => {
    const rows = parseStatusTable(fixture('status-working.txt'))
    expect(rows).toEqual([
      {
        handle: '2-core',
        status: 'working',
        elapsedSeconds: 12 * 60,
        detail: '⠐ Implement core event schema and reducer',
      },
      {
        handle: '3-git-collector',
        status: 'working',
        elapsedSeconds: 6 * 60,
        detail: '⠐ Implement Git collector with shell commands and parsers',
      },
      {
        handle: '4-tmux-collector',
        status: 'working',
        elapsedSeconds: 5 * 60,
        detail: '⠐ Implement tmux collector for The Rhizomorph',
      },
      {
        handle: '5-workmux-collector',
        status: 'working',
        elapsedSeconds: 5 * 60,
        detail: '⠂ Implement workmux collector with status parsing',
      },
      {
        handle: '6-server',
        status: 'working',
        elapsedSeconds: 5 * 60,
        detail: '⠂ Build server SSE API and CLI with session logging',
      },
      {
        handle: '7-web-shell',
        status: 'working',
        elapsedSeconds: 4 * 60,
        detail: '⠂ Build web shell with stream hook and layout',
      },
    ])
  })

  it('parses waiting and done rows alongside working ones', () => {
    const rows = parseStatusTable(fixture('status-mixed.txt'))
    expect(rows.map((r) => [r.handle, r.status])).toEqual([
      ['2-core', 'working'],
      ['3-git-collector', 'waiting'],
      ['4-tmux-collector', 'done'],
      ['5-workmux-collector', 'working'],
    ])
    expect(rows[1]?.detail).toBe('⠂ Needs input: which diff format for renames?')
  })

  it('returns no rows for "No active agents"', () => {
    expect(parseStatusTable(fixture('status-empty.txt'))).toEqual([])
  })

  it('returns no rows for unrecognised text', () => {
    expect(parseStatusTable('workmux: command not found\n')).toEqual([])
  })
})

describe('parseListTable', () => {
  it('parses real captured `workmux list` output, including the "(here)" path', () => {
    const rows = parseListTable(fixture('list-working.txt'))
    expect(rows).toEqual([
      { branch: 'main', path: '../../worktrees-challenge' },
      { branch: '2-core', path: '../2-core' },
      { branch: '3-git-collector', path: '../3-git-collector' },
      { branch: '4-tmux-collector', path: '../4-tmux-collector' },
      { branch: '5-workmux-collector', path: '(here)' },
      { branch: '6-server', path: '../6-server' },
      { branch: '7-web-shell', path: '../7-web-shell' },
    ])
  })

  it('returns no rows for unrecognised text', () => {
    expect(parseListTable('workmux: command not found\n')).toEqual([])
  })
})

describe('parseElapsed', () => {
  it.each([
    ['12m', 12 * 60],
    ['43s', 43],
    ['27s', 27],
    ['1h2m3s', 3600 + 120 + 3],
    ['2h', 7200],
    ['<1m', 0],
    ['-', null],
    ['', null],
    ['garbage', null],
  ])('parses %s', (raw, expected) => {
    expect(parseElapsed(raw)).toBe(expected)
  })
})
