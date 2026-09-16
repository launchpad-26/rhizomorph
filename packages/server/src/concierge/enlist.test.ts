import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyEnlistment,
  assertUserLevelTarget,
  backupPathFor,
  EnlistmentRefusedError,
  EnlistmentStaleError,
  planEnlistment,
  type EnlistContext,
} from './enlist.js'
import type { HarnessEnlistContext } from './harness/types.js'

/**
 * The fourth hand's IO half — prd-57 ruling 4.
 *
 * What to WRITE is decided by the adapter and asserted in
 * `harness/claude.test.ts` against strings, with no filesystem at all. What is
 * left here is the four things that need one: read, back up, write, re-read —
 * and the refusal that sits between the last two.
 *
 * Every test drives a real temp directory. A fake filesystem would not exercise
 * the thing most likely to be wrong here, which is the order of the steps.
 */

let home: string
let repo: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'rhizo-enlist-home-'))
  repo = await mkdtemp(path.join(tmpdir(), 'rhizo-enlist-repo-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

const LAUNCH: HarnessEnlistContext = {
  lane: 'lane-a',
  role: 'conductor',
  port: 7317,
  instance: 'instance-abc123',
  runnerPath: '/opt/rhizomorph/bin/rhizomorph',
}

const contextFor = (): EnlistContext => ({ harness: 'claude', home, watchedRepoPath: repo, launch: LAUNCH })
const settingsPath = () => path.join(home, '.claude', 'settings.json')

async function writeSettings(text: string): Promise<void> {
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), text, 'utf8')
}

describe('planning writes nothing at all — the first of two acts', () => {
  it('returns the diff and leaves the file exactly as it was', async () => {
    const before = `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`
    await writeSettings(before)

    const { plan } = await planEnlistment(contextFor(), 'enlist')

    expect(plan.kind).toBe('ready')
    // The whole point of two acts: the operator has a diff and nothing has
    // happened yet.
    expect(await readFile(settingsPath(), 'utf8')).toBe(before)
  })

  it('creates no file when there is none — planning is not a first run', async () => {
    const { plan } = await planEnlistment(contextFor(), 'enlist')
    expect(plan.kind).toBe('ready')
    await expect(readFile(settingsPath(), 'utf8')).rejects.toThrow()
  })
})

describe('applying writes, backs up first, and says what it changed', () => {
  it('writes the plan and copies the original beside it', async () => {
    const before = `${JSON.stringify({ theme: 'dark', env: { EDITOR: 'vim' } }, null, 2)}\n`
    await writeSettings(before)

    const planned = await planEnlistment(contextFor(), 'enlist')
    const outcome = await applyEnlistment(planned, () => new Date('2026-09-16T12:00:00.000Z'))

    expect(outcome.backupPath).not.toBeNull()
    // The backup holds the ORIGINAL, which is the only thing that makes an
    // in-place write recoverable.
    expect(await readFile(outcome.backupPath!, 'utf8')).toBe(before)
    const after = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(after.theme).toBe('dark')
    expect(after.env.EDITOR).toBe('vim')
    expect(Object.keys(after.hooks).length).toBeGreaterThan(0)
    expect(outcome.changedKeys.every((key) => key.startsWith('env.') || key.startsWith('hooks.'))).toBe(true)
  })

  it('creates the directory and the file on a first run, and takes no backup', async () => {
    // `~/.claude` may simply not exist. There is nothing to preserve, so the
    // backup is absent rather than an empty file pretending to be one.
    const planned = await planEnlistment(contextFor(), 'enlist')
    const outcome = await applyEnlistment(planned)

    expect(outcome.backupPath).toBeNull()
    expect(JSON.parse(await readFile(settingsPath(), 'utf8')).hooks).toBeDefined()
  })

  it('round-trips: enlist then unenlist restores the file byte-for-byte', async () => {
    // The adapter proves this over strings; this proves the HAND does not add
    // anything of its own on the way through — a write that normalised, or a
    // read that dropped a trailing newline, would break it here and nowhere
    // else.
    const before = `${JSON.stringify({ theme: 'dark', env: { EDITOR: 'vim' } }, null, 2)}\n`
    await writeSettings(before)

    await applyEnlistment(await planEnlistment(contextFor(), 'enlist'))
    await applyEnlistment(await planEnlistment(contextFor(), 'unenlist'))

    expect(await readFile(settingsPath(), 'utf8')).toBe(before)
  })

  it('is idempotent — enlisting twice refuses the second as nothing to do', async () => {
    await applyEnlistment(await planEnlistment(contextFor(), 'enlist'))
    const second = await planEnlistment(contextFor(), 'enlist')

    expect(second.plan.kind).toBe('already-settled')
    await expect(applyEnlistment(second)).rejects.toThrow(EnlistmentRefusedError)
  })
})

