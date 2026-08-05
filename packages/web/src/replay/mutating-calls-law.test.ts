import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE MUTATING-CALLS LAW — prd16 ruling 2's condition on the web half, in the
 * philosophy of `drawer/readonly.test.ts` widened to the whole app.
 *
 * The drawer's law says "this directory sends only GETs". That law stays
 * exactly as it was, and stays green. But rotation gave the dashboard its
 * first mutating call ever, and "the drawer is clean" is no longer the same
 * statement as "the app is". So this law enumerates instead of forbidding:
 * across every source file in `packages/web/src`, the mutating calls are
 * EXACTLY one, in exactly one file, to exactly one route, with exactly one
 * verb. A second one added tomorrow — anywhere, in any panel, in a branch
 * nothing renders — fails here and has to say so in a diff a reviewer reads.
 *
 * Deliberately crude and deliberately loud, like the law it extends. Test
 * files are excluded (a test is not the app, and this file itself names every
 * verb it forbids), which is also why the enumeration is by *file*: the one
 * allowed call has to stay in the one module that documents why it exists.
 */

const REPLAY_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(REPLAY_DIR, '..')

/** The single file allowed to mutate, and the single route it may reach. */
const THE_MUTATING_MODULE = path.join(WEB_SRC, 'replay', 'rotate.ts')
const THE_MUTATING_ROUTE = '/api/rotate'
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

describe('the web app names exactly one mutating call (prd16 ruling 2)', () => {
  it('has the whole app to check, not one directory — an empty grep proves nothing', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(80)
    // The sweep really does reach the far corners, not just this directory.
    expect(files.map((file) => file.name)).toContain(path.join('app', 'StatusBar.tsx'))
    expect(files.map((file) => file.name)).toContain(path.join('drawer', 'useTranscript.ts'))
  })

  it('is the ONLY file in the app that names a mutating verb or builds a request init', () => {
    expect(mutatingFiles()).toEqual([path.relative(WEB_SRC, THE_MUTATING_MODULE)])
  })

  it('and that file mutates exactly one route, with exactly one verb', () => {
    const text = readFileSync(THE_MUTATING_MODULE, 'utf8')

    const verbs = [...new Set([...text.matchAll(/\b(POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]))]
    expect(verbs).toEqual([THE_ONLY_VERB])

    const routes = [...new Set([...text.matchAll(/'(\/api\/[a-z/:${}\-.[\]]+)'/gi)].map((match) => match[1]))]
    expect(routes).toEqual([THE_MUTATING_ROUTE])

    // Every `method:` in the file names POST — the call itself and the narrow
    // fetch type that will not typecheck against anything else. A `method:`
    // this doesn't account for means a verb went in some other way.
    const methods = [...text.matchAll(/\bmethod\s*:\s*'([A-Za-z]+)'/g)].map((match) => match[1])
    expect(methods.length).toBeGreaterThan(0)
    expect([...new Set(methods)]).toEqual([THE_ONLY_VERB])
    expect([...text.matchAll(REQUEST_INIT_GLOBAL_RE)]).toHaveLength(methods.length)
  })

  it('mutates nothing but the recording: it sends no body, no headers, no credential', () => {
    const text = readFileSync(THE_MUTATING_MODULE, 'utf8')
    expect(text).not.toMatch(/\b(?:headers|credentials|body)\s*:/)
    expect(text).not.toMatch(/FormData|URLSearchParams|new Request\(/)
    expect(text).not.toMatch(/apiKey|api_key|ANTHROPIC_API_KEY|Authorization|Bearer\s/i)
  })

  it('the button reaches the route only through that module — never its own fetch', () => {
    const button = readFileSync(path.join(WEB_SRC, 'replay', 'RotateButton.tsx'), 'utf8')
    expect(button).toContain("from './rotate.js'")
    expect(button).not.toMatch(/\bfetch\s*\(/)
    expect(button).not.toContain('/api/')
  })

  it('the detectors bite — a POST added anywhere else would be caught', () => {
    expect(MUTATING_VERB_RE.test("await fetch('/api/kill', { method: 'DELETE' })")).toBe(true)
    expect(REQUEST_INIT_RE.test("fetch(url, { method: 'post' })")).toBe(true)
    // …and do not fire on ordinary reading code, so the law is not vacuous.
    expect(MUTATING_VERB_RE.test("const data = await fetch('/api/sessions')")).toBe(false)
    expect(REQUEST_INIT_RE.test("const data = await fetch('/api/sessions')")).toBe(false)
  })
})
