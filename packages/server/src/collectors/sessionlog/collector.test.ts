import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
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
    emit: (type, payload, options) =>
      createEvent(type, payload, {
        id: `id-${(counter += 1)}`,
        ts: options?.ts === undefined ? now : Math.floor(options.ts),
      }),
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

  it('skips a worktree with no session dir yet, then sees the file once one appears (EOF-started, no backfill)', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.events).toEqual([])

    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl')
    await writeFile(filePath, await readFixture('worker-2-core.jsonl'), 'utf8')

    // First sight of a file that already has content on disk: no backfill
    // requested, so it seeks to EOF and emits nothing for what's already there.
    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    expect(second.events).toEqual([])

    // A line appended after first sight is new activity and is emitted.
    await writeFile(filePath, `${await readFixture('worker-2-core.jsonl')}${await readFixture('conductor-root.jsonl')}`, 'utf8')
    const third = await collector.poll(second.nextSnapshot, makeContext(gitExec))
    expect(third.events.filter((e) => e.type === 'llm.usage')).toHaveLength(1)
  })

  it('reads a newly discovered file from byte 0 when backfill: true is set', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))

    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(result.events.some((e) => e.type === 'llm.usage')).toBe(true)
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    // '/repo' is the main working tree (first porcelain entry); listing it
    // ahead of `worktreePath` here is what makes alpha a genuine *linked*
    // worktree instead of accidentally being read as the root.
    const gitExec: Exec = async () => success(worktreeListOutput(['/repo', worktreePath]))
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
    // filePath/toolUseId (prd11 ruling 2): the fixture's file_path lives under
    // the real worktree the session ran in, not the fake one `alpha` tails
    // here — honest raw paths, never a guessed rewrite, and Bash stays null.
    expect(tools.map((e) => (e.payload as { filePath: string | null }).filePath)).toEqual([
      '/home/operator/worktrees-challenge__worktrees/4-tmux-collector/docs/vision.md',
      '/home/operator/worktrees-challenge__worktrees/4-tmux-collector/docs/prd0.md',
      '/home/operator/worktrees-challenge__worktrees/4-tmux-collector/docs/architecture.md',
      null,
    ])
    expect(tools.map((e) => (e.payload as { toolUseId: string | null }).toolUseId)).toEqual([
      'toolu_019fAq2GB1eeu9rh63n1BfU6',
      'toolu_01BNpUfRjed6SWA9Se4HGWY3',
      'toolu_01SzR2F33CgoyztWPJ6thcC1',
      'toolu_016mhV6ZLsSUsgv9fAENhG3A',
    ])

    for (const event of [...usage, ...tools]) {
      expect(event.source).toBe('sessionlog')
      expect(event.payload).toMatchObject({
        lane: '4-tmux-collector',
        role: 'worker',
        worktreePath, // the discovered worktree root, not the log's own (possibly nested) cwd
        branch: '4-tmux-collector',
        thread: 'main', // none of this fixture's lines are marked isSidechain: true
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

    // Each event carries the fixture line's own timestamp, not the tick clock.
    expect(usage[0]?.ts).toBe(Date.parse('2026-07-30T00:49:19.094Z'))
    expect(usage[1]?.ts).toBe(Date.parse('2026-07-30T00:49:22.966Z'))
    expect(tools.map((e) => e.ts)).toEqual([
      Date.parse('2026-07-30T00:49:19.094Z'),
      Date.parse('2026-07-30T00:49:19.457Z'),
      Date.parse('2026-07-30T00:49:19.739Z'),
      Date.parse('2026-07-30T00:49:22.966Z'),
    ])

    // prd15's capability law: `telemetry`/`activity: provided` need a real
    // path that emits them — `llm.usage`/`tool.activity` above just proved
    // it. `attention` stays `partial` (inferred, not declared) since this
    // poll never emits `agent.status` — see `lane-state.ts`'s BLOCKED note.
    expect(collector.capabilities?.telemetry).toEqual({ level: 'provided' })
    expect(collector.capabilities?.activity).toEqual({ level: 'provided' })
    expect(collector.capabilities?.attention.level).toBe('partial')
    expect(result.events.some((e) => e.type === 'agent.status')).toBe(false)
  })

  it('normalizes filePath to repo-relative when it sits under the lane\'s own worktree (prd11 ruling 2)', async () => {
    // worker-2-core.jsonl's tool_use reports
    // /home/operator/worktrees-challenge__worktrees/2-core/docs/vision.md — real
    // capture from a session that ran with that exact cwd as its worktree.
    const worktreePath = '/home/operator/worktrees-challenge__worktrees/2-core'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.payload).toMatchObject({ tool: 'Read', filePath: 'docs/vision.md' })
  })

  it('keeps the raw path when it does not sit under the lane\'s worktree — no guessed rewrite', async () => {
    // Same fixture, tailed as a *different* worktree than the one the session
    // actually ran with: the reported file_path is honestly outside it.
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.payload).toMatchObject({
      tool: 'Read',
      filePath: '/home/operator/worktrees-challenge__worktrees/2-core/docs/vision.md',
    })
  })

  it('emits thread: "subagent" for an isSidechain: true line, on both llm.usage and tool.activity (#65)', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    // The real fixture's lines are all isSidechain: false — flip it to simulate
    // a Task/subagent turn, the marker shape actually seen in captured JSONL
    // (fixtures/conductor-root.jsonl:1) rather than inventing a new shape.
    const sidechainFixture = (await readFixture('worker-2-core.jsonl')).replaceAll(
      '"isSidechain":false',
      '"isSidechain":true',
    )
    await writeFile(
      path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      sidechainFixture,
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(usage).toHaveLength(1)
    expect(tools).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ thread: 'subagent' })
    expect(tools[0]?.payload).toMatchObject({ thread: 'subagent' })
  })

  it('books the main working tree as unattributed while a linked worktree stays worker (#62)', async () => {
    const rootPath = '/repo'
    const linkedPath = '/fake/worktrees/alpha'
    const rootProjectDir = path.join(root, worktreePathToProjectSlug(rootPath))
    const linkedProjectDir = path.join(root, worktreePathToProjectSlug(linkedPath))
    await mkdir(rootProjectDir, { recursive: true })
    await mkdir(linkedProjectDir, { recursive: true })
    // Same fixture content in both dirs: any role/lane difference below comes
    // from which worktree it was tailed from, not from the log content.
    await writeFile(
      path.join(rootProjectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )
    await writeFile(
      path.join(linkedProjectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    // '/repo' is listed first — git worktree list --porcelain always puts the
    // main working tree first, then linked worktrees in creation order.
    const gitExec: Exec = async () => success(worktreeListOutput([rootPath, linkedPath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter(
      (e): e is typeof e & { payload: { worktreePath: string } } => e.type === 'llm.usage',
    )
    expect(usage).toHaveLength(2)

    const rootUsage = usage.find((e) => e.payload.worktreePath === rootPath)
    const linkedUsage = usage.find((e) => e.payload.worktreePath === linkedPath)

    expect(rootUsage?.payload).toMatchObject({ role: 'unattributed', lane: 'unattributed' })
    // The linked worktree's lane is still inferred from the log's own gitBranch/cwd.
    expect(linkedUsage?.payload).toMatchObject({ role: 'worker', lane: '2-core' })
  })

  it('keeps a root worktree declared via --extra-sessions at its declared role/lane, never falling back to unattributed, and tails it exactly once (#62)', async () => {
    const rootPath = '/repo'
    const rootProjectDir = path.join(root, worktreePathToProjectSlug(rootPath))
    await mkdir(rootProjectDir, { recursive: true })
    await writeFile(
      path.join(rootProjectDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [`${rootPath}:conductor`],
      backfill: true,
    })
    // Only the root is listed — a single-entry porcelain output is still the
    // main working tree, and the operator's declaration must win over it.
    const gitExec: Exec = async () => success(worktreeListOutput([rootPath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    // Exactly one event, not two: the auto-discovered root entry must not
    // also tail the same project dir alongside the declared extra-session one.
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      role: 'conductor',
      lane: 'conductor',
      worktreePath: rootPath,
    })
  })

  it('attributes role: conductor and the default "conductor" lane for sessions under an extra session dir with no explicit lane', async () => {
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
      backfill: true,
    })
    const gitExec: Exec = async () => success(worktreeListOutput(['/fake/worktrees/alpha']))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      role: 'conductor',
      lane: 'conductor',
      worktreePath: conductorPath,
    })
  })

  it('tails an --extra-sessions path directly when it contains *.jsonl, no slugification, lane defaults to "conductor" (not the dir basename)', async () => {
    const conductorSessionDir = path.join(root, 'agenticlaunchpad')
    await mkdir(conductorSessionDir, { recursive: true })
    await writeFile(
      path.join(conductorSessionDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [conductorSessionDir],
      backfill: true,
    })
    const gitExec: Exec = async () => success(worktreeListOutput(['/fake/worktrees/alpha']))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    expect(result.events.some((e) => e.type === 'collector.error')).toBe(false)
    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      role: 'conductor',
      lane: 'conductor',
      worktreePath: conductorSessionDir,
    })
  })

  it('numbers the default lane conductor-2, conductor-3… for the second and third extra dir with no explicit lane', async () => {
    const dirs = await Promise.all(
      ['first', 'second', 'third'].map(async (name) => {
        const dir = path.join(root, name)
        await mkdir(dir, { recursive: true })
        await writeFile(
          path.join(dir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
          await readFixture('conductor-root.jsonl'),
          'utf8',
        )
        return dir
      }),
    )

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: dirs,
      backfill: true,
    })
    const gitExec: Exec = async () => success(worktreeListOutput([]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    expect(result.events.some((e) => e.type === 'collector.error')).toBe(false)
    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(3)
    expect(usage.map((e) => (e.payload as { lane: string }).lane)).toEqual([
      'conductor',
      'conductor-2',
      'conductor-3',
    ])
  })

  it('mixes an explicit :<lane> with default-numbered lanes across multiple extra dirs', async () => {
    const namedDir = path.join(root, 'named')
    const defaultedDir = path.join(root, 'defaulted')
    for (const dir of [namedDir, defaultedDir]) {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
        await readFixture('conductor-root.jsonl'),
        'utf8',
      )
    }

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [`${namedDir}:my-conductor`, defaultedDir],
      backfill: true,
    })
    const gitExec: Exec = async () => success(worktreeListOutput([]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(2)
    expect(usage.map((e) => (e.payload as { lane: string }).lane)).toEqual([
      'my-conductor',
      'conductor-2',
    ])
  })

  it('honours an explicit :<lane> suffix on a direct --extra-sessions path, overriding the dir basename', async () => {
    const conductorSessionDir = path.join(root, 'agenticlaunchpad')
    await mkdir(conductorSessionDir, { recursive: true })
    await writeFile(
      path.join(conductorSessionDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [`${conductorSessionDir}:my-conductor`],
      backfill: true,
    })
    const gitExec: Exec = async () => success(worktreeListOutput([]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ role: 'conductor', lane: 'my-conductor' })
  })

  it('emits one collector.error, not silence, when an --extra-sessions path resolves neither directly nor as a cwd slug', async () => {
    const bogusPath = path.join(root, 'never-created', 'bogus-conductor-dir')
    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [bogusPath],
    })
    const gitExec: Exec = async () => success(worktreeListOutput([]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.nextSnapshot.disabled).toBe(false) // a bogus extra dir must not disable the whole collector
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({
      source: 'system',
      type: 'collector.error',
      payload: { collector: 'sessionlog' },
    })
    expect((first.events[0]?.payload as { message: string }).message).toContain(bogusPath)

    // Second poll: the same bogus path must not spam another error.
    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    expect(second.events).toEqual([])
  })

  it('resolves the foreign-slug basename case without leaking the raw project-dir slug as the lane (Windows-shaped dir name a POSIX slug function could never produce)', async () => {
    // Mimics a Windows conductor mounted at a WSL path — e.g.
    // /mnt/c/Users/operator/.claude/projects/C--Users-operator-agenticlaunchpad.
    // This is issue #49's exact bug: the raw slug used to leak as the lane.
    const foreignSessionDir = path.join(root, 'foreign', 'C--Users-operator-agenticlaunchpad')
    await mkdir(foreignSessionDir, { recursive: true })
    await writeFile(
      path.join(foreignSessionDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    // claudeProjectsRoot is a bare empty dir: if this test only passed because
    // of a slug-inferred fallback under it, there would be nothing there to find.
    const emptyProjectsRoot = await mkdtemp(path.join(tmpdir(), 'sessionlog-empty-root-'))
    const collector = createSessionlogCollector({
      claudeProjectsRoot: emptyProjectsRoot,
      extraSessionDirs: [foreignSessionDir],
      backfill: true,
    })
    const gitExec: Exec = async () => success(worktreeListOutput(['/fake/worktrees/alpha']))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    await rm(emptyProjectsRoot, { recursive: true, force: true })

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      role: 'conductor',
      lane: 'conductor',
      worktreePath: foreignSessionDir,
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
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

  it('discovers a rotated/new session file dropped into an already-watched project dir (backfill: true reads it in full)', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, 'session-one.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
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

  it('EOF-starts per file: a second file dropped in mid-run is new to it and, without backfill, emits nothing for its existing content', async () => {
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

    // session-one.jsonl is already on disk at first sight: EOF-started, nothing emitted.
    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.events).toEqual([])

    // session-two.jsonl appears mid-run, already fully written — it is new to
    // this collector too, so it gets the same EOF-start treatment, not a free
    // pass just because the project dir was already being watched.
    await writeFile(
      path.join(projectDir, 'session-two.jsonl'),
      await readFixture('worker-4-tmux-collector.jsonl'),
      'utf8',
    )
    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    expect(second.events).toEqual([])
  })

  it('resumes exactly from a rehydrated per-file offset on restart: no gap, no repeat', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, '14442c1b-664e-4d26-9b0b-3009a5d69183.jsonl')
    const fixture = await readFixture('worker-4-tmux-collector.jsonl')
    await writeFile(filePath, fixture, 'utf8')

    // Simulate a restart: a previous run (persisted via #56/#58) already read
    // and emitted for line 1 only — offset sits right after it, with
    // lastUsageRequestId carried over so the still-open reply doesn't
    // re-fire its usage event once line 3 (same requestId) is read again.
    const line1 = fixture.split('\n')[0] as string
    const rehydratedOffset = Buffer.byteLength(`${line1}\n`, 'utf8')
    const prevSnapshot = {
      disabled: false,
      files: {
        [filePath]: { offset: rehydratedOffset, lastUsageRequestId: 'req_011CdXKgL7B2nj6xkUSoy4tk' },
      },
      erroredExtraSessionDirs: {},
      knownWorktrees: {},
    }

    const collector = createSessionlogCollector({ claudeProjectsRoot: root })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(prevSnapshot, makeContext(gitExec))

    // No repeat: line 1's requestId already fired pre-restart, so only the
    // 4th line's (distinct) requestId produces a new llm.usage.
    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ requestId: 'req_011CdXKgfbwmprh37TF3u2MZ' })

    // No gap: lines 2-4's tool_use blocks are all still picked up.
    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(tools.map((e) => (e.payload as { tool: string }).tool)).toEqual(['Read', 'Read', 'Bash'])
  })

  it('keeps tailing a worktree once it folds — drops out of `git worktree list` but its slug stays in the tail set (#165)', async () => {
    const worktreePath = '/fake/worktrees/163'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl')
    await writeFile(filePath, await readFixture('worker-2-core.jsonl'), 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })

    // First poll: the worktree is live, git lists it, the lane's own content
    // is tailed and correctly attributed with its worktreePath/role.
    const liveExec: Exec = async () => success(worktreeListOutput(['/repo', worktreePath]))
    const first = await collector.poll(collector.initialSnapshot(), makeContext(liveExec))
    const firstUsage = first.events.filter((e) => e.type === 'llm.usage')
    expect(firstUsage).toHaveLength(1)
    expect(firstUsage[0]?.payload).toMatchObject({ worktreePath, role: 'worker', lane: '2-core' })

    // The lane lands: its worktree is removed, so `git worktree list` no
    // longer reports it — but the session file is still on disk and gains
    // trailing content (the fold's own writes finishing up).
    await writeFile(
      filePath,
      `${await readFixture('worker-2-core.jsonl')}${await readFixture('conductor-root.jsonl')}`,
      'utf8',
    )
    const foldedExec: Exec = async () => success(worktreeListOutput(['/repo']))
    const second = await collector.poll(first.nextSnapshot, makeContext(foldedExec))

    // Before #165, a worktree missing from `git worktree list` was dropped
    // from the tail set entirely — this content would never be read or
    // attributed. It still must be, with the worktreePath the collector
    // remembers rather than one derived from git's now-empty answer.
    const secondUsage = second.events.filter((e) => e.type === 'llm.usage')
    expect(secondUsage).toHaveLength(1)
    expect(secondUsage[0]?.payload).toMatchObject({ worktreePath, role: 'worker' })

    // And the memory survives a third poll — still folded, still known.
    const third = await collector.poll(second.nextSnapshot, makeContext(foldedExec))
    expect(third.events).toEqual([])
    expect((third.nextSnapshot as { knownWorktrees: Record<string, string> }).knownWorktrees).toMatchObject({
      [worktreePath]: 'worker',
    })
  })

  it('remembers a folded main worktree as unattributed, not worker, and keeps its lane override (#165)', async () => {
    const rootPath = '/repo'
    const rootProjectDir = path.join(root, worktreePathToProjectSlug(rootPath))
    await mkdir(rootProjectDir, { recursive: true })
    const filePath = path.join(rootProjectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl')
    await writeFile(filePath, await readFixture('worker-2-core.jsonl'), 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    const liveExec: Exec = async () => success(worktreeListOutput([rootPath]))
    const first = await collector.poll(collector.initialSnapshot(), makeContext(liveExec))
    expect(first.events.filter((e) => e.type === 'llm.usage')).toHaveLength(1)

    // The root worktree itself "folds" (a pathological case, but the
    // reconstruction from remembered role must still be honest about it).
    await writeFile(
      filePath,
      `${await readFixture('worker-2-core.jsonl')}${await readFixture('conductor-root.jsonl')}`,
      'utf8',
    )
    const foldedExec: Exec = async () => success(worktreeListOutput([]))
    const second = await collector.poll(first.nextSnapshot, makeContext(foldedExec))

    const usage = second.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ worktreePath: rootPath, role: 'unattributed', lane: 'unattributed' })
  })

  it('does not double-tail a worktree that is both remembered-folded and declared via --extra-sessions', async () => {
    const rootPath = '/repo'
    const rootProjectDir = path.join(root, worktreePathToProjectSlug(rootPath))
    await mkdir(rootProjectDir, { recursive: true })
    await writeFile(
      path.join(rootProjectDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      extraSessionDirs: [`${rootPath}:conductor`],
      backfill: true,
    })
    // The worktree starts out remembered as folded-worker from a prior run
    // (simulated via a hand-built prevSnapshot), then is also declared via
    // --extra-sessions this run — the declared role/lane must win, once.
    const prevSnapshot = {
      disabled: false,
      files: {},
      erroredExtraSessionDirs: {},
      knownWorktrees: { [rootPath]: 'worker' as const },
    }
    const gitExec: Exec = async () => success(worktreeListOutput([]))
    const result = await collector.poll(prevSnapshot, makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ role: 'conductor', lane: 'conductor', worktreePath: rootPath })
  })
})
