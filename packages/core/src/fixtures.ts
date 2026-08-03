import type { Exec, ExecOptions, ExecResult } from './collector.js'
import {
  createEvent,
  createIdFactory,
  type EventEnvelopeInit,
  type EventOf,
  type EventType,
  type RhizomorphEvent,
  type PayloadOf,
} from './events/index.js'

/**
 * Test fixtures, exported from the package so every other package's tests
 * (and the scene, before live data exists) build against the real schemas
 * instead of hand-rolled object literals that drift.
 */

/** 2026-07-30T09:00:00Z — the build day, so fixture timestamps read sensibly. */
export const FIXTURE_START_TS = Date.UTC(2026, 6, 30, 9, 0, 0)

export const FIXTURE_REPO_PATH = '/repo/rhizomorph'

export interface EventFactoryOptions {
  startTs?: number
  /** Milliseconds added to the clock after each event. */
  stepMs?: number
  idPrefix?: string
}

type Init<T extends EventType = EventType> = Partial<EventEnvelopeInit<T>>

/**
 * A deterministic event factory: sequential ids, a clock that ticks per event,
 * and one sugar method per event type taking a partial payload.
 */
export interface EventFactory {
  /** Current clock value, in epoch millis. */
  now(): number
  /** Move the clock to an absolute time. */
  at(ts: number): EventFactory
  /** Move the clock forward. */
  advance(ms: number): EventFactory
  /** Reset clock and id counter. */
  reset(): EventFactory
  /** Every event this factory has produced, in order. */
  all(): RhizomorphEvent[]

  make<T extends EventType>(type: T, payload: PayloadOf<T>, init?: Init<T>): EventOf<T>

  sessionStarted(payload?: Partial<PayloadOf<'session.started'>>, init?: Init<'session.started'>): EventOf<'session.started'>
  collectorError(payload?: Partial<PayloadOf<'collector.error'>>, init?: Init<'collector.error'>): EventOf<'collector.error'>
  collectorDisabled(payload?: Partial<PayloadOf<'collector.disabled'>>, init?: Init<'collector.disabled'>): EventOf<'collector.disabled'>
  collectorDegraded(payload?: Partial<PayloadOf<'collector.degraded'>>, init?: Init<'collector.degraded'>): EventOf<'collector.degraded'>
  collectorRecovered(payload?: Partial<PayloadOf<'collector.recovered'>>, init?: Init<'collector.recovered'>): EventOf<'collector.recovered'>
  worktreeDiscovered(payload?: Partial<PayloadOf<'worktree.discovered'>>, init?: Init<'worktree.discovered'>): EventOf<'worktree.discovered'>
  worktreeRemoved(payload?: Partial<PayloadOf<'worktree.removed'>>, init?: Init<'worktree.removed'>): EventOf<'worktree.removed'>
  worktreeDirty(payload?: Partial<PayloadOf<'worktree.dirty'>>, init?: Init<'worktree.dirty'>): EventOf<'worktree.dirty'>
  branchUpdated(payload?: Partial<PayloadOf<'branch.updated'>>, init?: Init<'branch.updated'>): EventOf<'branch.updated'>
  branchRemoved(payload?: Partial<PayloadOf<'branch.removed'>>, init?: Init<'branch.removed'>): EventOf<'branch.removed'>
  commitLanded(payload?: Partial<PayloadOf<'commit.landed'>>, init?: Init<'commit.landed'>): EventOf<'commit.landed'>
  paneDiscovered(payload?: Partial<PayloadOf<'pane.discovered'>>, init?: Init<'pane.discovered'>): EventOf<'pane.discovered'>
  paneClosed(payload?: Partial<PayloadOf<'pane.closed'>>, init?: Init<'pane.closed'>): EventOf<'pane.closed'>
  paneActivity(payload?: Partial<PayloadOf<'pane.activity'>>, init?: Init<'pane.activity'>): EventOf<'pane.activity'>
  agentStatus(payload?: Partial<PayloadOf<'agent.status'>>, init?: Init<'agent.status'>): EventOf<'agent.status'>

