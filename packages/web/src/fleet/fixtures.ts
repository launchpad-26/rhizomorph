import {
  createEvent,
  createIdFactory,
  type AgentThread,
  type EventType,
  type RhizomorphEvent,
  type PayloadOf,
  type SourceOf,
} from '@rhizomorph/core'
import type { LaneManifest } from './fences.js'

/**
 * The two synthetic fleets prd3 ruling 24 asks for, plus the one the "done is
 * not a pathology" rule needs.
 *
 * Every event here goes through core's `createEvent`, so a payload the real
 * collectors could not produce fails loudly at construction instead of quietly
 * rendering; every fixture is then folded by core's real reducer and read by
 * the same selectors and detectors the live stream drives. What is simulated is
 * the *fleet*. What is not simulated is any part of the path from event to
 * pixel.
 *
 * Two properties are load-bearing and both are tested:
 *
 * - **The 20-lane fleet is ALL CLEAR** (ruling 22's scale test). Nothing is
 *   staged in it — no fault, no shared file, and a burn spread deliberately
 *   kept inside the outlier test — so when the detectors say "clear", they said
 *   it on their own.
 * - **The staged fleet has exactly one of each pathology.** The detectors are
 *   never told; they read the same recorded facts they read live.
 *
 * Everything is derived from an injected `now`, never from the clock, so a
 * fixture folds to the same fleet twice and a screenshot is reproducible.
 */

const REPO_PATH = '/repo/rhizomorph'
const REPO_NAME = 'rhizomorph'
const MAIN_BRANCH = 'main'
const MODEL = 'claude-opus-5'

/** How much past a fixture opens with — a fleet mid-run has a history. */
const HISTORY_MS = 40 * 60_000

/**
 * One model request per lane per this interval, walked *backwards* from the
 * lane's last moment. Regular spacing is the point: the burn rate is a real
 * trailing-window derivation, so a jittery fixture would trip the outlier test
 * on noise and make "exactly one expensive lane" a coin flip.
 */
const REQUEST_EVERY_MS = 30_000

/** Output tokens per request at weight 1. A lane's weight scales this. */
const OUTPUT_PER_REQUEST = 250

/** How long a stuck lane has been turning its wheel. Inside the loop window. */
const LOOP_TAIL_MS = 3.5 * 60_000
/** Past FROZEN_AFTER_MS (8m) with nobody saying `done`. */
const FROZEN_SILENCE_MS = 11 * 60_000
/** Past WAITING_QUIET_MS (75s), and workmux has declared the stop. */
const WAITING_SILENCE_MS = 160_000
/** Every lane but the looping one lands something recently: real progress. */
const LAST_COMMIT_BEFORE_END_MS = 30_000
/** Wall-clock between live generator ticks, when a fixture is driving the UI. */
export const FIXTURE_TICK_MS = 1_000

export type FixtureId = 'live' | 'fleet20' | 'pathology'

export type Behaviour =
  | 'steady'
  | 'looping'
  | 'frozen'
  | 'waiting'
  | 'expensive'
  | 'off-fence'
  | 'done'
  // Issue #226 — the known workmux worker-death shape: committed everything,
  // then the pane died. Ends in silence past FROZEN's own threshold, same as
  // 'frozen', but leaves a CLEAN worktree behind rather than one still dirty
  // with unresolved work — the fact that tells the two apart.
  | 'terminal-done'

export interface LaneSpec {
  name: string
  behaviour: Behaviour
  /** Relative share of the fleet's burn. The outlier test reads this directly. */
  weight: number
  /** Fraction of requests that belong to a subagent thread (ruling 20). */
  subagentShare: number
  /** The fence this lane was dispatched with — repo-relative globs. */
  fence: string[]
  /** Files it commits and dirties. An off-fence lane lists a neighbour's. */
  touches: string[]
  /**
   * Issue #226 — files the lane's worktree dirties but never commits: the
   * `package-lock.json` shape, churned by every `npm install` in every
   * worktree, never staged, always outside whatever fence it sits in. Never
   * fed to `commit.landed`, so `BranchTouch.committed` stays false for these —
   * off-fence detection (which reads the committed diff only) must stay quiet
   * about them regardless of what fence they fall outside of.
   */
  dirtyOnly?: string[]
}

