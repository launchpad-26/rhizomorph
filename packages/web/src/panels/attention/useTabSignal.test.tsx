import { reduceAll } from '@rhizomorph/core'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type AttentionItem,
  type Fleet,
  type FixtureSpec,
  type LadderRank,
} from '../../fleet/index.js'
import { AGE_INK_MAX_MS } from './ageBands.js'
import { useTabSignal } from './useTabSignal.js'

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const ICON_SELECTOR = 'link[rel="icon"]'

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function Harness({ fleet }: { fleet: Fleet }) {
  useTabSignal(fleet)
  return null
}

beforeEach(() => {
  document.title = 'Rhizomorph Test'
  document.querySelectorAll(ICON_SELECTOR).forEach((el) => el.remove())
})

afterEach(cleanup)

describe('useTabSignal', () => {
  const calm = fleetFor(fleet20Spec())
  const staged = fleetFor(pathologySpec())

  it('leaves the tab untouched while calm', () => {
    expect(calm.rank).toBe('calm')

    render(<Harness fleet={calm} />)

    expect(document.title).toBe('Rhizomorph Test')
    expect(document.querySelector(ICON_SELECTOR)).toBeNull()
  })

  it('flips the title to "● N need you" at NEEDS-YOU and above, counting only the summons', () => {
    expect(staged.rank).toBe('broken')

    render(<Harness fleet={staged} />)

    // frozen (broken) + looping/waiting/off-fence (needs-you) = 4; the
    // expensive (notice) lane is a heads-up, not a summons, so it is not
    // counted in "need you". The frozen lane's own staged "no events"
    // duration is already past the top age band, so the oldest-summons
    // suffix (ruling 5) rides along too.
    expect(document.title).toBe('● 4 need you (oldest 10m)')
  })

  it('takes the favicon to the worst rung\'s hue', () => {
    render(<Harness fleet={staged} />)

    const link = document.querySelector(ICON_SELECTOR)
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toContain('data:image/svg+xml')
  })

  it('restores the exact original title and favicon once the fleet returns to calm', () => {
    const { rerender } = render(<Harness fleet={staged} />)
    expect(document.title).toBe('● 4 need you (oldest 10m)')
    expect(document.querySelector(ICON_SELECTOR)).not.toBeNull()

    rerender(<Harness fleet={calm} />)

    expect(document.title).toBe('Rhizomorph Test')
    expect(document.querySelector(ICON_SELECTOR)).toBeNull()
  })
})

describe('useTabSignal — the oldest summons ages the title too (prd5 ruling 5)', () => {
  it('omits the age suffix while every summons is still under the top band', () => {
    render(<Harness fleet={fleetWithItems([item('needs-you', AGE_INK_MAX_MS - 1)])} />)
    expect(document.title).toBe('● 1 need you')
  })

  it('appends "(oldest Xm)" once the oldest summons crosses the top band', () => {
    render(<Harness fleet={fleetWithItems([item('needs-you', AGE_INK_MAX_MS)])} />)
    expect(document.title).toBe('● 1 need you (oldest 10m)')
  })

  it('reads the oldest summons, not the newest, across a mixed list', () => {
    render(
      <Harness
        fleet={fleetWithItems([
          item('needs-you', 30_000),
          item('broken', 43 * 60_000),
          item('needs-you', AGE_INK_MAX_MS),
        ])}
      />,
    )
    expect(document.title).toBe('● 3 need you (oldest 43m)')
  })

  it('counts a stale BROKEN lane exactly like a stale NEEDS-YOU one — the suffix is not chip-scoped', () => {
    render(<Harness fleet={fleetWithItems([item('broken', AGE_INK_MAX_MS)])} />)
    expect(document.title).toBe('● 1 need you (oldest 10m)')
  })

  it('ignores a null forMs when finding the oldest, rather than treating it as ageless-old', () => {
    render(
      <Harness
        fleet={fleetWithItems([item('needs-you', null), item('needs-you', AGE_INK_MAX_MS)])}
      />,
    )
    expect(document.title).toBe('● 2 need you (oldest 10m)')
  })
})

/** Same minimal-`Fleet` approach as `AttentionStripView.test`'s `singleItemFleet`, generalized to a list. */
let nextItemId = 0
function item(rank: Exclude<LadderRank, 'calm'>, forMs: number | null): AttentionItem {
  nextItemId += 1
  return {
    id: `${rank}:${nextItemId}`,
    laneId: 'lane-x',
    label: 'lane-x',
    kind: rank === 'broken' ? 'frozen' : 'looping',
    rank,
    forMs,
    evidence: 'evidence',
    inferred: false,
  }
}

function fleetWithItems(items: [AttentionItem, ...AttentionItem[]]): Fleet {
  const rank = items.some((i) => i.rank === 'broken') ? 'broken' : 'needs-you'
  return {
    now: NOW,
    root: {
      repoName: null,
      mainBranch: null,
      worktreePath: null,
      commitsHome: 0,
      landings: 0,
      conductorOutputTokens: 0,
      overheadRatio: null,
      lastCommitTs: null,
    },
    lanes: [],
    ladder: { rank, items },
    rank,
    burn: {
      outputTokens: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      costUsd: 0,
      costIsAuthoritative: null,
      costEventCount: 0,
      outputPerMin: 0,
      costUsdPerHour: 0,
      overheadRatio: null,
      conductorInstrumented: false,
      windowMs: 300_000,
    },
    collisions: [],
    gaps: [],
    hasLaneManifest: false,
    eventCount: 0,
  }
}
