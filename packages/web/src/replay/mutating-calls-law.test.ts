import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_TOKEN_HEADER } from '../recordings/capability.js'

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

/**
 * A header key inside an inline object literal — a single- or double-quoted
 * literal name, OR a computed `[identifier]` key. `label.ts`'s real call
 * site spells its capability header as `[CAPABILITY_TOKEN_HEADER]:`, which a
 * quote-only pattern cannot see at all: it would read that block as naming
 * just `Content-Type`, silently accept a computed credential under any other
 * name, and still compile (a computed key doesn't trigger TS's excess-
 * property check). Every group is optional per alternative; callers read
 * whichever of groups 1–3 is defined.
 */
const HEADER_KEY_RE = /(?:'([^']+)'|"([^"]+)"|\[([A-Za-z_$][\w$]*)\])\s*:/g

/**
 * `headers:` followed by anything other than an inline object literal — a
 * bare variable reference (`headers: h`) hides its contents from
 * {@link HEADER_KEY_RE} entirely, so the law must refuse that shape outright
 * rather than silently reading zero headers as "nothing to complain about".
 */
const HEADERS_NOT_INLINE_RE = /headers\s*:\s*(?!\{)\S/

/** Every name imported from `'./capability.js'` in `text` — the one source a computed capability-header key is ever trusted to come from. */
function importedFromCapabilityModule(text: string): Set<string> {
  const names = new Set<string>()
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/capability\.js'/g)) {
    for (const part of match[1]?.split(',') ?? []) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

/** The two headers `label.ts` may send, and no third — the JSON body's own `Content-Type`, and the capability token #249 delivered a channel for. */
const ALLOWED_HEADER_NAMES: readonly string[] = ['Content-Type', CAPABILITY_TOKEN_HEADER]

/**
 * THE HEADER LAW ITSELF, as one function both the law and its self-test call
 * — the law asserts it holds on the real `label.ts`, the self-test asserts it
 * throws on reconstructed defects, so the mechanism that guards the file is
 * the same mechanism proven able to fail. (The 2026-08-09 verify pass caught
 * the previous shape: a self-test that re-implemented the extraction inline
 * stayed green when the real per-block loop was reverted to the aggregate.)
 *
 * Every `headers:` block must be an inline object literal naming exactly
 * {@link ALLOWED_HEADER_NAMES} — per block, deliberately: an aggregate union
 * across blocks would stay green when the type declares both headers but the
 * call site sends only `Content-Type`, the pre-#249 defect hiding behind its
 * own declaration. A spread is refused outright: `...extra` names nothing
 * {@link HEADER_KEY_RE} can see and can smuggle any header at runtime.
 * Throws with a sentence naming the violation; returns silently when the law
 * holds.
 */
function assertHeaderBlocksExact(text: string): void {
  if (HEADERS_NOT_INLINE_RE.test(text)) {
    throw new Error('headers must stay an inline object literal, never a variable reference')
  }
  const importedFromCapability = importedFromCapabilityModule(text)
  const headerBlocks = [...text.matchAll(/headers\s*:\s*\{([^}]*)\}/g)]
  if (headerBlocks.length === 0) throw new Error('no headers: blocks found — an empty sweep proves nothing')

  for (const block of headerBlocks) {
    const body = block[1] ?? ''
    if (body.includes('...')) {
      throw new Error('a spread inside a headers block can carry a header no regex sees — refused outright')
    }
    const namesSeen = new Set<string>()
    const matches = [...body.matchAll(HEADER_KEY_RE)]
    if (matches.length === 0) throw new Error('a headers block that names no keys at all')
    for (const match of matches) {
      const literalName = match[1] ?? match[2]
      const computedIdentifier = match[3]
      if (literalName !== undefined) {
        if (!ALLOWED_HEADER_NAMES.includes(literalName)) {
          throw new Error(`${literalName} is not one of the two headers this call is allowed to send`)
        }
        namesSeen.add(literalName)
        continue
      }
      // A computed key is only trusted when it names the one constant this
      // call is allowed to send, imported from its one legitimate source — a
      // same-named identifier shadowed locally, or imported from anywhere
      // else, still fails.
      if (computedIdentifier !== 'CAPABILITY_TOKEN_HEADER') {
        throw new Error('a computed header key must name CAPABILITY_TOKEN_HEADER, nothing else')
      }
      if (!importedFromCapability.has('CAPABILITY_TOKEN_HEADER')) {
        throw new Error('CAPABILITY_TOKEN_HEADER must be imported from ./capability.js, the one trusted source')
      }
      namesSeen.add(CAPABILITY_TOKEN_HEADER)
    }
    const seen = [...namesSeen].sort()
    const allowed = [...ALLOWED_HEADER_NAMES].sort()
    if (seen.length !== allowed.length || seen.some((name, i) => name !== allowed[i])) {
      throw new Error(
        `every headers: block must name exactly the two allowed headers — no more, no fewer (this block names: ${seen.join(', ') || 'none'})`,
      )
    }
  }
}

describe('the web app names exactly three mutating calls (prd16 rulings 2 and 4; prd12/prd14 for the launch)', () => {
  it('has the whole app to check, not one directory — an empty grep proves nothing', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(80)
    // The sweep really does reach the far corners, not just this directory.
    expect(files.map((file) => file.name)).toContain(path.join('app', 'StatusBar.tsx'))
    expect(files.map((file) => file.name)).toContain(path.join('drawer', 'useTranscript.ts'))
  })

  it('are the ONLY three files in the app that name a mutating verb or build a request init', () => {
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
   * token the server requires.
   *
   * AMENDED for #249, alongside `label.ts`'s own widening, in the same
   * commit (`e9d506f`) — not a separate one, and this comment says so rather
   * than claiming otherwise: a law that requires both headers to be present
   * cannot go green before `label.ts` actually emits the second one, so the
   * two could not land as two independently-green commits. The commit
   * message names the amendment loudly instead.
   *
   * The check still names exactly the shape allowed rather than merely
   * "some body, somehow", so a stray header or a widened payload fails here
   * too — and, since the real call site spells its capability header as a
   * computed `[CAPABILITY_TOKEN_HEADER]` key rather than a string literal,
   * this resolves that computed key back to its one trusted import instead
   * of trusting any bracketed identifier by name, and refuses a `headers:`
   * value that isn't an inline object literal in the first place (either
   * escape would hide a smuggled header from every check below).
   */
  it("label.ts's body carries only sessionId and label, behind exactly the two headers the mutating call needs, no credential", () => {
    const text = readFileSync(path.join(WEB_SRC, 'recordings', 'label.ts'), 'utf8')
    expect(text).not.toMatch(/FormData|URLSearchParams|new Request\(/)
    expect(text).not.toMatch(/apiKey|api_key|ANTHROPIC_API_KEY|Authorization|Bearer\s/i)
    expect(text).not.toMatch(/credentials\s*:/)

    // Two blocks are expected — the narrow fetch type's own shape and the one
    // real call site — and {@link assertHeaderBlocksExact} holds each to
    // exactly the fixed header set. The self-test below proves that same
    // function able to fail; this line proves it holds on the real file.
    expect(() => assertHeaderBlocksExact(text), 'the header law must hold on the real label.ts').not.toThrow()

    expect(text).toMatch(/body\s*:\s*JSON\.stringify\(\{\s*sessionId,\s*label\s*\}\)/)
  })

  it('the header checks themselves catch what they claim to — a computed credential under a different name, a shadowed import, and headers hidden in a variable', () => {
    // A computed key naming anything other than CAPABILITY_TOKEN_HEADER is
    // visible to the pattern (so the law can inspect and reject it) — the
    // pattern's job is to surface the identifier, not silently miss it.
    const smuggled = [
      ..."{ 'Content-Type': 'application/json', [AUTH_HEADER]: token }".matchAll(HEADER_KEY_RE),
    ].map((match) => match[3])
    expect(smuggled).toContain('AUTH_HEADER')
    expect(smuggled).not.toContain('CAPABILITY_TOKEN_HEADER')

    // A same-named identifier imported from anywhere other than
    // `./capability.js` does not satisfy the trusted-import check.
    expect(
      importedFromCapabilityModule("import { CAPABILITY_TOKEN_HEADER } from './somewhere-else.js'").has(
        'CAPABILITY_TOKEN_HEADER',
      ),
    ).toBe(false)
    expect(
      importedFromCapabilityModule("import { CAPABILITY_TOKEN_HEADER } from './capability.js'").has(
        'CAPABILITY_TOKEN_HEADER',
      ),
    ).toBe(true)

    // `headers:` assigned from a bare variable hides its contents from
    // HEADER_KEY_RE entirely — the law must refuse that shape outright.
    expect(HEADERS_NOT_INLINE_RE.test('headers: h,')).toBe(true)
    expect(HEADERS_NOT_INLINE_RE.test("headers: { 'Content-Type': 'application/json' }")).toBe(false)
  })

  it('the header law itself refuses the pre-#249 drop-back, a spread, and a smuggled name — and passes the healthy shape', () => {
    // These probes call assertHeaderBlocksExact — THE function the law runs
    // on the real label.ts — not a re-implementation of its regexes. (The
    // 2026-08-09 verify pass showed the previous, re-implemented probe
    // stayed green when the real per-block loop was reverted to the
    // aggregate; a probe that doesn't run the mechanism pins nothing.)
    const trustedImport = "import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from './capability.js'\n"

    // The defect that shipped #249: the type declares both headers, the call
    // site drops back to Content-Type alone. The union across blocks equals
    // the allowed set — an aggregate check stays green — so only a per-block
    // law can refuse it.
    const dropBackLiteral =
      trustedImport +
      "headers: { 'Content-Type': 'application/json'; 'x-rhizomorph-capability': string }\n" +
      "headers: { 'Content-Type': 'application/json' },\n"
    expect(() => assertHeaderBlocksExact(dropBackLiteral)).toThrow(/no more, no fewer/)

    // The same drop-back in the spelling the real call site actually uses —
    // a computed [CAPABILITY_TOKEN_HEADER] key in the surviving block.
    const dropBackComputed =
      trustedImport +
      "headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken }\n" +
      "headers: { 'Content-Type': 'application/json' },\n"
    expect(() => assertHeaderBlocksExact(dropBackComputed)).toThrow(/no more, no fewer/)

    // A spread can smuggle any header past every name check at runtime —
    // refused outright, not silently unseen (the verify pass executed this
    // evasion against the pre-fix law and it passed; now it cannot).
    const spread =
      trustedImport +
      "headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken, ...extra },\n"
    expect(() => assertHeaderBlocksExact(spread)).toThrow(/spread/)

    // A third named header is refused for its name.
    const smuggled =
      trustedImport +
      "headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken, 'x-api-key': key },\n"
    expect(() => assertHeaderBlocksExact(smuggled)).toThrow(/not one of the two headers/)

    // And the healthy two-block shape — type declaration plus real call site,
    // exactly as label.ts spells them — passes, so the probes above are
    // distinguishing sick from well, not failing everything.
    const healthy =
      trustedImport +
      "headers: { 'Content-Type': 'application/json'; 'x-rhizomorph-capability': string }\n" +
      "headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },\n"
    expect(() => assertHeaderBlocksExact(healthy)).not.toThrow()
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