  /**
   * prd1 telemetry. `source` defaults to each type's primary collector, so pass
   * `{ source: 'otel' }` to fake the authority side of a cross-validation.
   */
  llmUsage(payload?: Partial<PayloadOf<'llm.usage'>>, init?: Init<'llm.usage'>): EventOf<'llm.usage'>
  llmCost(payload?: Partial<PayloadOf<'llm.cost'>>, init?: Init<'llm.cost'>): EventOf<'llm.cost'>
  toolActivity(payload?: Partial<PayloadOf<'tool.activity'>>, init?: Init<'tool.activity'>): EventOf<'tool.activity'>

  /**
   * prd9 traces. The default is one `llm_request` span of the shape the
   * 2026-08-03 capture showed; {@link fixtureTraceSpans} builds a whole tree.
   */
  traceSpan(payload?: Partial<PayloadOf<'trace.span'>>, init?: Init<'trace.span'>): EventOf<'trace.span'>
}

const defaults = {
  'session.started': {
    sessionId: 'session-fixture',
    repoPath: FIXTURE_REPO_PATH,
    repoName: 'rhizomorph',
    mainBranch: 'main',
  },
  'collector.error': { collector: 'git', message: 'git worktree list exited 128' },
  'collector.disabled': { collector: 'workmux', reason: 'workmux not found on PATH' },
  'collector.degraded': {
    collector: 'tmux',
    reason: 'tmux exited with code 1',
    consecutiveFailures: 1,
  },
  'collector.recovered': { collector: 'tmux', consecutiveFailures: 2 },
  'worktree.discovered': {
    path: FIXTURE_REPO_PATH,
    branch: 'main',
    head: 'sha-main-0',
    isMain: true,
  },
  'worktree.removed': { path: `${FIXTURE_REPO_PATH}-wt/feature` },
  'worktree.dirty': {
    path: `${FIXTURE_REPO_PATH}-wt/feature`,
    branch: 'feature',
    files: [{ path: 'src/a.ts', status: 'modified' }],
  },
  'branch.updated': { branch: 'feature', head: 'sha-feature-1' },
  'branch.removed': { branch: 'feature' },
  'commit.landed': {
    sha: 'sha-feature-1',
    branch: 'feature',
    message: 'feat: something',
    author: { name: 'Agent', email: 'agent@example.com' },
    files: [{ path: 'src/a.ts', status: 'modified', insertions: 4, deletions: 1 }],
    insertions: 4,
    deletions: 1,
  },
  'pane.discovered': {
    paneId: '%1',
    windowName: 'feature',
    currentPath: `${FIXTURE_REPO_PATH}-wt/feature`,
    currentCommand: 'node',
    worktreePath: `${FIXTURE_REPO_PATH}-wt/feature`,
  },
  'pane.closed': { paneId: '%1' },
  'pane.activity': { paneId: '%1', contentHash: 'hash-1' },
  'agent.status': { handle: 'feature', status: 'working' },
  // Token proportions are the real ones from the build day's keystone lane
  // (research §S2): cache reads dwarf everything, output is the next biggest.
  'llm.usage': {
    lane: 'feature',
    role: 'worker',
    model: 'claude-opus-5',
    tokens: { input: 2, output: 1_700, cacheRead: 99_700, cacheCreation: 1_900 },
    requestId: 'req_fixture_1',
    durationMs: 9_400,
    sessionId: 'sess-feature',
    worktreePath: `${FIXTURE_REPO_PATH}-wt/feature`,
    branch: 'feature',
  },
  // 0.0588372 is the literal cost_usd the OTel spike captured (research §S1).
  'llm.cost': {
    lane: 'feature',
    role: 'worker',
    model: 'claude-opus-5',
    costUsd: 0.0588372,
    authoritative: true,
    sessionId: 'sess-feature',
    worktreePath: `${FIXTURE_REPO_PATH}-wt/feature`,
    branch: 'feature',
  },
  'tool.activity': {
    lane: 'feature',
    tool: 'Bash',
    role: 'worker',
    sessionId: 'sess-feature',
    worktreePath: `${FIXTURE_REPO_PATH}-wt/feature`,
    branch: 'feature',
  },
  'telemetry.refused': {
    instance: 'other-rhizomorph',
    expectedInstance: 'fixture-instance',
    count: 1,
  },
  // prd9: one `llm_request` span, shaped like the 2026-08-03 capture (§1) —
  // raw beta name, derived kind, tokens present but annotation-only.
  'trace.span': {
    lane: 'feature',
    role: 'worker',
    traceId: 'trace-fixture-1',
    spanId: 'span-fixture-1',
    parentSpanId: null,
    name: 'claude_code.llm_request',
    kind: 'llm_request',
    startTs: FIXTURE_START_TS,
    endTs: FIXTURE_START_TS + 9_400,
    status: 'ok',
    model: 'claude-opus-5',
    tokens: { input: 2, output: 1_700, cacheRead: 99_700, cacheCreation: 1_900 },
    ttftMs: 1_200,
    requestId: 'req_fixture_1',
    sessionId: 'sess-feature',
    worktreePath: `${FIXTURE_REPO_PATH}-wt/feature`,
    branch: 'feature',
  },
} as const satisfies { [T in EventType]: PayloadOf<T> }

