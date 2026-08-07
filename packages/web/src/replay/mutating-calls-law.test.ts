import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE MUTATING-CALLS LAW — prd16 ruling 2's condition on the web half, widened
 * by ruling 4 in the philosophy of `drawer/readonly.test.ts` applied to the
 * whole app.
 *
 * The drawer's law says "this directory sends only GETs". That law stays
 * exactly as it was, and stays green. Rotation gave the dashboard its first
 * mutating call ever; the recordings library's rename-in-place gave it its
 * second; the lab's launch gives it its third. So this law enumerates
 * instead of forbidding: across every source file in `packages/web/src`, the
 * mutating calls are EXACTLY THREE, each in exactly one file, each to
 * exactly one route — and every verb any one names is the same single verb,
 * `POST`. A FOURTH one added tomorrow — anywhere, in any panel, in a branch
 * nothing renders — fails here and has to say so in a diff a reviewer reads.
 *
 * **Why a third mutating call is allowed to exist at all, not just why it is
 * caught.** Rotation (`replay/rotate.ts`), the rename (`recordings/label.ts`)
 * and the launch (`lab/launch/launch.ts`) are constitutional for the
 * identical three reasons the first two already were: each writes only a
 * SIDECAR, a session boundary, or — for the launch — refs and worktrees
 * confined to the laboratory's own amended namespace (prd12 ruling 1), never
 * an operator branch and never the watched repo's working tree; each is
 * triggered only by an EXPLICIT OPERATOR ACT (a button the operator clicked,
 * behind exactly one confirmation for the launch — prd14 ruling 4), never a
 * background poll or a timer (`lab/launch/explicit-invocation-law.test.ts`
 * proves that structurally); and none of the three ever mutates the
 * append-only event log's PAST — rotation appends a
 * `session.closed`/`session.started` pair the log already permits, the
 * rename writes `log/label.ts`'s own sidecar file beside it, and the launch's
 * `fork.dispatched` events are exactly what `server/src/lab/fork.ts` already
 * appends for an operator-run `rhizomorph lab fork`, spend and all, never
 * hidden as "just an experiment" (prd12 ruling 3). A fourth mutating call
 * would need to clear that same bar, argued in its own diff, not inherited
 * from these three by default — which is exactly why this law enumerates by
 * *file* and stays exact rather than "at least one, at most a few": the one
 * module that may reach each route is also the one module that documents why
 * it is allowed to.
 *
 * Deliberately crude and deliberately loud, like the law it extends. Test
 * files are excluded (a test is not the app, and this file itself names every
 * verb it forbids), which is also why the enumeration is by *file*: each
 * allowed call has to stay in the one module that documents why it exists.
 */

const REPLAY_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(REPLAY_DIR, '..')

/** The three files allowed to mutate, and the one route each may reach — every verb across all three is `POST`. */
const MUTATING_MODULES: ReadonlyArray<{ file: string; route: string }> = [
  { file: path.join(WEB_SRC, 'replay', 'rotate.ts'), route: '/api/rotate' },
  { file: path.join(WEB_SRC, 'recordings', 'label.ts'), route: '/api/label' },
  { file: path.join(WEB_SRC, 'lab', 'launch', 'launch.ts'), route: '/api/lab/launch' },
]
const THE_ONLY_VERB = 'POST'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

interface SourceFile {
  path: string
  name: string
  text: string
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(full))) continue
      if (/\.test\.tsx?$/.test(entry)) continue
      out.push({ path: full, name: path.relative(WEB_SRC, full), text: readFileSync(full, 'utf8') })
    }
  }
  visit(WEB_SRC)
  return out
}

/** Naming a mutating verb, or building a request init that could carry one. */
const MUTATING_VERB_RE = /\b(?:POST|PUT|PATCH|DELETE)\b/
const REQUEST_INIT_RE = /\bmethod\s*:/
/** The same check, global, for counting occurrences rather than finding one. */
const REQUEST_INIT_GLOBAL_RE = /\bmethod\s*:/g

function mutatingFiles(): string[] {
  return sourceFiles()
    .filter((file) => MUTATING_VERB_RE.test(file.text) || REQUEST_INIT_RE.test(file.text))
    .map((file) => file.name)
    .sort()
}