describe('the write refuses a file that moved since the diff', () => {
  it('throws EnlistmentStaleError and writes NOTHING', async () => {
    // The reason the plan carries a digest. An operator who read a diff, edited
    // their settings by hand, then accepted would otherwise have that edit
    // silently overwritten by a plan computed against the old bytes.
    await writeSettings(`${JSON.stringify({ theme: 'dark' }, null, 2)}\n`)
    const planned = await planEnlistment(contextFor(), 'enlist')

    const edited = `${JSON.stringify({ theme: 'light' }, null, 2)}\n`
    await writeSettings(edited)

    await expect(applyEnlistment(planned)).rejects.toThrow(EnlistmentStaleError)
    // Not a partial write, not a backup of something nobody asked to touch:
    // the operator's own edit is exactly where they left it.
    expect(await readFile(settingsPath(), 'utf8')).toBe(edited)
  })

  it('refuses a file that APPEARED after the plan said there was none', async () => {
    // The other direction of the same race, and the one a naive digest of
    // "" would miss: planning saw nothing, and something wrote a settings file
    // before the operator accepted.
    const planned = await planEnlistment(contextFor(), 'enlist')
    const appeared = `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`
    await writeSettings(appeared)

    await expect(applyEnlistment(planned)).rejects.toThrow(EnlistmentStaleError)
    expect(await readFile(settingsPath(), 'utf8')).toBe(appeared)
  })
})

describe('ADR-0019 clause 4, enforced here rather than trusted to an adapter', () => {
  it('refuses a target that is not under the home directory', () => {
    expect(() => assertUserLevelTarget({ path: '/etc/claude.json', display: '/etc/claude.json' }, home)).toThrow(
      EnlistmentRefusedError,
    )
  })

  it('refuses a target inside the watched repo — the case the clause names', () => {
    // A write there would show up as a dirty file this instrument then reports
    // on, and a `git clean` would silently undo an enlistment.
    const inside = path.join(repo, '.claude', 'settings.json')
    expect(() => assertUserLevelTarget({ path: inside, display: '<repo>/.claude/settings.json' }, repo, repo)).toThrow(
      /never inside the watched repo/,
    )
  })

  it('admits the real target — the control, without which every case above is vacuous', () => {
    const target = { path: path.join(home, '.claude', 'settings.json'), display: '~/.claude/settings.json' }
    expect(() => assertUserLevelTarget(target, home, repo)).not.toThrow()
  })
})

describe('a harness with no capture cannot be enlisted, and the refusal is this module s', () => {
  it('turns the adapter s HarnessNotImplementedError into one refusal type', async () => {
    // A caller has one error to handle rather than two, and the reason
    // survives: `no capture` is the adapter's word and it reaches the operator.
    await expect(planEnlistment({ harness: 'codex', home, launch: LAUNCH }, 'enlist')).rejects.toThrow(
      EnlistmentRefusedError,
    )
    await expect(planEnlistment({ harness: 'codex', home, launch: LAUNCH }, 'enlist')).rejects.toThrow(/no capture/)
  })

  it('refuses an enlist with no launch context rather than rendering an empty recipe', async () => {
    await expect(planEnlistment({ harness: 'claude', home }, 'enlist')).rejects.toThrow(EnlistmentRefusedError)
  })

  it('but an UNENLIST needs none — it removes what enlist declared', async () => {
    await applyEnlistment(await planEnlistment(contextFor(), 'enlist'))
    const planned = await planEnlistment({ harness: 'claude', home }, 'unenlist')
    expect(planned.plan.kind).toBe('ready')
  })
})

describe('the backup path', () => {
  it('sits beside the file and sorts chronologically', () => {
    const a = backupPathFor('/home/operator/.claude/settings.json', new Date('2026-09-16T12:00:00.000Z'))
    const b = backupPathFor('/home/operator/.claude/settings.json', new Date('2026-09-16T12:00:01.000Z'))

    expect(path.dirname(a)).toBe('/home/operator/.claude')
    expect(a).toContain('.rhizomorph-backup-')
    // A backup somewhere else is a backup nobody finds; one that does not sort
    // is a directory nobody can read at a glance.
    expect([b, a].sort()).toEqual([a, b])
    // And no colons, because Windows will not have them in a filename.
    expect(path.basename(a)).not.toContain(':')
  })
})