export function createEventFactory(options: EventFactoryOptions = {}): EventFactory {
  const startTs = options.startTs ?? FIXTURE_START_TS
  const stepMs = options.stepMs ?? 1000
  const idPrefix = options.idPrefix ?? 'evt'

  let clock = startTs
  let nextId = createIdFactory(idPrefix)
  const produced: RhizomorphEvent[] = []

  const make = <T extends EventType>(type: T, payload: PayloadOf<T>, init: Init<T> = {}) => {
    const ts = init.ts ?? clock
    const event = createEvent(type, payload, {
      id: init.id ?? nextId(),
      ts,
      ...(init.source === undefined ? {} : { source: init.source }),
    })
    if (init.ts === undefined) clock += stepMs
    produced.push(event)
    return event
  }

  const sugar =
    <T extends EventType>(type: T) =>
    (payload: Partial<PayloadOf<T>> = {}, init: Init<T> = {}) =>
      // The spread of a generic partial widens, and `PayloadOf<T>` for an
      // unresolved `T` narrows to the intersection of every payload — which is
      // uninhabited now that `agent.status` and `trace.span` both have a
      // `status` field of their own enum. Hence the double cast; each caller's
      // own signature above is still exact, and the schema still validates.
      make(type, { ...defaults[type], ...payload } as unknown as PayloadOf<T>, init)

  const factory: EventFactory = {
    now: () => clock,
    at(ts) {
      clock = ts
      return factory
    },
    advance(ms) {
      clock += ms
      return factory
    },
    reset() {
      clock = startTs
      nextId = createIdFactory(idPrefix)
      produced.length = 0
      return factory
    },
    all: () => [...produced],
    make,
    sessionStarted: sugar('session.started'),
    collectorError: sugar('collector.error'),
    collectorDisabled: sugar('collector.disabled'),
    collectorDegraded: sugar('collector.degraded'),
    collectorRecovered: sugar('collector.recovered'),
    worktreeDiscovered: sugar('worktree.discovered'),
    worktreeRemoved: sugar('worktree.removed'),
    worktreeDirty: sugar('worktree.dirty'),
    branchUpdated: sugar('branch.updated'),
    branchRemoved: sugar('branch.removed'),
    commitLanded: sugar('commit.landed'),
    paneDiscovered: sugar('pane.discovered'),
    paneClosed: sugar('pane.closed'),
    paneActivity: sugar('pane.activity'),
    agentStatus: sugar('agent.status'),
    llmUsage: sugar('llm.usage'),
    llmCost: sugar('llm.cost'),
    toolActivity: sugar('tool.activity'),
    traceSpan: sugar('trace.span'),
  }

  return factory
}

/**
 * Shared default factory, for one-off events in a test that does not care
 * about ids or ordering. Call `fx.reset()` in a `beforeEach` if it does.
 */
export const fx: EventFactory = createEventFactory()

/** Build a single validated event with sensible envelope defaults. */
export function makeEvent<T extends EventType>(
  type: T,
  payload: PayloadOf<T>,
  init: Init<T> = {},
): EventOf<T> {
  return createEvent(type, payload, {
    id: init.id ?? `evt-${type}-${init.ts ?? FIXTURE_START_TS}`,
    ts: init.ts ?? FIXTURE_START_TS,
    ...(init.source === undefined ? {} : { source: init.source }),
  })
}

export interface StubExecRoute {
  /** Substring of `command arg arg…`, or a predicate for anything fussier. */
  match: string | ((command: string, args: readonly string[]) => boolean)
  /** Defaults to a clean exit with empty output. */
  result?: Partial<ExecResult>
}

