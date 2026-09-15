import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INSTALLATION_ID_FILE,
  installationIdPath,
  isInstallationId,
  readOrMintInstallationId,
} from './installation-id.js'

const roots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rhizo-installation-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const FIXED = 'rzi_11111111-2222-3333-4444-555555555555'
const OTHER = 'rzi_99999999-8888-7777-6666-555555555555'

describe('the installation id is minted once (prd-57 ruling 7)', () => {
  it('mints on the first call and persists it where the next reader will look', () => {
    const dataRoot = freshRoot()
    const first = readOrMintInstallationId({ dataRoot, mint: () => FIXED })

    expect(first).toEqual({ id: FIXED, minted: true, replaced: null })
    expect(readFileSync(installationIdPath(dataRoot), 'utf8').trim()).toBe(FIXED)
  })

  it('a second call returns the stored id and does NOT mint — asserted against the FILE, not a cache', () => {
    const dataRoot = freshRoot()
    readOrMintInstallationId({ dataRoot, mint: () => FIXED })

    // The mint here would produce a DIFFERENT id if it were ever called. That
    // is the whole test: a module-level cache would pass a
    // call-it-twice-in-one-process check while being useless across two
    // processes, which is the case that matters — the CLI mints and the server
    // reads.
    const second = readOrMintInstallationId({ dataRoot, mint: () => OTHER })

    expect(second).toEqual({ id: FIXED, minted: false })
    expect(readFileSync(installationIdPath(dataRoot), 'utf8').trim()).toBe(FIXED)
  })

  it('the id does not parse as a number — a recorder session id does, and the two must never be swapped', () => {
    const dataRoot = freshRoot()
    const { id } = readOrMintInstallationId({ dataRoot })

    expect(isInstallationId(id)).toBe(true)
    expect(Number.isNaN(Number(id))).toBe(true)
    // api/meta.ts computes `startedAt: Number(ctx.recorder.sessionId)`. An
    // installation id reaching that call site must break loudly, not produce a
    // plausible epoch.
    expect(id.startsWith('rzi_')).toBe(true)
  })

  it('is not shaped like a machine key — ADR-0050 fixes `rzk_` for a credential, and this authorises nothing', () => {
    const { id } = readOrMintInstallationId({ dataRoot: freshRoot() })
    expect(id.startsWith('rzk_')).toBe(false)
  })

  it('lives under the data root itself, not under any repo slug — it outlives every repo', () => {
    const dataRoot = freshRoot()
    expect(installationIdPath(dataRoot)).toBe(path.join(dataRoot, INSTALLATION_ID_FILE))
  })
})

describe('an unusable stored value is replaced, and the replacement is reported', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
    ['a bare number, which is what a session id looks like', '1788591365000'],
    ['a machine key', 'rzk_deadbeefdeadbeefdeadbeefdeadbeef'],
    ['truncated', 'rzi_11111111-2222'],
  ])('replaces %s rather than returning it', (_label, corrupt) => {
    const dataRoot = freshRoot()
    readOrMintInstallationId({ dataRoot, mint: () => FIXED })
    writeFileSync(installationIdPath(dataRoot), corrupt, 'utf8')

    const outcome = readOrMintInstallationId({ dataRoot, mint: () => OTHER })

    expect(outcome.id).toBe(OTHER)
    expect(outcome.minted).toBe(true)
    // Reported, never silent: a replacement means something wrote a value this
    // instrument could not use, and the caller is entitled to say so.
    expect(outcome.minted === true ? outcome.replaced : undefined).toBe(corrupt.trim())
  })

  it('a first mint reports no replacement, so `replaced` distinguishes the two cases rather than always being set', () => {
    const outcome = readOrMintInstallationId({ dataRoot: freshRoot(), mint: () => FIXED })
    expect(outcome.minted === true ? outcome.replaced : 'not minted').toBeNull()
  })

  it('refuses to hand out an id its own mint got wrong, rather than persisting it', () => {
    const dataRoot = freshRoot()
    expect(() => readOrMintInstallationId({ dataRoot, mint: () => 'not-an-id' })).toThrow(/not one/)
    // And nothing was written, so the next honest call still mints cleanly.
    expect(readOrMintInstallationId({ dataRoot, mint: () => FIXED })).toEqual({
      id: FIXED,
      minted: true,
      replaced: null,
    })
  })
})

describe('two processes racing the first call settle on one id', () => {
  it('the loser returns the WINNER\'s id, not the one it just minted', () => {
    const dataRoot = freshRoot()

    // The race, made deterministic: this mint writes the winner's id into place
    // at exactly the moment the caller is between its read and its own create —
    // which is the window the `wx` flag exists to close.
    const outcome = readOrMintInstallationId({
      dataRoot,
      mint: () => {
        writeFileSync(installationIdPath(dataRoot), `${OTHER}\n`, 'utf8')
        return FIXED
      },
    })

    expect(outcome).toEqual({ id: OTHER, minted: false })
    expect(readFileSync(installationIdPath(dataRoot), 'utf8').trim()).toBe(OTHER)
  })

  it('a temp-file-and-rename implementation would fail this — rename REPLACES the target on both platforms', () => {
    // Stated as a test rather than a comment because it is the reason the
    // implementation looks the way it does. `rename` succeeds over an existing
    // file, so two writers would both "win" and the second would clobber a live
    // id. `wx` is the only primitive here that actually fails on the second
    // writer.
    const dataRoot = freshRoot()
    writeFileSync(installationIdPath(dataRoot), `${OTHER}\n`, 'utf8')
    expect(() => writeFileSync(installationIdPath(dataRoot), `${FIXED}\n`, { flag: 'wx' })).toThrow()
    expect(readFileSync(installationIdPath(dataRoot), 'utf8').trim()).toBe(OTHER)
  })
})

describe('this module has no hand', () => {
  it('reaches nothing under concierge/, and reads no harness configuration', () => {
    const source = readFileSync(new URL('./installation-id.ts', import.meta.url), 'utf8')
    for (const forbidden of [/concierge/, /\.claude/, /settings\.json/]) {
      expect(source, `installation-id.ts names ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('writes exactly one path, under the data root it was given', () => {
    const dataRoot = freshRoot()
    readOrMintInstallationId({ dataRoot, mint: () => FIXED })
    expect(readdirSync(dataRoot)).toEqual([INSTALLATION_ID_FILE])
  })
})
