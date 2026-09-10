import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import type { MeasureFetchLike, MeasureOutcome } from '../measure.js'
import type { LabExperiment } from '../types.js'
import { DEFAULT_GATE_COMMAND, MeasureControl, worktreeCount } from './MeasureControl.js'

/**
 * MEASURING IS A CONTROL (prd-55 ruling 7). Two halves: the behaviour a person
 * meets — the default, the one confirmation naming the worktree count, the
 * verbatim refusal, the hand-up on success — and a grep half over this
 * directory's own source, in the shape `launch/explicit-invocation-law.test.ts`
 * uses for the launch: the write is reached from exactly one call site, wired
 * to the confirm click, with no clock anywhere near it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..', '..')

afterEach(cleanup)

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (ADR-0012) — `measure.ts` refuses before the wire without it. */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

function run(id: string, n: number) {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: `/tmp/${id}` }
}

/** Two arms × two runs — four worktrees, which is the number the confirmation has to say. */
const EXPERIMENT: LabExperiment = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a1', 1), run('a2', 2)] },
    { arm: 2, treatment: { model: 'sonnet', promptDigest: null }, runs: [run('b1', 1), run('b2', 2)] },
  ],
}

const OUTCOME: MeasureOutcome = {
  forkId: 'fork-1',
  verifyCommand: 'npm test',
  measured: [
    { arm: 1, run: 1, laneHandle: 'lane-a1', verified: 'pass', verifiedDetail: null, commits: 2 },
    { arm: 1, run: 2, laneHandle: 'lane-a2', verified: 'fail', verifiedDetail: '3 tests failed', commits: 1 },
    { arm: 2, run: 1, laneHandle: 'lane-b1', verified: 'pass', verifiedDetail: null, commits: 4 },
    { arm: 2, run: 2, laneHandle: 'lane-b2', verified: 'not-run', verifiedDetail: 'worktree missing', commits: null },
  ],
}

function answering(payload: unknown, status = 200): MeasureFetchLike {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })) as unknown as MeasureFetchLike
}