export interface StubExecCall {
  command: string
  args: readonly string[]
  options: ExecOptions | undefined
}

export interface StubExec {
  (command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>
  /** Every invocation, in order, for asserting what a collector actually ran. */
  calls: StubExecCall[]
}

/**
 * An {@link Exec} backed by canned command output, so collector tests run with
 * no git, tmux or workmux installed. An unmatched command comes back the way a
 * missing binary does — which every collector has to survive anyway.
 */
export function createStubExec(routes: readonly StubExecRoute[] = []): StubExec {
  const calls: StubExecCall[] = []

  const exec = async (command: string, args: readonly string[], options?: ExecOptions) => {
    calls.push({ command, args, options })
    const line = [command, ...args].join(' ')
    const route = routes.find((candidate) =>
      typeof candidate.match === 'string'
        ? line.includes(candidate.match)
        : candidate.match(command, args),
    )

    if (route === undefined) {
      return {
        stdout: '',
        stderr: '',
        code: 127,
        failed: true,
        errorMessage: `no stub for: ${line}`,
      }
    }

    const { result = {} } = route
    const code = result.code === undefined ? 0 : result.code
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code,
      failed: result.failed ?? (code !== 0),
      ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
    }
  }

  const stub = exec as StubExec
  stub.calls = calls
  return stub
}

/** Compile-time assurance that {@link StubExec} really is an {@link Exec}. */
export const _stubExecIsAnExec: Exec = createStubExec()

const WT = (name: string) => `${FIXTURE_REPO_PATH}-wt/${name}`

/** `now` to pass to liveness selectors when folding {@link fixtureSession}. */
export const FIXTURE_NOW = FIXTURE_START_TS + 10 * 60_000

/**
 * A believable slice of a swarm: four worktrees, three agent panes, commits
 * landing, two file collisions (one dirty-vs-dirty, one dirty-vs-commit), and
 * one pane that went quiet nine minutes ago. Enough for a panel or the scene
 * to look alive before any real data exists.
 */
