import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImportSpecifiers } from '../test/import-specifiers.js'

/**
 * THE INSTRUMENT PATH IS REACHABLE ONLY FROM AN EXPLICIT REQUEST (prd-20
 * ruling 6's "invoked only by the same explicit human act that requests the
 * resume — never a collector, never a poll, never a timer"; ADR-0020 grant 4;
 * prd-14 ruling 4's one-confirmation bar, since this spawns a process).
 *
 * Same tactic `lab/launch/explicit-invocation-law.test.ts` uses, and the same
 * reason: a `useEffect` or a timer added tomorrow would pass every behavioural
 * test in `InstrumentButton.test.tsx` and still be exactly the thing the
 * ruling forbids — a relaunch that fires, and a transcript that gets copied,
 * without a human clicking "instrument". `replay/mutating-calls-law.test.ts`
 * enumerates this module as the app's fourth mutating call and cites THIS file
 * for the structural half of that argument, so what is asserted below is what
 * that enumeration is standing on.
 *
 * **AMENDED for #266, in two directions.** This directory gained the app's
 * FIFTH mutating call — `clone.ts`, ADR-0019's other power — so the same
 * structural proof now covers it. And the caller enumeration, which used to
 * sweep this directory alone, now sweeps all of `packages/web/src`: the wizard
 * (`connect/wizard.tsx`) is a legitimate second caller of the relaunch and the
 * only caller of the clone, and a rule reading "exactly one call site" that can
 * only see one directory stops being a rule the moment a call site lands
 * outside it. The clocks-and-effects bans stay scoped here, because those are
 * rules about what may live in this directory rather than about who may ask.
 *
 * **The walk is the sibling law's recursive shape, defined here rather than
 * imported** — vitest re-executes a test module's top-level code, `describe`
 * blocks included, every time another test file imports it, so importing the
 * sibling's walker would report its whole suite a second time nested under
 * this one. One walk *shape*, defined twice, is the established trade in this
 * repo (see the sibling law's own file doc); the import *extraction* is
 * genuinely shared (`test/import-specifiers.ts`), because a plain module with
 * no `describe` blocks carries no such cost.
 */

const CONCIERGE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** `packages/web/src` — the sweep the caller enumeration needs, since #266 put a caller outside this directory. */
const WEB_SRC = path.resolve(CONCIERGE_DIR, '..')

interface ConciergeSourceFile {
  readonly name: string
  readonly text: string
}

function walk(root: string): ConciergeSourceFile[] {
  const out: ConciergeSourceFile[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (/\.test\.tsx?$/.test(entry)) continue
      out.push({ name: path.relative(root, full), text: readFileSync(full, 'utf8') })
    }
  }
  visit(root)
  return out
}

function sourceFiles(): ConciergeSourceFile[] {
  return walk(CONCIERGE_DIR)
}

/**
 * EVERY source file in the web app, for the one check that cannot be scoped to
 * this directory (#266).
 *
 * The caller enumeration used to sweep `concierge/` alone, which was exact
 * while `InstrumentButton.tsx` was the only caller and became VACUOUS the
 * moment `connect/wizard.tsx` reached for the same act: a second, unreviewed
 * call site added in `panels/` tomorrow would have passed a `concierge/`-only
 * sweep without being seen at all. The ban on clocks and effects stays scoped
 * to this directory — that is a rule about what may live HERE — but "who may
 * ask for this act" is a claim about the whole app, so it is now checked
 * against the whole app.
 */
function appSourceFiles(): ConciergeSourceFile[] {
  return walk(WEB_SRC)
}

