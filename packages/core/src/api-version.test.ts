import { describe, expect, it } from 'vitest'
import { API_VERSION, apiVersionRefusal, compareApiVersion } from './api-version.js'

/** prd-58 ruling 8 and Success 8. */

describe('compareApiVersion', () => {
  it('the same number is ok', () => {
    expect(compareApiVersion(API_VERSION)).toEqual({ kind: 'ok', version: API_VERSION })
  })

  it('a MISSING version is unknown, not a mismatch — every server before ruling 8', () => {
    // Refusing here would break every client against every server that predates
    // the handshake. Adding a version is to stop guessing, not to start
    // refusing retroactively.
    expect(compareApiVersion(undefined)).toEqual({ kind: 'unknown' })
    expect(compareApiVersion(null)).toEqual({ kind: 'unknown' })
    expect(compareApiVersion('1')).toEqual({ kind: 'unknown' })
    expect(compareApiVersion(1.5)).toEqual({ kind: 'unknown' })
  })

  it('refuses in BOTH directions, because both mis-read the wire', () => {
    // A rule that only refused an old client would leave exactly half the
    // failures silent. The verdict is the same; only the remedy differs.
    expect(compareApiVersion(9, 1)).toEqual({ kind: 'mismatch', client: 1, server: 9 })
    expect(compareApiVersion(1, 9)).toEqual({ kind: 'mismatch', client: 9, server: 1 })
  })

  it('is pinned against a LITERAL, so bumping the constant cannot make this vacuous', () => {
    // `expect(API_VERSION).toBe(API_VERSION)` in a costume is the shape
    // `AGENTS.md` names by example. A literal on one side keeps the assertion
    // about behaviour rather than about a name.
    expect(compareApiVersion(424_242, 1).kind).toBe('mismatch')
    expect(compareApiVersion(1, 1)).toEqual({ kind: 'ok', version: 1 })
  })
})

describe('apiVersionRefusal — Success 8 is the CONTENT, not the style', () => {
  it('names both versions and a remedy when the view is behind', () => {
    const message = apiVersionRefusal({ kind: 'mismatch', client: 1, server: 2 })
    expect(message).toContain('v1')
    expect(message).toContain('v2')
    expect(message).toContain('reload this page')
  })

  it('names both versions and the OTHER remedy when the server is behind', () => {
    // The two halves are different things the operator can update, and telling
    // them to reload a page when the server is stale sends them in a circle.
    const message = apiVersionRefusal({ kind: 'mismatch', client: 2, server: 1 })
    expect(message).toContain('v1')
    expect(message).toContain('v2')
    expect(message).toContain('restart `rhizomorph`')
    expect(message).not.toContain('reload this page')
  })

  it('says nothing is shown, rather than letting a reader assume a blank view is a quiet fleet', () => {
    expect(apiVersionRefusal({ kind: 'mismatch', client: 1, server: 2 })).toMatch(/nothing is shown/i)
  })
})
