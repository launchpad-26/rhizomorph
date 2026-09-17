import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { createEvent, UNATTRIBUTED_LANE } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionlogCollector, SESSIONLOG_CAPABILITIES } from './collector.js'
import { TRANSCRIPT_STALL_MS, TURN_SETTLE_MS } from './lane-state.js'
import type { ProcessLiveness, ProcessProbe } from './process-probe.js'
import type { AssistantLineFacts, TurnGrammar } from './turn-grammar.js'
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
  let home: string
  let root: string

  beforeEach(async () => {
    // `home` and `root` in the production relationship: `claudeProjectsRoot`
    // IS `<home>/.claude/projects`. Discovery reads `home`, tailing reads
    // `root`, and a fixture that let them diverge would be testing a machine
    // nobody has (prd-57 ruling 8).
    home = await mkdtemp(path.join(tmpdir(), 'sessionlog-collector-'))
    root = path.join(home, '.claude', 'projects')
    await mkdir(root, { recursive: true })
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
    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
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
      '/repo-wt/4-tmux-collector/docs/vision.md',
      '/repo-wt/4-tmux-collector/docs/prd0.md',
      '/repo-wt/4-tmux-collector/docs/architecture.md',
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
    // it. The organ publishes (#281); attention stays `partial` because a
    // published inference is still one.
    expect(collector.capabilities?.telemetry).toEqual({ level: 'provided' })
    expect(collector.capabilities?.activity).toEqual({ level: 'provided' })
    expect(collector.capabilities?.attention.level).toBe('partial')
    expect(result.events.some((e) => e.type === 'agent.status')).toBe(true)
  })

  it('normalizes filePath to repo-relative when it sits under the lane\'s own worktree (prd11 ruling 2)', async () => {
    // worker-2-core.jsonl's tool_use reports
    // /repo-wt/2-core/docs/vision.md — real
    // capture from a session that ran with that exact cwd as its worktree.
    const worktreePath = '/repo-wt/2-core'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.payload).toMatchObject({
      tool: 'Read',
      filePath: '/repo-wt/2-core/docs/vision.md',
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(usage).toHaveLength(1)
    expect(tools).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ thread: 'subagent' })
    expect(tools[0]?.payload).toMatchObject({ thread: 'subagent' })
  })

  /**
   * #62's RULE, ONE LAYER ON — prd-57 ruling 8.
   *
   * This asserted `role: 'unattributed'` for the main tree, and #62 was right:
   * booking a conductor's spend as worker spend is worse than an honest gap, so
   * the main tree stayed unattributed until an operator declared it with
   * `--extra-sessions`.
   *
   * The gap existed because nothing could tell the instrument whose transcript
   * that was. It can now: the transcript is sitting under the dialect's own
   * user-level root, which is where Claude Code puts a conductor's session
   * whoever is running it. Discovering it is not a guess — it is reading the
   * one place the harness itself writes.
   *
   * So the main tree reads `conductor` here, and the linked worktree still
   * reads `worker` from its own log content. Nothing about the linked half
   * moved, which is what makes this a change to one rule rather than to the
   * attribution model.
   */
  it('books a DISCOVERED main working tree as the conductor while a linked worktree stays worker (#62, prd-57 ruling 8)', async () => {
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
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

    expect(rootUsage?.payload).toMatchObject({ role: 'conductor', lane: 'conductor' })
    // The linked worktree's lane is still inferred from the log's own gitBranch/cwd.
    expect(linkedUsage?.payload).toMatchObject({ role: 'worker', lane: '2-core' })
  })

  /**
   * THE FLAG'S GRAMMAR IS GONE, and so are the seven cases that described it —
   * prd-57 ruling 8.
   *
   * They covered a direct dir, slug fallback, default lane numbering
   * (`conductor-2`, `conductor-3`…), an explicit `:<lane>` suffix, a mix, and
   * the `collector.error` a bad spec produced. Every one was a way of typing a
   * path, and there is no longer a path to type.
   *
   * The test above is what replaces the useful half of them — a discovered
   * conductor — and this is the other half: what discovery refuses to claim.
   */
  it('claims NOTHING for a main tree whose dialect root holds no session dir — the honest gap #62 ruled for', async () => {
    // The half of #62 that survives, and the reason discovery is not a licence
    // to guess. An empty root means `claude` has not run here, which is a setup
    // gap the ladder already reports; booking the main tree as a conductor on
    // no evidence would be #62's silent mis-attribution reached from the other
    // direction.
    const rootPath = '/repo'
    const linkedPath = '/fake/worktrees/alpha'
    // Only the LINKED worktree has a session dir. The main tree's is absent.
    const linkedProjectDir = path.join(root, worktreePathToProjectSlug(linkedPath))
    await mkdir(linkedProjectDir, { recursive: true })
    await writeFile(
      path.join(linkedProjectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl'),
      await readFixture('worker-2-core.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([rootPath, linkedPath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    const usage = result.events.filter(
      (e): e is typeof e & { payload: { worktreePath: string } } => e.type === 'llm.usage',
    )
    // The linked worktree still reports; the main tree contributes nothing at
    // all rather than contributing something mis-attributed.
    expect(usage.map((e) => e.payload.worktreePath)).toEqual([linkedPath])
  })



  /**
   * THE LEAK THIS GUARDED IS NOW STRUCTURAL — prd-57 ruling 8.
   *
   * A test lived here proving that a directly-tailed `--extra-sessions` dir did
   * not leak its raw basename as the lane — a Windows-shaped project-dir name a
   * POSIX slug function could never produce, used as the lane label.
   *
   * It guarded a path that no longer exists. Discovery never reads a basename:
   * it joins `worktreePathToProjectSlug(mainWorktreePath)` under the dialect's
   * root and sets the lane from the ROSTER's own `lane` field, so there is no
   * spelling for a directory name to leak through. The guarantee moved from a
   * test to the shape of the code, which is the better place for it.
   */

  it('only parses new lines across polls, and dedupes usage for a reply split across polls', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl')

    const fixtureLines = (await readFixture('worker-2-core.jsonl')).split('\n').filter(Boolean)
    // First poll only sees the reply's text block (no newline yet on the second line).
    await writeFile(filePath, `${fixtureLines[0]}\n`, 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
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

  it("resets the fold on a same-path rotation — turnShape, lane, and branch come from the replacement, not the predecessor", async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, 'session.jsonl')
    await writeFile(filePath, await readFixture('claude-code-2.1.222-tail-pending-tool.jsonl'), 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    // '/repo' as the main worktree so `worktreePath` is a linked ('worker')
    // one — lane comes from `facts.gitBranch` there, not the fixed
    // `unattributed` laneOverride the main worktree always carries (#62).
    const gitExec: Exec = async () => success(worktreeListOutput(['/repo', worktreePath]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    const before = first.nextSnapshot.files[filePath]
    expect(before?.turnShape?.shape).toBe('pending-tool')
    expect(before?.turnShape?.pendingToolUseIds).toEqual(['toolu_016B8H8YKsFicyG9JazwdoeV'])
    expect(before?.lane).toBe('lane-a')
    expect(before?.branch).toBe('lane-a')

    // Same-path rotation: write the replacement elsewhere, then rename() it
    // over the old path — the inode changes, the name doesn't. Its one line
    // is a plain user prompt: no tool_result (so it cannot legitimately close
    // the predecessor's pending tool call) and not an assistant line (so
    // nothing here would overwrite lane/branch even without a reset) — the
    // only way the assertions below can pass is if the reset happened.
    const replacementPath = path.join(projectDir, 'session.jsonl.new')
    await writeFile(
      replacementPath,
      '{"type":"user","isSidechain":false,"message":{"role":"user","content":"continue"},"timestamp":"2026-08-03T08:00:00.000Z"}\n',
      'utf8',
    )
    await rename(replacementPath, filePath)

    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    const after = second.nextSnapshot.files[filePath]
    // A fresh fold over one plain user line lands on 'awaiting-reply' with
    // nothing pending. Folding it onto the predecessor's pending-tool state
    // instead would leave pendingToolUseIds non-empty (the dangling call
    // belongs to the replaced file) and shape stuck at 'pending-tool'.
    expect(after?.turnShape?.shape).toBe('awaiting-reply')
    expect(after?.turnShape?.pendingToolUseIds).toEqual([])
    // Neither is derivable from the line above, so a pass here can only mean
    // the reset ran, not that this poll's own content produced it.
    expect(after?.lane).toBe('alpha')
    expect(after?.branch).toBeNull()
  })

  it('does not reset the fold on a same-inode truncation, unlike a rotation', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    // The `lane` assertions below prove preservation only because 'alpha'
    // (this path's basename, the post-reset fallback) differs from 'lane-a'
    // (the fixture's gitBranch, the preserved value) — if a future edit ever
    // makes them equal, a reset-then-fallback would read identically to a
    // preserved fold and `lane` could no longer tell the two apart.
    expect(path.basename(worktreePath)).not.toBe('lane-a')
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, 'session.jsonl')
    await writeFile(filePath, await readFixture('claude-code-2.1.222-tail-pending-tool.jsonl'), 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput(['/repo', worktreePath]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    const before = first.nextSnapshot.files[filePath]
    expect(before?.turnShape?.shape).toBe('pending-tool')
    expect(before?.turnShape?.pendingToolUseIds).toEqual(['toolu_016B8H8YKsFicyG9JazwdoeV'])
    expect(before?.lane).toBe('lane-a')
    expect(before?.branch).toBe('lane-a')
    expect(before?.lastUsageRequestId).toBe('req_011CdfKhwWU9Hi5mf8UWvj8X')

    // Same-inode truncation: overwrite the SAME path directly (no rename, no
    // new file) with far less content — the byte cursor can no longer be
    // trusted (tail.ts resets it to 0), but the inode is unchanged, so
    // isRotated is false. The replacement line is a plain user prompt: no
    // tool_result (so it cannot legitimately close the predecessor's pending
    // tool call) and not an assistant line (so it cannot legitimately
    // overwrite lane/branch/lastUsageRequestId either) — the only way every
    // assertion below can pass is if the fold was preserved, not reset (#413).
    await writeFile(
      filePath,
      '{"type":"user","isSidechain":false,"message":{"role":"user","content":"continue"},"timestamp":"2026-08-03T08:00:00.000Z"}\n',
      'utf8',
    )

    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    const after = second.nextSnapshot.files[filePath]
    // Folding this line onto the PRESERVED pending-tool state leaves it
    // pending (closesToolUseIds is empty, so nothing closes toolu_016B8...).
    // Contrast the rotation test above: the identical line folded onto a
    // FRESH state lands on 'awaiting-reply' / [] instead — the two tests
    // together are the asymmetry this issue rules on.
    expect(after?.turnShape?.shape).toBe('pending-tool')
    expect(after?.turnShape?.pendingToolUseIds).toEqual(['toolu_016B8H8YKsFicyG9JazwdoeV'])
    expect(after?.lane).toBe('lane-a')
    expect(after?.branch).toBe('lane-a')
    expect(after?.lastUsageRequestId).toBe('req_011CdfKhwWU9Hi5mf8UWvj8X')
  })

  it("does not let a carried lastUsageRequestId suppress a usage block belonging to the replacement file", async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, 'session.jsonl')

    // Deliberately reuses the same requestId across the rotation. Real
    // provider-issued ids won't collide in practice, but correctness here
    // must not rest on that — the dedupe key has to be scoped to this file's
    // own fold, reset on rotation, not merely "usually different next time."
    const assistantLine = (branch: string, requestId: string): string =>
      `${JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          model: 'claude-opus-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        requestId,
        gitBranch: branch,
        cwd: `/fake/worktrees/${branch}`,
        sessionId: 'session-one',
        timestamp: '2026-08-03T08:00:00.000Z',
      })}\n`

    await writeFile(filePath, assistantLine('lane-a', 'req_SHARED'), 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))

    const first = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    expect(first.events.filter((e) => e.type === 'llm.usage')).toHaveLength(1)

    const replacementPath = path.join(projectDir, 'session.jsonl.new')
    await writeFile(replacementPath, assistantLine('lane-b', 'req_SHARED'), 'utf8')
    await rename(replacementPath, filePath)

    const second = await collector.poll(first.nextSnapshot, makeContext(gitExec))
    expect(second.events.filter((e) => e.type === 'llm.usage')).toHaveLength(1)
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

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })

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

  /**
   * #165 still holds, and retiring the flag is what makes the FIRST poll here
   * read `conductor` where it used to read `unattributed` — the tree is live
   * and its session dir is discovered. The second poll folds it, so there is no
   * live main tree to discover, and the remembered role is all that is left.
   * That is the case this test was always about.
   */
  it('remembers a folded main worktree by its remembered role, not as worker (#165)', async () => {
    const rootPath = '/repo'
    const rootProjectDir = path.join(root, worktreePathToProjectSlug(rootPath))
    await mkdir(rootProjectDir, { recursive: true })
    const filePath = path.join(rootProjectDir, '95f42357-058c-4ea2-84d4-de7b1eb58635.jsonl')
    await writeFile(filePath, await readFixture('worker-2-core.jsonl'), 'utf8')

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    const liveExec: Exec = async () => success(worktreeListOutput([rootPath]))
    const first = await collector.poll(collector.initialSnapshot(), makeContext(liveExec))
    const firstUsage = first.events.filter((e) => e.type === 'llm.usage')
    expect(firstUsage).toHaveLength(1)
    // Live and discovered on the first poll — prd-57 ruling 8. It read
    // `unattributed` before, because nothing could say whose session it was.
    expect(firstUsage[0]?.payload).toMatchObject({ role: 'conductor' })

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
    // The remembered role AND its lane come back — prd-57 ruling 8. It was
    // `unattributed` on both counts before, because the first poll could not
    // say whose session this was; now the first poll discovers it and the fold
    // keeps what the first poll established. #165's claim is unchanged: a
    // folded worktree is never silently demoted to `worker`.
    expect(usage[0]?.payload).toMatchObject({ worktreePath: rootPath, role: 'conductor', lane: 'conductor' })
  })

  it('does not double-tail a worktree that is both remembered-folded and discovered as the conductor', async () => {
    const rootPath = '/repo'
    const rootProjectDir = path.join(root, worktreePathToProjectSlug(rootPath))
    await mkdir(rootProjectDir, { recursive: true })
    await writeFile(
      path.join(rootProjectDir, '85649f6d-2f7d-43aa-a23e-10c9c1c0d2bc.jsonl'),
      await readFixture('conductor-root.jsonl'),
      'utf8',
    )

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true })
    // The worktree starts out remembered as folded-worker from a prior run
    // (simulated via a hand-built prevSnapshot), and is ALSO the discovered
    // conductor this run — the discovered role/lane must win, once. The two
    // routes to the same worktree are what this test exists for, and retiring
    // the flag changed which second route it is, not that there is one.
    const prevSnapshot = {
      disabled: false,
      files: {},
      erroredExtraSessionDirs: {},
      knownWorktrees: { [rootPath]: 'worker' as const },
    }
    // LIVE, not folded — that is the one setup change retiring the flag forced
    // here. Discovery keys off the live main tree (`git worktree list` names it
    // first), where the flag could declare a path whether or not git still knew
    // about it. The claim under test is unchanged: two routes reach this
    // worktree, and it is tailed ONCE.
    const gitExec: Exec = async () => success(worktreeListOutput([rootPath]))
    const result = await collector.poll(prevSnapshot, makeContext(gitExec))

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ role: 'conductor', lane: 'conductor', worktreePath: rootPath })
  })

  it('reads classification and extraction through the injected turnGrammar, not the claude parser (#508)', async () => {
    const worktreePath = '/fake/worktrees/alpha'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    // Deliberately not valid Claude Code JSONL: CLAUDE_JSONL_GRAMMAR fails to
    // JSON.parse this and classifies/extracts nothing from it (both return
    // null on an unparsable line, same as an empty one). Any lane reading or
    // event below can only have come from the injected fake grammar below —
    // proof the collector's call sites read through `config.turnGrammar`
    // rather than the claude dialect directly, for both classify and extractFacts.
    await writeFile(path.join(projectDir, 'fake-session.jsonl'), 'not real jsonl\n', 'utf8')

    const fakeFacts: AssistantLineFacts = {
      sessionId: 'fake-session-id',
      cwd: null,
      gitBranch: 'fake-branch',
      requestId: 'fake-req-1',
      model: 'fake-model',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      toolUses: [{ tool: 'FakeTool', toolUseId: 'fake-tool-1', filePath: null }],
      timestamp: 555,
      isSidechain: false,
    }
    // Recorded, not just returned: proves not only that the injected grammar
    // is READ but WHAT it is handed. An isolated call-site bug that still
    // reads *some* raw line through the injected grammar (e.g. an off-by-one
    // passing the previous line) would sail through a fake that ignores its
    // argument; it cannot sail through an assertion on the argument itself.
    const seenLines: { classify: string[]; extractFacts: string[] } = { classify: [], extractFacts: [] }
    const fakeGrammar: TurnGrammar = {
      cli: 'claude',
      capture: 'fake-test-grammar (#508, not a real capture)',
      classify: (rawLine) => {
        seenLines.classify.push(rawLine)
        return {
          role: 'assistant',
          turnComplete: true,
          opensToolUseIds: [],
          sidechain: false,
          ts: 555,
        }
      },
      extractFacts: (rawLine) => {
        seenLines.extractFacts.push(rawLine)
        return fakeFacts
      },
    }

    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      home,
      backfill: true,
      turnGrammar: fakeGrammar,
    })
    const gitExec: Exec = async () => success(worktreeListOutput([worktreePath]))
    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

    // Both halves are read off the SAME raw line, the exact line the fixture
    // wrote (the trailing newline is a line terminator, not part of the
    // line) — the reason ADR-0017 gives for one interface over two.
    expect(seenLines.classify).toEqual(['not real jsonl'])
    expect(seenLines.extractFacts).toEqual(['not real jsonl'])

    // extractFacts half: the emitted events reflect the fake facts, not
    // anything the real claude parser could have read off this garbage line.
    const usage = result.events.filter((e) => e.type === 'llm.usage')
    const tools = result.events.filter((e) => e.type === 'tool.activity')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      requestId: 'fake-req-1',
      model: 'fake-model',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      branch: 'fake-branch',
    })
    expect(tools).toHaveLength(1)
    expect(tools[0]?.payload).toMatchObject({ tool: 'FakeTool', toolUseId: 'fake-tool-1' })

    // classify half: the fake grammar's turn-complete entry drove the fold —
    // the real grammar classifies this line as null (unparsable), which would
    // leave the shape 'empty' and the lane unreadable (deriveLaneState returns
    // null for 'empty'). A 'working' reading here can only have come from the
    // injected classify.
    const lanes = result.nextSnapshot.lanes ?? {}
    const laneStates = Object.values(lanes).map((lane) => lane.state)
    expect(laneStates).toEqual(['working'])
  })
})