describe('the web app names exactly two mutating calls (prd16 rulings 2 and 4)', () => {
  it('has the whole app to check, not one directory — an empty grep proves nothing', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(80)
    // The sweep really does reach the far corners, not just this directory.
    expect(files.map((file) => file.name)).toContain(path.join('app', 'StatusBar.tsx'))
    expect(files.map((file) => file.name)).toContain(path.join('drawer', 'useTranscript.ts'))
  })

  it('are the ONLY two files in the app that name a mutating verb or build a request init', () => {
    expect(mutatingFiles()).toEqual(
      MUTATING_MODULES.map((module) => path.relative(WEB_SRC, module.file)).sort(),
    )
  })

  it('each mutates exactly its own one route, and every verb either names is the one shared verb', () => {
    const allVerbs: string[] = []
    for (const { file, route } of MUTATING_MODULES) {
      const text = readFileSync(file, 'utf8')

      const verbs = [
        ...new Set(
          [...text.matchAll(/\b(POST|PUT|PATCH|DELETE)\b/g)]
            .map((match) => match[1])
            .filter((verb): verb is string => verb !== undefined),
        ),
      ]
      expect(verbs, `${path.relative(WEB_SRC, file)} names an unexpected verb set`).toEqual([THE_ONLY_VERB])
      allVerbs.push(...verbs)

      const routes = [...new Set([...text.matchAll(/'(\/api\/[a-z/:${}\-.[\]]+)'/gi)].map((match) => match[1]))]
      expect(routes, `${path.relative(WEB_SRC, file)} names an unexpected route set`).toEqual([route])

      // Every `method:` in the file names POST — the call itself and the narrow
      // fetch type that will not typecheck against anything else. A `method:`
      // this doesn't account for means a verb went in some other way.
      const methods = [...text.matchAll(/\bmethod\s*:\s*'([A-Za-z]+)'/g)].map((match) => match[1])
      expect(methods.length).toBeGreaterThan(0)
      expect([...new Set(methods)]).toEqual([THE_ONLY_VERB])
      expect([...text.matchAll(REQUEST_INIT_GLOBAL_RE)]).toHaveLength(methods.length)
    }
    // The shared verb really is shared, not each module coincidentally alone.
    expect([...new Set(allVerbs)]).toEqual([THE_ONLY_VERB])
  })

  it('rotate.ts mutates nothing but the recording boundary: no body, no headers, no credential', () => {
    const text = readFileSync(path.join(WEB_SRC, 'replay', 'rotate.ts'), 'utf8')
    expect(text).not.toMatch(/\b(?:headers|credentials|body)\s*:/)
    expect(text).not.toMatch(/FormData|URLSearchParams|new Request\(/)
    expect(text).not.toMatch(/apiKey|api_key|ANTHROPIC_API_KEY|Authorization|Bearer\s/i)
  })

  /**
   * `label.ts` genuinely has something to say (which session, and what to
   * call it), unlike rotation — so it structurally cannot follow "no body at
   * all". What it must still never do is smuggle a credential or grow past
   * the two headers this call needs: the JSON body's own `Content-Type`,
   * and — since #249 delivered a channel for it — the per-process capability
   * token the server requires. AMENDED for #249: this pinned exactly one
   * header until the token had nowhere to travel; the fence for that change
   * (`docs/adr/`) is that this amendment lands in its own reviewable commit,
   * never folded silently into the feature that needed it. The check still
   * names exactly the shape allowed rather than merely "some body, somehow",
   * so a stray header or a widened payload fails here too.
   */
  it("label.ts's body carries only sessionId and label, behind exactly the two headers the mutating call needs, no credential", () => {
    const text = readFileSync(path.join(WEB_SRC, 'recordings', 'label.ts'), 'utf8')
    expect(text).not.toMatch(/FormData|URLSearchParams|new Request\(/)
    expect(text).not.toMatch(/apiKey|api_key|ANTHROPIC_API_KEY|Authorization|Bearer\s/i)
    expect(text).not.toMatch(/credentials\s*:/)

    // Two occurrences are expected — the narrow fetch type's own shape and the
    // one real call site — and each must name exactly this fixed header set,
    // nothing more and nothing less (a stray third header, or dropping back
    // to one, fails here).
    const ALLOWED_HEADER_NAMES = ['Content-Type', 'x-rhizomorph-capability']
    const headerBlocks = [...text.matchAll(/headers\s*:\s*\{([^}]*)\}/g)]
    expect(headerBlocks.length).toBeGreaterThan(0)

    const namesSeen = new Set<string>()
    for (const block of headerBlocks) {
      const names = [...(block[1] ?? '').matchAll(/'([^']+)'\s*:/g)].map((match) => match[1])
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) {
        expect(ALLOWED_HEADER_NAMES, `${name} is not one of the two headers this call is allowed to send`).toContain(
          name,
        )
        if (name !== undefined) namesSeen.add(name)
      }
    }
    // Both allowed headers actually appear somewhere — a block missing the
    // capability header entirely (the pre-#249 shape) fails this, not just a
    // block naming an extra one.
    expect([...namesSeen].sort()).toEqual([...ALLOWED_HEADER_NAMES].sort())

    expect(text).toMatch(/body\s*:\s*JSON\.stringify\(\{\s*sessionId,\s*label\s*\}\)/)
  })

  it('the buttons reach their routes only through their own module — never their own fetch', () => {
    const rotateButton = readFileSync(path.join(WEB_SRC, 'replay', 'RotateButton.tsx'), 'utf8')
    expect(rotateButton).toContain("from './rotate.js'")
    expect(rotateButton).not.toMatch(/\bfetch\s*\(/)
    expect(rotateButton).not.toContain('/api/')

    const renameControl = readFileSync(path.join(WEB_SRC, 'recordings', 'RenameControl.tsx'), 'utf8')
    expect(renameControl).toContain("from './label.js'")
    expect(renameControl).not.toMatch(/\bfetch\s*\(/)
    expect(renameControl).not.toContain('/api/')
  })

  it('the detectors bite — a POST added anywhere else would be caught', () => {
    expect(MUTATING_VERB_RE.test("await fetch('/api/kill', { method: 'DELETE' })")).toBe(true)
    expect(REQUEST_INIT_RE.test("fetch(url, { method: 'post' })")).toBe(true)
    // …and do not fire on ordinary reading code, so the law is not vacuous.
    expect(MUTATING_VERB_RE.test("const data = await fetch('/api/sessions')")).toBe(false)
    expect(REQUEST_INIT_RE.test("const data = await fetch('/api/sessions')")).toBe(false)
  })
})
