import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
} from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildCapabilityCookie } from '../api/security.js'
import { isPathContained } from '../log/transcript-attribution.js'
import { canonicalize } from '../paths/containment.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * The `<meta>` name the capability token is delivered under (issue #249;
 * `docs/adr/0012-in-band-capability-token-delivery.md`). Read back by
 * `packages/web/src/recordings/capability.ts` — keep the two in sync; there
 * is no shared package between server and web to import a single constant
 * from (web stays browser-safe, server is not).
 */
const CAPABILITY_META_NAME = 'rhizomorph-capability'

/**
 * THE PAGE'S CONTENT-SECURITY-POLICY (loop 18 — the loop-0 finding: every
 * shell console this session opened with Electron's insecure-CSP warning).
 *
 * The app is a localhost-only SPA that reaches nothing beyond its own origin:
 * the bundle is external module scripts (no inline script anywhere in the
 * built page — verified against dist before this landed), styles are one
 * external sheet plus inline `style=` attributes (hence 'unsafe-inline' on
 * style-src and nowhere else), the build inlines sub-4KB assets as data: URIs (one small woff2 face arrives that way, hence data: on font-src and img-src), the stream is same-origin SSE, and there is no
 * font, image or frame from anywhere. Everything else is closed: no eval, no
 * objects, no framing this page, no posting a form off-origin. Served as a
 * header on every HTML response — dev-served Vite (which needs eval and
 * inline for HMR) never passes through this route, so tooling stays unbroken.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Every token this process mints is 64 hex characters
 * (`generateCapabilityToken`, `api/security.ts`) — which is what lets
 * {@link injectCapabilityMeta} interpolate it into an HTML attribute with no
 * escaping. That premise is enforced here, not merely assumed: a
 * caller-supplied `ServerContext.capabilityToken` (tests only, in
 * production this is always `generateCapabilityToken()`'s own output) that
 * doesn't hold to this exact shape is refused before it ever reaches the
 * template string, so nothing containing a quote, an `onload=`, or a `$&`
 * replacement-pattern character can reach `String.prototype.replace`.
 */
const CAPABILITY_TOKEN_SHAPE = /^[0-9a-f]{64}$/

/**
 * Stamps the per-process capability token into `index.html`'s `<head>` so
 * the browser has a value to send back on `POST /api/label` — the one
 * channel that ever hands it out (see the ADR above for why in-band, and
 * what that costs).
 */
function injectCapabilityMeta(html: string, capabilityToken: string): string {
  if (!CAPABILITY_TOKEN_SHAPE.test(capabilityToken)) {
    throw new Error(
      `capability token is not the expected 64-hex-character shape — refusing to interpolate it into HTML unescaped`,
    )
  }
  const tag = `<meta name="${CAPABILITY_META_NAME}" content="${capabilityToken}">`
  if (html.includes('</head>')) {
    return html.replace('</head>', `  ${tag}\n  </head>`)
  }
  // No closing `</head>` — insert right after the opening tag instead of
  // prepending, which would land the tag before `<!doctype html>` itself
  // and drop the page into quirks mode. A shell with no `<head>` at all has
  // nowhere honest to put the token; refuse rather than silently prepending
  // to a body that starts with the doctype.
  const headOpen = /<head[^>]*>/.exec(html)
  if (headOpen) {
    const insertAt = headOpen.index + headOpen[0].length
    return `${html.slice(0, insertAt)}\n  ${tag}${html.slice(insertAt)}`
  }
  throw new Error('index.html has no <head> element — nowhere to stamp the capability token')
}

/**
 * Opens `candidatePath` read-only, refusing to follow a symlink in its FINAL
 * path component (`O_NOFOLLOW`), and returns the descriptor — or `null` if
 * the path doesn't exist or names a directory. Every other failure
 * (`ELOOP` above all — see the caller) is left to throw.
 *
 * This exists so that, once a path clears the containment check, NOTHING
 * downstream ever asks the filesystem "what is at this path?" again:
 * `fstatSync`/`readFileSync`/`createReadStream` below all take the
 * descriptor this returns, never `candidatePath` itself. A descriptor names
 * an open file (an inode), not a spelling — nothing that happens to the
 * PATH after this call (a directory replaced by a symlink, a file swapped
 * for another) can change what reading THIS descriptor returns. That closes
 * the exact shape of TOCTOU a review of this route's first fix (#51) found:
 * the fix canonicalized once and checked that, but still read via
 * `existsSync`/`statSync`/`readFileSync`(path) afterward — three MORE
 * independent, path-based filesystem lookups, each its own new chance for a
 * swap landing between the check and this specific one to redirect it. A
 * swap timed into the gap between `statSync` succeeding and the content read
 * that followed it — reproduced against that fix through the real route —
 * cannot happen here: there is no separate later path-based read for it to
 * land in front of.
 */
