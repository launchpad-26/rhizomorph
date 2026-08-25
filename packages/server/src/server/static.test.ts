import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from './build-app.js'
import { SessionRecorder } from './recorder.js'
import { registerStaticRoute } from './static.js'

/**
 * The lane page (prd9 B1b, #135) is a client-side route: `GET /lane/<handle>`
 * has no file of its own in `dist`, so it must fall back to `index.html` the
 * same way `/` already does — the SPA router then reads the URL itself. This
 * file proves that fallback, and that it never shadows a route the API or
 * OTLP receiver actually owns.
 */
describe('registerStaticRoute — the SPA fallback', () => {
  let dir: string
  // Must hold to the real shape (`/^[0-9a-f]{64}$/`) — `injectCapabilityMeta`
  // refuses anything else, since that shape is what lets it interpolate a
  // token into HTML with no escaping.
  const TEST_TOKEN = 'deadbeef'.repeat(8)

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-test-'))
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><head><title>rhizomorph</title></head>')
    await mkdir(path.join(dir, 'assets'), { recursive: true })
    await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("app")')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    const app = Fastify()
    registerStaticRoute(app, dir, TEST_TOKEN)
    return app
  }

  it('serves a real file with its own content type', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/javascript')
    expect(response.body).toBe('console.log("app")')
  })

  it('serves index.html at the root', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('rhizomorph')
  })

  it('falls back to index.html for a lane page URL — a client route, not a file on disk', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/42-otel-receiver' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('rhizomorph')
  })

  it('falls back to index.html for any lane handle, including one with slashes in the wildcard tail', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/some/deeply/nested/handle' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('rhizomorph')
  })

  it('stamps the capability token into index.html at the root — issue #249, the only channel that delivers it', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(`<meta name="rhizomorph-capability" content="${TEST_TOKEN}">`)
  })

  it('stamps the capability token into the SPA-fallback index.html too, not only the literal root', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/42-otel-receiver' })

    expect(response.body).toContain(`<meta name="rhizomorph-capability" content="${TEST_TOKEN}">`)
  })

  it('never stamps a token into a non-HTML asset', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

    expect(response.body).not.toContain('rhizomorph-capability')
  })

  it('refuses a caller-supplied token that is not the 64-hex-character shape, rather than interpolating it unescaped', async () => {
    const app = Fastify()
    registerStaticRoute(app, dir, 'abc" onload="alert(1)')
    const response = await app.inject({ method: 'GET', url: '/' })

    // Fastify's default error handler turns the thrown refusal into a 500 —
    // the important fact either way is that the malformed value never
    // reaches the response body at all.
    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('onload')
  })

  it('inserts the meta tag right after <head ...> when there is no </head> to anchor on, never before <!doctype html>', async () => {
    const headlessDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-headless-test-'))
    try {
      await writeFile(path.join(headlessDir, 'index.html'), '<!doctype html><head><title>no closing tag</title>')
      const app = Fastify()
      registerStaticRoute(app, headlessDir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/' })

      expect(response.statusCode).toBe(200)
      expect(response.body.indexOf('<!doctype html>')).toBe(0)
      expect(response.body).toContain(`<head>\n  <meta name="rhizomorph-capability" content="${TEST_TOKEN}">`)
    } finally {
      await rm(headlessDir, { recursive: true, force: true })
    }
  })

  it('refuses a shell with no <head> element at all, rather than silently prepending before the doctype', async () => {
    const noHeadDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-no-head-test-'))
    try {
      await writeFile(path.join(noHeadDir, 'index.html'), '<!doctype html><body>no head here</body>')
      const app = Fastify()
      registerStaticRoute(app, noHeadDir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/' })

      expect(response.statusCode).toBe(500)
    } finally {
      await rm(noHeadDir, { recursive: true, force: true })
    }
  })

  it('never reads outside the dist root, however the wildcard tail is spelled', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/../../etc/passwd' })

    // The URL is normalised before it reaches the route at all, so this lands
    // on the ordinary SPA fallback — the outcome that matters either way:
    // nothing outside `dir` is ever read, and the response is never a 403 or
    // a leak of a file the dist root does not contain.
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('rhizomorph')
  })

  it('refuses a sibling directory that merely shares the root as a literal string prefix', async () => {
    // A bare `requested.startsWith(root)` would pass this: `dir + '-sibling'`
    // starts with `dir` as a string even though it is a different directory
    // one level up. `isPathContained` canonicalizes both sides and compares
    // by path segment, so it rejects this the same way the separator-aware
    // string check it replaced did.
    const siblingDir = `${dir}-sibling`
    await mkdir(siblingDir, { recursive: true })
    await writeFile(path.join(siblingDir, 'secret.txt'), 'top secret')
    try {
      const app = makeApp()
      // A literal `/../` is normalised away before routing even sees it (as
      // the test above already shows) — `%2f` survives that normalisation
      // and still decodes to a `..` segment in `request.params['*']`.
      const response = await app.inject({
        method: 'GET',
        url: `/..%2f${path.basename(dir)}-sibling/secret.txt`,
      })

      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('top secret')
    } finally {
      await rm(siblingDir, { recursive: true, force: true })
    }
  })

  it('refuses a symlink placed inside the dist root whose target resolves outside it', async () => {
    // This is the case a literal-prefix check cannot see: `escape-link`'s own
    // unresolved path is `dir/escape-link`, which starts with `root + sep`
    // same as any ordinary file — the escape only shows up once the link is
    // followed. `isPathContained` canonicalizes through `realpath`, so it
    // resolves `escape-link` to where it actually points before comparing.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-outside-test-'))
    await writeFile(path.join(outsideDir, 'secret.txt'), 'top secret')
    const linkPath = path.join(dir, 'escape-link')
    await symlink(outsideDir, linkPath)
    try {
      const app = makeApp()
      const response = await app.inject({ method: 'GET', url: '/escape-link/secret.txt' })

      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('top secret')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('serves a sibling symlink that points into the dist root — DECISION (prd-42 ruling 6): 200, not 403', async () => {
    // The mirror image of the two tests above, and the case #51 was filed
    // over. "refuses a sibling directory" (above `it`) is textually AND
    // actually outside root — refused. "refuses a symlink ... outside it" is
    // textually inside root but resolves outside — refused. This is the
    // fourth quadrant: textually OUTSIDE root (a sibling of `dir`, same as
    // the sibling-directory test's spelling), but the sibling itself is a
    // symlink whose target is `dir` — so it resolves INSIDE root.
    //
    // `#13` (prd42 w2) moved this input from 403 to 200 when it replaced the
    // old string-prefix check with `isPathContained`, and nothing pinned
    // that either way (prd-42 ruling 6). DECISION: 200. `isPathContained`
    // canonicalizes both sides before comparing, and canonicalization is the
    // definition of "where this path actually reads from" — once resolved,
    // this request reads `dir/assets/app.js`, byte-for-byte the same file a
    // direct request for `/assets/app.js` would serve. The symlink points
    // INTO dist, not out of it, so nothing outside `dir` is ever read; the
    // only thing that changed is the spelling the client used to name a file
    // already inside the served root, which is exactly the "canonicalized
    // containment" reading ruling 6 says is defensible. Refusing this would
    // require either re-adding a string check on the unresolved spelling
    // (ruling 2 forbids it — containment has one implementation) or teaching
    // the primitive to treat some canonicalized-inside paths as outside,
    // which would misrepresent what containment means everywhere else it is
    // used. If a future change to `canonicalize` ever stops resolving this
    // path to somewhere under `dir` (e.g. it starts refusing to follow a
    // symlink whose immediate parent lies outside the root it's asked
    // about), this assertion is the thing that goes red and says so.
    const siblingLink = `${dir}-sibling`
    await symlink(dir, siblingLink)
    try {
      const app = makeApp()
      const response = await app.inject({
        method: 'GET',
        url: `/..%2f${path.basename(dir)}-sibling/assets/app.js`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('console.log("app")')
    } finally {
      await rm(siblingLink, { force: true })
    }
  })

  it('closes the sibling-symlink TOCTOU: the containment check and the read must agree on ONE resolution, not two', async () => {
    // The pinned 200 above says a sibling symlink into `dist` is allowed
    // through because, once canonicalized, nothing outside `dist` is ever
    // read. That is only true if the containment CHECK and the eventual
    // READ resolve the same untrusted spelling to the same target. An
    // earlier shape of this route resolved it twice, independently — once
    // inside the containment check, once again to get a path to read — so a
    // symlink whose target moved between those two calls could pass the
    // check pointing one place and get read pointing somewhere else
    // entirely (review of #51, EXECUTED against the real route with an
    // actual swapped symlink: `GET /..%2f<dist>-sibling/secret.txt` served
    // the outside secret at 200).
    //
    // A real race can't be triggered deterministically in a synchronous
    // unit test — there is no `await` between the two resolutions for a
    // concurrent mutation to land in. Rather than reimplementing the
    // containment comparison here (prd-42 ruling 2 forbids a second copy of
    // it, test files included), this drives the REAL `canonicalize`/
    // `isInside` through the `realpath` parameter both already accept for
    // exactly this purpose ("`realpath` is overridable so tests can
    // simulate a canonicalizer that DOES disagree with itself" —
    // `containment.ts`'s own doc comment on `isInside`). The fake only
    // replaces the lowest-level primitive: what a SECOND `realpath` call on
    // the exact same still-symlinked raw string sees, versus the first. A
    // resolved, symlink-free value never re-triggers it, because it is
    // never equal to that raw string.
    const siblingLink = `${dir}-sibling`
    await symlink(dir, siblingLink)
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-toctou-test-'))
    await writeFile(path.join(outsideDir, 'secret.txt'), 'top secret')
    try {
      const root = path.resolve(dir)
      const rawRequested = path.resolve(root, `../${path.basename(dir)}-sibling/assets/app.js`)
      const nativeRealpath = realpathSync.native ?? realpathSync
      let sawRawRequestOnce = false

      function trackedRealpath(existingPath: string): string {
        if (existingPath !== rawRequested) return nativeRealpath(existingPath)
        if (!sawRawRequestOnce) {
          sawRawRequestOnce = true
          return nativeRealpath(existingPath) // the symlink still points inside root — a real, honest resolution
        }
        // Any FURTHER resolution of that exact same raw spelling is what a
        // swapped symlink would produce — modelled here as resolving to a
        // file outside root instead, without needing to mutate a real
        // symlink mid-request (impossible to land deterministically without
        // an `await` between the two calls this defect used to make).
        return nativeRealpath(path.join(outsideDir, 'secret.txt'))
      }

      vi.resetModules()
      const actual = await vi.importActual<typeof import('../paths/containment.js')>('../paths/containment.js')
      vi.doMock('../paths/containment.js', () => ({
        ...actual,
        canonicalize: (candidate: string) => actual.canonicalize(candidate, trackedRealpath),
        isInside: (parent: string, candidate: string) => actual.isInside(parent, candidate, trackedRealpath),
      }))

      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({
        method: 'GET',
        url: `/..%2f${path.basename(dir)}-sibling/assets/app.js`,
      })

      // Resolving once means the check and the read cannot disagree: the
      // one snapshot taken is inside root, so it is served — the SAME file
      // `/assets/app.js` would serve directly — and the outside secret,
      // which only a SECOND resolution of the raw spelling could ever see,
      // is never reached. Under the old two-resolution code this assertion
      // fails: the check passes against the first (inside) resolution and
      // the read then uses the second (swapped) one, serving 'top secret'.
      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('console.log("app")')
      expect(response.body).not.toContain('top secret')
    } finally {
      vi.doUnmock('../paths/containment.js')
      vi.resetModules()
      await rm(siblingLink, { force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('reads through an already-open descriptor regardless of what happens to the path afterward — the guarantee the fd rewrite relies on', () => {
    // Second review round of #51: the first TOCTOU fix canonicalized once
    // and checked that, but still read the result via MORE independent,
    // path-based calls (`existsSync`, `statSync`, `readFileSync`/
    // `createReadStream` by path) — each one asking the filesystem "what is
    // at this path?" all over again. A review seat reproduced a leak by
    // replacing `dist/assets` with a symlink to an outside file DURING that
    // gap (specifically: after `statSync` had already confirmed the path
    // was a real, in-root file, but before the subsequent read). This is
    // the mechanism that closes it, isolated with no server or HTTP
    // involved (mirroring how the review itself found the defect): a file
    // descriptor names an open inode, not a path spelling, so nothing that
    // happens to the PATH after `openSync` returns can change what reading
    // THAT DESCRIPTOR produces — there is no later path-based operation left
    // for a swap to land in front of.
    const appJsPath = path.join(dir, 'assets', 'app.js')
    const fd = openSync(appJsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      // Replace the real `assets` directory with a symlink elsewhere —
      // exactly the swap the review executed against the old design —
      // AFTER the descriptor above was already opened against the real file.
      const impostorDir = path.join(dir, 'impostor-assets')
      mkdirSync(impostorDir)
      writeFileSync(path.join(impostorDir, 'app.js'), 'IMPOSTOR CONTENT')
      rmSync(path.join(dir, 'assets'), { recursive: true, force: true })
      symlinkSync(impostorDir, path.join(dir, 'assets'))

      expect(readFileSync(fd, 'utf8')).toBe('console.log("app")')
    } finally {
      closeSync(fd)
    }
  })

  // Fires `onSecondResolution` the SECOND time `targetPath` — or its own
  // canonical form — is resolved through the `realpath` this returns.
  //
  // Two forms, not one, because `canonicalize` resolves `targetPath` on its
  // very FIRST call and every later caller (the containment check, in
  // particular) passes THAT resolved string onward, never the raw one
  // again. On a platform where the temp directory itself sits behind a
  // symlink — `os.tmpdir()` on macOS resolves `/var` to `/private/var`,
  // exactly the shape this repo's own macOS CI leg exists to catch
  // (AGENTS.md) — the raw and canonical spellings of `targetPath` are
  // DIFFERENT STRINGS: the first call sees the raw one, the second sees the
  // canonical one, and matching only the raw form never sees a second hit
  // at all. EXECUTED, on this repo's own macOS CI leg, not locally (this
  // sandbox is Linux and cannot reproduce a symlinked tmpdir): six tests
  // built on an earlier, single-form version of this helper failed there —
  // `gh run view 32904237083 --log-failed` — every one of them with the
  // swapped-to content simply never appearing, because the swap this
  // function exists to time never fired. Matching both forms costs nothing
  // on Linux, where they are already the same string.
  function trackResolutionsOf(targetPath: string, onSecondResolution: () => void): (existingPath: string) => string {
    const nativeRealpath = realpathSync.native ?? realpathSync
    const canonicalTargetPath = nativeRealpath(targetPath)
    let resolutionCount = 0
    return function trackedRealpath(existingPath: string): string {
      const real = nativeRealpath(existingPath)
      if (existingPath === targetPath || existingPath === canonicalTargetPath) {
        resolutionCount += 1
        if (resolutionCount === 2) onSecondResolution()
      }
      return real
    }
  }

  // Shared by both tests below: swap `dist/assets` for a symlink to
  // `outsideDir`, timed to land in the declared residual window — right
  // after the containment check's own re-canonicalization of `filePath`
  // approves the real, in-root file, and strictly before the subsequent
  // `openSync` call. Drives the REAL `canonicalize`/`isInside` through an
  // injected `realpath` (the same technique the sibling-swap test above
  // uses) rather than reimplementing the containment comparison — prd-42
  // ruling 2. Returns the `outsideDir` cleanup path; callers install the
  // mock and register a fresh route themselves, since what else gets mocked
  // alongside it differs between the two tests.
  async function installIntermediateSwap() {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-component-swap-test-'))
    await writeFile(path.join(outsideDir, 'app.js'), 'IMPOSTOR CONTENT')
    const assetsDir = path.join(dir, 'assets')
    const targetPath = path.join(dir, 'assets', 'app.js')
    const trackedRealpath = trackResolutionsOf(targetPath, () => {
      rmSync(assetsDir, { recursive: true, force: true })
      symlinkSync(outsideDir, assetsDir)
    })

    const actual = await vi.importActual<typeof import('../paths/containment.js')>('../paths/containment.js')
    vi.doMock('../paths/containment.js', () => ({
      ...actual,
      canonicalize: (candidate: string) => actual.canonicalize(candidate, trackedRealpath),
      isInside: (parent: string, candidate: string) => actual.isInside(parent, candidate, trackedRealpath),
    }))

    return outsideDir
  }

  // `/proc/self/fd` is Linux-only — skipped, not silently not-run, on any
  // other platform (the shape #74 is filed against: an assertion that would
  // read as passing, or simply not appear, without saying why). This
  // environment and this repo's `ubuntu-latest` CI leg are Linux; the
  // macOS leg (`ci.yml:32`) skips this one and is covered instead by the
  // simulated-fallback test below, which needs no real `/proc` to prove
  // what happens in its absence.
  it.skipIf(process.platform !== 'linux')(
    'closes the intermediate-directory swap on LINUX, via the descriptor\'s own /proc/self/fd path',
    async () => {
      // Second review round declared this window permanently open — wrong:
      // once `fd` is open, "where did this descriptor actually land" is a
      // different, race-free question from "where will this path resolve",
      // and the kernel's own answer to it (via `/proc/self/fd`, real here,
      // not mocked) is authoritative. `descriptorRealPath` answers that
      // question, and `isUnderCanonicalRoot` refuses when it disagrees with
      // `canonicalRoot` — comparing the kernel's already-resolved string
      // directly, never re-canonicalizing it (round 5: doing so through
      // `isPathContained` reopened the very race this check exists to
      // close — see the rebind test below).
      const outsideDir = await installIntermediateSwap()
      try {
        const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
        const app = Fastify()
        registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
        const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

        // `openSync` still walks the swapped `assets` symlink and lands on
        // the impostor file — but the fd it returns is pinned to THAT
        // inode, and `/proc/self/fd` reports exactly that, truthfully, so
        // the post-open check catches what `openSync` alone could not.
        expect(response.statusCode).toBe(403)
        expect(response.body).not.toContain('IMPOSTOR')
      } finally {
        vi.doUnmock('../paths/containment.js')
        vi.resetModules()
        await rm(outsideDir, { recursive: true, force: true })
      }
    },
  )

  // The fallback test used to run ONE shape on every platform: simulate
  // `/proc` being unavailable, on whatever platform happened to run it.
  // That is backwards on the one platform where the fallback is actually
  // real — it simulates a condition macOS already has, instead of letting
  // the real thing happen (round 7 review: "a fallback test that cannot run
  // where the fallback actually lives is not testing the fallback"). Split
  // into a mirror pair instead, each exercising the shape real for ITS
  // platform and saying so in its own name — `it.skipIf`, not a silent gap:
  // - on Linux, `/proc` is normally real, so the absence has to be
  //   SIMULATED to exercise the fallback at all;
  // - everywhere else (macOS above all), `/proc` genuinely does not exist,
  //   so the exact same scenario is run with NO mocking of `readlinkSync`
  //   at all — the real fallback, for real.
  it.skipIf(process.platform !== 'linux')(
    'the same intermediate-directory swap still gets served when /proc/self/fd is unavailable — SIMULATED, on Linux where /proc is normally real',
    async () => {
      // If this ever starts failing because some OTHER mechanism closed it
      // too, that is progress — update this test and the comment in
      // `static.ts` together; don't just delete the inconvenient assertion.
      const outsideDir = await installIntermediateSwap()
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      vi.doMock('node:fs', () => ({
        ...actualFs,
        readlinkSync: (linkPath: string, options?: unknown) => {
          if (typeof linkPath === 'string' && linkPath.startsWith('/proc/self/fd/')) {
            const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, readlink '${linkPath}'`)
            err.code = 'ENOENT'
            throw err
          }
          return actualFs.readlinkSync(linkPath, options as never)
        },
      }))

      try {
        const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
        const app = Fastify()
        registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
        const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

        expect(response.statusCode).toBe(200)
        expect(response.body).toBe('IMPOSTOR CONTENT')
      } finally {
        vi.doUnmock('../paths/containment.js')
        vi.doUnmock('node:fs')
        vi.resetModules()
        await rm(outsideDir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'linux')(
    'the same intermediate-directory swap still gets served when /proc/self/fd is unavailable — REAL, on this platform where /proc genuinely does not exist',
    async () => {
      // No `readlinkSync` mock at all — `descriptorRealPath`'s own
      // `try { readlinkSync(...) } catch { return undefined }` hits the
      // real ENOENT this platform's missing `/proc` produces, for real.
      const outsideDir = await installIntermediateSwap()

      try {
        const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
        const app = Fastify()
        registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
        const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

        expect(response.statusCode).toBe(200)
        expect(response.body).toBe('IMPOSTOR CONTENT')
      } finally {
        vi.doUnmock('../paths/containment.js')
        vi.resetModules()
        await rm(outsideDir, { recursive: true, force: true })
      }
    },
  )

  // LINUX-ONLY, gated with a stated reason (round 8: three tests of exactly
  // this shape were missed the first time round — same file, same
  // property, same round this whole issue has been about at the code
  // level, now caught at the level of test gating instead). The property
  // that puts a test in this bucket: its expected outcome is 403, and that
  // 403 can ONLY come from the `/proc/self/fd`-based `descriptorRealPath` /
  // `isUnderCanonicalRoot` check — on a platform without `/proc`, the exact
  // same intermediate-directory swap would succeed at 200 through
  // `openInsideRoot` alone (the documented, DIFFERENT fallback behaviour,
  // covered by its own paired tests above). This one and the two below it
  // all swap-then-expect-403; every other test in this file either expects
  // an outcome the pre-open containment check or `O_NOFOLLOW` alone already
  // produces (no `/proc` involved at all) or is a plain, unattacked request.
  it.skipIf(process.platform !== 'linux')(
    'a file merely NAMED with the deleted-suffix text is refused — the CONTROL: still linked, no unlink involved at all',
    async () => {
      // Originally BLOCKING 1, round 5 (found independently by two review
      // seats, one with nothing more than a filename): a NAMED-not-deleted
      // outside file, `ordinary.js (deleted)`, used to slip past a
      // suffix-texted-based "genuinely unlinked, skip the check" branch.
      // Round 6 deleted that branch entirely rather than patching it again —
      // see `descriptorRealPath`'s doc comment for why the branch had become
      // a bypass and why a pure segment comparison needs no such skip at all.
      // This test is now the CONTROL half of that story: the file is real,
      // still linked, never unlinked — the segment comparison must still
      // refuse it because it is genuinely outside `root`, suffix or not. The
      // round-6 bypass itself (this same filename, unlinked mid-request) is
      // the next test.
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-malicious-filename-test-'))
    await writeFile(path.join(outsideDir, 'ordinary.js (deleted)'), 'IMPOSTOR CONTENT')
    // The swapped-FROM file must genuinely exist inside root beforehand —
    // `canonicalize`'s walk-up-on-ENOENT only reaches the tracked `realpath`
    // at all once per resolution if the full path resolves; a target that
    // never existed inside root would throw before the swap-timing counter
    // below ever got a chance to increment.
    await writeFile(path.join(dir, 'assets', 'ordinary.js (deleted)'), 'the real, in-root file')
    try {
      const assetsDir = path.join(dir, 'assets')
      const targetPath = path.join(dir, 'assets', 'ordinary.js (deleted)')
      const trackedRealpath = trackResolutionsOf(targetPath, () => {
        rmSync(assetsDir, { recursive: true, force: true })
        symlinkSync(outsideDir, assetsDir)
      })

      vi.resetModules()
      const actual = await vi.importActual<typeof import('../paths/containment.js')>('../paths/containment.js')
      vi.doMock('../paths/containment.js', () => ({
        ...actual,
        canonicalize: (candidate: string) => actual.canonicalize(candidate, trackedRealpath),
        isInside: (parent: string, candidate: string) => actual.isInside(parent, candidate, trackedRealpath),
      }))

      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/ordinary.js%20(deleted)' })

      // Refused: outside root, suffix or not — the segment comparison never
      // treats the `... (deleted)`-suffixed last segment as evidence of
      // anything, so there is nothing here for the text to fool.
      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('IMPOSTOR')
    } finally {
      vi.doUnmock('../paths/containment.js')
      vi.resetModules()
      await rm(outsideDir, { recursive: true, force: true })
    }
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'the round-6 bypass: the same malicious filename, genuinely unlinked mid-request, is STILL refused',
    async () => {
    // The bypass BOTH round-6 review seats found, and I reproduced myself
    // before deleting anything: the deleted-suffix skip round 5 added
    // looked at two facts — the reported target ends in `' (deleted)'`, and
    // `fstatSync(fd).nlink === 0` — and both become honestly true at once
    // when an outside file named `ordinary.js (deleted)` (opened via the
    // usual intermediate swap) is genuinely unlinked in the window between
    // `readlinkSync` and that `fstatSync` call. With the skip in place, that
    // made `descriptorRealPath` return `undefined` — "no verdict" — and the
    // still-open, still-outside descriptor streamed at 200 with nothing left
    // to catch it. The skip is now deleted (see `descriptorRealPath`'s doc
    // comment): there is no `fstatSync` call left inside it to time an
    // unlink against, and the segment comparison downstream never looks at
    // whether the last segment says "(deleted)" at all — outside is outside,
    // unlinked or not.
    //
    // Timed via the same "hook the one `fstatSync` call `openInsideRoot`
    // itself makes" technique as the "swap after open" tests, so the unlink
    // lands deterministically right after `fd` is established — no raced
    // timing, no reliance on winning against real wall-clock scheduling.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-bypass-unlink-test-'))
    const maliciousPath = path.join(outsideDir, 'ordinary.js (deleted)')
    await writeFile(maliciousPath, 'IMPOSTOR CONTENT')
    await writeFile(path.join(dir, 'assets', 'ordinary.js (deleted)'), 'the real, in-root file')
    let sawFstatOnce = false

    try {
      const assetsDir = path.join(dir, 'assets')
      const targetPath = path.join(dir, 'assets', 'ordinary.js (deleted)')
      const trackedRealpath = trackResolutionsOf(targetPath, () => {
        rmSync(assetsDir, { recursive: true, force: true })
        symlinkSync(outsideDir, assetsDir)
      })

      vi.resetModules()
      const actual = await vi.importActual<typeof import('../paths/containment.js')>('../paths/containment.js')
      vi.doMock('../paths/containment.js', () => ({
        ...actual,
        canonicalize: (candidate: string) => actual.canonicalize(candidate, trackedRealpath),
        isInside: (parent: string, candidate: string) => actual.isInside(parent, candidate, trackedRealpath),
      }))
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      vi.doMock('node:fs', () => ({
        ...actualFs,
        fstatSync: (fd: number, options?: unknown) => {
          if (!sawFstatOnce) {
            sawFstatOnce = true
            // `fd` is already open, bound to the malicious outside file, at
            // this point — the genuine unlink lands right after, the same
            // instant the old skip's own `fstatSync(fd).nlink === 0` check
            // would have fired.
            rmSync(maliciousPath, { force: true })
          }
          return actualFs.fstatSync(fd, options as never)
        },
      }))

      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/ordinary.js%20(deleted)' })

      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('IMPOSTOR')
      expect(sawFstatOnce).toBe(true)
    } finally {
      vi.doUnmock('../paths/containment.js')
      vi.doUnmock('node:fs')
      vi.resetModules()
      await rm(outsideDir, { recursive: true, force: true })
    }
    },
  )

  it('a GENUINE in-root file, unlinked mid-request, still serves its correct original bytes — the legitimate case round 6 must not regress', async () => {
    // The other half of what the deleted-suffix skip's removal has to
    // prove: it existed to protect a real case (a legitimate, in-root file
    // deleted out from under an already-open `fd`), and that case must keep
    // working with the skip GONE, not just with the bypass closed. Segment
    // comparison handles it for free: `/proc/self/fd` reports
    // `<realRoot>/assets-file.js (deleted)`, and `isUnderCanonicalRoot` only
    // ever checks the segments spanning `canonicalRoot` itself — the
    // `(deleted)`-suffixed LAST segment is never compared against anything,
    // so it neither helps nor hurts. No swap, no mocked containment module —
    // this is the plain, no-attacker path, unlinked via the same
    // fstatSync-hook timing as the bypass test above.
    const targetPath = path.join(dir, 'assets', 'genuine-file.js')
    await writeFile(targetPath, 'genuinely inside, then unlinked')
    let sawFstatOnce = false

    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.doMock('node:fs', () => ({
      ...actualFs,
      fstatSync: (fd: number, options?: unknown) => {
        if (!sawFstatOnce) {
          sawFstatOnce = true
          rmSync(targetPath, { force: true })
        }
        return actualFs.fstatSync(fd, options as never)
      },
    }))

    try {
      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/genuine-file.js' })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('genuinely inside, then unlinked')
      expect(sawFstatOnce).toBe(true)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  // LINUX-ONLY, same shape and same reason as the two tests above: this
  // asserts a 403 only the `/proc`-based check produces (here, catching a
  // rebind that would otherwise fool a re-resolution). Without `/proc` the
  // rebind question doesn't even arise — the swap alone would succeed at
  // 200, the fallback's job, not this test's.
  it.skipIf(process.platform !== 'linux')(
    'a rebind timed right after readlinkSync cannot flip the verdict — nothing re-resolves the kernel\'s answer',
    async () => {
    // BLOCKING 2, round 5. My own error caused this one: I told the lane to
    // feed the /proc answer into `isPathContained` "rather than writing a
    // second string test" — wrong, because `isPathContained` -> `isInside`
    // -> `realpathSync.native`, so that call CANONICALIZES THE /proc ANSWER
    // AGAIN — a third filesystem resolution, precisely the thing this whole
    // fix exists to eliminate. EXECUTED, mechanism-level, before the fix:
    // rebinding the outside directory `readlinkSync` just reported back to
    // somewhere INSIDE root, timed between that call and `isPathContained`,
    // made the check agree the still-outside `fd` was fine.
    //
    // Modelled here: the usual intermediate swap lands `fd` on the real
    // outside impostor file; a SEPARATE mock makes any FRESH resolution of
    // that exact reported path claim to be inside root — what a
    // rebind-then-recheck would produce. Against the fix (`isUnderCanonicalRoot`,
    // comparing the string `readlinkSync` already returned, once, with no
    // further filesystem call) this mock is never even consulted, so it has
    // no effect — proving there is nothing left after `readlinkSync` for a
    // rebind to land in front of.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-rebind-test-'))
    const impostorPath = path.join(outsideDir, 'app.js')
    await writeFile(impostorPath, 'IMPOSTOR CONTENT')
    try {
      const assetsDir = path.join(dir, 'assets')
      const targetPath = path.join(dir, 'assets', 'app.js')
      const nativeRealpath = realpathSync.native ?? realpathSync
      const baseTrackedRealpath = trackResolutionsOf(targetPath, () => {
        rmSync(assetsDir, { recursive: true, force: true })
        symlinkSync(outsideDir, assetsDir)
      })

      function trackedRealpath(existingPath: string): string {
        // The rebind simulation: a FRESH resolution of the impostor's own
        // (real, outside) path is made to falsely claim it is inside root —
        // modelling a rebind landing right after `readlinkSync` reports it.
        if (existingPath === nativeRealpath(impostorPath)) {
          return path.join(dir, 'assets', 'app.js')
        }
        return baseTrackedRealpath(existingPath)
      }

      vi.resetModules()
      const actual = await vi.importActual<typeof import('../paths/containment.js')>('../paths/containment.js')
      vi.doMock('../paths/containment.js', () => ({
        ...actual,
        canonicalize: (candidate: string) => actual.canonicalize(candidate, trackedRealpath),
        isInside: (parent: string, candidate: string) => actual.isInside(parent, candidate, trackedRealpath),
      }))

      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('IMPOSTOR')
    } finally {
      vi.doUnmock('../paths/containment.js')
      vi.resetModules()
      await rm(outsideDir, { recursive: true, force: true })
    }
    },
  )

  it('never leaks a descriptor when fstatSync itself throws (EIO), not just when it reports a directory', async () => {
    // Round 5, found by reading: `openInsideRoot`'s `isDirectory()` branch
    // already closed `fd` on its own way out, but a THROW from `fstatSync`
    // itself (EIO above all) escaped the function with `fd` still open —
    // the caller's `catch` (which turns this into a 403) had no way to know
    // a descriptor needed closing.
    let openedFd: number | undefined
    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.doMock('node:fs', () => ({
      ...actualFs,
      fstatSync: (fd: number, options?: unknown) => {
        openedFd = fd
        const err: NodeJS.ErrnoException = new Error('EIO: i/o error, fstat')
        err.code = 'EIO'
        throw err
      },
    }))

    try {
      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

      expect(response.statusCode).toBe(403)
      expect(openedFd).not.toBeUndefined()
      // Probed with the REAL fstatSync (not the mocked, always-throwing
      // one): EBADF means `fd` was actually closed, not merely abandoned.
      expect(() => actualFs.fstatSync(openedFd as number)).toThrow(
        expect.objectContaining({ code: 'EBADF' }),
      )
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('a swap landing AFTER the open still streams the ORIGINAL bytes — through the real route, not just the isolated mechanism', async () => {
    // The mechanism test above proves the underlying guarantee (a
    // descriptor is immune to a later path swap) but never calls into this
    // route's own code, so it cannot tell a descriptor-based read apart from
    // a path-based one in `static.ts` itself — it would pass unchanged even
    // if `createReadStream(filePath, { fd })` above were reverted to
    // `createReadStream(filePath)`. Reviewed and confirmed: reverting that
    // one call (and the matching `readFileSync(fd, ...)` in the next test)
    // left this whole file at 23/23 green, because every OTHER swap test
    // times its swap during the CONTAINMENT CHECK — strictly BEFORE
    // `openSync` runs — so a path-based re-read and an fd-based read see the
    // identically-already-swapped filesystem either way and can't be told
    // apart by any assertion. This test times the swap to land strictly
    // AFTER `openSync` has already returned an fd, by making it a side
    // effect of `fstatSync` — the one call `openInsideRoot` itself makes
    // between the open and the eventual read — so the ordering is
    // guaranteed, not raced.
    const impostorDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-post-open-swap-test-'))
    await writeFile(path.join(impostorDir, 'app.js'), 'IMPOSTOR CONTENT')
    let sawFstatOnce = false

    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.doMock('node:fs', () => ({
      ...actualFs,
      fstatSync: (fd: number, options?: unknown) => {
        if (!sawFstatOnce) {
          sawFstatOnce = true
          // `fd` is already open and bound to the real `app.js` at this
          // point — this swap happens strictly AFTER that, and strictly
          // BEFORE the route's subsequent `readFileSync(fd, ...)` /
          // `createReadStream(filePath, { fd })` call.
          rmSync(path.join(dir, 'assets'), { recursive: true, force: true })
          symlinkSync(impostorDir, path.join(dir, 'assets'))
        }
        return actualFs.fstatSync(fd, options as never)
      },
    }))

    try {
      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

      // If this were reading by path (the reverted shape), it would now
      // reopen `filePath` fresh, follow the swapped `assets` symlink, and
      // return 'IMPOSTOR CONTENT' — EXECUTED and confirmed to happen when
      // this exact mutation was applied to `static.ts` and this test run
      // against it.
      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('console.log("app")')
      expect(response.body).not.toContain('IMPOSTOR')
      expect(sawFstatOnce).toBe(true)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
      await rm(impostorDir, { recursive: true, force: true })
    }
  })

  it('a swap landing AFTER the open still reads the ORIGINAL bytes for the .html branch too', async () => {
    // The same proof as above, for the OTHER read call this route makes:
    // `readFileSync(fd, 'utf8')` in the `.html` branch. `/` resolves to
    // `index.html`, which takes that branch, not `createReadStream`.
    const impostorDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-post-open-swap-html-test-'))
    await writeFile(
      path.join(impostorDir, 'index.html'),
      '<!doctype html><head><title>impostor</title></head>',
    )
    let sawFstatOnce = false

    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.doMock('node:fs', () => ({
      ...actualFs,
      fstatSync: (fd: number, options?: unknown) => {
        if (!sawFstatOnce) {
          sawFstatOnce = true
          rmSync(path.join(dir, 'index.html'), { force: true })
          symlinkSync(path.join(impostorDir, 'index.html'), path.join(dir, 'index.html'))
        }
        return actualFs.fstatSync(fd, options as never)
      },
    }))

    try {
      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/' })

      // Reading by path here would reopen the now-swapped `index.html` and
      // stamp the capability token into the IMPOSTOR shell instead —
      // EXECUTED and confirmed to happen when this mutation was applied.
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('rhizomorph')
      expect(response.body).not.toContain('impostor')
      expect(sawFstatOnce).toBe(true)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
      await rm(impostorDir, { recursive: true, force: true })
    }
  })

  it('O_NOFOLLOW refuses when the FINAL path component becomes a symlink between the check and the open — 403, not a silent follow', async () => {
    // The sibling to the intermediate-directory swap tests above: those
    // swap an INTERMEDIATE component (`assets`) — `openSync` follows it
    // regardless of `O_NOFOLLOW` (which never claimed to cover that case).
    // This one swaps the FINAL component (`app.js` itself) into a symlink in
    // the same window, which `O_NOFOLLOW` DOES cover: `openSync` must refuse
    // (ELOOP) rather than follow it.
    //
    // `/proc/self/fd` is ALSO simulated unavailable here, deliberately: on
    // real Linux, a dropped `O_NOFOLLOW` still gets caught afterward by the
    // `descriptorRealPath` check below (the fd would land outside `root`,
    // same as the intermediate-directory case) — EXECUTED and confirmed:
    // dropping `O_NOFOLLOW` with `/proc` left real left this test green for
    // the WRONG reason, the second check quietly covering for the first. On
    // any platform without `/proc/self/fd` (macOS above all), THAT
    // safety net does not exist, so `O_NOFOLLOW` is the only thing standing
    // between this exact input and a 200 — simulating its absence here is
    // what makes this test isolate `O_NOFOLLOW`'s own contribution rather
    // than the two checks' combined effect. Confirmed load-bearing THIS way:
    // temporarily dropping `O_NOFOLLOW` from `openInsideRoot`'s flags and
    // rerunning this exact test turns the 403 below into a 200 serving the
    // impostor content.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-final-component-swap-test-'))
    await writeFile(path.join(outsideDir, 'app.js'), 'IMPOSTOR CONTENT')
    try {
      const targetPath = path.join(dir, 'assets', 'app.js')
      // Fires during the containment check's own re-canonicalization of
      // `filePath` — strictly BEFORE the subsequent `openSync` call, the
      // same window as the intermediate-directory swap tests above, but
      // targeting the LAST path segment instead.
      const trackedRealpath = trackResolutionsOf(targetPath, () => {
        rmSync(targetPath, { force: true })
        symlinkSync(path.join(outsideDir, 'app.js'), targetPath)
      })

      vi.resetModules()
      const actual = await vi.importActual<typeof import('../paths/containment.js')>('../paths/containment.js')
      vi.doMock('../paths/containment.js', () => ({
        ...actual,
        canonicalize: (candidate: string) => actual.canonicalize(candidate, trackedRealpath),
        isInside: (parent: string, candidate: string) => actual.isInside(parent, candidate, trackedRealpath),
      }))
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      vi.doMock('node:fs', () => ({
        ...actualFs,
        readlinkSync: (linkPath: string, options?: unknown) => {
          if (typeof linkPath === 'string' && linkPath.startsWith('/proc/self/fd/')) {
            const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, readlink '${linkPath}'`)
            err.code = 'ENOENT'
            throw err
          }
          return actualFs.readlinkSync(linkPath, options as never)
        },
      }))

      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('IMPOSTOR')
    } finally {
      vi.doUnmock('node:fs')
      vi.doUnmock('../paths/containment.js')
      vi.resetModules()
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('never leaks a descriptor, on any exit path: refused, directory, index.html fallback, not-found, html read, or stream', async () => {
    // Every place `static.ts` can return without reaching the final
    // `reply.send`, and every place it opens a descriptor, exercised
    // together against ONE instrumented run so a leak on any of them shows
    // up as a descriptor still open at the end. Only `openSync` is wrapped
    // to record what got opened — NOT `closeSync`/`close`, deliberately:
    // `createReadStream`'s own `autoClose` closes its fd through a
    // reference to `fs.close` it captures internally when built from the
    // real, unmocked `fs` module (spread in below as `...actualFs`), so a
    // module-level mock of `close` never actually intercepts it — that was
    // tried first and silently under-counted the stream exit path (4 of 5
    // closes recorded, the stream's real close never seen). The reliable
    // check is authoritative rather than observational: ask the OS,
    // directly, whether each fd `static.ts` opened is still open once every
    // request (and any of their async cleanup) has had time to finish.
    const opened: number[] = []

    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: (...args: Parameters<typeof actualFs.openSync>) => {
        const fd = actualFs.openSync(...args)
        opened.push(fd as number)
        return fd
      },
    }))

    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-fd-hygiene-test-'))
    await writeFile(path.join(outsideDir, 'secret.txt'), 'top secret')
    const escapeLink = path.join(dir, 'escape-link')
    await symlink(outsideDir, escapeLink)
    const noIndexDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-fd-hygiene-no-index-'))

    try {
      const { registerStaticRoute: registerStaticRouteUnderTest } = await import('./static.js')
      const app = Fastify()
      registerStaticRouteUnderTest(app, dir, TEST_TOKEN)
      const noIndexApp = Fastify()
      registerStaticRouteUnderTest(noIndexApp, noIndexDir, TEST_TOKEN)

      // 403 after a failed containment check — never reaches `openInsideRoot`.
      await app.inject({ method: 'GET', url: '/escape-link/secret.txt' })
      // The directory case — `openSync` succeeds on `assets` itself, `fstat`
      // says directory, `openInsideRoot` closes it and falls back.
      await app.inject({ method: 'GET', url: '/assets' })
      // index.html fallback for a nonexistent path.
      await app.inject({ method: 'GET', url: '/lane/fd-hygiene-check' })
      // 404 — even the index.html fallback has nothing to open.
      await noIndexApp.inject({ method: 'GET', url: '/anything' })
      // The `.html` read branch.
      await app.inject({ method: 'GET', url: '/' })
      // The stream branch.
      await app.inject({ method: 'GET', url: '/assets/app.js' })

      // `createReadStream`'s own close-on-end runs on a later tick than the
      // one `app.inject()`'s promise resolves on; give it room to happen
      // before probing.
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(opened.length).toBeGreaterThan(0)
      // `fstatSync` on a closed fd throws EBADF; succeeding means the fd is
      // still open — a leak. Using `fstatSync` rather than `closeSync` to
      // probe keeps this check side-effect-free on the (expected) healthy
      // path — nothing here relies on this call to do any cleanup.
      const stillOpen = opened.filter((fd) => {
        try {
          actualFs.fstatSync(fd)
          return true
        } catch {
          return false
        }
      })
      expect(stillOpen).toEqual([])
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
      await rm(escapeLink, { force: true })
      await rm(outsideDir, { recursive: true, force: true })
      await rm(noIndexDir, { recursive: true, force: true })
    }
  })

  // `/proc/self/fd` is Linux-only — skipped, not silently not-run, on any
  // other platform, same as the other Linux-closure tests above. FD hygiene
  // itself is NOT platform-specific (the test above proves that, running
  // everywhere); only THIS particular exit path is, because it exists only
  // behind the Linux `descriptorRealPath` check — on a platform without
  // `/proc`, the intermediate swap below would simply succeed at 200
  // through `openInsideRoot` alone, which is a DIFFERENT test's job
  // (the no-`/proc` fallback test), not this one's.
  it.skipIf(process.platform !== 'linux')(
    'the descriptor-mismatch refusal exit path — the newest one, added round 4 — never leaks a descriptor either, on LINUX',
    async () => {
      // Split out from the hygiene test above (round 7): reusing
      // `dir`/`assets`/`app.js` from that test's other exercises would have
      // fired this swap mid-request for one of THEM too (`canonicalize`
      // resolves that exact path twice per request regardless of which one
      // triggers it), corrupting what they're meant to prove — hence a
      // dedicated `swapDir` here, same as before.
      const opened: number[] = []
      const swapDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-fd-hygiene-swap-dir-'))
      await writeFile(path.join(swapDir, 'index.html'), '<!doctype html><head><title>swap</title></head>')
      await mkdir(path.join(swapDir, 'assets'), { recursive: true })
      await writeFile(path.join(swapDir, 'assets', 'app.js'), 'console.log("swap")')
      const swapOutsideDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-fd-hygiene-swap-outside-'))
      await writeFile(path.join(swapOutsideDir, 'app.js'), 'swap impostor')
      const swapAssetsDir = path.join(swapDir, 'assets')
      const swapTargetPath = path.join(swapDir, 'assets', 'app.js')
      const trackedRealpath = trackResolutionsOf(swapTargetPath, () => {
        rmSync(swapAssetsDir, { recursive: true, force: true })
        symlinkSync(swapOutsideDir, swapAssetsDir)
      })

      vi.resetModules()
      const actualContainment = await vi.importActual<typeof import('../paths/containment.js')>(
        '../paths/containment.js',
      )
      vi.doMock('../paths/containment.js', () => ({
        ...actualContainment,
        canonicalize: (candidate: string) => actualContainment.canonicalize(candidate, trackedRealpath),
        isInside: (parent: string, candidate: string) => actualContainment.isInside(parent, candidate, trackedRealpath),
      }))
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      vi.doMock('node:fs', () => ({
        ...actualFs,
        openSync: (...args: Parameters<typeof actualFs.openSync>) => {
          const fd = actualFs.openSync(...args)
          opened.push(fd as number)
          return fd
        },
      }))

      try {
        const { registerStaticRoute: registerStaticRouteSwap } = await import('./static.js')
        const swapApp = Fastify()
        registerStaticRouteSwap(swapApp, swapDir, TEST_TOKEN)
        const swapResponse = await swapApp.inject({ method: 'GET', url: '/assets/app.js' })
        // Sanity: this IS the refusal branch under test, not some other exit.
        expect(swapResponse.statusCode).toBe(403)

        expect(opened.length).toBeGreaterThan(0)
        const stillOpen = opened.filter((fd) => {
          try {
            actualFs.fstatSync(fd)
            return true
          } catch {
            return false
          }
        })
        expect(stillOpen).toEqual([])
      } finally {
        vi.doUnmock('../paths/containment.js')
        vi.doUnmock('node:fs')
        vi.resetModules()
        await rm(swapDir, { recursive: true, force: true })
        await rm(swapOutsideDir, { recursive: true, force: true })
      }
    },
  )

  it('refuses a wildcard tail that treats a real file as a directory, and never names the dist path in the response', async () => {
    // `realpathSync` throws ENOTDIR trying to resolve `index.html/x`, since
    // `index.html` exists and is not a directory — a canonicalization error
    // the raw `isInside` cannot recover from and does not catch. Before
    // `isPathContained` (the fail-closed wrapper `log/transcript-attribution.ts`
    // already exports for exactly this reason), that uncaught throw reached
    // Fastify's default error handler, which answers 500 with a body of
    // `{"message":"ENOTDIR: not a directory, realpath '<abs dist path>/index.html/x'"}`
    // — the server's own absolute filesystem path, handed to an
    // unauthenticated caller on the one route ADR-0012 keeps tokenless
    // forever. A path that cannot be canonicalized must be refused, not
    // guessed at, so this is now a plain 403 with no path anywhere in it —
    // a deliberate behaviour change from the 200 SPA-fallback this used to
    // get when a bare `existsSync` check simply reported "not found".
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/index.html/x' })

    expect(response.statusCode).toBe(403)
    expect(response.body).not.toContain(dir)
    expect(response.body).not.toContain('ENOTDIR')
  })

  it('refuses a symlink loop inside the dist root instead of hanging or crashing', async () => {
    // The same fail-closed requirement as the ENOTDIR case above, for the
    // other error `canonicalize` cannot recover from: ELOOP. A raw `isInside`
    // would throw this uncaught, straight into a 500.
    const linkA = path.join(dir, 'loop-a')
    const linkB = path.join(dir, 'loop-b')
    await symlink(linkB, linkA)
    await symlink(linkA, linkB)
    try {
      const app = makeApp()
      const response = await app.inject({ method: 'GET', url: '/loop-a' })

      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain(dir)
    } finally {
      await rm(linkA, { force: true })
      await rm(linkB, { force: true })
    }
  })
})

describe('buildApp — the SPA fallback never shadows a real route', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-app-test-'))
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))

    const distDir = path.join(dir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(path.join(distDir, 'index.html'), '<!doctype html><head><title>rhizomorph shell</title></head>')
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
      webDistDir: path.join(dir, 'dist'),
    })
  }

  it('a real API route still answers as itself, not the app shell', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/api/meta' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toMatchObject({ repoPath: '/repo', repoName: 'repo' })
  })

  it('the OTLP receiver still answers as itself, not the app shell', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      payload: { resourceSpans: [] },
    })

    // Whatever the receiver's own verdict on an empty payload, it must be the
    // receiver that answered — a route that fell through to the HTML shell
    // would report 200 with `content-type: text/html`, which this is not.
    expect(response.headers['content-type']).not.toContain('text/html')
  })

  it('a real boot delivers the capability token it minted, embedded in the shell it serves — issue #249', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(`<meta name="rhizomorph-capability" content="${app.capabilityToken}">`)
  })

  it('GET /lane/<handle> gets the app shell, cold, with no session events at all', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/42-otel-receiver' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('rhizomorph shell')
  })
})
