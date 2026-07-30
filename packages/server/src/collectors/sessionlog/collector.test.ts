import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectorContext, Exec, ExecResult } from '@observatory/core'
import { createEvent } from '@observatory/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionlogCollector } from './collector.js'
import { worktreePathToProjectSlug } from './worktree-slug.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(dirname, 'fixtures')

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8')
}

function worktreeListOutput(paths: readonly string[]): string {
  return paths
    .map((worktreePath) => `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/main\n`)
    .join('\n')
}

function makeContext(exec: Exec, repoPath = '/repo', now = 1_000): CollectorContext {
  let counter = 0
  return {
    repoPath,
    now,
    exec,
    nextId: () => `id-${(counter += 1)}`,
    emit: (type, payload) => createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: now }),
  }
}

const missingBinary = (): ExecResult => ({
  stdout: '',
  stderr: '',
  code: null,
  failed: true,
  errorMessage: 'spawn git ENOENT',
})

const success = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0, failed: false })

describe('createSessionlogCollector', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sessionlog-collector-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('disables itself once when the claude projects root does not exist, never crashing', async () => {
    const collector = createSessionlogCollector({
      claudeProjectsRoot: path.join(root, 'does-not-exist'),
    })
    const gitExec: Exec = async () => success(worktreeListOutput(['/repo']))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.nextSnapshot.disabled).toBe(true)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({
      source: 'system',
      type: 'collector.disabled',
      payload: { collector: 'sessionlog' },
    })

    let execCalls = 0
    const countingExec: Exec = async () => {
      execCalls += 1
      return success(worktreeListOutput(['/repo']))
    }
    const second = await collector.poll(first.nextSnapshot, makeContext(countingExec))
    expect(second.events).toEqual([])
    expect(second.nextSnapshot).toBe(first.nextSnapshot)
    expect(execCalls).toBe(0)
  })

  it('disables itself once when git worktree list fails', async () => {
    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const context = makeContext(async () => missingBinary())

    const result = await collector.poll(collector.initialSnapshot(), context)
    expect(result.nextSnapshot.disabled).toBe(true)
    expect(result.events[0]?.payload).toMatchObject({
      collector: 'sessionlog',
      reason: 'spawn git ENOENT',
    })
  })

  it('skips a worktree with no session dir yet, then discovers it once one appears', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.events).toEqual([])

    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    expect(second.events.some((e) => e.type === 'llm.usage')).toBe(true)
  })

  it('emits llm.usage once per requestId and tool.activity per tool_use, attributing role: worker', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const slug = worktreePathToProjectSlug(worktreePath)
    const projectDir = path.join(root, slug)
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '14442c1b-664e-4d26-9b0b-3009a5d69183.jsonl'),
      await readFixture('worker-4-tmux-collector.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    const tools = result.events.filter((e) => e.type === 'tool.activity')

    // 3 lines share one requestId (the Read triple), 1 line has another (Bash).
    expect(usage).toHaveLength(2)
    expect(tools).toHaveLength(4)
    expect(tools.map((e) => (e.payload as { tool: string }).tool)).toEqual([
      'Read',
      'Read',
      'Read',
      'Bash',
    ])

    for (const event of [...usage, ...tools]) {
      expect(event.source).toBe('sessionlog')
      expect(event.payload).toMatchObject({
        lane: '4-tmux-collector',
        role: 'worker',
        worktreePath, // the discovered worktree root, not the log's own (possibly nested) cwd
        branch: '4-tmux-collector',
      })
    }

    expect(usage[0]?.payload).toMatchObject({
      model: 'claude-sonnet-5',
      requestId: 'req_011CdXKgL7B2nj6xkUSoy4tk',
      tokens: { input: 2, output: 275, cacheRead: 29434, cacheCreation: 10201 },
    })
    expect(usage[1]?.payload).toMatchObject({
      requestId: 'req_011CdXKgfbwmprh37TF3u2MZ',
      tokens: { input: 2, output: 169, cacheRead: 39635, cacheCreation: 4476 },
    })
  })

  it('attributes role: conductor for sessions under an extra session dir', async () => {
    const conductorPath = '/fake/conductor/cwd'
    const projectDir = path.join(root, worktreePathToProjectSlug(conductorPath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [conductorPath],
    })
    const gitExec: Exec = async () => success(worktreeListOutput(['/fake/worktrees/alpha']))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      role: 'conductor',
      lane: 'main',
      worktreePath: conductorPath,
    })
  })

  it('only parses new lines across polls, and dedupes usage for a reply split across polls', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl')

    const fixtureLines = (await readFixture('worker-2-core.jsonl')).split('\n').filter(Boolean)
    // First poll only sees the reply's text block (no newline yet on the second line).
    await writeFile(filePath, `${fixtureLines[0]}\n`, 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.events.filter((e) => e.type === 'llm.usage')).toHaveLength(1)
    expect(first.events.filter((e) => e.type === 'tool.activity')).toHaveLength(0)

    // Second poll: the tool_use line lands, repeating the same requestId/usage.
    await writeFile(filePath, `${fixtureLines[0]}\n${fixtureLines[1]}\n`, 'utf8')
    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))

    expect(second.events.filter((e) => e.type === 'llm.usage')).toHaveLength(0)
    const tools = second.events.filter((e) => e.type === 'tool.activity')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.payload).toMatchObject({ tool: 'Read' })
  })

  it('discovers a rotated/new session file dropped into an already-watched project dir', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, 'session-one.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.events.filter((e) => e.type === 'llm.usage')).toHaveLength(1)

    await writeFile(
      path.join(projectDir, 'session-two.jsonl'),
      await readFixture('worker-4-tmux-collector.jsonl'),
      'utf8',
    )
    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    expect(second.events.filter((e) => e.type === 'llm.usage')).toHaveLength(2)
  })
})
