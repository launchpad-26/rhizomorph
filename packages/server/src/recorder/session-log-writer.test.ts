import { access, chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLogWriter } from './session-log-writer.js'

/**
 * The two properties the recorder seam added to the writer, both in service of
 * rotation (prd16 ruling 2, prd17 ruling 3.5): appends are ORDERED as issued,
 * and `sync()` is a real flush + fsync. The writer's round-trip behaviour with
 * the reader — resuming, dropping a crash-truncated last line — is tested
 * beside the reader in `log/session-log.test.ts`, where the pair belongs.
 *
 * The 2026-08-06 audit's two asks over this exact module — secure
 * permissions and a symlink guard — get their own `describe` blocks below.
 * chmod's bits are POSIX-only, so those specific assertions skip on Windows
 * rather than assert a mode Windows never applies.
 */
const isPosix = platform() !== 'win32'

function errorEvent(id: string, ts: number, message = 'boom') {
  return createEvent('collector.error', { collector: 'git', message }, { id, ts })
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('SessionLogWriter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-writer-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes lines in the order appends were ISSUED, even when nobody awaits them in turn', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const writer = new SessionLogWriter(filePath)

    // Two callers racing is the real case: a collector's poll and the
    // operator's rotation, in the same tick. Whoever called first is first in
    // the file — which is what makes "a final `session.closed`" a property of
    // the log rather than a hope about scheduling.
    const pending = [
      writer.append(errorEvent('evt-1', 1)),
      writer.append(errorEvent('evt-2', 2)),
      writer.append(errorEvent('evt-3', 3)),
    ]
    await Promise.all(pending)

    const ids = (await readFile(filePath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { id: string }).id)
    expect(ids).toEqual(['evt-1', 'evt-2', 'evt-3'])
  })

  it('sync() leaves the file complete — every issued append is on disk when it resolves', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const writer = new SessionLogWriter(filePath)

    void writer.append(errorEvent('evt-1', 1))
    void writer.append(errorEvent('evt-2', 2))
    await writer.sync()

    const raw = await readFile(filePath, 'utf8')
    expect(raw.trimEnd().split('\n')).toHaveLength(2)
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('sync() on a writer nobody appended to is a no-op, not an error — and creates no file', async () => {
    const filePath = path.join(dir, 'session-never-written.jsonl')
    const writer = new SessionLogWriter(filePath)

    await expect(writer.sync()).resolves.toBeUndefined()
    expect(await exists(filePath)).toBe(false)
  })

  it('surfaces a write failure to the caller that issued it', async () => {
    // A path whose parent is a FILE: `mkdir` cannot make it, so the append
    // fails loudly instead of silently losing an event.
    const blocked = path.join(dir, 'not-a-dir')
    await writeFile(blocked, 'in the way\n')
    const writer = new SessionLogWriter(path.join(blocked, 'session-1.jsonl'))

    await expect(writer.append(errorEvent('evt-1', 1))).rejects.toThrow()
  })

  describe('secure permissions (2026-08-06 audit)', () => {
    it.runIf(isPosix)('creates the session directory owner-only (0700)', async () => {
      const nested = path.join(dir, 'a-repo-hash')
      const writer = new SessionLogWriter(path.join(nested, 'session-1.jsonl'))

      await writer.append(errorEvent('evt-1', 1))

      expect((await stat(nested)).mode & 0o777).toBe(0o700)
    })

    it.runIf(isPosix)('creates the session log owner-only (0600)', async () => {
      const filePath = path.join(dir, 'session-1.jsonl')
      const writer = new SessionLogWriter(filePath)

      await writer.append(errorEvent('evt-1', 1))

      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    })

    it.runIf(isPosix)('tightens a pre-existing, over-permissive directory and file on a resumed run', async () => {
      const filePath = path.join(dir, 'session-1.jsonl')
      // A file left behind loosely-permissioned by, say, an older build of
      // this instrument, or an operator's own `chmod` — the resumed run
      // must not just trust whatever it finds.
      await writeFile(filePath, '{"a":1}\n', { mode: 0o666 })
      await chmod(dir, 0o777)

      const writer = new SessionLogWriter(filePath, { resuming: true })
      await writer.append(errorEvent('evt-2', 2))

      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    })
  })

  describe('symlink guard (2026-08-06 audit)', () => {
    it('refuses to append through a file that is a symlink, and never writes the decoy target', async () => {
      const decoyDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-writer-decoy-'))
      const decoy = path.join(decoyDir, 'not-a-session-log')
      await writeFile(decoy, 'untouched\n')

      const filePath = path.join(dir, 'session-1.jsonl')
      await symlink(decoy, filePath)

      const writer = new SessionLogWriter(filePath)
      await expect(writer.append(errorEvent('evt-1', 1))).rejects.toThrow(/symlink/)

      expect(await readFile(decoy, 'utf8')).toBe('untouched\n')
      await rm(decoyDir, { recursive: true, force: true })
    })

    it('refuses to append when the session directory itself is a symlink to somewhere else', async () => {
      const decoyDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-writer-decoy-dir-'))

      const linkedDir = path.join(dir, 'linked-session-dir')
      await symlink(decoyDir, linkedDir)

      const writer = new SessionLogWriter(path.join(linkedDir, 'session-1.jsonl'))
      await expect(writer.append(errorEvent('evt-1', 1))).rejects.toThrow(/symlink/)

      // the decoy dir itself must stay empty — nothing landed inside it
      expect(await readdir(decoyDir)).toEqual([])
      await rm(decoyDir, { recursive: true, force: true })
    })
  })
})
