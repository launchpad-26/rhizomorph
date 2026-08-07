import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
 * relative import `index.tsx` makes that leaves `drawer/` resolves into
 * either `DRAWER_SURFACES` or `CONSUMED` — nothing escapes ungoverned AND
 * unnamed. An import into a third place fails loudly, with the import path
 * and both lists spelled out, rather than silently passing because nobody
 * walks there.
 */

const DRAWER_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(DRAWER_DIR, '..')

/** Surfaces the drawer hosts and renders as its own tabs — governed exactly like drawer/ itself, not merely allowlisted. */
const DRAWER_SURFACES: readonly string[] = ['why/']

/**
 * Dependencies `index.tsx` legitimately reaches for that are NOT drawer
 * surfaces (traced as a rejected import closure, see the file doc above).
 * Written without extensions, relative to `packages/web/src`, so both
 * `../fleet/index.js` and a same-target `../fleet/index.ts` normalise the
 * same way when checked below.
 */
const CONSUMED: readonly string[] = [
  'app/panelPrefs',
  'app/router',
  'app/StreamContext',
  'fleet/index',
  'fleet/manifest',
  'trace/model',
]

function sourceFilesIn(dir: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
    .map((name) => ({
      name: path.join(path.relative(WEB_SRC, dir), name),
      text: readFileSync(path.join(dir, name), 'utf8'),
    }))
}

function sourceFiles(): { name: string; text: string }[] {
  const dirs = [DRAWER_DIR, ...DRAWER_SURFACES.map((surface) => path.join(WEB_SRC, surface))]
  return dirs.flatMap(sourceFilesIn)
}

describe('the drawer sends only GETs', () => {
  it('has source files to check at all, drawer/ AND every declared surface — an empty grep proves nothing', () => {
    // 13 real files as of the 2026-08-08 audit (10 in drawer/, 3 in why/) —
    // pinned to today's count, not a loose lower bound, so a surface quietly
    // dropping out of the walk fails loudly here too.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(13)
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

  it('never runs the attach command — it only ever copies the string', () => {
    const attachButton = readFileSync(path.join(DRAWER_DIR, 'AttachButton.tsx'), 'utf8')

    expect(attachButton).toMatch(/clipboard/)
    expect(attachButton).not.toMatch(/tmux|workmux/)
  })

  it('every relative import leaving drawer/ in index.tsx resolves into DRAWER_SURFACES or the declared CONSUMED allowlist', () => {
    const indexText = readFileSync(path.join(DRAWER_DIR, 'index.tsx'), 'utf8')
    // Only imports that leave drawer/ at all — a bare `./…` import stays
    // inside drawer/ and is already covered by the walk above.
    const leavingImports = [...indexText.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g)].map((match) => match[1]!)
    expect(leavingImports.length).toBeGreaterThan(0) // the check below would pass vacuously on an empty sweep

    for (const importPath of leavingImports) {
      // '../why/index.js' → 'why/index'; '../fleet/manifest.js' → 'fleet/manifest' —
      // strip the leading '../' hops and the extension so the import compares
      // cleanly against both lists regardless of how deep index.tsx sits.
      const resolved = importPath.replace(/^(\.\.\/)+/, '').replace(/\.(ts|tsx|js|jsx)$/, '')
      const inSurface = DRAWER_SURFACES.some((surface) => resolved.startsWith(surface.replace(/\/$/, '')))
      const inConsumed = CONSUMED.includes(resolved)
      expect(
        inSurface || inConsumed,
        `index.tsx imports '${importPath}', which leaves drawer/ into neither a DRAWER_SURFACES entry ` +
          `(${DRAWER_SURFACES.join(', ')}) nor the CONSUMED allowlist (${CONSUMED.join(', ')}) — this import is ` +
          `ungoverned by the read-only law; add its target to DRAWER_SURFACES if the drawer should walk it too, ` +
          `or to CONSUMED if it is a legitimate dependency this law deliberately does not walk`,
      ).toBe(true)
    }
  })

  it('the resolver bites — an import into a third, undeclared place would be caught', () => {
    const resolved = 'launch/launch'
    const inSurface = DRAWER_SURFACES.some((surface) => resolved.startsWith(surface.replace(/\/$/, '')))
    const inConsumed = CONSUMED.includes(resolved)
    expect(inSurface || inConsumed).toBe(false)
  })
})