function openInsideRoot(candidatePath: string): number | null {
  let fd: number
  try {
    fd = openSync(candidatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  // `fstatSync` can itself throw (EIO above all) — caught here specifically
  // so `fd` is closed before the error propagates. Round 5 review found this
  // by reading: the `isDirectory()` branch below already closed `fd` on ITS
  // path out, but a throw from `fstatSync` itself escaped this function with
  // `fd` still open, and the caller's `catch` (which turns it into a 403)
  // had no way to know a descriptor needed closing.
  let stat: ReturnType<typeof fstatSync>
  try {
    stat = fstatSync(fd)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  if (stat.isDirectory()) {
    closeSync(fd)
    return null
  }
  return fd
}

/**
 * "Where will this path resolve" cannot be answered race-free without
 * per-component resolution (`openat(2)`, holding a directory descriptor
 * from `root` down) — Node has no binding for that: no `AT_*` constants, no
 * fd-relative call anywhere in `node:fs`. But once `fd` is OPEN, that is not
 * the question that matters anymore. The question that matters is "where
 * did THIS descriptor actually land" — and `fd` is already pinned to an
 * inode, so there is nothing left for a path swap to redirect. The kernel's
 * own answer to that question, on Linux, is `/proc/self/fd/<fd>` — a
 * symlink whose target IS the descriptor's real, current path, however it
 * got there, whether or not anything still lives at that path.
 *
 * Returns `undefined` — "no verdict, trust `openInsideRoot` alone" — only
 * when that answer isn't available at all: `/proc/self/fd` doesn't exist on
 * macOS (this repo gates a macOS CI leg, `ci.yml:32`, and Node exposes no
 * `fcntl(F_GETPATH)` equivalent for it) or wherever else `/proc` is absent.
 *
 * ROUND 5 gave this function a SECOND `undefined` case — "the descriptor is
 * genuinely orphaned (unlinked), so skip the check" — reasoning that a fresh
 * FILESYSTEM RESOLUTION of an orphaned path was unreliable (it could walk
 * through a directory swapped AFTER the fact and land somewhere wrong).
 * That reasoning was correct for what the caller did with the answer at the
 * time — feed it into `isPathContained`, which resolves it again — and
 * became FALSE the moment the caller changed, in the same round, to
 * `isUnderCanonicalRoot`, which resolves nothing at all. ROUND 6, both
 * review seats, found the skip had become a bypass rather than a safety
 * valve: an outside file named `ordinary.js (deleted)` opened via the usual
 * intermediate-directory swap, then genuinely unlinked in the narrow window
 * between this function's `readlinkSync` and the `fstatSync` the skip used
 * to gate on, makes BOTH conditions honestly true — the suffix from the
 * filename, the zero link count from the real unlink — so the check was
 * skipped and the still-open, still-outside descriptor streamed at 200.
 * EXECUTED, confirmed with a no-unlink control refusing correctly (403) and
 * the timed-unlink case leaking (200) with the skip in place.
 *
 * The skip is deleted, not patched a third time, because `isUnderCanonicalRoot`
 * needs it to be gone: comparing PATH SEGMENTS means a literal `" (deleted)"`
 * suffix lands entirely inside the LAST segment, which the comparison never
 * checks against `canonicalRoot` — only the segments spanning `canonicalRoot`
 * itself matter. EXECUTED, both directions, with the skip already removed:
 * a genuinely-unlinked file that WAS inside `root` still compares as inside
 * (the suffix rides along in a segment the check ignores) and still reads
 * its real, original content through `fd`; the malicious-filename bypass
 * above now compares as outside and is refused. There is nothing left to
 * strip and nothing left to skip — round 5's "do NOT strip the suffix" was
 * the right call for a fresh resolution, which is exactly what this
 * function and its caller no longer do.
 */
function descriptorRealPath(fd: number): string | undefined {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`)
  } catch {
    return undefined
  }
}

/**
 * True when `descriptorPath` is `canonicalRoot` itself or lies beneath it —
 * compared PURELY AS STRINGS, with NO filesystem call of any kind between
 * `readlinkSync` (in the caller) and this verdict. That absence is the
 * point, not an oversight: `descriptorPath` is the kernel's own answer to
 * "where does this fd actually point", already fully resolved. Asking the
 * filesystem to resolve it again — which `isPathContained`/`isInside` do,
 * every time, via `realpathSync.native` — reopens exactly the race this
 * check exists to close. EXECUTED, before writing this function: with the
 * check spelled as `isPathContained(canonicalRoot, descriptorPath)`, a
 * symlink swap timed between `readlinkSync` and THAT call can rebind
 * whatever the kernel just reported back to somewhere inside `root`, and
 * the already-open `fd` — still pointing at the ORIGINAL, outside target —
 * streams it at 200 anyway, because the check re-resolved a STRING instead
 * of trusting the answer it was already given.
 *
 * Comparing an ALREADY-kernel-resolved string against another
 * ALREADY-kernel-resolved string (`canonicalRoot`, canonicalized once at
 * registration — see the comment there) is not "a path-containment
 * comparison" in ruling 2's sense: ruling 2 governs asking the FILESYSTEM
 * "is this path inside that root", which is what `isPathContained` does and
 * must keep doing everywhere else. Here the filesystem has already
 * answered, through the kernel's own `/proc/self/fd` bookkeeping; comparing
 * its answer is string work, done once, on values nothing here re-resolves.
 *
 * Spelled as a SEGMENT comparison — split on `path.sep`, checked
 * element-by-element — rather than `.startsWith(canonicalRoot)` or any of
 * the other idioms `paths/prefix-comparison-law.test.ts` (ruling 2's
 * automated enforcement) hunts for, because that law asserts a hard,
 * zero-tolerance requirement — no allowlist entry, not even one — that
 * `server/static.ts` SPECIFICALLY shows no containment-comparison violation
 * at all. That is a syntactic proxy, not the rule itself (see above for why
 * this comparison does not violate the rule it enforces), but this file is
 * bound by the proxy regardless. Do not "simplify" this into `.startsWith`;
 * that trips the law for real, on this exact file, on purpose.
 *
 * A side effect of comparing SEGMENTS rather than the whole string: a
 * `descriptorPath` that names an unlinked or renamed target — which
 * `/proc/self/fd` reports with a literal `" (deleted)"` appended to its
 * LAST segment, e.g. `.../app.js (deleted)` — needs no special handling at
 * all here. That suffix lives entirely inside `targetSegments`' final
 * element, and this function only ever checks segments `0..rootSegments.length`
 * against `canonicalRoot` — it never reaches, and is never fooled by,
 * whatever the last segment says. Round 5 gave `descriptorRealPath` a skip
 * for exactly this case, reasoning it needed to avoid a fresh FILESYSTEM
 * resolution of a stale string; that reasoning stopped applying the moment
 * this function replaced `isPathContained` in round 5 itself (this function
 * resolves nothing), and round 6 found the leftover skip had become a
 * bypass — see `descriptorRealPath`'s doc comment for the mechanism and the
 * EXECUTED proof both directions.
 */
function isUnderCanonicalRoot(descriptorPath: string, canonicalRoot: string): boolean {
  const rootSegments = canonicalRoot.split(path.sep)
  const targetSegments = descriptorPath.split(path.sep)
  if (targetSegments.length < rootSegments.length) return false
  return rootSegments.every((segment, index) => targetSegments[index] === segment)
}

/**
 * Serves `packages/web/dist` as a single-page app: a request for a real file
 * in dist gets that file, anything else (a client-side route) falls back to
 * index.html. Only wired in when the directory actually exists — there is
 * no `web` dependency at build time, just a dist folder that may or may not
 * be there yet.
 *
 * Every response that is `index.html` — whether requested directly or
 * reached via the SPA fallback — is read and stamped with the capability
 * token rather than streamed verbatim; every other file streams unmodified.
 * The same response also sets the capability as an HttpOnly, SameSite=Strict
 * cookie (prd-29 ruling 4) — the credential `GET /api/stream` reads instead
 * of a header, since `EventSource` cannot set one.
 */
export function registerStaticRoute(app: FastifyInstance, distDir: string, capabilityToken: string): void {
  const root = path.resolve(distDir)
  // Canonicalized ONCE, at registration, not per request. Originally just a
  // clarity/performance choice — `isPathContained`'s own internal
  // canonicalize would have re-resolved plain `root` freshly on every
  // request regardless, so this saved a redundant syscall but was not,
  // itself, a security boundary (reverting it to plain `root` left every
  // test green, since every OTHER containment check still canonicalized
  // both sides). `isUnderCanonicalRoot` below changes that: it compares
  // against `canonicalRoot` with NO further resolution at all, so THIS
  // value is now the only canonical thing standing between a descriptor's
  // reported path and the verdict — its own correctness is load-bearing
  // from here on. If `root` itself cannot be canonicalized (missing, a
  // dangling symlink), every request would fail regardless; fail loudly
  // now, at startup, rather than on the first GET.
  const canonicalRoot = canonicalize(root)

  app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    const requested = path.resolve(root, request.params['*'] || 'index.html')
    // Canonicalize the untrusted wildcard tail EXACTLY ONCE, and use THAT
    // resolved value for the containment check below. An earlier shape of
    // this route (prd42 w2, #13) checked containment of `requested` first
    // and canonicalized `requested` again afterward to get a path to read;
    // a later fix (still #51) closed THAT gap but kept reading the result
    // via more independent, path-based filesystem calls
    // (`existsSync`/`statSync`/`readFileSync`) — each one a fresh
    // resolution a swapped symlink could still win. `canonicalize` (not the
    // raw `isInside`) is used for this first resolution because it throws
    // on a canonicalization error it cannot recover from (ENOTDIR — a path
    // segment naming an existing file, e.g. `/index.html/x` — or ELOOP from
    // a symlink cycle), and this route has no error handler, so an
    // uncaught throw would reach the caller as a 500 whose body is
    // Fastify's default error shape: the absolute dist path, verbatim.
    // `GET /*` is tokenless forever (ADR-0012, prd-29 ruling 1), so that
    // 500 would hand the server's own filesystem layout to whoever asked. A
    // path that cannot be canonicalized is refused (`403`) rather than
    // guessed at, so `/index.html/x` answers 403 where it used to fall
    // through to the SPA shell at 200; a shape the containment check cannot
    // clear is not a client route to fall back for.
    let filePath: string
    try {
      filePath = canonicalize(requested)
    } catch {
      return reply.code(403).send({ error: 'forbidden' })
    }

    // A bare `startsWith(root)` passes a sibling directory that merely
    // shares `root` as a literal string prefix (`/a/dist2/x` starts with
    // `/a/dist`) — the separator makes this a path-segment check, not a
    // string one, the same guard `log/transcript-attribution.ts`'s
    // containment check applies. `isPathContained` — that file's own
    // fail-closed wrapper over `paths/containment.ts`'s `isInside` — is
    // given the ALREADY-canonical `filePath` (and the pre-canonicalized
    // `canonicalRoot`) here, not the raw, possibly still-symlinked
    // `requested`: re-canonicalizing an already-resolved, symlink-free path
    // is idempotent, not a second independent resolution of untrusted
    // input, so there is nothing left for a swap to race AT THIS STEP. A
    // request that is textually outside `root` but resolves, at this one
    // snapshot, to somewhere inside it — a symlink pointing INTO `root` —
    // is DELIBERATELY allowed through (prd-42 ruling 6, pinned in
    // static.test.ts): canonicalized containment is the honest reading of
    // what this route actually reads from.
    if (!isPathContained(canonicalRoot, filePath)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    // DECLARED RESIDUAL, SCOPE NARROWED (#51, third review round — the
    // second round's comment here said this was "not closed by this
    // route"; that was wrong, and the fix below is what makes it wrong).
    // Between the containment check finishing above and the `openSync`
    // call below, `filePath` is still a bare string, and the check's
    // approval of it is already a moment old. If an INTERMEDIATE directory
    // component of `filePath` (e.g. `dist/assets`) is replaced by a symlink
    // to somewhere outside `root` in that gap, `openSync` — like any
    // path-based syscall — walks through it and opens whatever it now
    // points to; `O_NOFOLLOW` below guards only the FINAL path component,
    // not an intermediate one.
    //
    // CLOSED ON LINUX, by the `descriptorRealPath` check right after `fd`
    // is established below: once `fd` is open, asking "what path did the
    // OS actually resolve" (via `/proc/self/fd`) is a different, race-free
    // question from "what will this path resolve to" — the fd is already
    // pinned to an inode, so a swapped intermediate directory changes
    // nothing about where it points, and the kernel's own answer catches a
    // landing outside `root` regardless. STILL OPEN wherever `/proc/self/fd`
    // doesn't exist (macOS above all — this repo gates a macOS CI leg,
    // `ci.yml:32` — and anywhere else without a `/proc`): `descriptorRealPath`
    // returns `undefined` there and this route falls back to trusting
    // `openInsideRoot`'s `O_NOFOLLOW` guarantee alone, exactly as before
    // this existed. This is a genuine, platform-conditional improvement,
    // not a universal close — say so, don't round it up: `static.test.ts`
    // pins BOTH the real Linux closure and the simulated no-`/proc`
    // fallback, so neither reads as more than it is.
    let fd: number
    try {
      const opened = openInsideRoot(filePath)
      if (opened === null) {
        // Not found, or a directory: SPA fallback to `index.html`, itself
        // canonicalized once (it may legitimately be a symlink in an
        // unusual build layout — canonicalizing resolves that before the
        // `O_NOFOLLOW` open below ever sees it, so a genuine symlinked
        // `index.html` isn't refused for no reason) and opened the same
        // guarded way. `index.html`'s path is never attacker-influenced
        // (its only variable component is the trusted `root`), so it gets
        // no separate containment check — same as before this fix.
        let indexPath: string
        try {
          indexPath = canonicalize(path.join(root, 'index.html'))
        } catch {
          return reply.code(404).send({ error: 'not found' })
        }
        const indexFd = openInsideRoot(indexPath)
        if (indexFd === null) {
          return reply.code(404).send({ error: 'not found' })
        }
        fd = indexFd
        filePath = indexPath
      } else {
        fd = opened
      }
    } catch {
      // Most importantly ELOOP: the final path component turned out to be a
      // symlink even though `canonicalize` just resolved it to a real,
      // symlink-free target a moment ago — something replaced it in
      // between. A path that failed to open safely is refused, never
      // guessed at.
      return reply.code(403).send({ error: 'forbidden' })
    }

    // The Linux closure of the residual declared above: ask the kernel
    // where `fd` actually landed, and refuse if that is somewhere
    // `canonicalRoot` does not cover — whether or not anything still lives
    // at that path (see `isUnderCanonicalRoot`'s own doc comment for why a
    // deleted or renamed target needs no special case here). `descriptorRealPath`
    // returns `undefined` only where `/proc/self/fd` doesn't exist, in
    // which case this is a no-op and the route relies on `openInsideRoot`
    // alone, same as before this check existed. `isUnderCanonicalRoot`, NOT
    // `isPathContained`, on purpose: see its own doc comment for why
    // re-canonicalizing the kernel's already-resolved answer would reopen
    // the exact race this check exists to close.
    const descriptorPath = descriptorRealPath(fd)
    if (descriptorPath !== undefined && !isUnderCanonicalRoot(descriptorPath, canonicalRoot)) {
      closeSync(fd)
      return reply.code(403).send({ error: 'forbidden' })
    }

    reply.header('Content-Type', MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream')
    // Nothing served from dist is ever content-sniffed into something else.
    reply.header('X-Content-Type-Options', 'nosniff')

    // Every `.html` file gets the token, not only `index.html` — there is no
    // `public/` directory today, so `index.html` is the only `.html` file
    // dist ever contains, but the check is by extension rather than by name
    // so a second static HTML page wouldn't silently miss the token later.
    if (path.extname(filePath) === '.html') {
      reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      // `readFileSync` does not close a descriptor it did not open itself —
      // this route owns `fd` and closes it exactly once, whether the read
      // (or the token-shape check inside `injectCapabilityMeta`, called
      // after the descriptor is already closed) succeeds or throws, rather
      // than leaking it or double-closing it.
      let html: string
      try {
        html = readFileSync(fd, 'utf8')
      } finally {
        closeSync(fd)
      }
      // `injectCapabilityMeta` validates the token before interpolating it,
      // so an invalid token never produces either a stamped body or a cookie.
      const stamped = injectCapabilityMeta(html, capabilityToken)
      reply.header('Set-Cookie', buildCapabilityCookie(capabilityToken))
      return reply.send(stamped)
    }

    // `createReadStream` reads and closes THIS descriptor (the default
    // `autoClose: true`) rather than reopening `filePath` by name — the path
    // argument is otherwise unused once `fd` is given. If constructing the
    // stream itself throws before it ever takes ownership of `fd`, close it
    // here so it isn't leaked.
    try {
      return reply.send(createReadStream(filePath, { fd }))
    } catch (err) {
      closeSync(fd)
      throw err
    }
  })
}