export interface FixtureSpec {
  id: FixtureId | 'finished'
  label: string
  /** Shown in the provenance bar — a fixture must never pass as live data. */
  provenance: string
  lanes: LaneSpec[]
}

// ── fixture 2: twenty lanes, nothing wrong ──────────────────────────────────

const AREAS = [
  'packages/core/src/selectors',
  'packages/core/src/events',
  'packages/server/src/collectors/git',
  'packages/server/src/collectors/otel',
  'packages/server/src/api',
  'packages/web/src/panels/ledger',
  'packages/web/src/panels/feed',
  'packages/web/src/scene',
  'packages/web/src/app',
  'docs',
]

const FLEET20_NAMES = [
  '101-thread-rollup',
  '102-cost-authority',
  '103-fence-manifest',
  '104-pulse-budget',
  '105-glance-test',
  '106-ladder-hues',
  '107-tabular-numerals',
  '108-drawer-activity',
  '109-attach-command',
  '110-replay-frame',
  '111-collector-bar',
  '112-feed-filters',
  '113-sigil-marks',
  '114-node-glyphs',
  '115-reduced-motion',
  '116-favicon-badge',
  '117-focus-mode',
  '118-collapse-prefs',
  '119-si-formatter',
  '120-evidence-lines',
]

/**
 * Every event log this file can generate is a pure function of a spec plus a
 * `(now, seed)` pair, so nothing here needs to be rebuilt per test: the specs
 * below are memoised singletons and {@link fixtureHistory} caches the events
 * it folds from them. Freezing what's returned is what makes the memo safe —
 * a fixture one test mutated would be a new class of flake for every test
 * that shares its cache entry after it.
 */
function freezeSpec(spec: FixtureSpec): FixtureSpec {
  for (const lane of spec.lanes) {
    Object.freeze(lane.fence)
    Object.freeze(lane.touches)
    if (lane.dirtyOnly !== undefined) Object.freeze(lane.dirtyOnly)
    Object.freeze(lane)
  }
  Object.freeze(spec.lanes)
  return Object.freeze(spec)
}

/**
 * Ruling 22's scale test: twenty lanes, every one of them threaded, all
 * healthy. The weight spread (0.7–1.6) is wide enough that thread thickness is
 * worth reading and tight enough that no lane reaches three times the fleet
 * median — so ALL CLEAR here is a finding, not a fixture's assertion.
 */
let fleet20Singleton: FixtureSpec | null = null

export function fleet20Spec(): FixtureSpec {
  fleet20Singleton ??= freezeSpec({
    id: 'fleet20',
    label: '20-LANE',
    provenance: 'synthetic · 20 lanes · real schema events',
    lanes: FLEET20_NAMES.map((name, i) => {
      // Each lane gets its own sub-area, so twenty lanes share ten directories
      // without any two of them ever touching the same file.
      const area = `${AREAS[i % AREAS.length] as string}/${issueOf(name)}`
      return {
        name,
        behaviour: 'steady' as Behaviour,
        weight: 0.7 + ((i * 7) % 10) / 10,
        subagentShare: i % 3 === 0 ? 0.34 : i % 4 === 0 ? 0.18 : 0,
        fence: [`${area}/**`],
        touches: [`${area}/${slugOf(name)}.ts`],
      }
    }),
  })
  return fleet20Singleton
}

// ── fixture 3: one lane per pathology ───────────────────────────────────────

/**
 * One lane per pathology, with healthy neighbours to be diagnosed against —
 * EXPENSIVE is relative, so a fleet of one sick lane could not produce it.
 *
 * Deliberately collision-free: the ladder here should be exactly the five
 * faults, so a reader pointing at them (the ruling 25 demo test) is not also
 * being asked to explain a contended file. The ladder floor gets its own,
 * sharper test instead.
 */
/** Shared by {@link pathologySpec} and {@link offFenceHonestySpec} — both are one-lane-per-fact fixtures. */
function pathologyLane(
  name: string,
  behaviour: Behaviour,
  area: string,
  overrides: Partial<LaneSpec> = {},
): LaneSpec {
  return {
    name,
    behaviour,
    weight: 1,
    subagentShare: 0,
    fence: [`${area}/**`],
    touches: [`${area}/${slugOf(name)}.ts`],
    ...overrides,
  }
}

