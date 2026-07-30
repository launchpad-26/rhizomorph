import { describe, expect, it } from 'vitest'
import { fixtureEvents } from './fixtures.js'
import {
  BASE_RADIUS,
  CONVERGENCE_MS,
  MAX_BEADS,
  MAX_BEADS_PER_BRANCH,
  MAX_RADIUS,
  layoutScene,
  stationPosition,
} from './layout.js'
import { buildSceneModel, type SceneModel, type SceneStation } from './sceneModel.js'

const NOW = 1_000_000_000

function station(overrides: Partial<SceneStation> = {}): SceneStation {
  return {
    id: '/repo/wt/a',
    label: 'feat',
    path: '/repo/wt/a',
    branch: 'feat',
    isMain: false,
    commits: [],
    aheadOfMain: null,
    dirtyFiles: 0,
    paneIds: [],
    agentStatus: null,
    lastActivityTs: NOW,
    discoveredAt: NOW,
    removedAt: null,
    ...overrides,
  }
}

function commits(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    sha: `sha-${index}`,
    ts: NOW,
    message: 'm',
    author: 'a',
    files: 1,
    insertions: 1,
    deletions: 0,
  }))
}

function model(stations: SceneStation[], trunk: SceneStation | null = null): SceneModel {
  return {
    repoName: 'observatory',
    mainBranch: 'main',
    trunk,
    stations,
    commitCount: stations.reduce((total, s) => total + s.commits.length, 0),
    lastEventTs: NOW,
    eventCount: 0,
  }
}

describe('layoutScene', () => {
  it('grows a branch outward as commits land, and clamps it', () => {
    const short = layoutScene(model([station({ commits: commits(2) })]), NOW)
    const long = layoutScene(model([station({ commits: commits(40) })]), NOW)
    const absurd = layoutScene(model([station({ commits: commits(5_000) })]), NOW)

    expect(short.branches[0]?.radius).toBeGreaterThanOrEqual(BASE_RADIUS)
    expect(long.branches[0]?.radius).toBeGreaterThan(short.branches[0]!.radius)
    expect(absurd.branches[0]?.radius).toBe(MAX_RADIUS)
  })

  it('spreads stations around the trunk without overlapping angles', () => {
    const stations = Array.from({ length: 10 }, (_unused, index) =>
      station({ id: `wt-${index}`, label: `b${index}` }),
    )
    const angles = layoutScene(model(stations), NOW).branches.map((branch) => branch.angle)

    expect(new Set(angles).size).toBe(10)
    expect(Math.max(...angles)).toBeLessThan(Math.PI * 2)
  })

  it('strings commit beads along the branch, newest outermost', () => {
    const layout = layoutScene(model([station({ commits: commits(5) })]), NOW)
    const branch = layout.branches[0]!

    expect(branch.beads).toHaveLength(5)
    const distances = branch.beads.map((bead) => Math.hypot(bead.position[0], bead.position[2]))
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
    expect(Math.max(...distances)).toBeLessThan(branch.radius)
    expect(branch.beads.at(-1)?.recency).toBe(1)
  })

  it('draws only the newest beads on a very long branch', () => {
    const layout = layoutScene(model([station({ commits: commits(400) })]), NOW)

    expect(layout.branches[0]?.beads).toHaveLength(MAX_BEADS_PER_BRANCH)
    expect(layout.branches[0]?.beads[0]?.commit.sha).toBe(`sha-${400 - MAX_BEADS_PER_BRANCH}`)
  })

  it('puts the main worktree’s commits on the trunk', () => {
    const trunk = station({ id: '/repo', label: 'main', isMain: true, commits: commits(6) })
    const layout = layoutScene(model([], trunk), NOW)

    expect(layout.trunkBeads).toHaveLength(6)
    expect(layout.trunkBeads.every((bead) => bead.onTrunk)).toBe(true)
    expect(layout.trunkBeads.every((bead) => bead.position[0] === 0)).toBe(true)
  })

  it('converges a removed station into the trunk, then stops drawing it', () => {
    const removed = station({ removedAt: NOW })

    const start = layoutScene(model([removed]), NOW).branches[0]!
    expect(start.convergence).toBe(0)
    expect(stationPosition(start)).toEqual(start.tip)

    const midway = layoutScene(model([removed]), NOW + CONVERGENCE_MS / 2).branches[0]!
    expect(midway.convergence).toBeCloseTo(0.5)
    expect(distance(stationPosition(midway), midway.anchor)).toBeLessThan(
      distance(midway.tip, midway.anchor),
    )

    const done = layoutScene(model([removed]), NOW + CONVERGENCE_MS + 1).branches[0]!
    expect(done.convergence).toBe(1)
    expect(done.visible).toBe(false)
    expect(layoutScene(model([removed]), NOW + CONVERGENCE_MS + 1).beads).toHaveLength(0)
  })

  it('caps the instanced bead pool', () => {
    const stations = Array.from({ length: 30 }, (_unused, index) =>
      station({ id: `wt-${index}`, commits: commits(MAX_BEADS_PER_BRANCH) }),
    )
    expect(layoutScene(model(stations), NOW).beads.length).toBeLessThanOrEqual(MAX_BEADS)
  })

  it('lays out the fixture swarm within the instancing budget', () => {
    const layout = layoutScene(buildSceneModel(fixtureEvents(NOW)), NOW)

    expect(layout.branches.length).toBeGreaterThanOrEqual(10)
    expect(layout.beads.length).toBeGreaterThan(0)
    expect(layout.beads.length).toBeLessThanOrEqual(MAX_BEADS)
    expect(layout.beads.every((bead) => Number.isFinite(bead.position[0]))).toBe(true)
  })
})

function distance(a: readonly [number, number, number], b: readonly [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
