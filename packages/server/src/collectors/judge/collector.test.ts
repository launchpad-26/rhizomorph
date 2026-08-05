import { createEvent, createIdFactory, createStubExec } from '@rhizomorph/core'
import type { CollectorContext, Exec, StubExec, StubExecRoute } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { createJudgeCollector } from './collector.js'

/**
 * Driven purely through a scripted {@link Exec} — no real git process ever
 * runs here, matching the git-collector's own test convention. The judge
 * organ's actual symbol-extraction and merge-tree logic is proven against
 * real hermetic git repos in `../../judge/symbols.test.ts` and
 * `../../judge/mergetree.test.ts`; this file is the collector's own
 * wiring: cadence, lane discovery, dedup, and graceful degradation.
 */
function scriptedExec(routes: readonly StubExecRoute[]): Exec {
  return createStubExec(routes)
}

function makeContext(exec: Exec, now: number): CollectorContext {
  const nextId = createIdFactory('evt')
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId,
    emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
  }
}

const MAIN_ONLY = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main
`

const TWO_LANES_V1 = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/lane-a
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/lane-a

worktree /repo-worktrees/lane-b
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/lane-b
`

const TWO_LANES_V2_MOVED_A = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/lane-a
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2
branch refs/heads/lane-a

worktree /repo-worktrees/lane-b
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/lane-b
`

const DIFF_ADDS_FORMAT_DURATION_A = `diff --git a/a.ts b/a.ts
index 000..111 100644
--- /dev/null
+++ b/a.ts
@@ -0,0 +1,3 @@
+export function formatDuration(ms) {
+  return ms
+}
`

const DIFF_ADDS_FORMAT_DURATION_B = `diff --git a/b.ts b/b.ts
index 000..222 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1,3 @@
+export function formatDuration(ms) {
+  return ms * 2
+}
`

// Two lanes each adding a symbol of their own, distinct names — so the
// merge-tree-only tests below don't accidentally also trip the
// symbol-overlap check.
const DIFF_UNRELATED_A = `diff --git a/c.ts b/c.ts
index 000..333 100644
--- /dev/null
+++ b/c.ts
@@ -0,0 +1,1 @@
+export const onlyInA = 1
`

const DIFF_UNRELATED_B = `diff --git a/d.ts b/d.ts
index 000..444 100644
--- /dev/null
+++ b/d.ts
@@ -0,0 +1,1 @@
+export const onlyInB = 2
`

const MERGE_TREE_CLEAN = 'e25f1ee1cd91ad381d8412b0349059ba5d282d54\0'
const MERGE_TREE_CONFLICT =
  'e25f1ee1cd91ad381d8412b0349059ba5d282d54\0' +
  '100644 6c22836ad8e0e090bf304446e410b71bf05b48b8 1\tshared.ts\0' +
  '100644 e63d4d51e27733787be626f9f3c05337c6edeb50 2\tshared.ts\0' +
  '100644 d9dc8fc463f4756b7ef8a558a23950f1718addf4 3\tshared.ts\0' +
  '\0'

const THREE_LANES_V1 = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/lane-a
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/lane-a

worktree /repo-worktrees/lane-b
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/lane-b

worktree /repo-worktrees/lane-c
HEAD cccccccccccccccccccccccccccccccccccccccc
branch refs/heads/lane-c
`

const THREE_LANES_V2_MOVED_A = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/lane-a
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2
branch refs/heads/lane-a

worktree /repo-worktrees/lane-b
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/lane-b

