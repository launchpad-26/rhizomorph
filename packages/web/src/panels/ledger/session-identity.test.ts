import {
  createEventFactory,
  fixtureTelemetrySession,
  reduceAll,
  selectSpendByBranch,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { foldStreamEvent, initialStreamState } from '../../app/streamState.js'
import { buildSessionIndex, foldFrom, initialFoldCursor } from '../../replay/replayFold.js'

/**
 * THE IDENTITY THE FIX RELIES ON (#171, the audit's P1).
 *
 * `LedgerPanel` used to build its own `session` with
 * `reduceAll(state.events)` — a from-scratch re-fold of the whole log, every
 * event. The fix reads `state.session` instead, the same fold the shell
 * already maintains incrementally (`streamState.ts`) and every other panel
 * reads. That is only safe because the two are the same value by
 * construction: both are `RhizomorphEvent[].reduce(reduce, initialSessionState())`
 * over the same prefix, live and in replay. This file is the falsifiable
 * claim, checked rather than asserted by comment: fold the same events two
 * ways — the panel's old way and the shell's real way — and diff the output
 * the panel actually renders from (`selectSpendByBranch`), not just the raw
 * state.
 */
describe('state.session is bit-identical to reduceAll(events) — the ledger fix relies on this (#171)', () => {
  it('matches on the swarm fixture, live-folded one event at a time through foldStreamEvent', () => {
    const events = fixtureTelemetrySession()
    const connectedAt = events[events.length - 1]!.ts + 1
    let state = initialStreamState(connectedAt)
    for (const event of events) state = foldStreamEvent(state, event)

    const incremental = state.session
    const reFolded = reduceAll(events)

    // The whole session, not just the rows — this is the identity the fix
    // trusts, and the rows check below is what a divergence would actually
    // look like on screen.
    expect(incremental).toEqual(reFolded)
    expect(selectSpendByBranch(incremental)).toEqual(selectSpendByBranch(reFolded))
  })

  it('matches on a mid-session replay prefix — the replay fold engine, not the live one', () => {
    const f = createEventFactory({ startTs: 0, idPrefix: 'replayid', stepMs: 500 })
    f.sessionStarted()
    for (let i = 0; i < 30; i += 1) {
      const branch = `replay-branch-${i % 5}`
      const path = `/repo-wt/${branch}`
      if (i < 5) f.worktreeDiscovered({ path, branch, head: `sha-${branch}` })
      f.llmUsage({ lane: branch, branch, worktreePath: path, requestId: `req-${i}` })
      f.llmCost({ lane: branch, branch, worktreePath: path })
    }
    const events = f.all()
    // A prefix well short of the whole log — a scrub stopped partway, not the
    // end-of-log case the fixture above already covers.
    const prefixLength = Math.floor(events.length / 2)

    const index = buildSessionIndex(events)
    const cursor = foldFrom(index, events[prefixLength - 1]!.ts, initialFoldCursor())
    const reFolded = reduceAll(events.slice(0, prefixLength))

    expect(cursor.index).toBe(prefixLength)
    expect(cursor.state).toEqual(reFolded)
    expect(selectSpendByBranch(cursor.state)).toEqual(selectSpendByBranch(reFolded))
  })
})
