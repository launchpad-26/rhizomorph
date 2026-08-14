import { createEvent, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { FAULT_THROTTLE_MS } from '../api/otel.js'
import { describeTelemetryCost, lanesAtBoundary } from './retarget-cost.js'

/**
 * WHAT THE RETARGET COST (#391, spike Q4).
 *
 * Two halves, tested apart because they fail differently. `lanesAtBoundary` is
 * a fold question — which lanes did this recording know — and its failure mode
 * is under-reporting. `describeTelemetryCost` is a wording question, and its
 * failure mode is an answer that reads as a bigger loss than it is, or a
 * paste-ready command that cannot work.
 *
 * The ORDERING that makes either possible — read the lanes before the boundary
 * — is not a property of this module and cannot be: after the close the
 * recorder's buffer is the new session's. It is pinned where it lives, in
 * `api/retarget.test.ts`.
 */

let nextId = 0
function status(lane: string, ts = 1000): RhizomorphEvent {
  nextId += 1
  return createEvent(
    'agent.status',
    { handle: lane, status: 'working' },
    { id: `evt-${nextId}`, ts, source: 'workmux' },
  )
}

function cost(lane: string, ts = 1000): RhizomorphEvent {
  nextId += 1
  return createEvent(
    'llm.cost',
    { lane, role: 'worker', model: 'claude-opus-5', costUsd: 0.02, authoritative: true },
    { id: `evt-${nextId}`, ts, source: 'otel' },
  )
}

describe('lanesAtBoundary', () => {
  it('is empty for a recording that knew nobody', () => {
    expect(lanesAtBoundary([])).toEqual([])
  })

  it('names a lane a collector saw, and a lane only telemetry attributed', () => {
    // The superset, deliberately: a lane that has not exported yet was still
    // launched against the old instance and will still be refused, so naming
    // only the lanes observed exporting would under-report exactly the ones
    // nobody has noticed. And a lane whose only trace is an OTLP cost record
    // — no workmux pane, no status poll — is real too.
    expect(lanesAtBoundary([status('seen-by-workmux'), cost('only-exported')])).toEqual([
      'only-exported',
      'seen-by-workmux',
    ])
  })

  it('counts a lane once however many events mention it, and sorts', () => {
    const events = [cost('zulu'), status('alpha'), cost('alpha', 2000), status('alpha', 3000)]
    expect(lanesAtBoundary(events)).toEqual(['alpha', 'zulu'])
  })
})

describe('describeTelemetryCost', () => {
  const base = { previousInstance: '1000', instance: '5000' }

  it('names both instance ids, the lanes, and a paste-ready re-issue for each', () => {
    const cost = describeTelemetryCost({ ...base, lanes: ['w1', 'w2'], port: 4317 })

    expect(cost.previousInstance).toBe('1000')
    expect(cost.instance).toBe('5000')
    expect(cost.lanes).toEqual(['w1', 'w2'])
    expect(cost.reissue).toEqual(['rhizomorph env w1 --port 4317', 'rhizomorph env w2 --port 4317'])
    expect(cost.reissueTemplate).toBe('rhizomorph env <lane> --port 4317')
  })

  it('says what stops AND what does not — an answer naming only the loss reads as going dark', () => {
    const cost = describeTelemetryCost({ ...base, lanes: ['w1'], port: 4317 })

    // OTLP is the only source of these three.
    expect(cost.lost).toEqual(expect.arrayContaining(['llm.cost', 'trace.span', 'active time']))
    // …and these keep working untouched, so the instrument drops a rung
    // rather than going dark.
    expect(cost.stillWorking).toEqual(expect.arrayContaining(['git', 'tmux', 'workmux', 'sessionlog transcripts']))
    expect(cost.lost).not.toEqual(expect.arrayContaining(cost.stillWorking))
  })

  it('says the refusal is throttled by declared instance — a standing fault, and a quiet one', () => {
    const cost = describeTelemetryCost({ ...base, lanes: ['w1', 'w2', 'w3'], port: 4317 })

    // Every stale lane declares the SAME old id and the throttle keys by
    // declared instance, so an eight-lane swarm is one key: roughly one
    // recorded refusal per window for the whole set, not one per lane. Left
    // unsaid, the operator reads a quiet log as a healthy one.
    expect(cost.note).toContain('throttled by declared instance')
    expect(cost.note).toContain('one telemetry.refused per minute')
    expect(cost.note).toContain('not one per lane')
    // The claim above is about a real constant, not a remembered one.
    expect(FAULT_THROTTLE_MS).toBe(60_000)
  })

  it('the note counts the lanes and agrees with itself about the number', () => {
    expect(describeTelemetryCost({ ...base, lanes: ['w1'], port: 4317 }).note).toContain('1 lane still exports')
    expect(describeTelemetryCost({ ...base, lanes: ['w1', 'w2'], port: 4317 }).note).toContain('2 lanes still export')
  })

  it('still explains itself when the recording knew no lane at all', () => {
    const cost = describeTelemetryCost({ ...base, lanes: [], port: 4317 })

    // No lane to name is not "no cost": a lane launched but never yet seen is
    // still exporting as the old instance, so the answer stays a warning.
    expect(cost.lanes).toEqual([])
    expect(cost.reissue).toEqual([])
    expect(cost.note).toContain('refused whole')
    expect(cost.note).toContain('1000')
    expect(cost.reissueTemplate).toBe('rhizomorph env <lane> --port 4317')
  })

  it('names `<port>` rather than a command that cannot work, for a port it does not have', () => {
    // `--port 0` is a real, documented CLI value meaning "let the OS pick", so
    // a server holding it cannot print a working re-issue — the same posture
    // `/api/concierge/launch` takes toward a port nothing is listening on.
    for (const options of [{ ...base, lanes: ['w1'] }, { ...base, lanes: ['w1'], port: 0 }]) {
      const cost = describeTelemetryCost(options)
      expect(cost.reissue).toEqual(['rhizomorph env w1 --port <port>'])
      expect(cost.reissueTemplate).toBe('rhizomorph env <lane> --port <port>')
    }
  })
})