let pathologySingleton: FixtureSpec | null = null

export function pathologySpec(): FixtureSpec {
  if (pathologySingleton !== null) return pathologySingleton

  const lane = pathologyLane

  pathologySingleton = freezeSpec({
    id: 'pathology',
    label: 'PATHOLOGY',
    provenance: 'synthetic · one lane per pathology · real schema events',
    lanes: [
      lane('41-retry-parser', 'looping', 'packages/server/src/collectors/git', {
        weight: 0.9,
        subagentShare: 0.2,
      }),
      lane('42-otel-receiver', 'frozen', 'packages/server/src/collectors/otel', { weight: 1 }),
      lane('43-drawer-attach', 'waiting', 'packages/web/src/panels/drawer', { weight: 0.8 }),
      // Six times the base rate: comfortably past 3× the fleet median, so the
      // finding is about the lane and not about where the median happened to
      // land on the day.
      lane('44-scene-pulses', 'expensive', 'packages/web/src/scene', {
        weight: 6,
        subagentShare: 0.42,
      }),
      lane('45-ledger-subrows', 'off-fence', 'packages/web/src/panels/ledger', {
        weight: 1.2,
        // Its fence is the ledger panel; its hands are in core's selectors —
        // and those files are 46's, which is what gives the trespass a victim.
        touches: [
          'packages/web/src/panels/ledger/index.tsx',
          'packages/core/src/selectors/spend-subrows.ts',
        ],
      }),
      lane('46-spend-selectors', 'steady', 'packages/core/src/selectors', {
        weight: 1.4,
        subagentShare: 0.25,
      }),
      lane('47-format-module', 'steady', 'packages/web/src/lib', { weight: 1.1 }),
      lane('48-doctor-report', 'steady', 'packages/server/src/cli', { weight: 1.6 }),
      lane('49-stream-route', 'steady', 'packages/server/src/api', {
        weight: 1,
        subagentShare: 0.3,
      }),
    ],
  })
  return pathologySingleton
}

// ── fixture 4: off-fence honesty regressions (issue #226) ──────────────────

/**
 * Two lanes, kept out of {@link pathologySpec} on purpose: that fixture's lane
 * count is pinned by tests all over this package (`StreamContext`,
 * `FleetContext`, the scene, its geometry, its marks), so growing it here
 * would make every one of those a casualty of a change that has nothing to do
 * with them. This fixture is `pathologySpec`'s own shape — one lane per fact
 * being pinned, healthy neighbours are unnecessary because neither fact here
 * is EXPENSIVE's relative kind — reserved for the two false readings issue
 * #226 reported.
 */
let offFenceHonestySingleton: FixtureSpec | null = null

export function offFenceHonestySpec(): FixtureSpec {
  offFenceHonestySingleton ??= freezeSpec({
    id: 'pathology',
    label: 'OFF-FENCE HONESTY',
    provenance: 'synthetic · off-fence honesty regressions (issue #226) · real schema events',
    lanes: [
      // Defect 1 (signal): this lane's worktree has npm-install churn sitting
      // in package-lock.json — outside every lane's fence, never committed.
      // It must read as calm; if it shows OFF-FENCE, the diagnosis is reading
      // the dirty set instead of the committed diff `scripts/gate.sh` gates on.
      pathologyLane('60-lockfile-churn', 'steady', 'packages/web/src/panels/attention', {
        weight: 1,
        dirtyOnly: ['package-lock.json'],
      }),
      // Defect 3: committed all its work, worktree left clean, then silence
      // past FROZEN's own threshold — the workmux worker-death shape (a pane
      // dying right after its last commit lands). Must read TERMINAL-DONE,
      // never FROZEN: the git geography it left behind is a finish, not a
      // flatline.
      pathologyLane('61-pane-died-clean', 'terminal-done', 'packages/server/src/cli/lanes', {
        weight: 1,
      }),
    ],
  })
  return offFenceHonestySingleton
}

