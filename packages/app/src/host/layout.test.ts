import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findRepoRoot,
  resolveLayout,
  SERVER_BUNDLE_SEGMENTS,
  SERVER_ENTRY_SEGMENTS,
  WEB_DIST_SEGMENTS,
} from './layout.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')

describe('the two worlds hang off one root', () => {
  it('resolves the development layout against the repo root', () => {
    const layout = resolveLayout({ packaged: false, repoRoot: '/repo', resourcesPath: '/app/Resources' })
    expect(layout).toEqual({
      packaged: false,
      root: '/repo',
      serverEntry: path.join('/repo', 'packages', 'server', 'bin', 'rhizomorph.mjs'),
      serverBundle: path.join('/repo', 'packages', 'server', 'dist', 'cli', 'index.js'),
      webDist: path.join('/repo', 'packages', 'web', 'dist'),
    })
  })

  it('resolves the packaged layout against resourcesPath, at the SAME relative paths', () => {
    const layout = resolveLayout({ packaged: true, repoRoot: '/repo', resourcesPath: '/app/Resources' })
    expect(layout.root).toBe('/app/Resources')
    expect(layout.serverEntry).toBe(path.join('/app/Resources', 'packages', 'server', 'bin', 'rhizomorph.mjs'))
    // The mirroring is the load-bearing part: `run.ts`'s defaultWebDistDir()
    // walks `<bundle>/../../../web/dist`, which only lands on the copied SPA
    // when the copy keeps the repo's own shape.
    expect(path.resolve(path.dirname(layout.serverBundle), '..', '..', '..', 'web', 'dist')).toBe(layout.webDist)
  })

  it('ignores the root it is not in — a packaged app never consults the repo root', () => {
    const packaged = resolveLayout({ packaged: true, repoRoot: '/repo', resourcesPath: '/app/Resources' })
    expect(packaged.serverEntry).not.toContain('/repo')
    const dev = resolveLayout({ packaged: false, repoRoot: '/repo', resourcesPath: '/app/Resources' })
    expect(dev.serverEntry).not.toContain('Resources')
  })
})

describe('the relative walk `run.ts` performs still lands where this file says', () => {
  it('holds against the real checkout, not against a fixture', () => {
    const layout = resolveLayout({ packaged: false, repoRoot: REPO_ROOT, resourcesPath: '/unused' })
    expect(existsSync(layout.serverEntry)).toBe(true)
    expect(path.resolve(path.dirname(layout.serverBundle), '..', '..', '..', 'web', 'dist')).toBe(layout.webDist)
  })

  it('names the three paths as segments, so a join is the only way to build one', () => {
    expect([...SERVER_ENTRY_SEGMENTS]).toEqual(['packages', 'server', 'bin', 'rhizomorph.mjs'])
    expect([...SERVER_BUNDLE_SEGMENTS]).toEqual(['packages', 'server', 'dist', 'cli', 'index.js'])
    expect([...WEB_DIST_SEGMENTS]).toEqual(['packages', 'web', 'dist'])
  })
})

describe('finding the repo root by search, not by counting `..`', () => {
  it('finds it from the source tree this test is running in', () => {
    expect(findRepoRoot(HERE, existsSync)).toBe(REPO_ROOT)
  })

  it('finds the same root from the built `dist/` — the depth a `..` count would get wrong', () => {
    // `esbuild` puts the bundled main at `packages/app/dist/main.js`, one level
    // shallower than `packages/app/src/host/`. A fixed count tuned to one is
    // wrong for the other; this is the assertion that pins it.
    const fromDist = findRepoRoot(path.join(REPO_ROOT, 'packages', 'app', 'dist'), existsSync)
    const fromSrc = findRepoRoot(path.join(REPO_ROOT, 'packages', 'app', 'src', 'host'), existsSync)
    expect(fromDist).toBe(REPO_ROOT)
    expect(fromSrc).toBe(REPO_ROOT)
  })

  it('returns null rather than guessing when there is no repo above', () => {
    expect(findRepoRoot('/nowhere/at/all', () => false)).toBeNull()
  })

  it('stops at the FIRST directory holding the bin, not the last', () => {
    const seen: string[] = []
    const found = findRepoRoot('/a/b/c', (candidate) => {
      seen.push(candidate)
      return candidate === path.join('/a/b', ...SERVER_ENTRY_SEGMENTS)
    })
    expect(found).toBe('/a/b')
    expect(seen[0]).toBe(path.join('/a/b/c', ...SERVER_ENTRY_SEGMENTS))
  })
})
