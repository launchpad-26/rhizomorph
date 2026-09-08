import { describe, expect, it } from 'vitest'
import { disclosureLines, type DisclosureContent } from '../../disclosure/index.js'
import type { Gap, Lane } from '../../fleet/index.js'
import {
  ageActiveCellDisclosure,
  ageCellDisclosure,
  costCellDisclosure,
  fenceCell,
  gitStatusIncidentDisclosure,
  inferredDisclosure,
  laneBranchDisclosure,
  laneIdentityDisclosure,
  outputCellDisclosure,
  terminalDoneDisclosure,
  threadsCellDisclosure,
} from './format.js'

/**
 * THE ABSENCES (#220).
 *
 * The sweep's own risk, stated plainly: every card carries an age, and this
 * package is full of readings that legitimately have none — a lane git never
 * saw, a cost feed that never spoke, a thread list nothing reported. The old
 * `title=` strings could say "no event recorded yet" and stop. A card cannot:
 * `disclosureLines` refuses a missing fact and refuses a non-finite or negative
 * age (`disclosure/vocabulary.ts`'s `requireText` / `requireAge`), so a builder
 * that reached for `now - null` renders `NaN ago` — or throws inside the card,
 * in the one place nobody is looking.
 *
 * So every arm is exercised here through the same function the card renders
 * through. **`disclosureLines` throwing IS the failure**; there is no separate
 * assertion for it, and there does not need to be.
 *
 * The rule these all follow is core's own, from `selectors/condition.ts`: a
 * condition with no timestamp of its own reports `elapsedMs: 0` — "confirmed
 * just now", which is what re-reading the fold on every tick means — rather
 * than a fabricated span or a NaN.
 */

/** Just enough of a `Lane` for the cell builders, which read named fields only. */
function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: 'lane-7',
    label: '7-parser',
    issue: '7',
    branch: 'prd30-w1-sweep',
    worktreePath: '/repo-wt/7-parser',
    present: true,
    parked: false,
    ageMs: 90_000,
    activeSeconds: 30,
    tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400, total: 189_504 },
    outputTokens: 3_100,
    costUsd: 1.23,
    costIsAuthoritative: true,
    costEventCount: 2,
    requestCount: 5,
    toolCallCount: 9,
    filaments: [],
    pathologies: [],
    trespasses: [],
    fenced: true,
    dirtyStatusFailedForMs: null,
    rank: 'calm',
    activity: 'working',
    recentOutputTokens: [],
    ...overrides,
  } as Lane
}

/** The card's own rendering — the assertions read what a reader reads. */
function render(disclosure: DisclosureContent): string {
  const lines = disclosureLines(disclosure)
  return [lines.label, lines.why, lines.remedy, lines.command ?? ''].join(' · ')
}

