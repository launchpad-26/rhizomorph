import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  filterByQuery,
  hiddenLine,
  matchesQuery,
  sessionQuery,
  setSessionQuery,
} from './session.js'

/**
 * THE SEARCH'S OWN LAWS (prd-31 ruling 4 and S3, #559).
 *
 * S3's acceptance is two clauses: *filtering states the hidden count on every
 * surface it touches*, and *a test asserts no `/api/` string is added by this
 * feature*. The surface-by-surface half is in each surface's own suite (the
 * feed's, the trace's, the conversation's); this file holds the two claims that
 * are about the feature rather than about any one surface — the declaration's
 * wording, and the refusal of a read seam.
 */

afterEach(() => {
  setSessionQuery('')
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(HERE, '../..')

describe('the one query', () => {
  it('starts empty and round-trips', () => {
    expect(sessionQuery()).toBe('')
    setSessionQuery('retarget')
    expect(sessionQuery()).toBe('retarget')
    setSessionQuery('')
    expect(sessionQuery()).toBe('')
  })

  it('matches case-insensitively, on a plain substring', () => {
    expect(matchesQuery('Retargeting the fleet', 'retarget')).toBe(true)
    expect(matchesQuery('retargeting the fleet', 'FLEET')).toBe(true)
    expect(matchesQuery('nothing here', 'retarget')).toBe(false)
  })

  it('treats a regex metacharacter as a literal, not as a pattern', () => {
    // The mutation this guards: a `new RegExp(query)` implementation would
    // throw on the first unbalanced bracket a person types mid-word, taking the
    // whole surface down with it — and would silently match the wrong rows
    // before it got there.
    expect(() => matchesQuery('a(b', '(')).not.toThrow()
    expect(matchesQuery('a(b', '(')).toBe(true)
    expect(matchesQuery('aaa', 'a{2}')).toBe(false)
    expect(matchesQuery('a{2}', 'a{2}')).toBe(true)
  })

  it('matches everything on an empty query, so an unfiltered list takes the same path', () => {
    expect(matchesQuery('anything', '')).toBe(true)
    const result = filterByQuery(['a', 'b'], '', (s) => s)
    expect(result.shown).toEqual(['a', 'b'])
    expect(result.hidden).toBe(0)
    expect(result.filtering).toBe(false)
  })
})

describe('a filtered view declares what it hid (ruling 4 — law 12 at list altitude)', () => {
  it('returns the count with the list, so a surface cannot filter and forget to say so', () => {
    const result = filterByQuery(['alpha', 'beta', 'alfalfa'], 'al', (s) => s)
    expect(result.shown).toEqual(['alpha', 'alfalfa'])
    expect(result.hidden).toBe(1)
    expect(result.filtering).toBe(true)
  })

  it('says nothing at all when nothing is filtered', () => {
    // A permanent "0 hidden" on every unfiltered screen trains a reader to stop
    // reading the one line that matters on the screen where it is not zero.
    expect(hiddenLine({ hidden: 0, filtering: false }, { noun: 'events', query: '', shown: 9 })).toBeNull()
  })

  it('names the count, the total and the query when something is hidden', () => {
    const line = hiddenLine({ hidden: 3, filtering: true }, { noun: 'events', query: 'retarget', shown: 2 })
    expect(line).toBe('2 of 5 events — 3 hidden by “retarget”.')
  })

  it('says WHAT was searched and WHERE when nothing matches (S3’s *no matches*)', () => {
    // Not "no results": this feature can only see the loaded session, so
    // "retarget is not in this session" would be a claim it is not entitled to
    // make. It says what it searched instead.
    const line = hiddenLine({ hidden: 5, filtering: true }, { noun: 'turns', query: 'retarget', shown: 0 })
    expect(line).toContain('NO TURNS MATCH “retarget”')
    expect(line).toContain('5 turns in the loaded session were searched')
  })

  it('still declares itself when the hidden count is zero but a query is in force', () => {
    // `hidden === 0` and "not filtering" are different states, and conflating
    // them would leave a person reading a filtered list with no sign it was one
    // — the failure ruling 4 is written against, in its quietest form.
    const line = hiddenLine({ hidden: 0, filtering: true }, { noun: 'events', query: 'a', shown: 4 })
    expect(line).toBe('4 of 4 events — 0 hidden by “a”.')
  })
})

/**
 * Every file that IS this feature, or that consumes it. Named explicitly rather
 * than walked, because the claim is about the feature and not about the
 * directories it touches — `drawer/Conversation.tsx` legitimately fetches the
 * transcript and always has, so a blanket sweep of its file would fail for a
 * reason that has nothing to do with this.
 */
const FEATURE_FILES: readonly string[] = [
  'panels/search/session.ts',
  'panels/search/SearchField.tsx',
  'panels/search/HiddenNotice.tsx',
]

/** The consumers — checked for what this feature ADDED, which is a diff-shaped claim, so: no new route constant. */
const CONSUMERS: readonly string[] = [
  'panels/feed/feed.ts',
  'panels/feed/index.tsx',
  'trace/model.ts',
  'trace/TraceTree.tsx',
]

/**
 * Comments blanked before every sweep below, the same idiom `theme/tokens.ts`
 * and `settings/coverage-law.test.tsx` use and for the same reason: this
 * feature's own prose explains at length that it reaches for no `/api/` route
 * and no `fetch`, and a law that read the explanation as a violation would push
 * the next person to delete the explanation rather than the behaviour.
 * Blanked rather than removed, so a failure's line numbers still point at the
 * line the reader has open.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

describe('this feature adds no read seam (S3: no index, no server route)', () => {
  function read(name: string): string {
    return withoutComments(readFileSync(path.join(WEB_SRC, name), 'utf8'))
  }

  it('has the files it claims to check — a missing path would pass silently', () => {
    for (const name of [...FEATURE_FILES, ...CONSUMERS]) {
      expect(read(name).trim().length, `${name} is empty or missing`).toBeGreaterThan(0)
    }
  })

  it('walks the whole search directory, not a hand-listed subset of it', () => {
    // The list above is a claim about what this directory contains; if a fourth
    // file lands here it must be checked too, and this is what notices.
    const actual = readdirSync(path.join(WEB_SRC, 'panels', 'search'))
      .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      .map((entry) => `panels/search/${entry}`)
      .sort()
    expect(actual).toEqual([...FEATURE_FILES].sort())
  })

  it('names no /api/ path in any of its own files', () => {
    for (const name of FEATURE_FILES) {
      expect(read(name), `${name} reaches for a server route`).not.toMatch(/\/api\//)
    }
  })

  it('adds none to the surfaces it filters either', () => {
    for (const name of CONSUMERS) {
      expect(read(name), `${name} reaches for a server route`).not.toMatch(/\/api\//)
    }
  })

  it('reaches for no fetch mechanism at all', () => {
    for (const name of FEATURE_FILES) {
      expect(read(name), `${name} reaches for the network`).not.toMatch(
        /\bfetch\b|XMLHttpRequest|EventSource|WebSocket|sendBeacon/,
      )
    }
  })

  it('persists nothing — a query is a thing you are doing, not a thing you have set', () => {
    // …and structurally: `settings/coverage-law.test.tsx` forbids any file but
    // the registry from naming a store, so a persisted query would have needed
    // a declared key. This says the same thing at this feature's own altitude.
    for (const name of FEATURE_FILES) {
      expect(read(name), `${name} persists the query`).not.toMatch(/localStorage|sessionStorage/)
    }
  })

  it('the sweeps bite — each would catch what it looks for', () => {
    // Every grep above is a claim that a regex found nothing; without this, all
    // five pass identically against a typo'd pattern.
    expect(/\/api\//.test("const url = '/api/search'")).toBe(true)
    expect(/\bfetch\b/.test('await fetch(url)')).toBe(true)
    expect(/localStorage|sessionStorage/.test("localStorage.setItem('q', q)")).toBe(true)
    expect(/\/api\//.test('const q = query.toLowerCase()')).toBe(false)
    // …and the comment-blanking is real, so the sweeps are not passing because
    // the file arrived empty.
    expect(withoutComments('/* /api/x */ const a = 1').trim()).toBe('const a = 1')
    expect(withoutComments("const url = '/api/x'")).toContain('/api/x')
  })
})
