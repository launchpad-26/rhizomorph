import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, type CollectorContext, type Exec } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPiCollector } from './collector.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const NO_WORKTREES: Exec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

function makeContext(exec: Exec, now = 2_000): CollectorContext {
  let counter = 0
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId: () => `id-${(counter += 1)}`,
    emit: (type, payload, options) =>
      createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: options?.ts === undefined ? now : Math.floor(options.ts) }),
  }
}

describe('createPiCollector', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pi-collector-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('disables itself, once, when the pi sessions root does not exist', async () => {
    const missingRoot = path.join(root, 'does-not-exist')
    const collector = createPiCollector({ piSessionsRoot: missingRoot })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    expect(result.nextSnapshot.disabled).toBe(true)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'collector.disabled',
        payload: { collector: 'pi', reason: `no pi session directory at ${missingRoot}` },
      }),
    ])
  })

  it('a real turn-complete session: llm.usage and llm.cost carry harness "pi", the header cwd as lane, and no tool.activity', async () => {
    await writeFile(
      path.join(root, 'turn-complete.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    const usage = result.events.filter((event) => event.type === 'llm.usage')
    const cost = result.events.filter((event) => event.type === 'llm.cost')
    const activity = result.events.filter((event) => event.type === 'tool.activity')

    expect(usage).toHaveLength(1)
    expect(usage[0]!.source).toBe('sessionlog')
    expect(usage[0]!.payload).toMatchObject({
      lane: 'pi-capture',
      sessionId: '00000000-0000-0000-0000-000000000000',
      worktreePath: '/repo-wt/pi-capture',
      branch: null,
      harness: 'pi',
      model: 'anthropic/claude-haiku-4.5',
      tokens: { input: 1974, output: 38, cacheRead: 0, cacheCreation: 0 },
    })

    expect(cost).toHaveLength(1)
    expect(cost[0]!.source).toBe('sessionlog')
    expect(cost[0]!.payload).toMatchObject({
      lane: 'pi-capture',
      harness: 'pi',
      costUsd: 0.002164,
      authoritative: true,
    })

    expect(activity).toHaveLength(0)
  })

  it('a real tool-call session: one tool.activity for the bash call, two llm.usage/llm.cost pairs (open + close)', async () => {
    await writeFile(
      path.join(root, 'tool-call.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-tool-call.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    expect(result.events.filter((event) => event.type === 'llm.usage')).toHaveLength(2)
    expect(result.events.filter((event) => event.type === 'llm.cost')).toHaveLength(2)

    const activity = result.events.filter((event) => event.type === 'tool.activity')
    expect(activity).toHaveLength(1)
    expect(activity[0]!.payload).toMatchObject({
      lane: 'pi-capture',
      tool: 'bash',
      harness: 'pi',
      filePath: null,
      toolUseId: 'toolu_bdrk_016XrSLLjoF4jw1vmVpAKdwp',
    })
  })

  it('a real write-tool session: tool.activity carries the file tool\'s own "path" argument, repo-relative to the worktree', async () => {
    await writeFile(
      path.join(root, 'write-tool.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-write-tool.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    const activity = result.events.filter((event) => event.type === 'tool.activity')
    expect(activity.length).toBeGreaterThan(0)
    const write = activity.find((event) => (event.payload as { tool: string }).tool === 'write')
    expect(write).toBeDefined()
    const filePath = (write!.payload as { filePath: string | null }).filePath
    expect(filePath).not.toBeNull()
    expect(path.isAbsolute(filePath!)).toBe(false)
  })

  it('backfill defaults to off: a session already on disk before first sight is not read from byte 0', async () => {
    await writeFile(
      path.join(root, 'turn-complete.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    expect(result.events.filter((event) => event.type === 'llm.usage' || event.type === 'llm.cost')).toHaveLength(0)
  })

  it('walks nested directories under the root — no directory-naming convention is assumed', async () => {
    const nested = path.join(root, 'some-cwd-slug', 'deeper')
    await mkdir(nested, { recursive: true })
    await writeFile(
      path.join(nested, 'session.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    expect(result.events.some((event) => event.type === 'llm.usage')).toBe(true)
  })

  it('a lane resolves to "unattributed" when the header carries no readable cwd, never a crash', async () => {
    await writeFile(
      path.join(root, 'headerless.jsonl'),
      '{"type":"message","id":"a","parentId":null,"timestamp":"2026-08-14T05:31:58.969Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1786685518968}}\n',
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(NO_WORKTREES))

    expect(result.events).toEqual([])
    expect(result.nextSnapshot.disabled).toBe(false)
  })
})