/**
 * A fleet that has *finished*: every lane silent for far longer than the frozen
 * threshold, every one of them declared `done` by workmux. The instrument must
 * read this as seventeen finished lanes and ALL CLEAR — the single loudest way
 * it could cry wolf is to report a successful night as a wall of flatlines.
 */
let finishedSingleton: FixtureSpec | null = null

export function finishedSpec(): FixtureSpec {
  finishedSingleton ??= freezeSpec({
    id: 'finished',
    label: 'FINISHED',
    provenance: 'synthetic · a fleet that has landed · real schema events',
    lanes: FLEET20_NAMES.slice(0, 17).map((name, i) => {
      const area = `${AREAS[i % AREAS.length] as string}/${issueOf(name)}`
      return {
        name,
        behaviour: 'done' as Behaviour,
        weight: 1,
        subagentShare: 0,
        fence: [`${area}/**`],
        touches: [`${area}/${slugOf(name)}.ts`],
      }
    }),
  })
  return finishedSingleton
}

export function specFor(id: Exclude<FixtureId, 'live'>): FixtureSpec {
  return id === 'fleet20' ? fleet20Spec() : pathologySpec()
}

/**
 * The `.swarm/lanes.json` a fixture was dispatched with. Fixtures declare a
 * manifest because they know what they dispatched; the live stream gets one
 * only when the server actually serves one (#76).
 */
export function manifestFor(spec: FixtureSpec): LaneManifest {
  const manifest: LaneManifest = {}
  for (const lane of spec.lanes) {
    manifest[lane.name] = {
      handle: lane.name,
      fence: lane.fence,
      issue: issueOf(lane.name),
      model: MODEL,
    }
  }
  return manifest
}

// ── the generator ───────────────────────────────────────────────────────────

/** Deterministic PRNG: a fixture must fold to the same fleet twice. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The cycle a stuck lane turns. Three distinct tools: a wheel, not a repeat. */
const LOOP_CYCLE = ['Read', 'Edit', 'Bash'] as const
const TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] as const

interface LaneRuntime {
  spec: LaneSpec
  worktreePath: string
  sessionId: string
  paneId: string
  commits: number
  loopStep: number
}

/**
 * Keyed on the spec's own identity (so it only helps callers sharing one of
 * the frozen singletons above) and on `seed:now` beneath that, since those two
 * numbers are the whole of what a history additionally depends on.
 */
const historyCache = new WeakMap<FixtureSpec, Map<string, readonly RhizomorphEvent[]>>()

function cachedHistory(
  spec: FixtureSpec,
  seed: number,
  now: number,
  compute: () => RhizomorphEvent[],
): RhizomorphEvent[] {
  let bySeedAndNow = historyCache.get(spec)
  if (bySeedAndNow === undefined) {
    bySeedAndNow = new Map()
    historyCache.set(spec, bySeedAndNow)
  }

  const key = `${seed}:${now}`
  const cached = bySeedAndNow.get(key)
  if (cached !== undefined) return cached as RhizomorphEvent[]

  const events = Object.freeze(compute())
  bySeedAndNow.set(key, events)
  return events as RhizomorphEvent[]
}

export class SyntheticFleet {
  private readonly nextId = createIdFactory('fx')
  private readonly random: () => number
  private readonly lanes: LaneRuntime[]
  private readonly seed: number

  constructor(
    private readonly spec: FixtureSpec,
    seed = 0x0b5e2,
  ) {
    this.seed = seed
    this.random = mulberry32(seed)
    this.lanes = spec.lanes.map((laneSpec, i) => ({
      spec: laneSpec,
      worktreePath: `${REPO_PATH}__worktrees/${laneSpec.name}`,
      sessionId: `sess-${laneSpec.name}`,
      paneId: `%${200 + i}`,
      commits: 0,
      loopStep: 0,
    }))
  }

  /**
   * The fleet's past, in event order. Everything is measured back from `now`.
   *
   * Memoised by (spec identity, seed, now): a real 20-lane history is ~8,000
   * validated events, and every consumer that folds the same fixture at the
   * same instant — which is every test that pins `now` — is asking for
   * exactly the same log. `fleet20Spec()`/`pathologySpec()` return frozen
   * singletons for this reason: same spec object in, same cached, frozen
   * array out. Freezing is what makes sharing it safe — a test that mutated
   * its "own" copy would otherwise leak that mutation into every other test
   * reading the same cache entry.
   */
  history(now: number): RhizomorphEvent[] {
    return cachedHistory(this.spec, this.seed, now, () => this.computeHistory(now))
  }

