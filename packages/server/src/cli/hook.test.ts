import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBeaconLine } from '../collectors/beacon/parse-beacon-line.js'
import { installationBeaconDir } from '../collectors/beacon/paths.js'
import { beaconLineFor, DECLARED_KEYS, MESSAGE_MAX, runHookCommand } from './hook.js'

/**
 * `rhizomorph hook` — prd-57 ruling 6.
 *
 * Two properties carry this file, and they are the two the ruling names: it
 * writes a DECLARED key set and nothing else, and it **never blocks the agent**.
 */

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizo-hook-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const FIRING = {
  hook_event_name: 'PreToolUse',
  session_id: '11111111-2222-4333-8444-555555555555',
  transcript_path: '/home/operator/.claude/projects/repo/session.jsonl',
  cwd: '/repo',
  // The field this test exists for: whatever the agent was about to do.
  tool_input: { command: 'git push --force origin main', description: 'MARKER-7f3a1c' },
}

const doorFile = () => path.join(installationBeaconDir(root), 'claude-hook.jsonl')

describe('what the runner writes, and what it refuses to', () => {
  it('writes ONE line, and the collector can read it back', async () => {
    // Round-tripped through the real parser rather than eyeballed: a line this
    // runner writes that the collector cannot parse is a line that reaches
    // nothing, and shape assertions alone would not catch it.
    expect(await runHookCommand(JSON.stringify(FIRING), { dataRoot: root, parentPid: 4321 })).toBe(0)

    const written = await readFile(doorFile(), 'utf8')
    expect(written.split('\n').filter((l) => l.length > 0)).toHaveLength(1)

    const parsed = parseBeaconLine(written.trim())
    expect(parsed.kind).toBe('beacon')
    if (parsed.kind !== 'beacon') return
    expect(parsed.payload.kind).toBe('tool-running')
    expect(parsed.payload.cwd).toBe('/repo')
    expect(parsed.payload.sessionId).toBe(FIRING.session_id)
    expect(parsed.payload.pid).toBe(4321)
  })

  it('writes NOWHERE else — the whole data root, enumerated', async () => {
    // ADR-0055 grants this runner one write: into the installation's own data
    // root, append only. Asserted by walking the tree rather than by checking
    // the one file exists, because "it wrote the right file" and "it wrote only
    // that file" are different claims and the second is the granted one.
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'SessionEnd' }), { dataRoot: root })

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true })
      const found = await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(dir, entry.name)
          return entry.isDirectory() ? walk(full) : [path.relative(root, full).split(path.sep).join('/')]
        }),
      )
      return found.flat()
    }

    expect(await walk(root)).toEqual(['beacons/claude-hook.jsonl'])
  })

  it('PLANTS tool_input and asserts it is absent from the written bytes', async () => {
    // Ruling 6's own law, and the reason it is about what the RUNNER writes
    // rather than what the boundary strips: ADR-0036 records that the collector
    // keeps whatever the writer said, so a claim that an unknown key "dies at
    // the boundary" would be false. The file keeps what is written — therefore
    // the words must never be written.
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })

    const written = await readFile(doorFile(), 'utf8')
    expect(written).not.toContain('MARKER-7f3a1c')
    expect(written).not.toContain('tool_input')
    expect(written).not.toContain('git push')
    // The control: the marker really was in the input, and a line really was
    // written. Missing either makes the absence meaningless.
    expect(JSON.stringify(FIRING)).toContain('MARKER-7f3a1c')
    expect(written.length).toBeGreaterThan(0)
  })

  it('writes only the declared keys — asserted against the key set, not a sample', async () => {
    await runHookCommand(JSON.stringify({ ...FIRING, message: 'hi', extra: 'nope', nested: { a: 1 } }), {
      dataRoot: root,
    })
    const line = JSON.parse((await readFile(doorFile(), 'utf8')).trim()) as Record<string, unknown>

    for (const key of Object.keys(line)) {
      expect(DECLARED_KEYS, `the runner wrote an undeclared key: ${key}`).toContain(key)
    }
    expect(line.extra).toBeUndefined()
    expect(line.nested).toBeUndefined()
  })

  it('bounds the one field that carries an agent’s words', async () => {
    // A permission prompt's own sentence is admitted; it is bounded by the
    // WRITER rather than by whoever reads it, so an over-long one cannot reach
    // disk at all.
    const long = 'x'.repeat(MESSAGE_MAX * 3)
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'Notification', message: long }), {
      dataRoot: root,
    })
    const line = JSON.parse((await readFile(doorFile(), 'utf8')).trim()) as { message: string }
    expect(line.message).toHaveLength(MESSAGE_MAX)
  })

  it('maps each lifecycle event to the word ruling 5 derives from it', () => {
    const kindFor = (hook_event_name: string) => {
      const line = beaconLineFor({ ...FIRING, hook_event_name }, { parentPid: 1 })
      return line === null ? null : (JSON.parse(line) as { kind: string }).kind
    }
    expect(kindFor('PreToolUse')).toBe('tool-running')
    expect(kindFor('PostToolUse')).toBe('working')
    expect(kindFor('Notification')).toBe('waiting-permission')
    expect(kindFor('Stop')).toBe('working')
    expect(kindFor('SessionEnd')).toBe('stopped')
  })

  it('writes NOTHING for an event it has no word for — never a guessed state', async () => {
    // A hook entry an operator added by hand, or one a future harness fires.
    // Inventing a word for it would widen ruling 5's vocabulary without a ruling.
    expect(beaconLineFor({ ...FIRING, hook_event_name: 'SubagentStop' })).toBeNull()
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'SubagentStop' }), { dataRoot: root })
    await expect(readdir(installationBeaconDir(root))).rejects.toThrow()
  })
})

describe('THE LAW: it never blocks the agent', () => {
  /**
   * Every one of these is a real failure and every one exits 0. A hook that
   * exits non-zero can make the harness surface an error, retry, or refuse the
   * tool call — so a broken instrument would degrade the thing it exists to
   * watch. The operator learns from `doctor`; their agent must never learn at
   * all.
   */
  it.each([
    ['stdin that is not JSON', 'not json at all'],
    ['stdin that is JSON but not an object', '[1,2,3]'],
    ['an empty payload', '{}'],
    ['a payload with no hook_event_name', JSON.stringify({ cwd: '/repo' })],
    ['a null payload', 'null'],
    ['empty stdin', ''],
  ])('exits 0 on %s', async (_label, stdin) => {
    expect(await runHookCommand(stdin, { dataRoot: root })).toBe(0)
  })

  it('exits 0 when the door cannot be created at all', async () => {
    // A data root that cannot hold a directory — the stand-in for a full disk,
    // a permission refusal, or a read-only volume. The runner must not care
    // which.
    const notADirectory = path.join(root, 'file.txt')
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(notADirectory, 'x', 'utf8')

    expect(await runHookCommand(JSON.stringify(FIRING), { dataRoot: notADirectory })).toBe(0)
  })

  it('exits 0 even for a firing it wrote successfully — there is no other answer', async () => {
    // The control that makes the cases above mean something: this returns 0 on
    // success too, so "0" is not evidence of failure being swallowed. The
    // evidence is the file, which the tests above read.
    expect(await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })).toBe(0)
    expect((await readFile(doorFile(), 'utf8')).length).toBeGreaterThan(0)
  })

  it('appends rather than truncating — two firings are two lines', async () => {
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'Stop' }), { dataRoot: root })

    const lines = (await readFile(doorFile(), 'utf8')).split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).kind).toBe('tool-running')
    expect(JSON.parse(lines[1]!).kind).toBe('working')
  })
})