function sentBody(impl: MeasureFetchLike): Record<string, unknown> {
  const [, init] = (impl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
  return JSON.parse(init.body) as Record<string, unknown>
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('MeasureControl — measuring is a control (prd-55 ruling 7)', () => {
  it("the gate command defaults to the CLI's own --verify default, and the two are the same string", () => {
    render(<MeasureControl experiment={EXPERIMENT} />)
    expect(screen.getByTestId('measure-command-fork-1')).toHaveValue('npm test')
    expect(DEFAULT_GATE_COMMAND).toBe('npm test')
    // A web module may not import the server, so the default is restated;
    // this is the pin that keeps the restatement honest.
    expect(readFileSync(path.join(REPO, 'packages', 'server', 'src', 'cli', 'lab-compare.ts'), 'utf8')).toContain("const DEFAULT_VERIFY = 'npm test'")
  })

  it('the measure button never posts on its own — one confirmation, naming how many worktrees the gate will run in, stands between it and the route', async () => {
    const impl = answering(OUTCOME)
    render(<MeasureControl experiment={EXPERIMENT} measureFetchImpl={impl} />)

    await click(screen.getByTestId('measure-fork-1'))
    expect(impl).not.toHaveBeenCalled()
    const dialog = screen.getByTestId('measure-confirm-dialog-fork-1')
    // The count is the claim: four runs across two arms, four worktrees, four
    // gates. A confirmation that does not say the number is not the
    // confirmation ruling 7 asks for — the mutation is one interpolation.
    expect(dialog).toHaveTextContent('in 4 worktrees')
    expect(dialog).toHaveTextContent('npm test')
    expect(screen.getByTestId('measure-confirm-fork-1')).toHaveTextContent('measure 4 worktrees')

    await click(screen.getByTestId('measure-confirm-fork-1'))
    await waitFor(() => expect(screen.getByTestId('measure-result-fork-1')).toBeInTheDocument())
    expect(impl).toHaveBeenCalledTimes(1)
    expect(sentBody(impl)).toEqual({ forkId: 'fork-1', verifyCommand: 'npm test' })
  })

  it('cancelling the confirmation returns to the field without posting', async () => {
    const impl = answering(OUTCOME)
    render(<MeasureControl experiment={EXPERIMENT} measureFetchImpl={impl} />)
    await click(screen.getByTestId('measure-fork-1'))
    await click(screen.getByTestId('measure-cancel-fork-1'))
    expect(screen.queryByTestId('measure-confirm-dialog-fork-1')).toBeNull()
    expect(impl).not.toHaveBeenCalled()
  })

  it("the field's command is what travels, trimmed, and the confirmation names it", async () => {
    const impl = answering({ ...OUTCOME, verifyCommand: 'npm run gate' })
    render(<MeasureControl experiment={EXPERIMENT} measureFetchImpl={impl} />)
    fireEvent.change(screen.getByTestId('measure-command-fork-1'), { target: { value: '  npm run gate ' } })
    await click(screen.getByTestId('measure-fork-1'))
    expect(screen.getByTestId('measure-confirm-dialog-fork-1')).toHaveTextContent('Run npm run gate in 4 worktrees')
    await click(screen.getByTestId('measure-confirm-fork-1'))
    await waitFor(() => expect(screen.getByTestId('measure-result-fork-1')).toBeInTheDocument())
    expect(sentBody(impl)).toEqual({ forkId: 'fork-1', verifyCommand: 'npm run gate' })
  })

  it('a blank field sends no command at all — the server default rules and is what the record names', async () => {
    const impl = answering(OUTCOME)
    render(<MeasureControl experiment={EXPERIMENT} measureFetchImpl={impl} />)
    fireEvent.change(screen.getByTestId('measure-command-fork-1'), { target: { value: '   ' } })
    await click(screen.getByTestId('measure-fork-1'))
    expect(screen.getByTestId('measure-confirm-dialog-fork-1')).toHaveTextContent(`Run ${DEFAULT_GATE_COMMAND} in 4 worktrees`)
    await click(screen.getByTestId('measure-confirm-fork-1'))
    await waitFor(() => expect(screen.getByTestId('measure-result-fork-1')).toBeInTheDocument())
    expect(sentBody(impl)).toEqual({ forkId: 'fork-1' })
  })

  it('success reports what was measured, verdict by verdict, and hands the outcome up so the workspace re-reads', async () => {
    const onMeasured = vi.fn()
    render(<MeasureControl experiment={EXPERIMENT} measureFetchImpl={answering(OUTCOME)} onMeasured={onMeasured} />)
    await click(screen.getByTestId('measure-fork-1'))
    await click(screen.getByTestId('measure-confirm-fork-1'))
    await waitFor(() => expect(screen.getByTestId('measure-result-fork-1')).toBeInTheDocument())
    expect(screen.getByTestId('measure-result-fork-1')).toHaveTextContent('measured 4 runs with npm test — 2 passed, 1 failed, 1 not run')
    expect(onMeasured).toHaveBeenCalledTimes(1)
    expect(onMeasured).toHaveBeenCalledWith(OUTCOME)
  })

  it("a refusal renders the server's own message, verbatim, and nothing is handed up", async () => {
    const onMeasured = vi.fn()
    const message = 'no fork "fork-1" is recorded — nothing to compare (prd53 ruling 3)'
    render(<MeasureControl experiment={EXPERIMENT} measureFetchImpl={answering({ error: message }, 404)} onMeasured={onMeasured} />)
    await click(screen.getByTestId('measure-fork-1'))
    await click(screen.getByTestId('measure-confirm-fork-1'))
    await waitFor(() => expect(screen.getByTestId('measure-error-fork-1')).toBeInTheDocument())
    expect(screen.getByTestId('measure-error-fork-1')).toHaveTextContent(message)
    expect(screen.getByTestId('measure-error-fork-1').className).toContain('text-broken')
    expect(onMeasured).not.toHaveBeenCalled()
    expect(screen.queryByTestId('measure-result-fork-1')).toBeNull()
  })

  it('the worktree count is every run of every arm — and with none dispatched there is nothing to measure, said so', () => {
    expect(worktreeCount(EXPERIMENT)).toBe(4)
    const bare: LabExperiment = { ...EXPERIMENT, forkId: 'fork-2', arms: [{ arm: 1, treatment: { model: null, promptDigest: null }, runs: [] }] }
    expect(worktreeCount(bare)).toBe(0)
    render(<MeasureControl experiment={bare} />)
    expect(screen.getByTestId('measure-fork-2')).toBeDisabled()
    expect(screen.getByTestId('measure-nothing-fork-2')).toHaveTextContent('nothing to measure')
  })
})

describe('the measure control reaches the route from exactly one place, behind the confirm click, with no clock (grep)', () => {
  const source = readFileSync(path.join(HERE, 'MeasureControl.tsx'), 'utf8')

  it('requestMeasure is called once, from confirmMeasure, which only the confirm button invokes', () => {
    expect(source.match(/\brequestMeasure\s*\(/g) ?? []).toHaveLength(1)
    expect(source).toMatch(/onClick=\{\(\)\s*=>\s*void confirmMeasure\(\)\}/)
    // The measure button itself only opens the confirmation.
    expect(source).toMatch(/data-testid=\{`measure-\$\{id\}`\}\s+onClick=\{\(\)\s*=>\s*setPhase\(\{ status: 'confirming' \}\)\}/)
    expect(source.match(/confirmMeasure\(\)/g) ?? []).toHaveLength(1)
  })

  it('has no clock of its own, and no useEffect — a measurement never fires without an incoming click', () => {
    expect(source).not.toMatch(/\b(setInterval|setTimeout|setImmediate)\s*\(/)
    expect(source).not.toMatch(/\buseEffect\b/)
  })

  it('names neither the verb nor the route — `../measure.js` is the one module that does (replay/mutating-calls-law)', () => {
    expect(source).toContain("from '../measure.js'")
    expect(source).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/)
    expect(source).not.toContain('/api/lab/')
    expect(source).not.toMatch(/\bmethod\s*:/)
  })
})
