import { createEvent, createIdFactory, createStubExec, SIGNALS } from '@rhizomorph/core'
import type { CollectorContext, Exec, StubExec, StubExecRoute } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { createJudgeCollector, JUDGE_CAPABILITIES } from './collector.js'

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

const THREE_LANES_V2_MOVED_C = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/lane-a
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/lane-a

worktree /repo-worktrees/lane-b
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/lane-b

worktree /repo-worktrees/lane-c
HEAD cccccccccccccccccccccccccccccccccccccccc2
branch refs/heads/lane-c
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

describe('judge collector — error heartbeat (#526)', () => {
  /**
   * Both catches are exercised through a lane (`lane-a`) whose symbol
   * extraction keeps failing: since a throw never writes `nextLaneSymbols`,
   * `lane-a` stays a permanent cache-miss and therefore permanently `moved`,
   * which is what forces the `lane-a`/`lane-b` pair through the merge-tree
   * check on every poll even though the pair's heads never change — the same
   * coupling `git-collector.ts`'s dedup fixtures rely on. `lane-b` always
   * extracts a stable, unrelated symbol so neither the symbol-overlap path
   * nor lane-b's own moved-ness adds noise.
   */
  function heartbeatRoutes(diffAFails: boolean, mergeCode: 0 | 1): StubExecRoute[] {
    return [
      { match: 'git worktree list --porcelain', result: { stdout: TWO_LANES_V1 } },
      diffAFails
        ? { match: 'git diff --unified=0 main...lane-a', result: { failed: true, code: 128 } }
        : { match: 'git diff --unified=0 main...lane-a', result: { stdout: DIFF_UNRELATED_A } },
      { match: 'git diff --unified=0 main...lane-b', result: { stdout: DIFF_UNRELATED_B } },
      // code: 1 with empty stdout is merge-tree's "couldn't even attempt this"
      // plumbing-error shape (mergetree.ts:78-89) — the one that throws, as
      // opposed to code: 1 with non-empty stdout (a real conflict report).
      mergeCode === 0
        ? { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } }
        : { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { code: 1, stdout: '' } },
    ]
  }

  const EXTRACTION_MSG = 'symbol extraction failed for lane "lane-a"'
  const MERGE_MSG = 'speculative merge failed for "lane-a" vs "lane-b"'

  function messagesOf(events: readonly { payload: unknown }[]): string[] {
    return events.map((event) => (event.payload as { message: string }).message)
  }

  it('A — repetition: the same failing input across 3 polls voices exactly once per site', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })

    const p1 = await collector.poll(collector.initialSnapshot(), makeContext(scriptedExec(heartbeatRoutes(true, 1)), 1_000))
    const p2 = await collector.poll(p1.nextSnapshot, makeContext(scriptedExec(heartbeatRoutes(true, 1)), 2_000))
    const p3 = await collector.poll(p2.nextSnapshot, makeContext(scriptedExec(heartbeatRoutes(true, 1)), 3_000))

    const allMessages = [...messagesOf(p1.events), ...messagesOf(p2.events), ...messagesOf(p3.events)]
    expect(allMessages.filter((message) => message === EXTRACTION_MSG)).toHaveLength(1)
    expect(allMessages.filter((message) => message === MERGE_MSG)).toHaveLength(1)
  })

  it('B — site 2 recovery re-arm: an unchanged merge-tree pair voices, recovers silently, then re-voices on a fresh repeat', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })

    // Poll 1: both catches fire.
    const p1 = await collector.poll(collector.initialSnapshot(), makeContext(scriptedExec(heartbeatRoutes(true, 1)), 1_000))
    expect(messagesOf(p1.events)).toEqual(expect.arrayContaining([EXTRACTION_MSG, MERGE_MSG]))

    // Poll 2: merge-tree recovers at the SAME head pair (lane-a's own
    // extraction keeps failing throughout, which is exactly what keeps this
    // pair — and lane-b's cache — irrelevant to whether it gets re-checked;
    // lane-a's permanent cache-miss alone forces the pair through every poll).
    const p2 = await collector.poll(p1.nextSnapshot, makeContext(scriptedExec(heartbeatRoutes(true, 0)), 2_000))
    expect(messagesOf(p2.events)).not.toContain(MERGE_MSG)

    // Poll 3: merge-tree fails again at the identical, still-unchanged head
    // pair. If the latch had failed to re-arm on poll 2's recovery (or, worse,
    // never latched at all and just always suppressed), this would go
    // silent-forever or noisy-forever respectively; a real latch voices once.
    const p3 = await collector.poll(p2.nextSnapshot, makeContext(scriptedExec(heartbeatRoutes(true, 1)), 3_000))
    expect(messagesOf(p3.events).filter((message) => message === MERGE_MSG)).toHaveLength(1)

    // lane-a's own extraction never recovered in this fixture, so it stays
    // latched silent throughout poll 2 and poll 3 (site 1's Test A shape,
    // extended) — asserted here as a sanity check that the shared `moved`
    // coupling isn't accidentally re-voicing it too.
    expect(messagesOf(p2.events)).not.toContain(EXTRACTION_MSG)
    expect(messagesOf(p3.events)).not.toContain(EXTRACTION_MSG)
  })

  it('B2 — site 1 recovery re-arm: a lane\'s extraction voices, recovers silently, then re-voices once a later commit reintroduces a failure', async () => {
    // Site 1's own latch (`extractionErrorVoiced`) keys on branch, not head —
    // unlike site 2's `reported`, it has no head component (see the plan:
    // "recovery is a successful extraction, not a head change"). But
    // demonstrating recovery-then-refail for a lane whose OWN extraction is
    // the failing thing requires the lane to actually get re-swept, and the
    // `moved` cache-gate (out of this issue's fence) only re-sweeps a lane
    // whose head changed or whose symbols were never cached — so unlike test
    // A/B, this scenario needs lane-a's head to move once, between the
    // recovery poll and the re-failure poll, to force that re-sweep. Verified
    // via scratch test: a fixture that keeps lane-a's head static after
    // recovery cannot re-exercise this catch at all (the collector skips the
    // extraction attempt entirely, 0 exec calls beyond `worktree list`) — so
    // this is a deliberate, minimal deviation from the plan's literal "heads
    // still unchanged" framing for this one case; see the build report on
    // #526 for the full trace.
    const collector = createJudgeCollector({ cadenceMs: 0 })

    const p1 = await collector.poll(collector.initialSnapshot(), makeContext(scriptedExec(heartbeatRoutes(true, 0)), 1_000))
    expect(messagesOf(p1.events)).toContain(EXTRACTION_MSG)

    const p2 = await collector.poll(p1.nextSnapshot, makeContext(scriptedExec(heartbeatRoutes(false, 0)), 2_000))
    expect(messagesOf(p2.events)).not.toContain(EXTRACTION_MSG)

    const exec3 = scriptedExec([
      { match: 'git worktree list --porcelain', result: { stdout: TWO_LANES_V2_MOVED_A } },
      { match: 'git diff --unified=0 main...lane-a', result: { failed: true, code: 128 } },
      { match: 'git diff --unified=0 main...lane-b', result: { stdout: DIFF_UNRELATED_B } },
      { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
    ])
    const p3 = await collector.poll(p2.nextSnapshot, makeContext(exec3, 3_000))
    expect(messagesOf(p3.events).filter((message) => message === EXTRACTION_MSG)).toHaveLength(1)
  })

  it('C — distinct identity: lane-c\'s first failure still voices while lane-a\'s already-latched failure stays silent, proving the latch is keyed per branch, not one collector-wide boolean', async () => {
    const collector = createJudgeCollector({ cadenceMs: 0 })

    // Poll 1: lane-a's extraction fails and latches. lane-b and lane-c are
    // both still healthy — in particular lane-c has NOT failed yet, so a
    // collector-wide boolean and a per-branch latch agree here.
    const p1 = await collector.poll(
      collector.initialSnapshot(),
      makeContext(
        scriptedExec([
          { match: 'git worktree list --porcelain', result: { stdout: THREE_LANES_V1 } },
          { match: 'git diff --unified=0 main...lane-a', result: { failed: true, code: 128 } },
          { match: 'git diff --unified=0 main...lane-b', result: { stdout: DIFF_UNRELATED_B } },
          { match: 'git diff --unified=0 main...lane-c', result: { stdout: DIFF_UNRELATED_C } },
          { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
          { match: 'git merge-tree --write-tree -z lane-a lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
          { match: 'git merge-tree --write-tree -z lane-b lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
        ]),
        1_000,
      ),
    )
    const p1Messages = p1.events
      .filter((event) => event.type === 'collector.error')
      .map((event) => (event.payload as { message: string }).message)
    expect(p1Messages).toEqual(['symbol extraction failed for lane "lane-a"'])

    // Poll 2: lane-a's extraction keeps failing — its permanent cache-miss on
    // throw keeps it permanently `moved`, no head change needed — and it must
    // stay silent (already latched on poll 1). lane-c commits: the head move
    // is what forces the `moved` gate to re-sweep it at all, and its
    // extraction fails for the honest first time. lane-b's head is unchanged
    // and its symbols are still cached, so it is not re-swept — no route for
    // its diff below; an unwanted sweep would surface as an unmatched-stub
    // failure and a third message, breaking the exact-equality assertion.
    const p2 = await collector.poll(
      p1.nextSnapshot,
      makeContext(
        scriptedExec([
          { match: 'git worktree list --porcelain', result: { stdout: THREE_LANES_V2_MOVED_C } },
          { match: 'git diff --unified=0 main...lane-a', result: { failed: true, code: 128 } },
          { match: 'git diff --unified=0 main...lane-c', result: { failed: true, code: 128 } },
          { match: 'git merge-tree --write-tree -z lane-a lane-b', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
          { match: 'git merge-tree --write-tree -z lane-a lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
          { match: 'git merge-tree --write-tree -z lane-b lane-c', result: { stdout: MERGE_TREE_CLEAN, code: 0 } },
        ]),
        2_000,
      ),
    )
    const p2Messages = p2.events
      .filter((event) => event.type === 'collector.error')
      .map((event) => (event.payload as { message: string }).message)

    // The discriminating assertion: against the real per-branch latch,
    // lane-c's honest first failure voices exactly once while lane-a stays
    // silent. Against a collector-wide boolean latch, poll 2 sees the
    // boolean already set from lane-a's poll-1 failure, so lane-c's first
    // failure is swallowed too and this list would be empty instead.
    expect(p2Messages).toEqual(['symbol extraction failed for lane "lane-c"'])
  })
})

describe('judge collector — capabilities', () => {
  it('honestly declares every prd15 lane signal absent — the judge organ corroborates lanes, it does not adapt one', () => {
    const collector = createJudgeCollector()
    expect(collector.capabilities).toBe(JUDGE_CAPABILITIES)
    for (const signal of SIGNALS) {
      expect(JUDGE_CAPABILITIES[signal].level).toBe('absent')
    }
  })
})
