import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImportSpecifiers } from '../test/import-specifiers.js'

/**
 * THE READ-ONLY CONSTITUTION, ASSERTED AT THE LEVEL OF THE SOURCE TEXT.
 *
 * "The Rhizomorph never sends keys" (ruling 17) is not a property any single
 * behavioural test can prove — a POST added tomorrow in a branch nothing
 * renders would pass every one of them. So this file greps its own directory
 * instead: whatever the drawer grows into, it may issue GETs and nothing else,
 * and it may not reach for a way to run a command.
 *
 * The check is deliberately crude and deliberately loud. A future issue that
 * legitimately needs a POST will fail here and have to say so in a diff a
 * reviewer reads — which is exactly the conversation the constitution deserves.
 *
 * **The WHY tab is governed too** (2026-08-08 audit finding #3) — greping
 * `DRAWER_DIR` alone missed it: `index.tsx` renders `WhySurface` from `why/`,
 * a sibling directory this file never walked, so a POST added there tomorrow
 * would have passed every check below in total silence. `DRAWER_SURFACES`
 * names every such surface explicitly (today, just `why/`) and `sourceFiles()`
 * walks it exactly as it walks `drawer/` itself — the read-only checks apply
 * to both.
 *
 * That still leaves `index.tsx`'s other leaving imports — `app/`, `fleet/`,
 * `trace/model` — unwalked. The audit traced a true import closure from
 * `index.tsx` and rejected it: it pulls in the whole of `fleet/` and
 * `StreamContext`, and `trace/model.js`'s own reach, and `fleet/manifest.ts`
 * legitimately fetches (the fleet poll, not this drawer's constitution) —
 * walking all of that here would mean re-deriving a second, parallel
 * read-only law over most of `packages/web/src`. `CONSUMED` names those
 * dependencies instead of walking them, and the test below asserts every
 * relative import `index.tsx` *itself* makes that leaves `drawer/` resolves
 * into either `DRAWER_SURFACES` or `CONSUMED` — for `index.tsx`, nothing
 * escapes ungoverned AND unnamed. That guarantee is scoped to `index.tsx`
 * on purpose, not the whole directory: `Activity.tsx`, `Vitals.tsx` and
 * others each carry their own leaving imports (`panels/burn/format`,
 * `panels/fleet/format`, `lib/format`, `trace/TraceTree`, …) that neither
 * this test nor `CONSUMED` accounts for — walking those too is exactly the
 * larger closure the audit traced and rejected, restated per-file instead
 * of once. An import into a third place from `index.tsx` fails loudly, with
 * the import path and both lists spelled out, rather than silently passing
 * because nobody walks there; those other files' mutating calls, if any,
 * are still someone else's job to catch, and they are: `replay/mutating-
 * calls-law.test.ts`'s own recursive walk (`visit()`) already enumerates
 * every mutating call across the whole of `packages/web/src`, `fleet/` and
 * `panels/` included, so a POST reached through a CONSUMED dependency (or
 * one of those other files' own imports) would surface there even though
 * this file never walks that far.
 *
 * **AMENDED for prd-29 ruling 6.** The drawer's read now carries the
 * capability token (`/api/transcript/:lane` became a `gated-read`, ruling 1),
 * and the constitution this file asserts forbids MUTATIONS, not credentials —
 * a header proving the reader may read mutates nothing. The amendment lands as
 * a TIGHTENING, never a loosening: the header literal lives in one shared
 * module (`recordings/capabilityRead.js`), the drawer routes its default fetch
 * through it, and this file now also asserts the drawer names no capability
 * header inline of its own. `replay/mutating-calls-law.test.ts`'s READ_MODULES
 * is where that shared module's header is held to exactly the capability name.
 */

const DRAWER_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(DRAWER_DIR, '..')

/**
 * Surfaces governed exactly like `drawer/` itself, not merely allowlisted.
 *
 * `why/` joined this list because `index.tsx` rendered it as the drawer's WHY
 * tab. prd-36 ruling 2 cut the tabs (#562) and the WHY surface moved to the run
 * view with them — and it stays here anyway, deliberately. The reason for
 * walking it was never "the drawer imports it": it was that a POST added in
 * `why/` would otherwise pass every check below in total silence, and that is
 * exactly as true of a `why/` the run view renders. Dropping the entry would
 * un-govern the directory as a side effect of a UI change, which is how a
 * constitution quietly stops applying to somewhere.
 */
const DRAWER_SURFACES: readonly string[] = ['why/']

/**
 * Dependencies `index.tsx` legitimately reaches for that are NOT drawer
 * surfaces (traced as a rejected import closure, see the file doc above).
 * Written without extensions, relative to `packages/web/src`, so both
 * `../fleet/index.js` and a same-target `../fleet/index.ts` normalise the
 * same way when checked below.
 */
const CONSUMED: readonly string[] = ['app/router', 'app/StreamContext', 'fleet/index']