  private computeHistory(now: number): RhizomorphEvent[] {
    const events: RhizomorphEvent[] = []
    const start = now - HISTORY_MS

    events.push(
      this.event('session.started', {
        sessionId: `fx-${this.spec.id}`,
        repoPath: REPO_PATH,
        repoName: REPO_NAME,
        mainBranch: MAIN_BRANCH,
      }, start),
      this.event('worktree.discovered', {
        path: REPO_PATH,
        branch: MAIN_BRANCH,
        head: 'sha-main-000',
        isMain: true,
      }, start),
    )

    for (const lane of this.lanes) {
      events.push(
        this.event('worktree.discovered', {
          path: lane.worktreePath,
          branch: lane.spec.name,
          head: `sha-${lane.spec.name}-000`,
          isMain: false,
        }, start + 500),
        this.event('pane.discovered', {
          paneId: lane.paneId,
          windowName: `wm-${lane.spec.name}`,
          currentPath: lane.worktreePath,
          currentCommand: 'claude',
          worktreePath: lane.worktreePath,
        }, start + 600),
      )
    }

    // The conductor's own burn. Without it the overhead ratio has no numerator,
    // and prd1's whole point is that the orchestrator's spend is not free.
    for (let ts = start; ts <= now - 1_000; ts += 60_000) {
      this.conductorBurn(ts, events)
    }

    for (const lane of this.lanes) {
      const endAt = this.laneEndTs(lane, now)
      // A looping lane's tail must be the cycle and nothing else — interleaved
      // ordinary tool calls would hide the very pattern the detector looks for.
      // Its earlier history is normal work: a lane that was always looping was
      // never working, and that is a different (and less interesting) story.
      const burnUntil = lane.spec.behaviour === 'looping' ? endAt - LOOP_TAIL_MS : endAt

      // Walk backwards from the lane's last moment so the trailing window has
      // an exact, reproducible number of requests in it.
      for (let ts = burnUntil; ts >= start + 1_000; ts -= REQUEST_EVERY_MS) {
        this.laneBurn(lane, ts, events)
      }

      if (lane.spec.behaviour === 'looping') {
        const steps = 18
        for (let i = 0; i < steps; i += 1) {
          events.push(this.loopStep(lane, burnUntil + Math.floor((LOOP_TAIL_MS * i) / steps)))
        }
      } else {
        // Real progress, recently: this is what makes the looping lane's lack of
        // it a *finding* rather than the fixture's assertion.
        this.laneCommit(lane, endAt - LAST_COMMIT_BEFORE_END_MS, events)
      }

      // terminal-done leaves nothing dirty behind — that clean tree, beside the
      // commit just landed, is the whole of the fact the detector reads.
      if (lane.spec.behaviour !== 'terminal-done') {
        events.push(this.laneDirty(lane, endAt - 10_000))
      }
      events.push(this.laneStatus(lane, endAt))
    }

    // main's own history: the commits that already came home.
    for (let i = 0; i < 14; i += 1) {
      const ts = start + Math.floor((HISTORY_MS * i) / 16)
      events.push(
        this.event('commit.landed', {
          sha: `sha-main-${String(i).padStart(3, '0')}`,
          branch: MAIN_BRANCH,
          message: `chore: land ${i}`,
          author: { name: 'conductor', email: 'conductor@rhizomorph' },
          authoredAt: ts,
          files: [{ path: 'docs/roadmap.md', status: 'modified', insertions: 6, deletions: 2 }],
          insertions: 6,
          deletions: 2,
          worktreePath: REPO_PATH,
        }, ts),
      )
    }

    return events.sort((a, b) => a.ts - b.ts)
  }

