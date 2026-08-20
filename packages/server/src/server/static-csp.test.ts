import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './build-app.js'
import { SessionRecorder } from './recorder.js'
import { sessionFilePath } from '../log/session-log.js'
import { CONTENT_SECURITY_POLICY } from './static.js'

/**
 * THE PAGE POLICY LAWS (loop 18). The renderer ran with no CSP at all — the
 * warning Electron printed on every boot this session. These laws hold the
 * policy to the page it protects: every HTML response carries it (the SPA
 * fallback included, which is how every client-side route arrives), assets
 * carry nosniff, and the policy itself keeps the two commitments the app's
 * own architecture makes — no eval, and nothing loaded from another origin.
 */
describe('the served page carries its Content-Security-Policy', () => {
  let dir: string
  let dist: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-csp-test-'))
    dist = path.join(dir, 'dist')
    await mkdir(path.join(dist, 'assets'), { recursive: true })
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
    await writeFile(path.join(dist, 'assets', 'index.js'), 'export {}')
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    return buildApp({
      repoPath: '/repo',
      repoName: 'repo',
      sessionDir: dir,
      recorder,
      webDistDir: dist,
    })
  }

  it('the page and every SPA-fallback route carry the policy', async () => {
    const app = makeApp()
    for (const url of ['/', '/settings', '/recordings/deep/route']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    }
    await app.close()
  })

  it('assets are nosniff and carry no page policy of their own', async () => {
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/assets/index.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBeUndefined()
    await app.close()
  })

  it('the policy keeps the two commitments: no eval, no other origin', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
    // every source expression is self, data: (images only), or none
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\//)
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
  })
})
