import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../../drawer/useTranscript.js'
import { diffSteps } from './diff.js'
import { maskPaths, stepKey, toSteps } from './steps.js'

function say(role: TranscriptEntry['role'], text: string): TranscriptEntry {
  return { role, blocks: [{ kind: 'text', text }] }
}

function tool(name: string, hint: string): TranscriptEntry {
  return { role: 'assistant', blocks: [{ kind: 'tool_use', name, hint }] }
}

const HISTORY: TranscriptEntry[] = [
  say('user', 'fix the summariser'),
  say('assistant', 'reading /home/x/repo/src/summarise.ts'),
  say('assistant', 'the floor is wrong'),
]

describe('steps — a step is who spoke and what, with absolute paths masked down to the file (prd12 ruling 5; prd-55 w3, #384)', () => {
  it("the parent's step and the arm's path-rewritten copy of it are the SAME step", () => {
    const parent = say('assistant', 'reading /home/x/repo/src/summarise.ts')
    const arm = say('assistant', 'reading /data/lab/worktrees/fork-1-arm-1/src/summarise.ts')
    expect(stepKey(parent)).toBe(stepKey(arm))
  })

  it('but a different sentence is a different step, and a different speaker is too', () => {
    expect(stepKey(say('assistant', 'reading /a/b'))).not.toBe(stepKey(say('assistant', 'writing /a/b')))
    expect(stepKey(say('assistant', 'ok'))).not.toBe(stepKey(say('user', 'ok')))
  })

  it("two arms reading two different files are two different steps — the file survives the mask (the wave-3 review's finding)", () => {
    expect(stepKey(say('assistant', 'read /repo/a.ts'))).not.toBe(stepKey(say('assistant', 'read /fork/b.ts')))
    // The same through a tool call's hint, which is where a file is usually named.
    expect(stepKey(tool('Read', '/repo/a.ts'))).not.toBe(stepKey(tool('Read', '/fork/b.ts')))
    // While the same file under two worktrees is still one step.
    expect(stepKey(tool('Read', '/repo-wt/feature/src/a.ts'))).toBe(stepKey(tool('Read', '/data/lab/worktrees/fork-1-arm-1/src/a.ts')))
  })

  it('a bare directory — the worktree root itself, which the restore rewrites — masks whole, so `cd <worktree>` is one step on both sides', () => {
    expect(maskPaths('cd /repo-wt/feature && npm test')).toBe(maskPaths('cd /data/lab/worktrees/fork-1-arm-1 && npm test'))
    expect(maskPaths('cd /repo-wt/feature && npm test')).toBe('cd /… && npm test')
  })

  it('masks every absolute path and nothing else, keeping the file-shaped tail', () => {
    expect(maskPaths('see /home/x/a.ts and /tmp/b then a/relative one')).toBe('see /…/a.ts and /… then a/relative one')
  })

  it('keeps every step, in order, with its index', () => {
    expect(toSteps(HISTORY).map((step) => [step.index, step.role])).toEqual([
      [0, 'user'],
      [1, 'assistant'],
      [2, 'assistant'],
    ])
  })
})

describe('diffSteps — where an arm left the parent behind (prd53 S3)', () => {
  it('row 0 is the fork row and is `same` by construction — the last step the two share', () => {
    const parent = toSteps([...HISTORY, say('assistant', 'parent goes on')])
    const arm = toSteps([...HISTORY, say('assistant', 'arm goes elsewhere')])
    const diff = diffSteps(parent, arm)
    expect(diff.forkAt).toBe(3)
    expect(diff.rows[0]).toMatchObject({ index: 0, kind: 'same' })
    expect(diff.rows[0]?.arm?.text).toBe('the floor is wrong')
  })

  it('a step both have that differs is `diverged`; one only the arm has is `added`; one only the parent has is `absent`', () => {
    const parent = toSteps([...HISTORY, say('assistant', 'parent step A'), say('assistant', 'parent step B')])
    const arm = toSteps([...HISTORY, say('assistant', 'arm step A')])
    const kinds = diffSteps(parent, arm).rows.map((row) => row.kind)
    expect(kinds).toEqual(['same', 'diverged', 'absent'])

    // Here the shared history runs through "parent step A", so THAT is the fork
    // row; the arm's extra step is the first thing after it.
    const longerArm = toSteps([...HISTORY, say('assistant', 'parent step A'), say('assistant', 'extra')])
    const parentShort = toSteps([...HISTORY, say('assistant', 'parent step A')])
    expect(diffSteps(parentShort, longerArm).rows.map((row) => row.kind)).toEqual(['same', 'added'])
  })

  it('two arms that read different files after the fork are `diverged`, not `same`', () => {
    const parent = toSteps([...HISTORY, tool('Read', '/repo-wt/feature/a.ts')])
    const arm = toSteps([...HISTORY, tool('Read', '/data/lab/worktrees/fork-1-arm-1/b.ts')])
    expect(diffSteps(parent, arm).rows.map((row) => row.kind)).toEqual(['same', 'diverged'])
  })

  it("a dead arm's last row has no successor — every row after it is the parent's alone, and nothing dashes forward", () => {
    const parent = toSteps([...HISTORY, say('assistant', 'p1'), say('assistant', 'p2'), say('assistant', 'p3')])
    const arm = toSteps([...HISTORY, say('assistant', 'p1')])
    const rows = diffSteps(parent, arm).rows
    const lastArmRow = rows.map((row) => row.arm !== null).lastIndexOf(true)
    expect(rows.slice(lastArmRow + 1).every((row) => row.arm === null && row.kind === 'absent')).toBe(true)
    expect(rows.slice(lastArmRow + 1)).toHaveLength(2)
  })

  it('at the fork — an arm that has not moved — every row is `same`', () => {
    const steps = toSteps(HISTORY)
    expect(diffSteps(steps, steps).rows.map((row) => row.kind)).toEqual(['same'])
  })

  it('an arm with no shared history has no fork row — nothing is invented to make one', () => {
    const diff = diffSteps(toSteps([say('user', 'a')]), toSteps([say('user', 'b')]))
    expect(diff.forkAt).toBe(0)
    expect(diff.rows.map((row) => row.kind)).toEqual(['diverged'])
  })

  it('alignment is by content, not by byte — a path-rewritten copy still shares its whole history', () => {
    const parent = toSteps([say('assistant', 'reading /home/x/repo/a.ts'), say('assistant', 'done')])
    const arm = toSteps([say('assistant', 'reading /data/lab/worktrees/fork-1-arm-1/a.ts'), say('assistant', 'done')])
    expect(diffSteps(parent, arm).forkAt).toBe(2)
  })
})