export function fixtureSession(): RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 1000 })
  const minute = 60_000

  f.sessionStarted()
  f.worktreeDiscovered({ path: FIXTURE_REPO_PATH, branch: 'main', head: 'sha-main-0', isMain: true })
  f.worktreeDiscovered({ path: WT('2-core'), branch: '2-core', head: 'sha-main-0', isMain: false })
  f.worktreeDiscovered({ path: WT('3-git'), branch: '3-git', head: 'sha-main-0', isMain: false })
  f.worktreeDiscovered({ path: WT('7-web'), branch: '7-web', head: 'sha-main-0', isMain: false })

  f.paneDiscovered({
    paneId: '%1',
    windowName: '2-core',
    currentPath: WT('2-core'),
    worktreePath: WT('2-core'),
  })
  f.paneDiscovered({
    paneId: '%2',
    windowName: '3-git',
    currentPath: WT('3-git'),
    worktreePath: WT('3-git'),
  })
  f.paneDiscovered({
    paneId: '%3',
    windowName: '7-web',
    currentPath: WT('7-web'),
    worktreePath: WT('7-web'),
  })

  f.agentStatus({ handle: '2-core', status: 'working', worktreePath: WT('2-core'), branch: '2-core' })
  f.agentStatus({ handle: '3-git', status: 'working', worktreePath: WT('3-git'), branch: '3-git' })
  f.agentStatus({ handle: '7-web', status: 'working', worktreePath: WT('7-web'), branch: '7-web' })

  // t+1m — everyone is alive.
  f.at(FIXTURE_START_TS + minute)
  f.paneActivity({ paneId: '%1', contentHash: 'h1-a', previousHash: 'h1-0' })
  f.paneActivity({ paneId: '%2', contentHash: 'h2-a', previousHash: 'h2-0' })
  f.paneActivity({ paneId: '%3', contentHash: 'h3-a', previousHash: 'h3-0', preview: 'running tests' })

  // t+2m — first commit lands on 2-core.
  f.at(FIXTURE_START_TS + 2 * minute)
  f.commitLanded({
    sha: 'sha-core-1',
    branch: '2-core',
    message: 'feat(core): event schemas',
    author: { name: 'core agent', email: 'core@example.com' },
    files: [
      { path: 'packages/core/src/events/index.ts', status: 'added', insertions: 120, deletions: 0 },
      { path: 'docs/architecture.md', status: 'modified', insertions: 3, deletions: 1 },
    ],
    insertions: 123,
    deletions: 1,
  })
  f.branchUpdated({ branch: '2-core', head: 'sha-core-1', previousHead: 'sha-main-0', aheadOfMain: 1 })
  f.paneActivity({ paneId: '%1', contentHash: 'h1-b', previousHash: 'h1-a' })

  // t+3m — dirty sets appear. 3-git and 7-web are both editing core's barrel
  // file, and 3-git is editing the doc 2-core already committed.
  f.at(FIXTURE_START_TS + 3 * minute)
  f.worktreeDirty({
    path: WT('3-git'),
    branch: '3-git',
    files: [
      { path: 'packages/server/src/collectors/git/parse.ts', status: 'added' },
      { path: 'packages/core/src/index.ts', status: 'modified' },
      { path: 'docs/architecture.md', status: 'modified' },
    ],
  })
  f.worktreeDirty({
    path: WT('7-web'),
    branch: '7-web',
    files: [
      { path: 'packages/web/src/app/Shell.tsx', status: 'added' },
      { path: 'packages/core/src/index.ts', status: 'modified' },
    ],
  })
  f.paneActivity({ paneId: '%2', contentHash: 'h2-b', previousHash: 'h2-a' })

  // t+4m — second commit on 2-core; the tmux collector hiccups once.
  f.at(FIXTURE_START_TS + 4 * minute)
  f.commitLanded({
    sha: 'sha-core-2',
    branch: '2-core',
    message: 'feat(core): reducer + selectors',
    author: { name: 'core agent', email: 'core@example.com' },
    files: [
      { path: 'packages/core/src/reduce.ts', status: 'added', insertions: 210, deletions: 0 },
      { path: 'packages/core/src/index.ts', status: 'modified', insertions: 6, deletions: 1 },
    ],
    insertions: 216,
    deletions: 1,
  })
  f.branchUpdated({ branch: '2-core', head: 'sha-core-2', previousHead: 'sha-core-1', aheadOfMain: 2 })
  f.collectorError({ collector: 'tmux', message: 'capture-pane timed out', detail: 'pane %3' })

  // t+5m — 3-git commits; %3 has now been silent since t+1m.
  f.at(FIXTURE_START_TS + 5 * minute)
  f.commitLanded({
    sha: 'sha-git-1',
    branch: '3-git',
    message: 'feat(server): git worktree parser',
    author: { name: 'git agent', email: 'git@example.com' },
    files: [
      {
        path: 'packages/server/src/collectors/git/parse.ts',
        status: 'added',
        insertions: 88,
        deletions: 0,
      },
    ],
    insertions: 88,
    deletions: 0,
  })
  f.branchUpdated({ branch: '3-git', head: 'sha-git-1', previousHead: 'sha-main-0', aheadOfMain: 1 })
  f.paneActivity({ paneId: '%1', contentHash: 'h1-c', previousHash: 'h1-b' })
  f.paneActivity({ paneId: '%2', contentHash: 'h2-c', previousHash: 'h2-b' })
  f.agentStatus({ handle: '3-git', status: 'waiting', worktreePath: WT('3-git'), branch: '3-git' })

  return f.all()
}

export interface TraceFixtureOptions {
  lane?: string
  /** Defaults to `sess-<lane>`, the same join key the telemetry fixtures use. */
  sessionId?: string
  traceId?: string
  /** When the root interaction began. Everything else is offset from it. */
  startTs?: number
  idPrefix?: string
}

/**
 * One interaction's span tree, exactly the shape the 2026-08-03 capture found
 * (research §1): `claude_code.interaction` at the root, an `llm_request` and a
 * `tool` under it, and the tool's own `blocked_on_user` + `execution` pair
 * below that.
 *
 * Two properties are deliberate, because they are the ones a consumer will get
 * wrong otherwise:
 *
 * - **Arrival order is not tree order.** Spans export when they END ([Ran]), so
 *   the leaves arrive first and the root arrives last. Each event's envelope
 *   `ts` is its span's `endTs` plus one export interval, which is what the
 *   capture measured.
 * - **Only the `llm_request` carries tokens**, and they are annotation: prd9
 *   ruling 4 keeps every one of these spans out of spend.
 *
 * Call it twice with different `traceId`s for a multi-trace session, or with
 * the same one to fake an exporter re-delivery.
 */
