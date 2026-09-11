import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BOOT_LINE_MARKER, isLoopbackHttpUrl, readListeningUrl } from './boot-line.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

describe('reading the listening URL off the server\'s own boot line', () => {
  it('takes the URL out of the exact line the server prints', () => {
    expect(readListeningUrl('rhizomorph running at http://127.0.0.1:4321\n')).toBe('http://127.0.0.1:4321')
  })

  it('finds it among the other lines a boot prints', () => {
    const output = [
      'rhizomorph: running /repo/packages/server/src/cli/index.ts (dist/cli/index.js not built)',
      'starting session 1755300000000 (no previous session recorded)',
      'rhizomorph running at http://127.0.0.1:38211',
      'watching /repo — 3 worktrees, 4 branches · recording to /data/s.jsonl',
    ].join('\n')
    expect(readListeningUrl(output)).toBe('http://127.0.0.1:38211')
  })

  it('returns null for output that has not printed the line yet', () => {
    expect(readListeningUrl('starting session 1755300000000\n')).toBeNull()
    expect(readListeningUrl('')).toBeNull()
  })

  it('takes the first URL when a resumed session prints more than one boot', () => {
    const output = ['rhizomorph running at http://127.0.0.1:4321', 'rhizomorph running at http://127.0.0.1:9999'].join(
      '\n',
    )
    expect(readListeningUrl(output)).toBe('http://127.0.0.1:4321')
  })

  it('trims trailing punctuation rather than pasting it into a URL', () => {
    expect(readListeningUrl('rhizomorph running at http://127.0.0.1:4321.')).toBe('http://127.0.0.1:4321')
  })

  it('REFUSES a line naming a host that is not loopback — the window is never pointed off the machine', () => {
    expect(readListeningUrl('rhizomorph running at http://0.0.0.0:4321')).toBeNull()
    expect(readListeningUrl('rhizomorph running at http://192.168.1.9:4321')).toBeNull()
    expect(readListeningUrl('rhizomorph running at https://example.com/')).toBeNull()
  })

  it('accepts the loopback spellings a server could legitimately print', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:4321')).toBe(true)
    expect(isLoopbackHttpUrl('http://localhost:4321')).toBe(true)
    expect(isLoopbackHttpUrl('http://[::1]:4321')).toBe(true)
  })

  it('is not fooled by a hostname that merely starts with a loopback spelling', () => {
    // `localhost.attacker.example` resolves to whatever that domain says.
    expect(isLoopbackHttpUrl('http://localhost.attacker.example:4321')).toBe(false)
    expect(isLoopbackHttpUrl('http://127.0.0.1.attacker.example/')).toBe(false)
  })

  it('rejects a value that is not a URL at all', () => {
    expect(isLoopbackHttpUrl('')).toBe(false)
    expect(isLoopbackHttpUrl('not a url')).toBe(false)
  })
})

describe('the marker is the server\'s own, not a copy that can drift (#563)', () => {
  it('is the literal string `run.ts` prints', () => {
    const runSource = readFileSync(path.join(REPO_ROOT, 'packages', 'server', 'src', 'cli', 'run.ts'), 'utf8')
    // The server prints it with a template literal: `rhizomorph running at ${url}`.
    expect(runSource).toContain(`${BOOT_LINE_MARKER}\${url}`)
  })

  it('is the same string the boot smoke greps for', () => {
    // Was `.github/workflows/ci.yml` until the smoke was extracted to a script
    // so it could outlive the workflow and run locally. The law follows the
    // grep to where it actually lives: reading ci.yml here would now pass
    // vacuously on a file that no longer contains the marker at all.
    const smoke = readFileSync(path.join(REPO_ROOT, 'scripts', 'boot-smoke.sh'), 'utf8')
    expect(smoke).toContain(BOOT_LINE_MARKER.trimEnd())
  })
})
