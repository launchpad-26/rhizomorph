import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPackageVersion } from './version.js'

describe('readPackageVersion', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-version-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the "version" field from the given package.json', async () => {
    const pkgPath = path.join(dir, 'package.json')
    await writeFile(pkgPath, JSON.stringify({ version: '3.4.5' }))

    await expect(readPackageVersion(pkgPath)).resolves.toBe('3.4.5')
  })

  it('throws when the file has no "version" field', async () => {
    const pkgPath = path.join(dir, 'package.json')
    await writeFile(pkgPath, JSON.stringify({ name: 'no-version-here' }))

    await expect(readPackageVersion(pkgPath)).rejects.toThrow(/no "version" string/)
  })

  it('resolves the real root package.json by default, matching this repo\'s own version', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const rootPkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'package.json')
    const rootPkg = JSON.parse(await readFile(rootPkgPath, 'utf8')) as { version: string }

    await expect(readPackageVersion()).resolves.toBe(rootPkg.version)
  })
})