export function fixtureTraceSpans(options: TraceFixtureOptions = {}): EventOf<'trace.span'>[] {
  const lane = options.lane ?? '2-core'
  const sessionId = options.sessionId ?? `sess-${lane}`
  const traceId = options.traceId ?? `trace-${lane}-1`
  const t0 = options.startTs ?? FIXTURE_START_TS
  const f = createEventFactory({ idPrefix: options.idPrefix ?? `span-${lane}` })

  /** One export interval, per the capture's `OTEL_TRACES_EXPORT_INTERVAL=1000`. */
  const interval = 1_000
  const place = { lane, sessionId, worktreePath: WT(lane), branch: lane, role: 'worker' } as const
  // `make`, not the `traceSpan` sugar: the sugar's default payload is a whole
  // `llm_request`, and a `tool` span that inherited its tokens would be exactly
  // the double-count prd9 ruling 4 exists to prevent.
  const span = (
    payload: Omit<PayloadOf<'trace.span'>, 'lane' | 'role' | 'sessionId' | 'worktreePath' | 'branch' | 'traceId'>,
  ) => f.make('trace.span', { ...place, traceId, ...payload }, { ts: payload.endTs + interval })

  const root = `${traceId}-interaction`
  const tool = `${traceId}-tool`

  // Leaves first: each one is exported as it ends, and the root is last because
  // it is still open until the whole interaction is done.
  const llm = span({
    spanId: `${traceId}-llm`,
    parentSpanId: root,
    name: 'claude_code.llm_request',
    kind: 'llm_request',
    startTs: t0 + 200,
    endTs: t0 + 9_600,
    status: 'ok',
    model: 'claude-opus-5',
    tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400 },
    ttftMs: 1_400,
    requestId: `req-${lane}-1`,
  })
  const blocked = span({
    spanId: `${traceId}-blocked`,
    parentSpanId: tool,
    name: 'claude_code.tool.blocked_on_user',
    kind: 'tool_blocked',
    startTs: t0 + 9_700,
    endTs: t0 + 9_702,
    status: 'ok',
    // `unknown` is what a pre-allowed tool actually reports — nobody was asked.
    decision: 'unknown',
    toolName: 'Bash',
  })
  const execution = span({
    spanId: `${traceId}-execution`,
    parentSpanId: tool,
    name: 'claude_code.tool.execution',
    kind: 'tool_execution',
    startTs: t0 + 9_702,
    endTs: t0 + 13_900,
    status: 'ok',
    toolName: 'Bash',
  })
  const toolSpan = span({
    spanId: tool,
    parentSpanId: root,
    name: 'claude_code.tool',
    kind: 'tool',
    startTs: t0 + 9_650,
    endTs: t0 + 13_950,
    status: 'ok',
    toolName: 'Bash',
    toolUseId: `toolu_${lane}_1`,
  })
  const interaction = span({
    spanId: root,
    parentSpanId: null,
    name: 'claude_code.interaction',
    kind: 'interaction',
    startTs: t0,
    endTs: t0 + 14_100,
    status: 'ok',
  })

  return [llm, blocked, execution, toolSpan, interaction]
}

/**
 * prd1's money layer, on top of {@link fixtureSession}. Deliberately a separate
 * log rather than more events in `fixtureSession()`: every v0 panel test folds
 * that one and must keep reading exactly what it read before.
 *
 * What it says, so a test can assert against prose:
 *
 * - three worker lanes (`2-core`, `3-git`, `7-web`) plus a `conductor` lane and
 *   an `auxiliary` haiku call riding inside `2-core`'s session — the shape the
 *   OTel capture actually showed;
 * - tokens from `sessionlog` (all four cache tiers), dollars from `otel`
 *   (`authoritative: true`) — the two collectors doing their own jobs;
 * - one estimated cost, flagged as such, so the UI has something to caveat;
 * - a conductor that outspends any single worker, which is the whole point of
 *   the overhead ratio.
 */