  /**
   * One instant of live traffic, so a fixture driving the UI has *news* for the
   * scene to move on (the motion law's "a pulse is an event"). Frozen and
   * waiting lanes contribute nothing, which is the whole of their story;
   * a waiting lane's pane keeps beating, because a raised hand is still alive.
   */
  tick(now: number): RhizomorphEvent[] {
    const events: RhizomorphEvent[] = []

    for (const lane of this.lanes) {
      const behaviour = lane.spec.behaviour
      if (behaviour === 'frozen' || behaviour === 'done' || behaviour === 'terminal-done') continue

      if (behaviour === 'waiting') {
        events.push(
          this.event('pane.activity', {
            paneId: lane.paneId,
            contentHash: `hash-${Math.floor(now / 1000)}`,
            lines: 51,
            preview: 'Do you want to proceed? ❯ 1. Yes  2. No',
          }, now),
        )
        continue
      }

      if (behaviour === 'looping') {
        if (this.random() < 0.5) events.push(this.loopStep(lane, now))
        continue
      }

      const chance = (behaviour === 'expensive' ? 0.3 : 0.08) * lane.spec.weight
      if (this.random() > chance) continue
      this.laneBurn(lane, now, events)
      if (this.random() < 0.04) this.laneCommit(lane, now, events)
    }

    if (this.random() < 0.3) this.conductorBurn(now, events)

    return events
  }

  // --- pieces ---------------------------------------------------------------

  /** Where a lane's log stops. Only the stopped behaviours end early. */
  private laneEndTs(lane: LaneRuntime, now: number): number {
    switch (lane.spec.behaviour) {
      case 'frozen':
      case 'terminal-done':
        return now - FROZEN_SILENCE_MS
      case 'waiting':
        return now - WAITING_SILENCE_MS
      case 'done':
        return now - 22 * 60_000
      default:
        return now - 2_000
    }
  }

  /**
   * Pushes directly onto `sink` rather than building and spreading a
   * temporary array — this is the hottest path in the generator (up to
   * ~1,600 calls for a 20-lane history), so the intermediate allocation
   * a return-and-spread would cost here is not incidental.
   */
  private laneBurn(lane: LaneRuntime, ts: number, sink: RhizomorphEvent[]): void {
    const thread: AgentThread =
      lane.spec.subagentShare > 0 && this.random() < lane.spec.subagentShare ? 'subagent' : 'main'
    const output = Math.round(OUTPUT_PER_REQUEST * lane.spec.weight)
    const cacheRead = Math.round(60_000 + this.random() * 80_000)

    sink.push(
      this.event('llm.usage', {
        lane: lane.spec.name,
        role: 'worker',
        model: MODEL,
        tokens: {
          input: Math.round(2 + this.random() * 40),
          output,
          cacheRead,
          cacheCreation: Math.round(900 + this.random() * 2_600),
        },
        requestId: `req-${lane.spec.name}-${ts}`,
        durationMs: Math.round(3_000 + this.random() * 26_000),
        sessionId: lane.sessionId,
        worktreePath: lane.worktreePath,
        branch: lane.spec.name,
        thread,
      }, ts),
      // Dollars come from the authority collector, exactly as in production.
      this.event('llm.cost', {
        lane: lane.spec.name,
        role: 'worker',
        model: MODEL,
        costUsd: Number(((output / 1000) * 0.075 + (cacheRead / 1_000_000) * 1.5).toFixed(6)),
        authoritative: true,
        sessionId: lane.sessionId,
        worktreePath: lane.worktreePath,
        branch: lane.spec.name,
        thread,
      }, ts, 'otel'),
    )

    const toolCalls = 1 + Math.floor(this.random() * 3)
    for (let t = 0; t < toolCalls; t += 1) {
      sink.push(
        this.event('tool.activity', {
          lane: lane.spec.name,
          tool: TOOLS[Math.floor(this.random() * TOOLS.length)] as string,
          role: 'worker',
          durationMs: Math.round(40 + this.random() * 3_000),
          sessionId: lane.sessionId,
          worktreePath: lane.worktreePath,
          branch: lane.spec.name,
          thread,
        }, ts + t * 60),
      )
    }
  }

  /** One turn of a stuck lane's wheel: the repeating cycle the detector reads. */
  private loopStep(lane: LaneRuntime, ts: number): RhizomorphEvent {
    const tool = LOOP_CYCLE[lane.loopStep % LOOP_CYCLE.length] as string
    lane.loopStep += 1
    return this.event('tool.activity', {
      lane: lane.spec.name,
      tool,
      role: 'worker',
      durationMs: 800,
      sessionId: lane.sessionId,
      worktreePath: lane.worktreePath,
      branch: lane.spec.name,
      thread: 'main',
    }, ts)
  }