/**
 * Recursive walk (the `visit()` shape `replay/mutating-calls-law.test.ts`
 * uses, and `lab/no-live-fleet-law.test.ts` reuses) — a flat `readdirSync`
 * would silently drop a nested `drawer/net/post.ts` or `why/details/X.tsx`
 * from every check below, extension filter and all, with no signal and the
 * floor still passing. Both governed directories are flat today, but the
 * walk no longer depends on staying that way.
 */
function sourceFilesIn(dir: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (/\.test\.tsx?$/.test(entry)) continue
      out.push({ name: path.relative(WEB_SRC, full), text: readFileSync(full, 'utf8') })
    }
  }
  visit(dir)
  return out
}

function sourceFiles(): { name: string; text: string }[] {
  const dirs = [DRAWER_DIR, ...DRAWER_SURFACES.map((surface) => path.join(WEB_SRC, surface))]
  return dirs.flatMap(sourceFilesIn)
}

/**
 * Resolves `importPath` (as written in `index.tsx`, e.g. `'../why/index.js'`)
 * against `packages/web/src`, the same coordinate space `DRAWER_SURFACES`
 * and `CONSUMED` are written in — real path resolution, not a string strip,
 * so `../../fleet/manifest.js` and `../fleet/manifest.js` normalise to the
 * same `fleet/manifest` regardless of how many `../` hops `index.tsx` used.
 */
function resolveSpecifier(importPath: string): string {
  const absolute = path.resolve(DRAWER_DIR, importPath)
  const relative = path.relative(WEB_SRC, absolute).replace(/\.(ts|tsx|js|jsx)$/, '')
  return relative.split(path.sep).join('/')
}

/**
 * Whether `importPath` resolves into a declared surface or a declared
 * consumed dependency. A directory match requires the full next path
 * segment, not merely a shared prefix — `resolved === base` (the surface's
 * own entry point) or `resolved.startsWith(base + '/')` (something inside
 * it) — so a sibling like `why-not/x` or `whynot/x` can never pass as `why/`.
 */
function governs(importPath: string): boolean {
  const resolved = resolveSpecifier(importPath)
  const inSurface = DRAWER_SURFACES.some((surface) => {
    const base = surface.replace(/\/$/, '')
    return resolved === base || resolved.startsWith(`${base}/`)
  })
  return inSurface || CONSUMED.includes(resolved)
}

/**
 * Every relative import in `text` that leaves drawer/ — i.e. starts with
 * `../` — in ANY syntactic form, not only `… from '…'` (PR #301 review): a
 * side-effect `import '../launch/launch.js'` and a dynamic
 * `import('../launch/launch.js')` (quoted or template-literal) reach the
 * module just the same, and were exactly the forms a from-only sweep let
 * escape while `governs()` would have rejected them. A bare `./…` import
 * stays inside drawer/ and is already covered by the walk above.
 *
 * A computed template specifier is swept raw, `${…}` and all, WHEREVER the
 * interpolation sits — `` import(`${base}/launch/x.js`) `` starts with no
 * `../` yet reaches wherever `base` points, so a bare `../` filter would
 * drop it before `governs()` ever saw it (c77c2ee verify pass). Any
 * specifier containing `${` is therefore treated as leaving, and fails
 * `governs()` loudly rather than passing unseen.
 */
function leavingImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter(
    (specifier) => specifier.startsWith('../') || specifier.includes('${'),
  )
}

