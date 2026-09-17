import { describe, expect, it } from 'vitest'
import { createEvent } from './events/index.js'
import { parseStreamFrame } from './stream-frame.js'

/** prd-58 ruling 3: the frame says which colony; the event says what happened. */

const EVENT = createEvent('session.started', { sessionId: 's1', repoPath: '/repo', repoName: 'repo' } as never, {
  id: 'e1',
  ts: 1_000,
})

describe('parseStreamFrame', () => {
  it('reads the colony off the envelope, and the event out of it unchanged', () => {
    const frame = parseStreamFrame({ colony: 'repo-abc12345', event: EVENT })
    expect(frame?.colony).toBe('repo-abc12345')
    expect(frame?.event).toEqual(EVENT)
  })

  it('reads a BARE event — what every server before this wave wrote', () => {
    // The leniency that lets this wave land without #614's version handshake.
    // `colony: null` is the caller's cue to read it as "the one colony I watch".
    const frame = parseStreamFrame(EVENT)
    expect(frame?.colony).toBeNull()
    expect(frame?.event).toEqual(EVENT)
  })

  it('an envelope whose event is malformed reaches nothing — the colony does not rescue it', () => {
    expect(parseStreamFrame({ colony: 'repo-abc12345', event: { type: 'nope' } })).toBeUndefined()
  })

  it('an envelope with an EMPTY colony is not an envelope', () => {
    // A blank string is not a colony id. It falls through to the bare read,
    // which rejects it because the payload is not an event either — rather than
    // being folded under a colony called "".
    expect(parseStreamFrame({ colony: '', event: EVENT })).toBeUndefined()
  })

  it('neither shape is undefined, never a guess', () => {
    expect(parseStreamFrame({ hello: 'world' })).toBeUndefined()
    expect(parseStreamFrame(null)).toBeUndefined()
    expect(parseStreamFrame('a string')).toBeUndefined()
  })

  it('an envelope carrying extra keys still reads — additive, like every schema here', () => {
    const frame = parseStreamFrame({ colony: 'repo-abc12345', event: EVENT, future: 'ignored' })
    expect(frame?.colony).toBe('repo-abc12345')
  })
})