describe('a reading with no age still discloses honestly', () => {
  it('a lane with no event yet says so, and never renders NaN', () => {
    const card = render(ageCellDisclosure(lane({ ageMs: null })))

    expect(card).toContain('no event has been recorded for this lane yet')
    expect(card).not.toContain('NaN')
    // The absence was observed on this fold, so it reads as just-now rather
    // than as an invented span.
    expect(card).toContain('0s ago')
  })

  it('the AGE / ACTIVE cell keeps AGE when OTel reported no active time (law 12)', () => {
    const withOtel = render(ageActiveCellDisclosure(lane()))
    const without = render(ageActiveCellDisclosure(lane({ activeSeconds: null })))

    expect(withOtel).toContain('claude_code.active_time.total')
    expect(without).toContain('no OTel active-time reading')
    // Never an invented `/ 0s` — the gap is named, not zeroed.
    expect(without).not.toContain('active 0s')
    expect(without).not.toContain('NaN')
  })

  it('a lane with no cost event names the gap and offers the act that closes it', () => {
    const gaps: Gap[] = [{ id: 'no-cost-feed', line: 'NO COST FEED (OTel) — dollars unavailable' } as Gap]
    const card = render(costCellDisclosure(lane({ costEventCount: 0, costIsAuthoritative: null }), gaps))

    expect(card).toContain('NO COST FEED')
    expect(card).toContain('no llm.usage event has carried a dollar figure')
    expect(card).not.toContain('NaN')
  })

  it('an estimated cost says whose figure it is not', () => {
    const card = render(costCellDisclosure(lane({ costIsAuthoritative: false }), []))
    expect(card).toContain('estimated')
    expect(card).toContain('cache read')
  })

  it('a lane with no reported thread says nothing reported one', () => {
    const card = render(threadsCellDisclosure(lane({ filaments: [] })))
    expect(card).toContain('no source reported a thread for this lane')
    expect(card).not.toContain('NaN')
  })

  it('a lane git never saw a worktree for still names itself', () => {
    const card = render(laneIdentityDisclosure(lane({ worktreePath: null })))

    expect(card).toContain('git never named a worktree')
    expect(card).toContain('lane-7')
    expect(card).not.toContain('NaN')
  })

  it('a branchless lane says why rather than showing an empty name', () => {
    const card = render(laneBranchDisclosure(lane({ branch: null })))
    expect(card).toContain('git never saw a worktree for this lane')
    expect(card).not.toContain('NaN')
  })

  it('a git-status incident with no retained duration reads as just-now, not as NaN', () => {
    const card = render(gitStatusIncidentDisclosure(lane({ dirtyStatusFailedForMs: null })))

    expect(card).toContain('has failed repeatedly')
    expect(card).toContain('0s ago')
    expect(card).not.toContain('NaN')
    // The remedy carries the command apart from the prose, so a surface that
    // can offer a copy affordance has something to copy (prd-27 ruling 5).
    expect(disclosureLines(gitStatusIncidentDisclosure(lane())).command).toContain('git -C')
  })

  it('the terminal-done mark borrows core’s own sentence rather than writing a second one', () => {
    const card = render(terminalDoneDisclosure(lane({ ageMs: null })))
    expect(card).toContain('done')
    expect(card).not.toContain('NaN')
  })

  it('the inferred mark names what was inferred, and copes when nothing is', () => {
    const none = render(inferredDisclosure(lane({ pathologies: [] })))
    expect(none).toContain('no pathology on this lane names a direct observation')

    const some = render(inferredDisclosure(lane({ pathologies: [{ kind: 'frozen', inferred: true }] as Lane['pathologies'] })))
    expect(some).toContain('inferred: frozen')
  })
})

describe('the fence cell discloses all four of its states', () => {
  const gaps: Gap[] = [
    { id: 'no-lane-manifest', line: 'NO LANE MANIFEST — off-fence detection unavailable' } as Gap,
    { id: 'unfenced-lanes', line: 'UNFENCED LANES — cannot be judged off-fence' } as Gap,
  ]

  it('no manifest names the gap and the act that closes it', () => {
    const cell = fenceCell(lane(), { hasLaneManifest: false, gaps })
    expect(cell.kind).toBe('no-manifest')
    expect(render(cell.disclosure)).toContain('NO LANE MANIFEST')
  })

  it('an unfenced lane is a different claim from a clean one', () => {
    const cell = fenceCell(lane({ fenced: false }), { hasLaneManifest: true, gaps })
    expect(cell.kind).toBe('unfenced')
    expect(render(cell.disclosure)).toContain('UNFENCED LANES')
  })

  it('a clean lane still gets its evidence — "nothing wrong" is a claim too (ruling 14)', () => {
    const cell = fenceCell(lane(), { hasLaneManifest: true, gaps })
    expect(cell.kind).toBe('clean')
    expect(render(cell.disclosure)).toContain('every path this lane touched is one the manifest gave it')
  })

  it('a breach names the paths and what to do, not merely a count', () => {
    const cell = fenceCell(
      lane({ trespasses: [{ path: 'packages/core/src/index.ts', victim: '9-core' }] as Lane['trespasses'] }),
      { hasLaneManifest: true, gaps },
    )
    expect(cell.kind).toBe('breach')
    const card = render(cell.disclosure)
    expect(card).toContain('packages/core/src/index.ts')
    expect(card).toContain('→ 9-core')
    expect(card).toContain('widen the fence on the issue before the change')
  })
})

describe('the output cell', () => {
  it('carries the four-tier breakdown, never an unlabelled total', () => {
    const card = render(outputCellDisclosure(lane()))
    expect(card).toContain('cache read')
    expect(card).toContain('output')
  })

  it('survives a lane with no age at all', () => {
    expect(render(outputCellDisclosure(lane({ ageMs: null })))).not.toContain('NaN')
  })
})
