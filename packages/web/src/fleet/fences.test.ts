import { describe, expect, it } from 'vitest'
import {
  findTrespasses,
  globMatches,
  insideFence,
  parseLaneManifest,
  type LaneManifest,
} from './fences.js'

/**
 * A fence is an accusation, so its matcher and its parser are held to the
 * standard an accusation deserves: exact about what is inside, and flatly
 * absent rather than approximate when the manifest cannot be trusted.
 */

const manifest: LaneManifest = {
  '75-keystone': {
    handle: '75-keystone',
    fence: ['packages/web/src/fleet/**', 'packages/web/src/theme/**'],
    issue: '75',
    model: 'claude-opus-5',
  },
  '76-lanes': {
    handle: '76-lanes',
    fence: ['packages/server/src/api/**'],
    issue: '76',
    model: 'claude-opus-5',
  },
}

describe('globMatches', () => {
  it('lets ** cross directory separators and * stop at one', () => {
    expect(globMatches('packages/**', 'packages/web/src/fleet/x.ts')).toBe(true)
    expect(globMatches('packages/*/x.ts', 'packages/web/x.ts')).toBe(true)
    expect(globMatches('packages/*/x.ts', 'packages/web/src/x.ts')).toBe(false)
  })

  it('matches zero directories for `a/**/b`, so a fence covers its own root', () => {
    expect(globMatches('a/**/b.ts', 'a/b.ts')).toBe(true)
    expect(globMatches('a/**/b.ts', 'a/deep/nest/b.ts')).toBe(true)
  })

  it('treats regex metacharacters in a path as literals', () => {
    expect(globMatches('docs/a.md', 'docs/a.md')).toBe(true)
    expect(globMatches('docs/a.md', 'docs/aXmd')).toBe(false)
  })

  it('matches `?` against exactly one non-separator character', () => {
    expect(globMatches('src/a?.ts', 'src/ab.ts')).toBe(true)
    expect(globMatches('src/a?.ts', 'src/a/.ts')).toBe(false)
  })
})

describe('insideFence', () => {
  it('normalises a leading slash rather than failing to match on it', () => {
    const fence = manifest['75-keystone']!
    expect(insideFence(fence, 'packages/web/src/fleet/buildFleet.ts')).toBe(true)
    expect(insideFence(fence, '/packages/web/src/fleet/buildFleet.ts')).toBe(true)
    expect(insideFence(fence, 'packages/web/src/panels/ledger/index.tsx')).toBe(false)
  })
})

describe('findTrespasses', () => {
  it('names the lane whose fence claims the file', () => {
    expect(
      findTrespasses(manifest, '75-keystone', [
        'packages/web/src/fleet/buildFleet.ts',
        'packages/server/src/api/lanes.ts',
      ]),
    ).toEqual([{ path: 'packages/server/src/api/lanes.ts', victim: '76-lanes' }])
  })

  it('still reports a trespass nobody claims — outside the fence is outside it', () => {
    expect(findTrespasses(manifest, '75-keystone', ['docs/prd3.md'])).toEqual([
      { path: 'docs/prd3.md', victim: null },
    ])
  })

  it('says nothing about a lane the manifest never dispatched', () => {
    // An undispatched lane never agreed to a fence, so it cannot have crossed
    // one. Reporting every file it touches would accuse it of existing.
    expect(findTrespasses(manifest, 'not-dispatched', ['anything.ts'])).toEqual([])
  })

  it('counts each file once, however many times it was touched', () => {
    expect(
      findTrespasses(manifest, '75-keystone', ['docs/prd3.md', 'docs/prd3.md']),
    ).toHaveLength(1)
  })
})

describe('parseLaneManifest', () => {
  it('accepts the bare object and the `lanes` envelope alike', () => {
    const bare = { a: { handle: 'a', fence: ['x/**'], issue: '1', model: 'm' } }
    expect(parseLaneManifest(bare)).toEqual(bare)
    expect(parseLaneManifest({ lanes: bare })).toEqual(bare)
  })

  it('fills a missing handle from the key, and missing issue/model with null', () => {
    expect(parseLaneManifest({ a: { fence: ['x/**'] } })).toEqual({
      a: { handle: 'a', fence: ['x/**'], issue: null, model: null },
    })
  })

  it('rejects the whole manifest when any entry is malformed', () => {
    // Half a manifest would fence some lanes and silently leave the rest
    // unjudged, which reads on screen as "those lanes are behaving".
    expect(parseLaneManifest({ a: { fence: ['x/**'] }, b: { fence: 'not-an-array' } })).toBeNull()
    expect(parseLaneManifest({ a: { fence: [''] } })).toBeNull()
    expect(parseLaneManifest({ a: null })).toBeNull()
  })

  it('treats an empty manifest as no manifest', () => {
    // Otherwise it would quietly mean "every lane is unfenced", which is the
    // reassurance the gap voice exists to refuse.
    expect(parseLaneManifest({})).toBeNull()
    expect(parseLaneManifest({ lanes: {} })).toBeNull()
  })

  it('rejects things that are not manifests at all', () => {
    expect(parseLaneManifest(null)).toBeNull()
    expect(parseLaneManifest('a string')).toBeNull()
    expect(parseLaneManifest({ lanes: [] })).toBeNull()
  })

  // The exact envelope `GET /api/lanes` serves (packages/server/src/api/lanes.ts,
  // pinned by packages/server/src/api/lanes.test.ts's "serves a valid manifest"
  // case): `lanes` is an ARRAY of entries, not an object keyed by handle. A
  // hand-rolled approximation of this shape is how the array-vs-object mismatch
  // shipped past two green suites (#91) — so this copies the real payload.
  const liveApiLanesPayload = {
    available: true,
    version: 1,
    lanes: [
      {
        handle: '77-attention-strip',
        branch: '77-attention-strip',
        fence: ['packages/web/src/panels/attention/**'],
        issue: '77',
        model: 'sonnet',
        dispatchedAt: '2026-07-31T20:30:00Z',
      },
      {
        handle: '75-keystone',
        branch: '75-keystone',
        fence: ['packages/web/src/fleet/**', 'packages/web/src/theme/**'],
      },
    ],
  }

  it('parses the live `/api/lanes` array envelope into a manifest whose fences match', () => {
    expect(parseLaneManifest(liveApiLanesPayload)).toEqual({
      '77-attention-strip': {
        handle: '77-attention-strip',
        fence: ['packages/web/src/panels/attention/**'],
        issue: '77',
        model: 'sonnet',
      },
      '75-keystone': {
        handle: '75-keystone',
        fence: ['packages/web/src/fleet/**', 'packages/web/src/theme/**'],
        issue: null,
        model: null,
      },
    })
  })

  it('rejects an array manifest where two entries claim the same handle', () => {
    const duplicated = {
      ...liveApiLanesPayload,
      lanes: [
        ...liveApiLanesPayload.lanes,
        { handle: '75-keystone', branch: 'other', fence: ['packages/other/**'] },
      ],
    }
    expect(parseLaneManifest(duplicated)).toBeNull()
  })

  it('rejects an array entry with no handle and nothing to fall back to', () => {
    expect(parseLaneManifest({ lanes: [{ branch: 'a', fence: ['a/**'] }] })).toBeNull()
  })
})