// ── the organ publishes (#281, ADR-0037) ────────────────────────────────────

/**
 * prd-27 ruling 2's keystone: the transcript organ signs `agent.status` with
 * its own name. Everything asserted here is a property of *publication*, not
 * of the derivation — `lane-state.test.ts` owns the four states themselves,
 * and this suite owns which of them reach the log, how often, and under whose
 * signature.
 *
 * The fixtures are the same real captures `tmuxless-boot.test.ts` reads, aged
 * the same mechanical way (timestamps shifted by one constant per file, lane
 * identity rewritten, shapes never edited).
 */
describe('the organ publishes agent.status, edge-triggered and signed (#281, ADR-0037)', () => {
  const ORGAN_NOW = 1_800_000_000_000
  const CAPTURED_VERSION = 'claude-code-2.1.222'
  const TURN_COMPLETE = `${CAPTURED_VERSION}-tail-turn-complete.jsonl`
  const PENDING_TOOL = `${CAPTURED_VERSION}-tail-pending-tool.jsonl`

  let home: string
  let root: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'sessionlog-organ-'))
    root = path.join(home, '.claude', 'projects')
    await mkdir(root, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const worktreeOf = (lane: string): string => `/fake/organ-worktrees/${lane}`

  /**
   * Plants one captured transcript as `lane`'s session, aged so its last
   * conversational entry sits `ageMs` before `ORGAN_NOW`, with the file's own
   * mtime pinned too — otherwise the evidence string carries a wall-clock
   * "last write" span and stops being deterministic.
   */
  async function plant(
    worktreePath: string,
    lane: string | null,
    fixture: string,
    ageMs: number,
  ): Promise<void> {
    const raw = await readFixture(fixture)
    const lines = raw.split('\n').filter((line) => line.length > 0)
    const stamps = lines
      .map((line) => (JSON.parse(line) as { timestamp?: string }).timestamp)
      .filter((stamp): stamp is string => typeof stamp === 'string')
      .map((stamp) => Date.parse(stamp))
      .filter((stamp) => Number.isFinite(stamp))
    const shift = ORGAN_NOW - ageMs - Math.max(...stamps)

    const aged = lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (typeof entry.timestamp === 'string') {
        entry.timestamp = new Date(Date.parse(entry.timestamp) + shift).toISOString()
      }
      if (typeof entry.cwd === 'string') entry.cwd = worktreePath
      if (typeof entry.gitBranch === 'string' && lane !== null) entry.gitBranch = lane
      return JSON.stringify(entry)
    })

    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, 'session-1.jsonl')
    await writeFile(filePath, `${aged.join('\n')}\n`, 'utf8')
    const written = new Date(ORGAN_NOW - 1_000)
    await utimes(filePath, written, written)
  }

  /** A probe that answers from a table — no real process anywhere. */
  function stubProbe(alive: Readonly<Record<string, ProcessLiveness>>): ProcessProbe {
    return {
      name: 'stub',
      async probe(worktreePaths) {
        return new Map(worktreePaths.map((worktreePath) => [worktreePath, alive[worktreePath] ?? false]))
      },
    }
  }

  function organCollector(probe: ProcessProbe = stubProbe({})) {
    return createSessionlogCollector({ claudeProjectsRoot: root, home, backfill: true, processProbe: probe })
  }

  const gitFor =
    (worktreePaths: readonly string[]): Exec =>
    async () =>
      success(worktreeListOutput(['/repo', ...worktreePaths]))

  const statuses = <T extends { type: string }>(events: readonly T[]): T[] =>
    events.filter((e) => e.type === 'agent.status')

  it('three polls, one event: the first sighting publishes, an unchanged state does not', async () => {
    // buildFleet folds `agent.status` into `lastWorkTs`, so an organ that
    // re-announced a lane's state every poll would refresh the very silence
    // FROZEN and inferred-WAITING are measured against — the prd3 keystone
    // bug, through a new door. Only a change of state speaks.
    const lane = 'organ-a'
    await plant(worktreeOf(lane), lane, TURN_COMPLETE, 5_000)
    const collector = organCollector()
    const exec = gitFor([worktreeOf(lane)])

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, '/repo', ORGAN_NOW))
    const second = await collector.poll(first.nextSnapshot, makeContext(exec, '/repo', ORGAN_NOW))
    const third = await collector.poll(second.nextSnapshot, makeContext(exec, '/repo', ORGAN_NOW))

    expect(statuses(first.events)).toHaveLength(1)
    expect(statuses(second.events)).toHaveLength(0)
    expect(statuses(third.events)).toHaveLength(0)

    expect(statuses(first.events)[0]).toMatchObject({
      source: 'sessionlog',
      type: 'agent.status',
      payload: { handle: lane, status: 'working' },
    })
    // The payload's `detail` is the organ's own reading, not a paraphrase of
    // it: the same string the snapshot carries.
    expect((statuses(first.events)[0]?.payload as { detail: string }).detail).toBe(
      first.nextSnapshot.lanes?.[lane]?.evidence,
    )
  })

  it('a transition publishes once, with the new word', async () => {
    const lane = 'organ-b'
    await plant(worktreeOf(lane), lane, TURN_COMPLETE, 5_000)
    const collector = organCollector(stubProbe({ [worktreeOf(lane)]: true }))
    const exec = gitFor([worktreeOf(lane)])

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, '/repo', ORGAN_NOW))
    expect(statuses(first.events)).toHaveLength(1)
    expect(statuses(first.events)[0]?.payload).toMatchObject({ status: 'working' })

    // Past TURN_SETTLE_MS the completed turn has stayed completed: a raised hand.
    const settled = ORGAN_NOW + TURN_SETTLE_MS
    const second = await collector.poll(first.nextSnapshot, makeContext(exec, '/repo', settled))
    const reading = second.nextSnapshot.lanes?.[lane]
    expect(reading?.state).toBe('waiting')
    expect(statuses(second.events)).toHaveLength(1)
    expect(statuses(second.events)[0]?.payload).toMatchObject({
      handle: lane,
      status: 'waiting',
      elapsedSeconds: Math.floor((reading?.quietMs ?? 0) / 1000),
    })

    const third = await collector.poll(second.nextSnapshot, makeContext(exec, '/repo', settled))
    expect(statuses(third.events)).toHaveLength(0)
  })

  it('frozen and gone publish nothing', async () => {
    // FROZEN: silence *is* the signal downstream, and an event announcing the
    // freeze would postpone the alarm it announces. GONE: the union's only
    // candidate word is `done`, which would convert a crash into a success.
    const lane = 'organ-c'
    const stalled = ORGAN_NOW + TRANSCRIPT_STALL_MS

    await plant(worktreeOf(lane), lane, PENDING_TOOL, 30_000)
    const exec = gitFor([worktreeOf(lane)])

    const frozenCollector = organCollector(stubProbe({ [worktreeOf(lane)]: true }))
    const frozen = await frozenCollector.poll(
      frozenCollector.initialSnapshot(),
      makeContext(exec, '/repo', stalled),
    )
    expect(frozen.nextSnapshot.lanes?.[lane]?.state).toBe('frozen')
    expect(statuses(frozen.events)).toHaveLength(0)

    const goneCollector = organCollector(stubProbe({ [worktreeOf(lane)]: false }))
    const gone = await goneCollector.poll(goneCollector.initialSnapshot(), makeContext(exec, '/repo', stalled))
    expect(gone.nextSnapshot.lanes?.[lane]?.state).toBe('gone')
    expect(statuses(gone.events)).toHaveLength(0)
  })

  it('every agent.status the organ emits is signed sessionlog — never workmux', async () => {
    // ADR-0037's named guard. `createEvent('agent.status', …)` STILL defaults
    // `source` to `workmux`, and no schema catches a collector that forgets to
    // pass its own: forged provenance by omission. This assertion is the only
    // thing standing there. Do not weaken it.
    const lane = 'organ-d'
    await plant(worktreeOf(lane), lane, TURN_COMPLETE, 5_000)
    const collector = organCollector(stubProbe({ [worktreeOf(lane)]: true }))
    const exec = gitFor([worktreeOf(lane)])

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, '/repo', ORGAN_NOW))
    const second = await collector.poll(
      first.nextSnapshot,
      makeContext(exec, '/repo', ORGAN_NOW + TURN_SETTLE_MS),
    )
    const emitted = statuses([...first.events, ...second.events])

    // Non-vacuous: an organ that published nothing at all would satisfy
    // `every` trivially.
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.every((e) => e.source === 'sessionlog')).toBe(true)
  })

  it('an unattributed lane publishes no agent.status', async () => {
    // `deriveLanes` gives an undiscovered main working tree the lane
    // `unattributed` — a setup gap, never worker spend (#62). Minting an agent
    // record for it would hand the fleet a lane it deliberately does not have.
    //
    // WHAT `unattributed` MEANS NOW, and this test is the only place the two
    // can be told apart. It used to mean "nobody declared this tree with
    // `--extra-sessions`". Since prd-57 ruling 8 it means the DIALECT's own
    // user-level root holds nothing for it — so the transcript is readable and
    // still unclaimed, which is a rarer state and a more honest one.
    //
    // Reproduced by pointing `home` at a directory with no `.claude/projects`
    // while the transcript stays readable under `claudeProjectsRoot`. That
    // separation is exactly why discovery reads `home` and tailing reads
    // `claudeProjectsRoot`: collapsing them would make this state unreachable
    // and this guard untestable.
    await plant('/repo', null, TURN_COMPLETE, 5_000)
    const bareHome = await mkdtemp(path.join(tmpdir(), 'sessionlog-no-dialect-'))
    const collector = createSessionlogCollector({
      claudeProjectsRoot: root,
      home: bareHome,
      backfill: true,
      processProbe: stubProbe({}),
    })
    const exec: Exec = async () => success(worktreeListOutput(['/repo']))

    const result = await collector.poll(collector.initialSnapshot(), makeContext(exec, '/repo', ORGAN_NOW))

    expect(result.nextSnapshot.lanes?.[UNATTRIBUTED_LANE]).toBeDefined()
    expect(statuses(result.events)).toHaveLength(0)
  })
})

/**
 * prd-27 ruling 3 (#218). The organ's own self-declaration is this PRD's
 * thesis — it is quoted verbatim in prd-27's Evidence — and its remedy used to
 * point at a beacon that did not exist. #282 shipped the emitter, so the
 * remedy now names the command that installs it.
 */
describe('the manifest names the emitter that exists (prd-27 ruling 3, #218)', () => {
  const attention = SESSIONLOG_CAPABILITIES.attention

  it('still reads partial — a published inference is still an inference', () => {
    expect(attention.level).toBe('partial')
  })

  it('names the command that installs the hooks, and no longer a beacon that "would" declare it', () => {
    expect(attention.level !== 'provided' && attention.remedy).toContain('--hooks claude')
    expect(attention.level !== 'provided' && attention.remedy).not.toContain('would declare')
  })
})
