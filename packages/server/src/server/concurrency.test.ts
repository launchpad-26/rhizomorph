import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COLLECTOR_FANOUT_LIMIT, type FanoutOutcome, mapBounded, runBounded } from './concurrency.js'

/**
 * THE BOUNDED FAN-OUT LAWS — prd-44 ruling 3's declared cap and its ordering
 * requirement, asserted as COUNTS ONLY.
 *
 * There is no wall-clock assertion anywhere in this file, and there is no
 * `setTimeout(n > 0)` used to sequence anything: every task is a deferred the
 * test resolves by hand, so the schedule under test is the test's, never the
 * box's. That is also why this file is named `concurrency.test.ts` and carries
 * no `@gate-timing` opt-in marker — `scripts/gate.sh` derives its 4x-load
 * timing set from exactly those two spellings and ratchets
 * `.swarm/timing-count`, which only a human can clear. A timing assertion here
 * would measure the machine and enrol the file in a pass it does not belong
 * in.
 *
 * The marker is named just above WITHOUT its two-slash comment prefix on
 * purpose. The gate greps for the *prefixed* form as a fixed string, wherever
 * it appears — so spelling it in full, even inside prose explaining its
 * absence, is enough to enrol this file. That is not hypothetical: the first
 * draft of this comment did exactly that. L15 is the law that stops it
 * recurring.
 *
 * The one place this touches the macrotask queue is `flush()`, which drains
 * microtasks so a *count* can be read after a settled task has let a worker
 * resume. It measures nothing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Resolves once the microtask queue has drained. A flush, never a duration. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

interface Tracked {
  readonly tasks: readonly (() => Promise<string>)[]
  /** Task indices in the order they STARTED. */
  readonly starts: number[]
  /** Task indices in the order they SETTLED. */
  readonly finishes: number[]
  /** Starts and finishes interleaved, so "nothing began before its predecessor ended" is checkable. */
  readonly trace: string[]
  peak(): number
  inFlight(): number
  settle(index: number, value?: string): void
  fail(index: number, reason: unknown): void
}

interface Control {
  readonly resolve: (value: string) => void
  readonly reject: (reason: unknown) => void
}

/**
 * `count` thunks, each of which returns a promise this harness alone settles.
 * Nothing here resolves on its own, so every observed count is a consequence
 * of the implementation's own pulling and nothing else.
 */
function tracked(count: number): Tracked {
  const starts: number[] = []
  const finishes: number[] = []
  const trace: string[] = []
  const controls = new Array<Control | undefined>(count)
  let live = 0
  let peak = 0

  const controlAt = (index: number): Control => {
    const control = controls[index]
    if (control === undefined) throw new Error(`no started task ${index}`)
    return control
  }

  const tasks = Array.from({ length: count }, (_unused, index) => (): Promise<string> => {
    starts.push(index)
    trace.push(`start${index}`)
    live += 1
    if (live > peak) peak = live
    return new Promise<string>((resolve, reject) => {
      controls[index] = { resolve, reject }
    })
  })

  return {
    tasks,
    starts,
    finishes,
    trace,
    peak: () => peak,
    inFlight: () => live,
    settle(index, value = `v${index}`) {
      const control = controlAt(index)
      live -= 1
      finishes.push(index)
      trace.push(`finish${index}`)
      control.resolve(value)
    },
    fail(index, reason) {
      const control = controlAt(index)
      live -= 1
      finishes.push(index)
      trace.push(`finish${index}`)
      control.reject(reason)
    },
  }
}

function taskAt(harness: Tracked, index: number): () => Promise<string> {
  const task = harness.tasks[index]
  if (task === undefined) throw new Error(`no task ${index}`)
  return task
}

/**
 * Renders outcomes hole-safely. `Array.from` materialises a hole as
 * `undefined`, where `.map()` and `.filter()` SKIP holes — so an
 * implementation that left `outcomes` sparse (or pushed instead of assigning
 * by index) could pass a `filter((o) => o === undefined).length === 0`
 * assertion vacuously. This one cannot.
 */
function rendered<T>(outcomes: readonly (FanoutOutcome<T> | undefined)[]): unknown[] {
  return Array.from(outcomes, (outcome) => {
    if (outcome === undefined) return 'HOLE'
    return outcome.ok ? outcome.value : { failed: outcome.reason }
  })
}