const SCHEDULING_RE = /\b(setInterval|setTimeout|setImmediate)\s*\(/
const CALLS_REQUEST_INSTRUMENT_RE = /\brequestInstrument\s*\(/
const CALLS_REQUEST_CLONE_RE = /\brequestClone\s*\(/
const USE_EFFECT_RE = /\buseEffect\s*\(/

const FORBIDDEN_IDENTIFIERS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  /\breduceAll\(/,
]

/**
 * Import prefixes forbidden anywhere under `concierge/`, tested against every
 * specifier `extractImportSpecifiers` finds — so a bare side-effect import, a
 * dynamic `import('…')` and a template-literal specifier are exactly as
 * visible as a static `… from '…'` (the sibling law's own PR #301 lesson).
 *
 * `lab/` joins the sibling's three: the concierge is the front door, not the
 * laboratory, and a hand that spawns the operator's own conductor has no
 * business reaching into the experiment machinery that dispatches forks.
 * `(?:\.\.\/)+` — one or more hops, not a pinned depth — because pinning to
 * the depth today's flat directory happens to have is the drift the sibling
 * law's 2026-08-08 audit flagged.
 */
const FORBIDDEN_IMPORT_PREFIXES: readonly RegExp[] = [
  /^(?:\.\.\/)+fleet\//,
  /^(?:\.\.\/)+panels\//,
  /^(?:\.\.\/)+scene\//,
  /^(?:\.\.\/)+lab\//,
]

/**
 * The module that holds the act, WITHOUT its extension. Any second call site
 * must first import this file, and the spellings that reach it do not agree on
 * a suffix: `./instrument.js` is what this repo writes, `./instrument` also
 * compiles under the web package's resolution, and both name the same module.
 * Comparing against a fixed `instrument.ts` matched only the first — an
 * extensionless import resolved to a path with no `.ts` on it, compared false,
 * and walked past this law while `tsc --noEmit` exited 0 (verify pass on #608).
 */
const INSTRUMENT_MODULE_STEM = path.join(CONCIERGE_DIR, 'instrument')

/** `…/instrument.ts` and `…/instrument.js` and `…/instrument` all reduce to one key. */
function moduleStem(absolutePath: string): string {
  return absolutePath.replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, '')
}

/**
 * The web package's own `exports` map, which is a SECOND supported route to the
 * act and not an exotic one: `package.json` publishes
 * `"./concierge/instrument": "./src/concierge/instrument.ts"` deliberately, so
 * `import … from '@rhizomorph/web/concierge/instrument'` typechecks (verified,
 * `tsc --noEmit` exit 0). A law that filtered to relative specifiers could never
 * see it. Read from the manifest rather than hard-coded, so a subpath added
 * tomorrow is covered without editing this file.
 */
const WEB_PACKAGE_DIR = path.join(WEB_SRC, '..')
const WEB_PACKAGE = JSON.parse(readFileSync(path.join(WEB_PACKAGE_DIR, 'package.json'), 'utf8')) as {
  name?: string
  exports?: Record<string, string>
}

/** A bare specifier's target file, or null when it names no export of this package. */
function packageExportTarget(specifier: string): string | null {
  const name = WEB_PACKAGE.name
  if (name === undefined || (specifier !== name && !specifier.startsWith(`${name}/`))) return null
  const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`
  const target = WEB_PACKAGE.exports?.[subpath]
  return target === undefined ? null : path.resolve(WEB_PACKAGE_DIR, target)
}

/**
 * A whole `import type … from '…'` statement, erased by the compiler.
 *
 * The inner arm refuses to cross a following `import`, and that bound is the
 * load-bearing part rather than tidiness. A pattern that could run past the end
 * of its own statement would delete the NEXT import along with it — and the
 * next one may be a value import of the very module this law polices, which
 * turns the law green while the reach it forbids exists. Over-keeping a
 * statement can only ever over-report a reacher, which fails loudly in a diff;
 * over-deleting one fails silently forever, so the pattern is written to make
 * only the first mistake possible.
 *
 * Inline modifiers (`import { type A, b } from '…'`) are deliberately NOT
 * matched: such a statement still imports the value `b`, so it reaches.
 */
const TYPE_ONLY_IMPORT_RE = /\bimport\s+type\b(?:(?!\bimport\b)[\s\S])*?from\s*(['"])[^'"\n]*\1/g

/** Every import specifier in `text` that survives compilation — see {@link TYPE_ONLY_IMPORT_RE}. */
function valueImportSpecifiers(text: string): string[] {
  return extractImportSpecifiers(text.replace(TYPE_ONLY_IMPORT_RE, ''))
}

/**
 * Whether `file` imports the instrument module, by any of the forms
 * `extractImportSpecifiers` sees, at any depth, under any local name.
 *
 * This is the check the caller-count above cannot make. `CALLS_..._RE` reads
 * call *syntax*, so `import { requestInstrument as go }` + `go(…)` and
 * `ns['requestInstrument'](…)` both reach the act while never placing the
 * identifier next to an open paren — measured, not argued: a probe file
 * spelling it both ways passed this suite 21/21 (review of #528). Reachability
 * is the property the ruling actually cares about, and reachability requires an
 * import. There is no back door left: a specifier cannot be computed at runtime
 * here, because the `${…}` law below already refuses that outright.
 *
 * `root` is the directory `file.name` is relative to. It must match the walk
 * the caller used: {@link sourceFiles} names files against `CONCIERGE_DIR`,
 * {@link appSourceFiles} against `WEB_SRC`. Getting that wrong resolves every
 * specifier from the wrong directory and the check answers `false` for
 * everything — a green law proving nothing, which is the failure this test
 * exists to prevent rather than commit.
 *
 * Type-only imports do not count. `extractImportSpecifiers` sees
 * `import type { T } from '…'` on purpose — it serves FORBID laws, where
 * over-matching fails loudly in a diff and under-matching passes forever. This
 * law asks the opposite question, so the same reading is a false positive:
 * `connect/index.tsx` imports `InstrumentFetchLike` and `InstrumentOutcome` as
 * types, which TypeScript erases, and erased text cannot invoke the act.
 * Listing it as a reacher would make the assertion a census of who mentions the
 * module rather than of who can call it.
 */
function importsInstrumentModule(file: ConciergeSourceFile, root: string = CONCIERGE_DIR): boolean {
  const fromDir = path.dirname(path.join(root, file.name))
  return valueImportSpecifiers(file.text).some((specifier) => {
    const target = specifier.startsWith('.')
      ? path.resolve(fromDir, specifier)
      : packageExportTarget(specifier)
    return target !== null && moduleStem(target) === INSTRUMENT_MODULE_STEM
  })
}

function forbiddenImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) =>
    FORBIDDEN_IMPORT_PREFIXES.some((prefix) => prefix.test(specifier)),
  )
}

/**
 * Specifiers no prefix check can vouch for — `${…}` anywhere means the path is
 * computed at runtime and could land in any of the directories above without
 * matching a single prefix.
 */
function computedImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) => specifier.includes('${'))
}

describe('the concierge instrument path is reachable only from an explicit request (prd-20 ruling 6; ADR-0020 grant 4)', () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    const names = sourceFiles().map((file) => file.name)
    // Today's three, named rather than counted loosely: a silently dropped file
    // fails here as loudly as an empty directory would.
    expect(names).toContain('instrument.ts')
    expect(names).toContain('InstrumentButton.tsx')
    expect(names).toContain('clone.ts')
    expect(names.length).toBeGreaterThanOrEqual(3)
  })

  it('the app-wide walk really reaches the far corners — an enumeration over three files would prove nothing about a fourth caller', () => {
    const names = appSourceFiles().map((file) => file.name)
    expect(names.length).toBeGreaterThan(80)
    expect(names).toContain(path.join('connect', 'wizard.tsx'))
    expect(names).toContain(path.join('panels', 'fleet', 'index.tsx'))
    expect(names).toContain(path.join('concierge', 'instrument.ts'))
  })

  it('nothing under concierge/ has a clock of its own — a relaunch never fires without an incoming click', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} matches a scheduling call`).not.toMatch(SCHEDULING_RE)
    }
  })

  it('that detector bites — a scheduled relaunch would be caught', () => {
    expect(SCHEDULING_RE.test('setInterval(() => requestInstrument(x), 1000)')).toBe(true)
  })

  /**
   * AMENDED for #266, and WIDENED to the whole app in the same breath — see
   * {@link appSourceFiles} for why a `concierge/`-scoped enumeration stopped
   * being exact the moment a caller landed outside this directory.
   *
   * Two callers now, each named. `InstrumentButton.tsx` asks for a resume of
   * one named session, behind its own confirmation; `connect/wizard.tsx`'s
   * conductor step asks for a fresh launch or a continue, from a repo the
   * operator has just picked. A THIRD, anywhere in the app, fails here.
   */
  it('requestInstrument is invoked from exactly two files, app-wide — never a third, unreviewed call site', () => {
    const callers = appSourceFiles()
      .filter((file) => file.name !== path.join('concierge', 'instrument.ts'))
      .filter((file) => CALLS_REQUEST_INSTRUMENT_RE.test(file.text))
      .map((file) => file.name)
      .sort()
    expect(callers).toEqual([path.join('concierge', 'InstrumentButton.tsx'), path.join('connect', 'wizard.tsx')])
  })

  /**
   * The fifth mutating call's own enumeration (#266). The clone is a write to
   * the operator's disk, and prd-20 ruling 1's "invoked only by an explicit
   * human act in the UI" is exactly as binding on it as on the relaunch — so
   * it gets the same structural proof rather than the same promise.
   */
  it('requestClone is invoked from exactly one file, app-wide — connect/wizard.tsx', () => {
    const callers = appSourceFiles()
      .filter((file) => file.name !== path.join('concierge', 'clone.ts'))
      .filter((file) => CALLS_REQUEST_CLONE_RE.test(file.text))
      .map((file) => file.name)
    expect(callers).toEqual([path.join('connect', 'wizard.tsx')])
  })

  /**
   * App-wide, for the same reason the caller-count above is (#266): a reacher
   * that lands outside `concierge/` is exactly the one a directory-scoped walk
   * cannot see. When this check was written the second caller did not yet
   * exist, so it walked `sourceFiles()` and asserted a single importer — and
   * it PASSED against a tree holding two, because `connect/wizard.tsx` was out
   * of its walk. Scoped to this directory it is the defect it was written to
   * remove.
   *
   * Two, not three: `connect/index.tsx` names the module as well, but as
   * `import type`, which the compiler erases — see {@link TYPE_ONLY_IMPORT_RE}.
   */
  it('instrument.ts is REACHED from exactly two files, app-wide — the caller-count above reads syntax, this reads reachability', () => {
    const importers = appSourceFiles()
      .filter((file) => file.name !== path.join('concierge', 'instrument.ts'))
      .filter((file) => importsInstrumentModule(file, WEB_SRC))
      .map((file) => file.name)
      .sort()
    expect(importers).toEqual([path.join('concierge', 'InstrumentButton.tsx'), path.join('connect', 'wizard.tsx')])
  })

  it('that detector bites — alias, namespace and dynamic imports are all seen, at any depth', () => {
    const probe = (text: string, name = 'Probe.tsx') => importsInstrumentModule({ name, text })
    // The two spellings that walked past the caller-count, and the namespace
    // form the computed-member one needs.
    expect(probe("import { requestInstrument as go } from './instrument.js'")).toBe(true)
    expect(probe("import * as ns from './instrument.js'")).toBe(true)
    expect(probe("const m = await import('./instrument.js')")).toBe(true)
    expect(probe("import './instrument.js'")).toBe(true)
    // A nested file reaches the same module by a different spelling, so the
    // check cannot be pinned to today's flat directory (the sibling law's
    // 2026-08-08 drift finding).
    expect(probe("import { requestInstrument } from '../instrument.js'", 'sub/Deep.tsx')).toBe(true)
    // …and the imports this directory legitimately makes are not caught.
    expect(probe("import { readCapabilityToken } from '../recordings/capability.js'")).toBe(false)
    expect(probe("import { missingTokenMessage } from '../recordings/capability-guidance.js'")).toBe(false)
  })

  /**
   * The two spellings that defeated the first version of this law, both found
   * by the verify pass on #608 and both EXECUTED before being fixed: each
   * compiled (`tsc --noEmit` exit 0) while the law reported 18/18 green.
   *
   * They are here rather than in the docstring because a law's known evasions
   * are exactly the assertions most worth pinning — the first version's comment
   * claimed "there is no back door left", which was true of the back doors its
   * author had thought of.
   */
  it('an extensionless or package-name import is still a reach — both compile, and both walked past the first version of this law', () => {
    const probe = (text: string, name = 'Probe.tsx') => importsInstrumentModule({ name, text })
    // `./instrument` with no suffix: the old check appended `.ts` only to a
    // `.js` specifier, so this resolved to a path that compared false.
    expect(probe("import { requestInstrument as go } from './instrument'")).toBe(true)
    expect(probe("import { requestInstrument } from '../instrument'", 'sub/Deep.tsx')).toBe(true)
    // The package's own exports map publishes this subpath deliberately, so it
    // is a supported route to the act, not a trick. The old check filtered to
    // specifiers starting with '.', so it never looked.
    expect(probe("import { requestInstrument as go } from '@rhizomorph/web/concierge/instrument'")).toBe(true)
    // A different published subpath of the same package is NOT the act.
    expect(probe("import { rotate } from '@rhizomorph/web/replay/rotate'")).toBe(false)
    // An unrelated package is not a reach either.
    expect(probe("import { describe } from 'vitest'")).toBe(false)
  })

  it('a type-only import is not a reach — it is erased, and it cannot invoke', () => {
    const probe = (text: string, name = 'Probe.tsx') => importsInstrumentModule({ name, text })
    // The real shape this distinguishes: connect/index.tsx names the module for
    // its types alone. Counting it would make the assertion a census of who
    // mentions the act rather than of who can perform it.
    expect(probe("import type { InstrumentOutcome } from './instrument.js'")).toBe(false)
    expect(probe('import type {\n  InstrumentOutcome,\n} from "./instrument.js"')).toBe(false)
    // An inline modifier still imports a value beside the type, so it reaches.
    expect(probe("import { type InstrumentOutcome, requestInstrument } from './instrument.js'")).toBe(true)
    // The bound that makes over-deletion impossible: a type-only import of
    // ANOTHER module must not swallow the value import that follows it. Without
    // the `(?!\bimport\b)` guard this reads false and the law goes green over a
    // live reach — the one failure direction that would matter.
    expect(
      probe("import type { Foo } from '../recordings/capability.js'\nimport { requestInstrument } from './instrument.js'"),
    ).toBe(true)
  })

  it("the one call site is wired to the confirm button's onClick, not left implicit", () => {
    const button = readFileSync(path.join(CONCIERGE_DIR, 'InstrumentButton.tsx'), 'utf8')
    expect(button).toMatch(/onClick=\{\(\)\s*=>\s*void confirmInstrument\(\)\}/)
  })

  /**
   * **THE ARMING BAR, PINNED FOR BOTH CALLERS** (prd-14 ruling 4; ledger #2).
   *
   * The relaunch spawns a process that spends money, so a caller may not reach
   * it on one click. That was true of `InstrumentButton.tsx` from the start and
   * NOT true of `connect/wizard.tsx` when it landed: its launch button called
   * the act directly, while `instrument.ts`'s module doc went on claiming the
   * act sat "behind exactly one confirmation… one caller, arms before it acts".
   * The prose was the only thing asserting the bar, and prose does not hold —
   * so the bar is asserted here instead, per caller, in both halves that
   * matter: something ARMS (a click that only moves to a confirming state and
   * spends nothing), and the button that ACTS exists only inside that state.
   *
   * Deliberately per-file rather than a sweep: a generic "some confirming state
   * exists" check over the caller set would pass on a file where the two
   * buttons were wired the wrong way round, which is precisely the defect.
   */
  it('every caller arms before it acts — the act is never one click away', () => {
    const button = readFileSync(path.join(CONCIERGE_DIR, 'InstrumentButton.tsx'), 'utf8')
    // Arms: the idle button only moves the phase.
    expect(button).toMatch(/data-testid=\{`\$\{testId\}-start`\}\s+onClick=\{\(\)\s*=>\s*setPhase\(\{ status: 'confirming' \}\)\}/)
    // Acts: the button that reaches the act lives in the confirming branch.
    expect(button).toMatch(/phase\.status === 'confirming'/)
    expect(button).toMatch(/data-testid=\{`\$\{testId\}-confirm`\}\s+onClick=\{\(\)\s*=>\s*void confirmInstrument\(\)\}/)

    const wizard = readFileSync(path.join(WEB_SRC, 'connect', 'wizard.tsx'), 'utf8')
    expect(wizard).toMatch(/onArm=\{\(\)\s*=>\s*setLaunch\(\{ status: 'confirming' \}\)\}/)
    expect(wizard).toMatch(/data-testid="wizard-launch"[\s\S]{0,120}?onClick=\{onArm\}/)
    expect(wizard).toMatch(/launch\.status === 'confirming'/)
    expect(wizard).toMatch(/data-testid="wizard-launch-confirm"\s+onClick=\{onLaunch\}/)
    // …and `onLaunch` is reachable from nowhere else in the file, so the
    // confirming branch is the only door rather than merely one of them.
    expect(wizard.match(/onClick=\{onLaunch\}/g)).toHaveLength(1)
  })

  /**
   * The wizard's two acts, pinned across BOTH hops of their wiring — the
   * handler the step component receives, and the `onClick` that is the only
   * thing which fires it. Pinning one hop alone would leave the other free to
   * become a `useEffect` or an `onChange` without this law noticing, which is
   * the whole failure mode it exists for.
   */
  it("the wizard's clone and launch are each wired to one button's onClick, both hops named", () => {
    const wizard = readFileSync(path.join(WEB_SRC, 'connect', 'wizard.tsx'), 'utf8')
    expect(wizard).toMatch(/onClone=\{\(\)\s*=>\s*void confirmClone\(\)\}/)
    expect(wizard).toMatch(/onLaunch=\{\(\)\s*=>\s*void confirmLaunch\(\)\}/)
    expect(wizard).toMatch(/onClick=\{onClone\}/)
    expect(wizard).toMatch(/onClick=\{onLaunch\}/)
  })

  /**
   * The wizard is the one caller allowed a `useEffect` at all — the repo step
   * genuinely reads on mount (`GET /api/concierge/repos`), which is why the
   * total ban below stays scoped to `concierge/` and this narrower rule is
   * what covers the wizard. It is `LaunchPanel.tsx`'s own shape and its own
   * reason: an effect that READS is ordinary; an effect that ACTS is the
   * ruling's "never a collector, never a poll, never a timer".
   */
  it('no useEffect in connect/wizard.tsx ever reaches either act — reads happen there, writes never do', () => {
    const wizard = readFileSync(path.join(WEB_SRC, 'connect', 'wizard.tsx'), 'utf8')
    const effectBodies = [...wizard.matchAll(/useEffect\(([\s\S]*?), \[/g)].map((match) => match[1] ?? '')
    expect(effectBodies.length).toBeGreaterThan(0) // the check below would pass vacuously on an empty sweep
    for (const body of effectBodies) {
      expect(body).not.toMatch(/requestClone|requestInstrument|confirmClone|confirmLaunch/)
    }
    expect(wizard).not.toMatch(SCHEDULING_RE)
  })

  /**
   * Stricter than the sibling law's, deliberately. `LaunchPanel.tsx` has reads
   * of its own to make on mount (checkpoints), so its law can only forbid an
   * effect that *calls the launch*. Nothing under `concierge/` reads anything
   * — the whole directory is one act and its confirmation — so the ban is
   * total: an effect here could only ever be reaching for the act, and there
   * is no legitimate shape of it to carve an exception for.
   */
  it('no useEffect anywhere under concierge/ — this directory acts, it never watches', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} declares an effect`).not.toMatch(USE_EFFECT_RE)
    }
    expect(USE_EFFECT_RE.test('useEffect(() => { void confirmInstrument() }, [])')).toBe(true)
  })

  it('imports no fleet/panel/scene/lab machinery — this is the front door, never a second read of live fleet state', () => {
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_IDENTIFIERS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
      expect(
        forbiddenImportsIn(file.text),
        `${file.name} imports fleet/panel/scene/lab machinery`,
      ).toEqual([])
    }
  })

  it('no computed import specifier under concierge/ — an interpolation ahead of the path would defeat every prefix check in this law', () => {
    for (const file of sourceFiles()) {
      expect(
        computedImportsIn(file.text),
        `${file.name} builds a computed import specifier — no prefix check in this law can vouch for where it lands; name the target statically, or amend this law with a ruling`,
      ).toEqual([])
    }
  })

  it('the detector bites — a forbidden import added tomorrow, at any depth and in any form, would be caught by the path alone', () => {
    // No forbidden identifier in these probes — only deep import paths — so a
    // pass here is the specifier check catching them, not an identifier riding
    // along for free. Rows 2-4 carry no `from` clause at all (bare, dynamic
    // and template-literal), and the last rows are the legal spellings a
    // `\s+`-based matcher was found blind to: no separator, comment trivia.
    const probes: ReadonlyArray<[string, string[]]> = [
      ["import type { FetchLike } from '../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["import '../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["const manifest = await import('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ['const paint = await import(`../scene/paint.js`)', ['../scene/paint.js']],
      ["import '../panels/fleet/format.js'", ['../panels/fleet/format.js']],
      ["import { requestLaunch } from '../lab/launch/launch.js'", ['../lab/launch/launch.js']],
      ["import'../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["const manifest = await import(/* @vite-ignore */ '../fleet/manifest.js')", ['../fleet/manifest.js']],
    ]
    for (const [probe, expected] of probes) {
      expect(forbiddenImportsIn(probe), probe).toEqual(expected)
    }
    // …and the imports this directory legitimately makes are not caught, so
    // the law is refusing a named set rather than everything with a `../`.
    expect(forbiddenImportsIn("import { readCapabilityToken } from '../recordings/capability.js'")).toEqual([])
    expect(forbiddenImportsIn("import { copyToClipboard } from '../drawer/AttachButton.js'")).toEqual([])
  })

  it('the computed detector bites — an interpolation ahead of the policed segment cannot hide behind the prefix checks', () => {
    expect(forbiddenImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual([])
    expect(computedImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual(['${base}/fleet/manifest.js'])
  })
})