describe('the drawer sends only GETs', () => {
  it('has source files to check at all, drawer/ AND every declared surface — an empty grep proves nothing', () => {
    // 11 real files after #562 (8 in drawer/, 3 in why/): the peek retired
    // `Tabs.tsx` and `Trace.tsx` outright, so this pin comes DOWN by two — with
    // the count still exact-ish rather than a loose lower bound, so a surface
    // quietly dropping out of the walk fails loudly here too.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(11)
  })

  it('the walk actually reaches the WHY surface, not just drawer/ itself', () => {
    const names = sourceFiles().map((file) => file.name)
    expect(names).toContain(path.join('why', 'WhySurface.tsx'))
  })

  it('names no HTTP verb but GET', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} names a mutating HTTP verb`).not.toMatch(
        /\b(?:POST|PUT|PATCH|DELETE)\b/,
      )
    }
  })

  it('builds no request init at all — `fetch(url)` and nothing more', () => {
    // No init object means no `method`, and therefore no way to be anything but
    // a GET; it also means no body, no headers and no credentials to attach.
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} builds a request init`).not.toMatch(
        /\b(?:method|headers|credentials)\s*:/,
      )
      expect(file.text, `${file.name} builds a request body`).not.toMatch(
        /FormData|URLSearchParams|JSON\.stringify\(|new Request\(/,
      )
    }
  })

  it('touches no request path but the transcript tail', () => {
    const paths = sourceFiles()
      .flatMap((file) => [...file.text.matchAll(/`?\/api\/[a-z/:${}\-.[\]]+/gi)].map((m) => m[0]))
      .map((match) => match.replace(/^`/, ''))

    expect(paths.length).toBeGreaterThan(0)
    for (const found of paths) {
      expect(found.startsWith('/api/transcript/')).toBe(true)
    }
  })

  it('reaches for no way to execute anything', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} reaches for an execution channel`).not.toMatch(
        /child_process|\bexec\s*\(|\bspawn\s*\(|WebSocket|EventSource|sendBeacon|XMLHttpRequest|new Function|\beval\s*\(/,
      )
    }
  })

  it('holds no credential of any kind', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} mentions a credential`).not.toMatch(
        /apiKey|api_key|ANTHROPIC_API_KEY|Authorization|Bearer\s/i,
      )
    }
  })

  it('carries the read credential only through the shared module, never inline (prd-29 ruling 6)', () => {
    // prd-29 gates `/api/transcript/:lane` (ruling 1), so the drawer's read now
    // sends the capability token — but the constitution forbids MUTATIONS, not
    // credentials (ruling 6's argument): a header proving the reader may read
    // mutates nothing. The header literal lives in ONE shared module
    // (`recordings/capabilityRead.js`), which `drawer/useTranscript.ts` routes
    // its default fetch through; the drawer's own text names no capability
    // header at all. This is a tightening, not a loosening: an inline
    // credential added to the drawer tomorrow fails here, loudly.
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} inlines the capability header — it must ride via the shared module`).not.toMatch(
        /x-rhizomorph-capability|CAPABILITY_TOKEN_HEADER/,
      )
    }
  })

  it('never runs the attach command — it only ever copies the string', () => {
    const attachButton = readFileSync(path.join(DRAWER_DIR, 'AttachButton.tsx'), 'utf8')

    expect(attachButton).toMatch(/clipboard/)
    expect(attachButton).not.toMatch(/tmux|workmux/)
  })

  it('every relative import leaving drawer/ in index.tsx resolves into DRAWER_SURFACES or the declared CONSUMED allowlist', () => {
    const indexText = readFileSync(path.join(DRAWER_DIR, 'index.tsx'), 'utf8')
    const leavingImports = leavingImportsIn(indexText)
    expect(leavingImports.length).toBeGreaterThan(0) // the check below would pass vacuously on an empty sweep

    for (const importPath of leavingImports) {
      expect(
        governs(importPath),
        `index.tsx imports '${importPath}', which leaves drawer/ into neither a DRAWER_SURFACES entry ` +
          `(${DRAWER_SURFACES.join(', ')}) nor the CONSUMED allowlist (${CONSUMED.join(', ')}) — this import is ` +
          `ungoverned by the read-only law; add its target to DRAWER_SURFACES if the drawer should walk it too, ` +
          `or to CONSUMED if it is a legitimate dependency this law deliberately does not walk`,
      ).toBe(true)
    }
  })

  it('the resolver bites — an import into a third, undeclared place would be caught', () => {
    // Exercises the real `governs()` — not a hand-built resolved string —
    // so weakening the resolver itself would show up here too.
    expect(governs('../launch/launch.js')).toBe(false)
  })

  it('the sweep bites — a leaving import with no `from` clause at all is still swept, in every form', () => {
    // Exercises the real sweep (`leavingImportsIn`, extraction included) —
    // the first three are the forms the from-only regex missed (PR #301
    // review); the rest are the legal spellings its verify pass found the
    // first widening still blind to: no separator at all, comment trivia
    // between keyword and specifier, and double-quoted specifiers. Each
    // reaches the module `governs()` above proves ungoverned.
    const forms = [
      "import '../launch/launch.js'",
      "await import('../launch/launch.js')",
      'await import(`../launch/launch.js`)',
      "import'../launch/launch.js'",
      "import /* preload */ '../launch/launch.js'",
      "await import(/* @vite-ignore */ '../launch/launch.js')",
      'import "../launch/launch.js"',
      'await import("../launch/launch.js")',
    ]
    for (const form of forms) {
      expect(leavingImportsIn(form), form).toEqual(['../launch/launch.js'])
    }
  })

  it('the sweep bites on a computed specifier — an interpolation ahead of the path cannot hide the import', () => {
    // `${base}/launch/launch.js` starts with no `../`, so a bare leaving
    // filter dropped it before governs() ever ran (c77c2ee verify pass) —
    // any `${` specifier is swept instead, and lands here as ungoverned.
    expect(leavingImportsIn('await import(`${base}/launch/launch.js`)')).toEqual(['${base}/launch/launch.js'])
    expect(governs('${base}/launch/launch.js')).toBe(false)
  })

  it('the sweep does not over-reach — an inside-drawer/ import is not treated as leaving', () => {
    expect(leavingImportsIn("import './Activity.js'")).toEqual([])
    expect(leavingImportsIn("import { foldActivity } from './foldActivity.js'")).toEqual([])
  })

  it("the resolver does not accept a similarly-prefixed sibling as the WHY surface", () => {
    // 'why-not/' and 'whynot/' both share the string prefix 'why' with the
    // declared surface 'why/' — a startsWith on the bare prefix would wrongly
    // accept either. governs() requires the full next path segment instead.
    expect(governs('../why-not/thing.js')).toBe(false)
    expect(governs('../whynot/thing.js')).toBe(false)
    expect(governs('../why/index.js')).toBe(true)
  })
})