export function fixtureTelemetrySession(): RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 1000, idPrefix: 'tel' })
  const minute = 60_000
  const otel = { source: 'otel' } as const

  const usage = (
    lane: string,
    role: 'worker' | 'conductor' | 'auxiliary',
    model: string,
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number },
    extra: { ts?: number } = {},
  ) =>
    f.llmUsage(
      {
        lane,
        role,
        model,
        tokens,
        sessionId: `sess-${lane}`,
        worktreePath: role === 'conductor' ? null : WT(lane),
        branch: role === 'conductor' ? null : lane,
        requestId: `req-${lane}-${tokens.output}`,
        durationMs: 8_000,
      },
      extra.ts === undefined ? {} : { ts: extra.ts },
    )

  const cost = (lane: string, role: 'worker' | 'conductor' | 'auxiliary', model: string, costUsd: number) =>
    f.llmCost(
      {
        lane,
        role,
        model,
        costUsd,
        authoritative: true,
        sessionId: `sess-${lane}`,
        worktreePath: role === 'conductor' ? null : WT(lane),
        branch: role === 'conductor' ? null : lane,
      },
      otel,
    )

  // t+1m — the swarm starts spending. Workers on opus, conductor on sonnet.
  f.at(FIXTURE_START_TS + minute)
  usage('2-core', 'worker', 'claude-opus-5', {
    input: 4,
    output: 3_100,
    cacheRead: 180_000,
    cacheCreation: 6_400,
  })
  cost('2-core', 'worker', 'claude-opus-5', 0.42)
  usage('3-git', 'worker', 'claude-opus-5', {
    input: 3,
    output: 1_900,
    cacheRead: 120_000,
    cacheCreation: 4_100,
  })
  cost('3-git', 'worker', 'claude-opus-5', 0.28)
  usage('conductor', 'conductor', 'claude-sonnet-5', {
    input: 12,
    output: 5_600,
    cacheRead: 410_000,
    cacheCreation: 9_800,
  })
  cost('conductor', 'conductor', 'claude-sonnet-5', 0.9)

  f.toolActivity({ lane: '2-core', tool: 'Write', role: 'worker', sessionId: 'sess-2-core', worktreePath: WT('2-core'), branch: '2-core' })
  f.toolActivity({ lane: '2-core', tool: 'Bash', role: 'worker', sessionId: 'sess-2-core', worktreePath: WT('2-core'), branch: '2-core' })
  f.toolActivity({ lane: '3-git', tool: 'Bash', role: 'worker', sessionId: 'sess-3-git', worktreePath: WT('3-git'), branch: '3-git' })

  // t+3m — the CLI's own auxiliary haiku call, inside 2-core's session.
  f.at(FIXTURE_START_TS + 3 * minute)
  usage('2-core', 'auxiliary', 'claude-haiku-4-5-20251001', {
    input: 310,
    output: 40,
    cacheRead: 0,
    cacheCreation: 0,
  })
  cost('2-core', 'auxiliary', 'claude-haiku-4-5-20251001', 0.000591)

  // t+5m — 7-web joins, with tokens but no authoritative dollars: telemetry env
  // vars were never set on that lane, so its cost is an explicit estimate.
  f.at(FIXTURE_START_TS + 5 * minute)
  usage('7-web', 'worker', 'claude-opus-5', {
    input: 2,
    output: 2_400,
    cacheRead: 96_000,
    cacheCreation: 3_300,
  })
  f.llmCost(
    {
      lane: '7-web',
      role: 'worker',
      model: 'claude-opus-5',
      costUsd: 0.31,
      authoritative: false,
      estimateSource: 'pricing-table@litellm',
      worktreePath: WT('7-web'),
      branch: '7-web',
    },
    // An estimate is derived from the tokens, so it belongs to the depth
    // collector; otel is the only thing allowed to claim authority.
    { source: 'sessionlog' },
  )
  f.toolActivity({ lane: '7-web', tool: 'Edit', role: 'worker', worktreePath: WT('7-web'), branch: '7-web' })

  // t+6m — the conductor spends again, because it never stops.
  f.at(FIXTURE_START_TS + 6 * minute)
  usage('conductor', 'conductor', 'claude-sonnet-5', {
    input: 8,
    output: 4_200,
    cacheRead: 330_000,
    cacheCreation: 7_100,
  })
  cost('conductor', 'conductor', 'claude-sonnet-5', 0.71)

  return [...fixtureSession(), ...f.all()]
}
