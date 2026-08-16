import { describe, expect, it } from 'vitest'
import {
  mayDownload,
  relaunchDecision,
  unavailableUpdates,
  updateNote,
  UNAVAILABLE_REASON,
  type UpdateState,
} from './update-gate.js'

const READY: UpdateState = { phase: 'ready', version: '0.2.0', detail: null, unsigned: true }

/**
 * #564'S ACCEPTANCE: "a test asserts no update path can relaunch while the
 * fleet is live". Asserted in the stronger form the gate actually implements —
 * no update path can relaunch, full stop — because "is the fleet live" is a
 * judgement with an edge case, and an updater that had to get it right would
 * eventually get it wrong at 3am.
 */
describe('no update path may relaunch (S3, D44)', () => {
  it('refuses while the fleet is live — the acceptance, literally', () => {
    const decision = relaunchDecision({ state: READY, requester: 'update-path', fleetLive: true })
    expect(decision.allowed).toBe(false)
    expect(decision.why).toContain('never restarts')
  })

  it('refuses on a QUIET fleet too — the stronger promise', () => {
    expect(relaunchDecision({ state: READY, requester: 'update-path', fleetLive: false }).allowed).toBe(false)
  })

  it('refuses in every state, so no phase is a loophole', () => {
    const phases: UpdateState['phase'][] = ['unavailable', 'idle', 'checking', 'downloading', 'ready', 'failed']
    for (const phase of phases) {
      const decision = relaunchDecision({
        state: { ...READY, phase },
        requester: 'update-path',
        fleetLive: false,
      })
      expect(decision.allowed).toBe(false)
    }
  })
})

describe('a person may restart to apply immediately (S3)', () => {
  it('allows it when an update is downloaded and waiting', () => {
    const decision = relaunchDecision({ state: READY, requester: 'person', fleetLive: false })
    expect(decision.allowed).toBe(true)
  })

  it('allows it under a live fleet, and says what will happen to the session', () => {
    const decision = relaunchDecision({ state: READY, requester: 'person', fleetLive: true })
    expect(decision.allowed).toBe(true)
    expect(decision.why).toContain('stopped cleanly')
    expect(decision.why).toContain('resumes')
  })

  it('refuses when there is nothing to apply, and names the phase', () => {
    const decision = relaunchDecision({
      state: { ...READY, phase: 'downloading' },
      requester: 'person',
      fleetLive: false,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.why).toContain('downloading')
  })
})

describe('downloads are quiet, and only when they were left on', () => {
  it('downloads when a person left it on', () => {
    expect(mayDownload({ ...READY, phase: 'idle' }, true)).toBe(true)
  })

  it('does not when they turned it off', () => {
    expect(mayDownload({ ...READY, phase: 'idle' }, false)).toBe(false)
  })

  it('never downloads when there is no feed to download from', () => {
    expect(mayDownload(unavailableUpdates(), true)).toBe(false)
  })
})

describe('the absence has a name (ruling 9)', () => {
  it('reports unavailable rather than "up to date" when there is no feed', () => {
    const state = unavailableUpdates()
    expect(state.phase).toBe('unavailable')
    expect(state.detail).toBe(UNAVAILABLE_REASON)
    // The distinction this exists for: "up to date" would be a claim about a
    // check that never happened.
    expect(updateNote(state)).not.toContain('up to date')
    expect(updateNote(state)).toContain('signing is deferred')
  })

  it('says the build is unsigned, so the note can say it once', () => {
    expect(unavailableUpdates().unsigned).toBe(true)
  })
})

describe('the note is a line, never a modal', () => {
  it('says something for every phase', () => {
    const phases: UpdateState['phase'][] = ['unavailable', 'idle', 'checking', 'downloading', 'ready', 'failed']
    for (const phase of phases) {
      expect(updateNote({ ...READY, phase }).length).toBeGreaterThan(3)
    }
  })

  it('names the version and the restart when one is waiting', () => {
    expect(updateNote(READY)).toContain('0.2.0')
    expect(updateNote(READY)).toContain('restart')
  })

  it('surfaces a failure rather than swallowing it', () => {
    expect(updateNote({ ...READY, phase: 'failed', detail: 'ENOTFOUND' })).toContain('ENOTFOUND')
  })
})