function outcomeAt<T>(outcomes: readonly FanoutOutcome<T>[], index: number): FanoutOutcome<T> {
  const outcome = outcomes[index]
  if (outcome === undefined) throw new Error(`no outcome at index ${index} — the array has a hole`)
  return outcome
}

function valueAt<T>(outcomes: readonly FanoutOutcome<T>[], index: number): T {
  const outcome = outcomeAt(outcomes, index)
  if (!outcome.ok) throw new Error(`outcome ${index} failed with ${String(outcome.reason)}`)
  return outcome.value
}

function reasonAt<T>(outcomes: readonly FanoutOutcome<T>[], index: number): unknown {
  const outcome = outcomeAt(outcomes, index)
  if (outcome.ok) throw new Error(`outcome ${index} succeeded with ${String(outcome.value)}`)
  return outcome.reason
}

/** Settles the given indices one at a time, letting the pool refill between each. */
async function drive(harness: Tracked, order: readonly number[]): Promise<void> {
  for (const index of order) {
    harness.settle(index)
    await flush()
  }
}

describe('bounded fan-out', () => {
  it('L1: returns results in task order when they complete in reverse order', async () => {
    const harness = tracked(5)
    const batch = runBounded(harness.tasks, 5)

    // All five are in flight, so completion order is entirely the test's choice.
    expect(harness.starts).toEqual([0, 1, 2, 3, 4])
    for (const index of [4, 3, 2, 1, 0]) harness.settle(index)
    const outcomes = await batch

    expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4'])
    // The assertion above only means something because completion really was
    // the reverse of task order.
    expect(harness.finishes).toEqual([4, 3, 2, 1, 0])
  })

  it('L2: returns results in task order when they interleave under a real cap', async () => {
    const harness = tracked(6)
    const batch = runBounded(harness.tasks, 2)

    expect(harness.starts).toEqual([0, 1])
    await drive(harness, [1, 0, 3, 2, 5, 4])
    const outcomes = await batch

    expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
    expect(harness.finishes).toEqual([1, 0, 3, 2, 5, 4])
    // Not sorted: the pool genuinely handed back out-of-order completions.
    expect(harness.finishes).not.toEqual([...harness.finishes].sort((a, b) => a - b))
  })

  it('L3: fills every index exactly once — no holes, exact length', async () => {
    const harness = tracked(6)
    const batch = runBounded(harness.tasks, 2)
    await drive(harness, [1, 0, 3, 2, 5, 4])
    const outcomes = await batch

    expect(outcomes.length).toBe(6)
    expect(rendered(outcomes)).not.toContain('HOLE')
    expect(Object.keys(outcomes).length).toBe(6)
  })

  it('L3: the batch waits for every worker, not for the first one to drain', async () => {
    const harness = tracked(3)
    const batch = runBounded(harness.tasks, 2)

    expect(harness.starts).toEqual([0, 1])
    harness.settle(0)
    await flush()
    // Worker A took the last queued task; worker B is still on index 1.
    expect(harness.starts).toEqual([0, 1, 2])
    harness.settle(1)
    await flush()
    // Worker B now finds the queue empty and returns while index 2 is still in
    // flight. `Promise.race` over the workers would resolve the batch right
    // here, handing back an array with a hole at index 2.
    let settled = false
    void batch.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    expect(harness.inFlight()).toBe(1)

    harness.settle(2)
    const outcomes = await batch

    expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2'])
  })

  it('L4: never exceeds the cap at K=1', async () => {
    const harness = tracked(10)
    const batch = runBounded(harness.tasks, 1)

    for (let index = 0; index < 10; index += 1) {
      expect(harness.starts.length).toBe(index + 1)
      // At K=1 nothing may be started that its predecessor has not released.
      expect(harness.starts.length).toBeLessThanOrEqual(harness.finishes.length + 1)
      expect(harness.inFlight()).toBeLessThanOrEqual(1)
      harness.settle(index)
      await flush()
    }
    await batch

    // Equality, not `<=`: a cap that never reached its ceiling would satisfy
    // `<=` while doing no work at all.
    expect(harness.peak()).toBe(1)
  })

  it('L4: never exceeds the cap at K=3, and reaches it', async () => {
    const harness = tracked(10)
    const batch = runBounded(harness.tasks, 3)

    expect(harness.starts).toEqual([0, 1, 2])
    for (let index = 0; index < 10; index += 1) {
      expect(harness.inFlight()).toBeLessThanOrEqual(3)
      harness.settle(index)
      await flush()
      expect(harness.inFlight()).toBeLessThanOrEqual(3)
    }
    await batch

    expect(harness.peak()).toBe(3)
    expect(harness.starts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('L5: a freed slot takes the next queued task, not a pre-assigned one', async () => {
    const harness = tracked(4)
    const batch = runBounded(harness.tasks, 2)

    expect(harness.starts).toEqual([0, 1])
    harness.settle(1)
    await flush()
    // Per-worker slicing would give [0, 1, 3] here: worker B would own 2 and 3
    // and take *its* next one. A shared queue takes the queue's next one.
    expect(harness.starts).toEqual([0, 1, 2])

    harness.settle(0)
    await flush()
    harness.settle(2)
    await flush()
    harness.settle(3)
    const outcomes = await batch

    expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2', 'v3'])
  })

  it('L6: a rejecting task cancels no sibling, and its reason lands at its own index', async () => {
    const harness = tracked(5)
    const boom = new Error('one')
    const batch = runBounded(harness.tasks, 2)

    expect(harness.starts).toEqual([0, 1])
    harness.fail(0, boom)
    await flush()
    // The pool kept pulling across the rejection.
    expect(harness.starts).toEqual([0, 1, 2])
    expect(harness.inFlight()).toBeLessThanOrEqual(2)

    await drive(harness, [1, 2, 3, 4])
    const outcomes = await batch

    // Identity, not shape: a wrapped, re-thrown or stringified reason fails.
    expect(reasonAt(outcomes, 0)).toBe(boom)
    expect([valueAt(outcomes, 1), valueAt(outcomes, 2), valueAt(outcomes, 3), valueAt(outcomes, 4)]).toEqual([
      'v1',
      'v2',
      'v3',
      'v4',
    ])
    expect(harness.starts.length).toBe(5)
    expect(harness.peak()).toBe(2)
  })

  it('L7: a thunk that throws synchronously is the same case as one that rejects', async () => {
    const sync = new Error('thrown before any promise existed')
    const outcomes = await runBounded<string>(
      [
        () => 'a',
        () => {
          throw sync
        },
        () => 'c',
      ],
      2,
    )

    // THE SIBLING CASE. `await task()` *inside* the try is what makes the
    // synchronous throw and the asynchronous rejection one branch; a refactor
    // that invoked the thunk outside the try breaks only this law.
    expect(reasonAt(outcomes, 1)).toBe(sync)
    expect(rendered(outcomes)).toEqual(['a', { failed: sync }, 'c'])
  })

  it('L7: mapBounded shares that branch — a synchronously throwing worker', async () => {
    const sync = new Error('worker threw')
    const outcomes = await mapBounded(
      ['a', 'b', 'c'],
      (item) => {
        if (item === 'b') throw sync
        return item
      },
      2,
    )

    expect(reasonAt(outcomes, 1)).toBe(sync)
    expect(rendered(outcomes)).toEqual(['a', { failed: sync }, 'c'])
  })

  it('L8: a rejection produces no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const harness = tracked(4)
      const batch = runBounded(harness.tasks, 2)
      harness.fail(0, new Error('x'))
      await flush()
      await drive(harness, [1, 2, 3])
      await batch
      // Node reports an unhandled rejection a turn after the fact, so drain
      // twice before believing the empty list.
      await flush()
      await flush()

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('L9: runBounded with no limit argument runs at the stated ceiling', async () => {
    const harness = tracked(10)
    // The argument is deliberately OMITTED — a law that passes the value it
    // exists to protect never exercises the default.
    const batch = runBounded(harness.tasks)

    expect(harness.starts.length).toBe(COLLECTOR_FANOUT_LIMIT)
    expect(harness.finishes).toEqual([])
    await drive(harness, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    await batch

    expect(harness.peak()).toBe(COLLECTOR_FANOUT_LIMIT)
  })

  it('L9: mapBounded with no limit argument runs at the same ceiling', async () => {
    const harness = tracked(10)
    // Its sibling: mapBounded forwarding a literal instead of the constant
    // would satisfy every other law in this file.
    const batch = mapBounded(harness.tasks, (task) => task())

    expect(harness.starts.length).toBe(COLLECTOR_FANOUT_LIMIT)
    await drive(harness, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    await batch

    expect(harness.peak()).toBe(COLLECTOR_FANOUT_LIMIT)
  })

  it('L10: the ceiling is a stated constant and does not drift', () => {
    // Four, because the reference box is an 8 GB machine that already thrashes
    // at four concurrent agent lanes, and six collectors each fanning out per
    // entity could otherwise start 40+ subprocesses at once. Raising this is a
    // deliberate edit to a law with a written reason, not a quiet change to a
    // literal at a call site.
    expect(COLLECTOR_FANOUT_LIMIT).toBe(4)
  })

  it('L11: K=1 is exactly the sequential reference — same order, same results', async () => {
    const rejected = new Error('rejected')
    const thrown = new Error('thrown')
    const build = (): (() => string | PromiseLike<string>)[] => [
      () => 'a',
      () => Promise.resolve('b'),
      () => Promise.reject(rejected),
      () => {
        throw thrown
      },
      () => 'e',
    ]

    async function serially<T>(tasks: readonly (() => T | PromiseLike<T>)[]): Promise<FanoutOutcome<T>[]> {
      const out: FanoutOutcome<T>[] = []
      for (const task of tasks) {
        try {
          out.push({ ok: true, value: await task() })
        } catch (reason) {
          out.push({ ok: false, reason })
        }
      }
      return out
    }

    const reference = await serially(build())
    const fanout = await runBounded(build(), 1)

    expect(rendered(fanout)).toEqual(rendered(reference))
    expect(fanout).toEqual(reference)
    expect(reasonAt(fanout, 2)).toBe(rejected)
    expect(reasonAt(fanout, 3)).toBe(thrown)
    expect(reasonAt(reference, 2)).toBe(rejected)
    expect(reasonAt(reference, 3)).toBe(thrown)
  })

  it('L11: K=1 starts nothing before its predecessor has settled', async () => {
    const harness = tracked(3)
    const batch = runBounded(harness.tasks, 1)
    await drive(harness, [0, 1, 2])
    await batch

    expect(harness.trace).toEqual(['start0', 'finish0', 'start1', 'finish1', 'start2', 'finish2'])
  })

  it('L12: three identical runs do not drift', async () => {
    const results: unknown[][] = []
    const peaks: number[] = []
    for (let run = 0; run < 3; run += 1) {
      const harness = tracked(6)
      const batch = runBounded(harness.tasks, 2)
      await drive(harness, [0, 1, 2, 3, 4, 5])
      results.push(rendered(await batch))
      peaks.push(harness.peak())
    }

    expect(results[0]).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    expect(peaks).toEqual([2, 2, 2])
  })

  it('L12: one thunk array reused across three batches invokes each thunk once per batch', async () => {
    const calls = [0, 0, 0]
    const tasks = calls.map((_unused, index) => (): Promise<string> => {
      calls[index] = (calls[index] ?? 0) + 1
      return Promise.resolve(`v${index}`)
    })

    for (let run = 1; run <= 3; run += 1) {
      const outcomes = await runBounded(tasks, 2)
      expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2'])
      expect(calls).toEqual([run, run, run])
    }
    expect(calls).toEqual([3, 3, 3])
  })

  it('L12: consecutive batches are not throttled by each other (no module-level state)', async () => {
    const first = tracked(4)
    const firstBatch = runBounded(first.tasks, 2)
    expect(first.starts.length).toBe(2)
    await drive(first, [0, 1, 2, 3])
    await firstBatch
    expect(first.peak()).toBe(2)

    const second = tracked(4)
    const secondBatch = runBounded(second.tasks, 2)
    // Immediately, with nothing settled: a module-level semaphore left dirty by
    // the first batch would show up here as fewer than two starts.
    expect(second.starts.length).toBe(2)
    expect(second.finishes).toEqual([])
    await drive(second, [0, 1, 2, 3])
    await secondBatch

    expect(second.peak()).toBe(2)
  })

  it('L13: an empty task list resolves to an empty array and starts no worker', async () => {
    let pulls = 0
    const empty: (() => Promise<string>)[] = []
    // Counts how many workers reached the shared queue at all. With
    // `Math.min(limit, tasks.length)` that is zero; drop the `Math.min` and a
    // worker per slot is spawned and pulls, which this catches.
    Object.defineProperty(empty, 'entries', {
      value: function* (): Generator<[number, () => Promise<string>]> {
        pulls += 1
      },
    })

    const outcomes = await runBounded(empty, 4)

    expect(outcomes).toEqual([])
    expect(pulls).toBe(0)
  })

  it('L13: a limit above the task count starts every task and no more workers than tasks', async () => {
    const harness = tracked(3)
    const batch = runBounded(harness.tasks, 10)

    expect(harness.starts).toEqual([0, 1, 2])
    await drive(harness, [2, 0, 1])
    const outcomes = await batch

    expect(harness.peak()).toBe(3)
    expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2'])
  })

  it('L13: an invalid limit rejects with RangeError and starts nothing', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const harness = tracked(3)
      await expect(runBounded(harness.tasks, limit)).rejects.toThrow(RangeError)
      // Validated before anything runs — this is what makes that claim checkable.
      expect(harness.starts).toEqual([])
    }
  })

  it('L13: mapBounded passes (item, index) and returns outcomes in item order', async () => {
    const harness = tracked(3)
    const seen: [string, number][] = []
    const batch = mapBounded(
      ['a', 'b', 'c'],
      (item, index) => {
        seen.push([item, index])
        return taskAt(harness, index)()
      },
      3,
    )

    for (const index of [2, 0, 1]) harness.settle(index)
    const outcomes = await batch

    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
    expect(harness.finishes).toEqual([2, 0, 1])
    expect(rendered(outcomes)).toEqual(['v0', 'v1', 'v2'])
  })

  it('L14: a task that never settles holds exactly one slot and is never force-settled', async () => {
    const harness = tracked(4)
    const batch = runBounded(harness.tasks, 2)
    let settled = false
    void batch.then(() => {
      settled = true
    })

    await flush()
    // Bounding a hung child is `withTimeout`'s job (`server/exec.ts`), wired at
    // `poll-loop.ts:91`. This module deliberately grows no second timer, so a
    // pending task stays pending and holds its one slot.
    expect(settled).toBe(false)
    expect(harness.starts).toEqual([0, 1])
    expect(harness.inFlight()).toBe(2)

    // Leave nothing pending behind this law.
    await drive(harness, [0, 1, 2, 3])
    await batch
    expect(settled).toBe(true)
  })

  it('L14: the module imports nothing and has no timer or cancellation story', () => {
    const source = readFileSync(path.join(HERE, 'concurrency.ts'), 'utf8')

    // Three DoD bullets in one place: no dependency was added, `exec.ts` is
    // neither imported nor re-implemented, and there is no second timeout.
    expect(source).not.toMatch(/^\s*import\b/m)
    expect(source).not.toMatch(/^\s*export\s+[^\n]*\bfrom\b/m)
    for (const forbidden of ['require(', 'setTimeout', 'setInterval', 'setImmediate', 'AbortController', 'AbortSignal']) {
      expect(source).not.toContain(forbidden)
    }
    // Guard the guard: the file really was read.
    expect(source).toContain('export function mapBounded')
  })

  it('L15: these laws are not enrolled in the gate timing set, and hold no clock', () => {
    const thisFile = fileURLToPath(import.meta.url)
    const source = readFileSync(thisFile, 'utf8')

    // `scripts/gate.sh` builds its 4x-load timing pass from two spellings: a
    // `*.bench.test.ts` filename, and the opt-in marker grepped as a FIXED
    // string with its two-slash comment prefix attached. Either one puts these
    // laws under 4x contention and ratchets `.swarm/timing-count`, which only a
    // human can clear — and prd-44's grooming amendment forbids both for this
    // file. Every needle below is assembled from pieces so that this law does
    // not itself trip the guard it is enforcing.
    expect(path.basename(thisFile)).toBe('concurrency.test.ts')
    expect(thisFile.endsWith('.bench.test.ts')).toBe(false)
    expect(source).not.toContain(`${'//'} ${'@'}gate-timing`)

    // And the reason there is nothing to enrol: no law here reads a clock.
    for (const clock of [`Date${'.'}now`, `performance${'.'}now`, `process${'.'}hrtime`, `vi${'.'}useFakeTimers`]) {
      expect(source).not.toContain(clock)
    }
  })
})