worktree /repo-worktrees/lane-c
HEAD cccccccccccccccccccccccccccccccccccccccc
branch refs/heads/lane-c
`

const DIFF_UNRELATED_C = `diff --git a/e.ts b/e.ts
index 000..555 100644
--- /dev/null
+++ b/e.ts
@@ -0,0 +1,1 @@
+export const onlyInC = 3
`

/** Every `git diff`/`git merge-tree` call the stub actually saw — the two subcommand kinds the audit named as the O(lanes) / O(lanes²) cost. */
function subprocessCalls(exec: Exec): { command: string; args: readonly string[] }[] {
  const spy = exec as StubExec
  return spy.calls.filter((call) => call.args[0] === 'diff' || call.args[0] === 'merge-tree')
}

function laneRoutes(diffA: string, diffB: string, mergeStdout: string, mergeCode: 0 | 1): StubExecRoute[] {
  return [
    { match: 'git worktree list --porcelain', result: { stdout: TWO_LANES_V1 } },
    { match: 'git diff --unified=0 main...lane-a', result: { stdout: diffA } },
    { match: 'git diff --unified=0 main...lane-b', result: { stdout: diffB } },
    {
      match: 'git merge-tree --write-tree -z lane-a lane-b',
      result: { stdout: mergeStdout, code: mergeCode },
    },
  ]
}

describe('judge collector — cadence', () => {
  it('runs on the first poll, then no-ops (no exec calls) until the cadence elapses', async () => {
    const collector = createJudgeCollector({ cadenceMs: 60_000 })
    const exec = scriptedExec([{ match: 'git worktree list --porcelain', result: { stdout: MAIN_ONLY } }])

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    expect(first.nextSnapshot.lastRunAt).toBe(1_000)

    const execSpy = exec as Exec & { calls: unknown[] }
    const callsAfterFirst = execSpy.calls.length

    const second = await collector.poll(first.nextSnapshot, makeContext(exec, 30_000))
    expect(second.events).toEqual([])
    expect(second.nextSnapshot).toBe(first.nextSnapshot) // untouched — poll-loop's persist-skip depends on this
    expect(execSpy.calls.length).toBe(callsAfterFirst) // no new exec calls at all

    const third = await collector.poll(second.nextSnapshot, makeContext(exec, 61_000))
    expect(third.nextSnapshot.lastRunAt).toBe(61_000)
    expect(execSpy.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})

describe('judge collector — lane requirement', () => {
  it('is a graceful no-op with fewer than two lanes', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec([{ match: 'git worktree list --porcelain', result: { stdout: MAIN_ONLY } }])

    const { events, nextSnapshot } = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    expect(events).toEqual([])
    expect(nextSnapshot.disabled).toBe(false)
  })
})

describe('judge collector — graceful degradation', () => {
  it('emits collector.disabled (not a throw) when git worktree list fails', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec([
      {
        match: 'git worktree list --porcelain',
        result: { failed: true, code: 128, stderr: 'fatal: not a git repository' },
      },
    ])

    const { events, nextSnapshot } = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'collector.disabled',
        payload: expect.objectContaining({ collector: 'judge' }),
      }),
    )
    expect(nextSnapshot.disabled).toBe(true)
  })

  it('emits collector.error (not collector.disabled) for one lane\'s failed diff, and still evaluates the rest', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec([
      { match: 'git worktree list --porcelain', result: { stdout: TWO_LANES_V1 } },
      { match: 'git diff --unified=0 main...lane-a', result: { failed: true, code: 128 } },
      { match: 'git diff --unified=0 main...lane-b', result: { stdout: DIFF_ADDS_FORMAT_DURATION_B } },
      { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
    ])

    const { events, nextSnapshot } = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    expect(nextSnapshot.disabled).toBe(false)
    expect(events).toEqual([
      expect.objectContaining({ type: 'collector.error', payload: expect.objectContaining({ collector: 'judge' }) }),
    ])
  })
})

describe('judge collector — findings', () => {
  it('emits a symbol-overlap finding when two lanes independently add the same symbol', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec(
      laneRoutes(DIFF_ADDS_FORMAT_DURATION_A, DIFF_ADDS_FORMAT_DURATION_B, MERGE_TREE_CLEAN, 0),
    )

    const { events } = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    const finding = events.find((event) => event.type === 'judge.finding')
    expect(finding?.payload).toEqual({
      kind: 'symbol-overlap',
      lanes: ['lane-a', 'lane-b'],
      evidence: { symbols: ['formatDuration'] },
      severity: 'log',
      detectedAt: 1_000,
    })
    expect(finding?.source).toBe('judge')
  })

  it('emits a speculative-conflict finding with the conflicting files as evidence', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec(laneRoutes(DIFF_UNRELATED_A, DIFF_UNRELATED_B, MERGE_TREE_CONFLICT, 1))

    const { events } = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    const finding = events.find((event) => event.type === 'judge.finding')
    expect(finding?.payload).toEqual({
      kind: 'speculative-conflict',
      lanes: ['lane-a', 'lane-b'],
      evidence: { conflictingFiles: ['shared.ts'] },
      severity: 'log',
      detectedAt: 1_000,
    })
  })

  it('emits neither finding when lanes touch unrelated symbols and merge cleanly', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec(laneRoutes(DIFF_UNRELATED_A, DIFF_UNRELATED_B, MERGE_TREE_CLEAN, 0))

    const { events } = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    expect(events.filter((event) => event.type === 'judge.finding')).toEqual([])
  })

  it('does not re-emit an identical finding on the next run while heads are unchanged', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec(
      laneRoutes(DIFF_ADDS_FORMAT_DURATION_A, DIFF_ADDS_FORMAT_DURATION_B, MERGE_TREE_CLEAN, 0),
    )

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    expect(first.events.some((event) => event.type === 'judge.finding')).toBe(true)

    const second = await collector.poll(first.nextSnapshot, makeContext(exec, 2_000))
    expect(second.events.filter((event) => event.type === 'judge.finding')).toEqual([])
  })

  it('re-emits once a lane\'s head moves — a fresh fact, not a repeat', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec1 = scriptedExec(
      laneRoutes(DIFF_ADDS_FORMAT_DURATION_A, DIFF_ADDS_FORMAT_DURATION_B, MERGE_TREE_CLEAN, 0),
    )
    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec1, 1_000))
    expect(first.events.some((event) => event.type === 'judge.finding')).toBe(true)

    const exec2 = scriptedExec([
      { match: 'git worktree list --porcelain', result: { stdout: TWO_LANES_V2_MOVED_A } },
      { match: 'git diff --unified=0 main...lane-a', result: { stdout: DIFF_ADDS_FORMAT_DURATION_A } },
      { match: 'git diff --unified=0 main...lane-b', result: { stdout: DIFF_ADDS_FORMAT_DURATION_B } },
      { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
    ])
    const second = await collector.poll(first.nextSnapshot, makeContext(exec2, 2_000))
    expect(second.events.some((event) => event.type === 'judge.finding')).toBe(true)
  })
})

describe('judge collector — head-movement gate (2026-08-05 adversarial audit #172)', () => {
  it('spawns zero diff/merge-tree subprocesses on a cadence tick over a fleet whose heads did not move', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec = scriptedExec(
      laneRoutes(DIFF_ADDS_FORMAT_DURATION_A, DIFF_ADDS_FORMAT_DURATION_B, MERGE_TREE_CLEAN, 0),
    )

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, 1_000))
    const spawnedByFirstRun = subprocessCalls(exec).length
    expect(spawnedByFirstRun).toBeGreaterThan(0) // sanity: boot sweep really did spawn diff/merge-tree

    const second = await collector.poll(first.nextSnapshot, makeContext(exec, 2_000))
    expect(second.events).toEqual([])
    expect(subprocessCalls(exec).length).toBe(spawnedByFirstRun) // no NEW diff/merge-tree spawns

    // Lane discovery itself is a single O(1) spawn regardless of fleet size —
    // it's how movement is detected at all, and it's not the O(lanes)/O(lanes²)
    // cost the audit named, so it still runs every tick.
    const spy = exec as StubExec
    expect(spy.calls.filter((call) => call.args[0] === 'worktree').length).toBe(2)
  })

  it('re-checks exactly the moved lane\'s pairs, leaving the untouched pair unspawned', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })
    const exec1 = scriptedExec([
      { match: 'git worktree list --porcelain', result: { stdout: THREE_LANES_V1 } },
      { match: 'git diff --unified=0 main...lane-a', result: { stdout: DIFF_UNRELATED_A } },
      { match: 'git diff --unified=0 main...lane-b', result: { stdout: DIFF_UNRELATED_B } },
      { match: 'git diff --unified=0 main...lane-c', result: { stdout: DIFF_UNRELATED_C } },
      { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
      { match: 'git merge-tree --write-tree -z lane-a lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
      { match: 'git merge-tree --write-tree -z lane-b lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
    ])
    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec1, 1_000))
    expect(first.events.filter((event) => event.type === 'collector.error')).toEqual([]) // boot sweep covered all three lanes cleanly

    // Second poll: only lane-a's head moved. Routes for lane-b/lane-c diffs
    // and the lane-b/lane-c merge-tree are deliberately absent — if the
    // collector spawned any of them, the stub returns a failed exec (no
    // route matches) and the poll would surface a collector.error.
    const exec2 = scriptedExec([
      { match: 'git worktree list --porcelain', result: { stdout: THREE_LANES_V2_MOVED_A } },
      { match: 'git diff --unified=0 main...lane-a', result: { stdout: DIFF_UNRELATED_A } },
      { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
      { match: 'git merge-tree --write-tree -z lane-a lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
    ])
    const second = await collector.poll(first.nextSnapshot, makeContext(exec2, 2_000))
    expect(second.events.filter((event) => event.type === 'collector.error')).toEqual([])

    const spy = exec2 as StubExec
    const diffBranches = spy.calls
      .filter((call) => call.args[0] === 'diff')
      .map((call) => call.args[2]) // `main...lane-x`
    expect(diffBranches).toEqual(['main...lane-a'])

    const mergeTreePairs = spy.calls
      .filter((call) => call.args[0] === 'merge-tree')
      .map((call) => [call.args[3], call.args[4]])
    expect(mergeTreePairs).toEqual(
      expect.arrayContaining([
        ['lane-a', 'lane-b'],
        ['lane-a', 'lane-c'],
      ]),
    )
    expect(mergeTreePairs).toHaveLength(2) // lane-b/lane-c pair untouched — neither of its heads moved
  })
})