  private laneCommit(lane: LaneRuntime, ts: number, sink: RhizomorphEvent[]): void {
    lane.commits += 1
    const sha = `sha-${lane.spec.name}-${String(lane.commits).padStart(3, '0')}`
    const files = lane.spec.touches.map((path, i) => ({
      path,
      status: (i === 0 ? 'modified' : 'added') as 'modified' | 'added',
      insertions: 8 + Math.floor(this.random() * 90),
      deletions: Math.floor(this.random() * 20),
    }))

    sink.push(
      this.event('commit.landed', {
        sha,
        branch: lane.spec.name,
        message: `feat(${issueOf(lane.spec.name) ?? lane.spec.name}): step ${lane.commits}`,
        author: { name: lane.spec.name, email: 'agent@rhizomorph' },
        authoredAt: ts,
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        worktreePath: lane.worktreePath,
      }, ts),
      this.event('branch.updated', {
        branch: lane.spec.name,
        head: sha,
        worktreePath: lane.worktreePath,
        aheadOfMain: lane.commits,
        behindMain: 0,
      }, ts + 20),
    )
  }

  /** The uncommitted set — what makes "where is this agent" answerable early. */
  private laneDirty(lane: LaneRuntime, ts: number): RhizomorphEvent {
    const files = [...lane.spec.touches, ...(lane.spec.dirtyOnly ?? [])]
    return this.event('worktree.dirty', {
      path: lane.worktreePath,
      branch: lane.spec.name,
      files: files.map((path) => ({ path, status: 'modified' as const })),
    }, ts)
  }

  /**
   * Only the waiting lane has workmux declaring a stop, and only a finished
   * fleet says `done` — which is what makes the frozen lane's silence a fault
   * rather than a finish.
   */
  private laneStatus(lane: LaneRuntime, ts: number): RhizomorphEvent {
    const status =
      lane.spec.behaviour === 'waiting' ? 'waiting' : lane.spec.behaviour === 'done' ? 'done' : 'working'
    return this.event('agent.status', {
      handle: lane.spec.name,
      status,
      worktreePath: lane.worktreePath,
      branch: lane.spec.name,
    }, ts)
  }

  private conductorBurn(ts: number, sink: RhizomorphEvent[]): void {
    const output = Math.round(200 + this.random() * 700)
    sink.push(
      this.event('llm.usage', {
        lane: 'conductor',
        role: 'conductor',
        model: MODEL,
        tokens: { input: 8, output, cacheRead: 90_000, cacheCreation: 1_600 },
        sessionId: 'sess-conductor',
        worktreePath: REPO_PATH,
        branch: MAIN_BRANCH,
        thread: 'main',
      }, ts),
      this.event('llm.cost', {
        lane: 'conductor',
        role: 'conductor',
        model: MODEL,
        costUsd: Number(((output / 1000) * 0.075).toFixed(6)),
        authoritative: true,
        sessionId: 'sess-conductor',
        worktreePath: REPO_PATH,
        branch: MAIN_BRANCH,
        thread: 'main',
      }, ts, 'otel'),
    )
  }

  /**
   * Every event in this file goes through here, and therefore through core's
   * `createEvent` — a payload the collectors could not produce throws at
   * construction rather than rendering as a plausible lie.
   */
  private event<T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    ts: number,
    source?: SourceOf<T>,
  ): RhizomorphEvent {
    return createEvent(type, payload, {
      id: this.nextId(),
      ts,
      ...(source === undefined ? {} : { source }),
    })
  }
}

/** A fixture's whole past, ready to fold. */
export function fixtureHistory(spec: FixtureSpec, now: number, seed?: number): RhizomorphEvent[] {
  return new SyntheticFleet(spec, seed).history(now)
}

function issueOf(name: string): string | null {
  return /^\d+/.exec(name)?.[0] ?? null
}

function slugOf(name: string): string {
  return name.split('-').slice(1).join('-') || name
}
