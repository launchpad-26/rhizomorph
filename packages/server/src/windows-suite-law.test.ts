import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * #212's law — the native Windows suite result is a committed list of files,
 * not a number (prd-25 rulings 2 and 3).
 *
 * `.windows-known-failures` at the repo root is an EXPECTED-FAIL list: every
 * entry is reported on every run of the `Windows suite` workflow, a failure
 * outside it turns the job red, and an entry that passes is reported as a
 * removal candidate. A count masks a swap — one fixed, one newly broken, same
 * number — so the comparison `scripts/windows-triage.sh` makes is set
 * difference per file and never a count (ruling 2), and every entry carries one
 * of ruling 3's cause classes so the fixes can be groomed per class rather
 * than per file.
 *
 * Two things a gate depends on, held here:
 *
 *   A. the committed list is honest — one provenance line naming a real commit,
 *      every entry a tracked test file with a known class and an evidence note,
 *      no duplicates, and the classes in its header exactly the ones the
 *      script enforces;
 *   B. the script gives the verdict ruling 2 demands — driven for real with
 *      `spawnSync`, the way `gate-honesty-law.test.ts` drives `scripts/gate.sh`,
 *      against synthetic vitest JSON whose file names are Windows-shaped, so the
 *      normalisation is what is under test.
 *
 * A vitest law rather than a shell test because `scripts/dev/*.test.sh` are
 * hand-run only — nothing in `package.json`, `scripts/gate.sh` or CI invokes
 * them — so a shell test would be a test nobody runs. Lives under
 * `packages/server/` for the reason every sibling law gives: the root vitest
 * config globs `packages/*`, and a root-level test would never run.
 *
 * The parser in section A is deliberately a second, regex-only reading of the
 * list's grammar rather than a call into the script's code: the law and the
 * script are two readings of one contract, and a bug shared by both would be
 * invisible to a law that reused the script's parser.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const LIST_PATH = path.join(REPO_ROOT, '.windows-known-failures')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'windows-triage.sh')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'windows-suite.yml')

/** prd-25 ruling 3's cause classes — six at the ruling, `fs-semantics` by its 2026-09-03 amendment — pinned. */
const RULING_3_CLASSES = ['path-separator', 'drive-letter', 'procfs', 'line-endings', 'process-signalling', 'temp-dir', 'fs-semantics']

const MEASURED_RE = /^# measured: ([0-9a-f]{40}) node (\d+\.\d+\.\d+) windows-latest (\d{4}-\d{2}-\d{2}) (\S+)$/
const ENTRY_RE = /^(\S+)\s+(\S+)(?:\s+#\s*(.*))?$/

interface ListEntry {
  line: number
  file: string
  cls: string
  /** `undefined` when the entry carries no `# evidence:` trailer at all. */
  evidence: string | undefined
}

interface ParsedList {
  measured: string[]
  entries: ListEntry[]
  headerClasses: string[]
}

function parseList(text: string): ParsedList {
  const measured: string[] = []
  const entries: ListEntry[] = []
  const headerClasses: string[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '')
    if (line.length === 0) return
    if (line.startsWith('#')) {
      if (/^# measured:/.test(line)) measured.push(line)
      // The header's class table: exactly three spaces of indent, then the name.
      const cls = line.match(/^# {3}([a-z][a-z-]*) {2,}\S/)?.[1]
      if (cls !== undefined) headerClasses.push(cls)
      return
    }
    const m = ENTRY_RE.exec(line)
    if (m === null) {
      entries.push({ line: index + 1, file: line, cls: '', evidence: undefined })
      return
    }
    const trailer = m[3]
    const evidence = trailer === undefined ? undefined : (trailer.match(/^evidence:\s*(.*)$/)?.[1] ?? '')
    entries.push({ line: index + 1, file: m[1] ?? '', cls: m[2] ?? '', evidence })
  })
  return { measured, entries, headerClasses }
}

/** The class literal the script enforces, read from its source so the two cannot drift. */
function scriptClasses(): string[] {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  const literal = source.match(/const CLASSES = \[([^\]]*)\]/)?.[1]
  if (literal === undefined) throw new Error('scripts/windows-triage.sh no longer declares `const CLASSES = [...]` — the law has nothing to hold the list to')
  return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
}

function isTracked(relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** `git cat-file -e <sha>^{commit}` — exits 0 when the object exists AND is a commit. */
function isRealCommit(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** `git merge-base --is-ancestor <sha> HEAD` — exits 0 when the sha is in HEAD's history, so a foreign or stale-branch sha cannot pose as provenance. */
function isAncestorOfHead(sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function repoIsShallow(): boolean {
  return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === 'true'
}

describe('windows suite law A: the committed expected-fail list is honest (prd-25 ruling 2, #212)', () => {
  const list = parseList(readFileSync(LIST_PATH, 'utf8'))

  it('carries exactly one measured: line, in the grammar, naming a real commit', () => {
    expect(list.measured).toHaveLength(1)
    const m = MEASURED_RE.exec(list.measured[0] ?? '')
    expect(m, `the measured line does not match the grammar: ${list.measured[0]}`).not.toBeNull()
    expect(
      repoIsShallow(),
      'this clone is SHALLOW, so `git cat-file -e <sha>^{commit}` cannot see any sha but the tip — run `git fetch --unshallow`, or restore `fetch-depth: 0` on the suite legs',
    ).toBe(false)
    const sha = m?.[1] ?? ''
    expect(isRealCommit(sha), `measured sha ${sha} is not a commit in this clone`).toBe(true)
    // The header says the sha is the main commit the run was built from; a real
    // commit that is not in this tree's history is not that (review of #212:
    // the first value was a stale main tip the branch had never been based on,
    // and a bare cat-file check accepted it).
    expect(isAncestorOfHead(sha), `measured sha ${sha} is not an ancestor of HEAD — it is not the base this tree was built from`).toBe(true)
  })

  it('every entry is a tracked test file with a known class and a non-empty evidence note free of machine paths', () => {
    const classes = scriptClasses()
    const violations: string[] = []
    for (const entry of list.entries) {
      const at = `.windows-known-failures:${entry.line}`
      if (!/^packages\/.+\.test\.tsx?$/.test(entry.file)) violations.push(`${at}: "${entry.file}" is not a packages/ .test.ts(x) file`)
      if (!isTracked(entry.file)) violations.push(`${at}: "${entry.file}" is not tracked — matched by resolved path, never by prefix`)
      if (!classes.includes(entry.cls)) violations.push(`${at}: class "${entry.cls}" is not one of ruling 3's`)
      if (entry.evidence === undefined) violations.push(`${at}: no evidence note`)
      else if (entry.evidence.trim().length === 0) violations.push(`${at}: empty evidence note`)
      else if (/\/Users\/|\/home\/|C:\\Users|D:\\a\b/.test(entry.evidence)) violations.push(`${at}: evidence carries a runner or home path`)
    }
    expect(violations).toEqual([])
  })

  it('lists no file twice', () => {
    const files = list.entries.map((entry) => entry.file)
    expect(new Set(files).size).toBe(files.length)
  })

  it("the classes in the list's own header are exactly the ones the script enforces, and exactly ruling 3's", () => {
    expect(scriptClasses()).toEqual(RULING_3_CLASSES)
    expect(list.headerClasses).toEqual(RULING_3_CLASSES)
  })

  it('the parser is not vacuous — it reads an entry, its class and its evidence out of a rigged list', () => {
    const rigged = [
      '# header',
      '# measured: 0123456789abcdef0123456789abcdef01234567 node 22.0.0 windows-latest 2026-01-01 https://example.invalid/run',
      '#   alpha-class         something',
      'packages/x/y.test.ts  alpha-class  # evidence: expected a to be b',
      'packages/x/z.test.ts  alpha-class',
      'packages/x/w.test.ts  alpha-class  # not evidence',
    ].join('\n')
    const parsed = parseList(rigged)
    expect(parsed.measured).toHaveLength(1)
    expect(parsed.headerClasses).toEqual(['alpha-class'])
    expect(parsed.entries.map((e) => [e.file, e.cls, e.evidence])).toEqual([
      ['packages/x/y.test.ts', 'alpha-class', 'expected a to be b'],
      ['packages/x/z.test.ts', 'alpha-class', undefined],
      ['packages/x/w.test.ts', 'alpha-class', ''],
    ])
  })
})

// ---------------------------------------------------------------------------
// B. the script, driven for real.
// ---------------------------------------------------------------------------

/** Real tracked files, because the script's tracked check runs against this repo. */
const FILE_A = 'packages/server/src/runbook-delivery-law.test.ts'
const FILE_B = 'packages/server/src/doc-citation-law.test.ts'
const FILE_C = 'packages/server/src/api/route-class-law.test.ts'
const UNTRACKED = 'packages/server/src/not-a-real-file.test.ts'
const FILE_D = 'packages/server/src/gate-honesty-law.test.ts'
const FILE_E = 'packages/server/src/no-personal-paths-law.test.ts'

/** The tracked test-file set the workflow derives — read the same way, so law B's real-size case cannot drift from the job. */
function trackedTestFiles(): string[] {
  return execFileSync('git', ['ls-files', 'packages/*.test.ts', 'packages/*.test.tsx'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Place a synthetic result name the way the script does — either separator, from the last "/packages/". */
function placed(name: string): string {
  const slashed = name.replace(/\\/g, '/')
  const idx = slashed.lastIndexOf('/packages/')
  return idx === -1 ? slashed : slashed.slice(idx + 1)
}

const WIN_ROOT = 'D:\\a\\rhizomorph\\rhizomorph\\'
function winName(file: string): string {
  return WIN_ROOT + file.replace(/\//g, '\\')
}
function posixName(file: string): string {
  return `/Users/operator/rhizomorph/${file}`
}

interface SyntheticResult {
  name: string
  status: 'passed' | 'failed'
  message: string
  assertionResults: Array<{ fullName: string; status: 'passed' | 'failed'; failureMessages: string[] }>
}

function failed(name: string, detail = 'AssertionError: expected 1 to be 2 // Object.is equality'): SyntheticResult {
  return {
    name,
    status: 'failed',
    message: '',
    assertionResults: [
      { fullName: 'suite > passes', status: 'passed', failureMessages: [] },
      { fullName: 'suite > fails on win32', status: 'failed', failureMessages: [`${detail}\n    at somewhere`] },
    ],
  }
}

function passed(name: string): SyntheticResult {
  return { name, status: 'passed', message: '', assertionResults: [{ fullName: 'suite > passes', status: 'passed', failureMessages: [] }] }
}

/** A file vitest could not import: failed, zero assertions, a message. */
function failedToLoad(name: string, message: string): SyntheticResult {
  return { name, status: 'failed', message, assertionResults: [] }
}

const SYNTHETIC_MEASURED = '# measured: 0123456789abcdef0123456789abcdef01234567 node 22.22.2 windows-latest 2026-09-03 https://example.invalid/run'

function syntheticList(entries: Array<[string, string]>, options: { measured?: string | null; evidence?: boolean } = {}): string {
  const lines = ['# synthetic list']
  const measured = options.measured === undefined ? SYNTHETIC_MEASURED : options.measured
  if (measured !== null) lines.push(measured)
  for (const [file, cls] of entries) {
    lines.push(options.evidence === false ? `${file}  ${cls}` : `${file}  ${cls}  # evidence: expected 1 to be 2`)
  }
  return `${lines.join('\n')}\n`
}

interface Verdict {
  status: number | null
  stdout: string
  stderr: string
}

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'windows-triage-law-'))
  scratchDirs.push(dir)
  return dir
}

interface TriageOptions {
  /** The tracked test-file set; when omitted, exactly the files the results and the list already name. */
  tracked?: string[]
  env?: Record<string, string>
}

function triage(results: unknown, list: string, options: TriageOptions = {}): Verdict {
  const dir = scratch()
  const resultsPath = path.join(dir, 'windows-suite.json')
  const listPath = path.join(dir, 'known-failures')
  const trackedPath = path.join(dir, 'tracked')
  writeFileSync(resultsPath, typeof results === 'string' ? results : JSON.stringify({ testResults: results }))
  writeFileSync(listPath, list)
  const tracked = options.tracked ?? deriveTracked(results, list)
  writeFileSync(trackedPath, `${tracked.join('\n')}\n`)
  return triageAt(resultsPath, listPath, trackedPath, options.env)
}

/** The union of every file the results name and every entry path in the list — so an existing case's floor is exactly the files it talks about. */
function deriveTracked(results: unknown, list: string): string[] {
  const files = new Set<string>()
  if (Array.isArray(results)) {
    for (const r of results as SyntheticResult[]) files.add(placed(r.name))
  }
  for (const line of list.split('\n')) {
    const file = line.match(/^(packages\/\S+)\s/)?.[1]
    if (file !== undefined) files.add(file)
  }
  return [...files]
}

function triageAt(resultsPath: string, listPath: string, trackedPath: string, extraEnv: Record<string, string> = {}): Verdict {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GITHUB_STEP_SUMMARY
  Object.assign(env, extraEnv)
  const run = spawnSync('bash', [SCRIPT_PATH, resultsPath, listPath, trackedPath], { cwd: REPO_ROOT, encoding: 'utf8', env })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function summaryLine(stdout: string): string {
  return stdout.split('\n').find((line) => line.startsWith('windows-triage:')) ?? ''
}

describe('windows suite law B: the triage compares per file, never by count (prd-25 ruling 2, #212)', () => {
  it('happy: every failing file is listed — GREEN, and every entry is still printed', () => {
    const v = triage([failed(winName(FILE_A)), failed(winName(FILE_B))], syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']]))
    expect(v.status, v.stdout + v.stderr).toBe(0)
    expect(v.stdout).toContain(`expected, still failing [path-separator]: ${FILE_A}`)
    expect(v.stdout).toContain(`expected, still failing [line-endings]: ${FILE_B}`)
    expect(v.stdout).not.toContain('UNEXPECTED')
    expect(summaryLine(v.stdout)).toBe('windows-triage: 0 unexpected · 2 expected · 0 removal candidates · 0 listed-not-run · 0 unevaluated · verdict GREEN')
  })

  it('a failure outside the list is RED, named, with its first failing assertion', () => {
    const v = triage(
      [failed(winName(FILE_A)), failed(winName(FILE_B)), failed(winName(FILE_C), 'Error: spawn /bin/sh ENOENT')],
      syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']]),
    )
    expect(v.status).toBe(1)
    const unexpected = v.stdout.split('\n').filter((line) => line.startsWith('UNEXPECTED FAILURE'))
    expect(unexpected).toEqual([`UNEXPECTED FAILURE (not on .windows-known-failures): ${FILE_C}`])
    expect(v.stdout).toContain('suite > fails on win32 — Error: spawn /bin/sh ENOENT')
    expect(summaryLine(v.stdout)).toContain('1 unexpected · 2 expected')
    expect(summaryLine(v.stdout)).toContain('verdict RED')
  })

  it("a swap keeps the count and still goes RED — ruling 2's mutation", () => {
    // One listed file fixed, one unlisted file newly broken: |F| === |L| === 1.
    const v = triage([passed(winName(FILE_A)), failed(winName(FILE_C))], syntheticList([[FILE_A, 'temp-dir']]))
    expect(v.status).toBe(1)
    expect(v.stdout).toContain(`UNEXPECTED FAILURE (not on .windows-known-failures): ${FILE_C}`)
    expect(v.stdout).toContain(`CANDIDATE FOR REMOVAL (listed, now passes): ${FILE_A}`)
    expect(summaryLine(v.stdout)).toBe('windows-triage: 1 unexpected · 0 expected · 1 removal candidates · 0 listed-not-run · 0 unevaluated · verdict RED')
  })

  it('a listed file that now passes is a removal candidate, not RED', () => {
    const v = triage([failed(winName(FILE_A)), passed(winName(FILE_B))], syntheticList([[FILE_A, 'procfs'], [FILE_B, 'drive-letter']]))
    expect(v.status, v.stdout + v.stderr).toBe(0)
    expect(v.stdout).toContain(`CANDIDATE FOR REMOVAL (listed, now passes): ${FILE_B}`)
    expect(v.stdout).toContain(`expected, still failing [procfs]: ${FILE_A}`)
    expect(summaryLine(v.stdout)).toContain('1 removal candidates · 0 listed-not-run · 0 unevaluated · verdict GREEN')
  })

  it('a listed file the suite never ran is RED — a list may not claim a file the suite did not evaluate', () => {
    const v = triage([failed(winName(FILE_A))], syntheticList([[FILE_A, 'procfs'], [FILE_B, 'drive-letter']]))
    expect(v.status).toBe(1)
    expect(v.stdout).toContain(`listed but not run: ${FILE_B}`)
    expect(summaryLine(v.stdout)).toContain('1 listed-not-run · 0 unevaluated · verdict RED')
  })

  it('a file that failed to LOAD counts as failing, and its message is printed', () => {
    const v = triage([failedToLoad(winName(FILE_A), "Cannot find module './does-not-exist' imported from x.test.ts\n  at load")], syntheticList([]))
    expect(v.status).toBe(1)
    expect(v.stdout).toContain(`UNEXPECTED FAILURE (not on .windows-known-failures): ${FILE_A}`)
    expect(v.stdout).toContain("Cannot find module './does-not-exist' imported from x.test.ts")
    expect(v.stdout).not.toContain('at load')
  })

  it('missing results are RED — a run that crashed before writing results never reads as clean', () => {
    const dir = scratch()
    const listPath = path.join(dir, 'known-failures')
    writeFileSync(listPath, syntheticList([]))
    const trackedPath = path.join(dir, 'tracked')
    writeFileSync(trackedPath, `${FILE_A}\n`)
    const v = triageAt(path.join(dir, 'never-written.json'), listPath, trackedPath)
    expect(v.status).toBe(1)
    expect(v.stdout).toContain('no vitest results at')
    expect(summaryLine(v.stdout)).toContain('verdict RED')
  })

  it('malformed results are RED', () => {
    const v = triage('{', syntheticList([]))
    expect(v.status).toBe(1)
    expect(v.stdout).toContain('are not JSON')
    const v2 = triage('{"success": true}', syntheticList([]))
    expect(v2.status).toBe(1)
    expect(v2.stdout).toContain('no testResults array')
  })

  describe('a list that fails its own grammar is rejected before anything is compared', () => {
    const results = [failed(winName(FILE_A))]
    const nothingCompared = (v: Verdict, expectedText: string) => {
      expect(v.status).toBe(1)
      expect(v.stdout).toContain('list rejected')
      expect(v.stdout).toContain(expectedText)
      expect(v.stdout).not.toContain('expected, still failing')
      expect(v.stdout).not.toContain('UNEXPECTED FAILURE')
    }

    it('no measured: line', () => {
      nothingCompared(triage(results, syntheticList([[FILE_A, 'path-separator']], { measured: null })), 'expected exactly one "# measured:" line, found 0')
    })

    it('a malformed measured: line', () => {
      nothingCompared(
        triage(results, syntheticList([[FILE_A, 'path-separator']], { measured: '# measured: abc node 22 windows-latest yesterday' })),
        'malformed measured line',
      )
    })

    it('an unknown class', () => {
      nothingCompared(triage(results, syntheticList([[FILE_A, 'flaky']])), '"flaky" is not one of prd-25 ruling 3\'s cause classes')
    })

    it('an entry with no evidence', () => {
      nothingCompared(triage(results, syntheticList([[FILE_A, 'path-separator']], { evidence: false })), 'no evidence note')
    })

    it('an untracked path — matched by resolved path, never by the directory the real entries share', () => {
      nothingCompared(triage(results, syntheticList([[UNTRACKED, 'path-separator']])), `"${UNTRACKED}" is not a tracked file`)
    })

    it('a duplicate path', () => {
      nothingCompared(triage(results, syntheticList([[FILE_A, 'path-separator'], [FILE_A, 'temp-dir']])), `"${FILE_A}" is listed twice`)
    })
  })

  it('POSIX-shaped result names are read too — both separators reach the same repo-relative file', () => {
    const v = triage([failed(posixName(FILE_A)), failed(posixName(FILE_B))], syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']]))
    expect(v.status, v.stdout + v.stderr).toBe(0)
    expect(summaryLine(v.stdout)).toContain('0 unexpected · 2 expected')
  })

  it('a result name with no packages/ segment is RED — the script cannot place it and says so', () => {
    // An explicit floor: the derived one would be the unplaceable name itself,
    // which the set's own validation rejects before placement is reached.
    const v = triage([failed('D:\\a\\repo\\other\\x.test.ts')], syntheticList([]), { tracked: [FILE_A] })
    expect(v.status).toBe(1)
    expect(v.stdout).toContain('cannot place result')
    expect(v.stdout).toContain('other\\x.test.ts')
  })

  it('is pure — the same inputs give the same output and exit, three runs over', () => {
    const results = [failed(winName(FILE_A)), failed(winName(FILE_B))]
    const list = syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']])
    const first = triage(results, list, { tracked: [FILE_A, FILE_B, FILE_C] })
    for (let i = 0; i < 2; i += 1) {
      const again = triage(results, list, { tracked: [FILE_A, FILE_B, FILE_C] })
      expect(again.status).toBe(first.status)
      expect(again.stdout).toBe(first.stdout)
    }
  })

  it('writes the job-page summary when GITHUB_STEP_SUMMARY is set, and nowhere otherwise', () => {
    const dir = scratch()
    const summaryPath = path.join(dir, 'summary.md')
    const v = triage(
      [failed(winName(FILE_A)), passed(winName(FILE_B))],
      syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']]),
      { env: { GITHUB_STEP_SUMMARY: summaryPath } },
    )
    expect(v.status, v.stdout + v.stderr).toBe(0)
    const summary = readFileSync(summaryPath, 'utf8')
    expect(summary).toContain('measured: 0123456789abcdef0123456789abcdef01234567 node 22.22.2 windows-latest 2026-09-03')
    expect(summary).toContain(`- \`${FILE_A}\` [path-separator]`)
    expect(summary).toContain(`- \`${FILE_B}\` [line-endings]`)
    expect(summary).toMatch(/## Windows suite triage — GREEN/)
    expect(summary).toContain('### Tracked test files with no result — RED (0)')
  })

  it('the job-page summary carries the fifth section, naming each tracked file with no result (#252)', () => {
    const dir = scratch()
    const summaryPath = path.join(dir, 'summary.md')
    const v = triage(
      [failed(winName(FILE_A)), failed(winName(FILE_B))],
      syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']]),
      { tracked: [FILE_A, FILE_B, FILE_D], env: { GITHUB_STEP_SUMMARY: summaryPath } },
    )
    expect(v.status).toBe(1)
    const summary = readFileSync(summaryPath, 'utf8')
    expect(summary).toMatch(/## Windows suite triage — RED/)
    expect(summary).toContain('### Tracked test files with no result — RED (1)')
    expect(summary).toContain(`- \`${FILE_D}\``)
  })

  describe('a GREEN verdict proves the suite ran — the tracked test-file set is the floor (prd-25 ruling 2, #252)', () => {
    it('a tracked test file with no result is RED, and each one is named', () => {
      const v = triage(
        [failed(winName(FILE_A)), failed(winName(FILE_B)), passed(winName(FILE_C))],
        syntheticList([[FILE_A, 'path-separator'], [FILE_B, 'line-endings']]),
        { tracked: [FILE_A, FILE_B, FILE_C, FILE_D, FILE_E] },
      )
      expect(v.status).toBe(1)
      expect(v.stdout).toContain(`tracked test file with no result: ${FILE_D}`)
      expect(v.stdout).toContain(`tracked test file with no result: ${FILE_E}`)
      expect(v.stdout).not.toContain('UNEXPECTED')
      expect(summaryLine(v.stdout)).toContain('2 unevaluated · verdict RED')
    })

    it('a listed file absent from results is named once, as listed-but-not-run, never twice', () => {
      const v = triage([failed(winName(FILE_A))], syntheticList([[FILE_A, 'procfs'], [FILE_B, 'drive-letter']]), { tracked: [FILE_A, FILE_B] })
      expect(v.status).toBe(1)
      const naming = v.stdout.split('\n').filter((line) => line.includes(FILE_B))
      expect(naming).toHaveLength(1)
      expect(naming[0]).toContain('listed but not run')
      expect(v.stdout).not.toContain('tracked test file with no result')
      expect(summaryLine(v.stdout)).toContain('1 listed-not-run · 0 unevaluated')
    })

    it('GREEN is reachable at the real size — every tracked test file, Windows-shaped, passing', () => {
      const tracked = trackedTestFiles()
      expect(tracked.length, 'a broken pathspec would make this case vacuous').toBeGreaterThan(300)
      expect(tracked.some((f) => f.endsWith('.test.tsx')), 'the .tsx half of the set must be present').toBe(true)
      const v = triage(tracked.map((f) => passed(winName(f))), syntheticList([]), { tracked })
      expect(v.status, v.stdout + v.stderr).toBe(0)
      expect(summaryLine(v.stdout)).toBe('windows-triage: 0 unexpected · 0 expected · 0 removal candidates · 0 listed-not-run · 0 unevaluated · verdict GREEN')
    })

    it('the same real set with three results deleted is RED naming exactly those three — a count floor would pass a swap', () => {
      const tracked = trackedTestFiles()
      const firstTsx = tracked.find((f) => f.endsWith('.test.tsx')) ?? ''
      const dropped = [tracked[0] ?? '', tracked[tracked.length - 1] ?? '', firstTsx]
      expect(new Set(dropped).size).toBe(3)
      const results = tracked.filter((f) => !dropped.includes(f)).map((f) => passed(winName(f)))
      const v = triage(results, syntheticList([]), { tracked })
      expect(v.status).toBe(1)
      const named = v.stdout
        .split('\n')
        .filter((line) => line.startsWith('RED: tracked test file with no result: '))
        .map((line) => line.replace('RED: tracked test file with no result: ', '').split(' — ')[0] ?? '')
      expect(named.sort()).toEqual([...dropped].sort())
      expect(summaryLine(v.stdout)).toContain('3 unevaluated · verdict RED')
    })

    it('a missing tracked set is RED and nothing is compared', () => {
      const dir = scratch()
      const resultsPath = path.join(dir, 'windows-suite.json')
      const listPath = path.join(dir, 'known-failures')
      writeFileSync(resultsPath, JSON.stringify({ testResults: [failed(winName(FILE_A))] }))
      writeFileSync(listPath, syntheticList([[FILE_A, 'path-separator']]))
      const v = triageAt(resultsPath, listPath, path.join(dir, 'never-written'))
      expect(v.status).toBe(1)
      expect(v.stdout).toContain('no tracked test-file set')
      expect(v.stdout).not.toContain('expected, still failing')
    })

    it('an empty tracked set is RED', () => {
      const v = triage([failed(winName(FILE_A))], syntheticList([[FILE_A, 'path-separator']]), { tracked: ['# nothing', '# here'] })
      expect(v.status).toBe(1)
      expect(v.stdout).toContain('is empty')
    })

    it('a non-test path in the set is RED', () => {
      const v = triage([failed(winName(FILE_A))], syntheticList([[FILE_A, 'path-separator']]), { tracked: [FILE_A, 'packages/server/src/index.ts'] })
      expect(v.status).toBe(1)
      expect(v.stdout).toContain('is not a packages/ test file')
    })
  })
})

describe('windows suite law C: the workflow has the shape the README row claims (#212)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

  it('runs on windows-latest with full history and a bounded timeout', () => {
    expect(workflow).toMatch(/runs-on: windows-latest/)
    expect(workflow).toMatch(/fetch-depth: 0/)
    expect(workflow).toMatch(/timeout-minutes: \d+/)
  })

  /** The text of one step, from its `- name:` to the next step's. */
  function stepBlock(text: string, namePrefix: string): string {
    const steps = text.split(/\n(?= {6}- name: )/)
    const block = steps.find((s) => s.trimStart().startsWith(`- name: ${namePrefix}`))
    if (block === undefined) throw new Error(`windows-suite.yml has no step named "${namePrefix}…"`)
    return block
  }

  it('the suite step defers its verdict — continue-on-error on THAT step, JSON results written for the triage', () => {
    // Scoped to the step, not the file: moved onto the triage step, the same
    // line would make the only step allowed to fail unable to fail, and the
    // job permanently green whatever the list says (review of #212).
    const suite = stepBlock(workflow, 'Suite')
    expect(suite).toMatch(/continue-on-error: true/)
    expect(suite).toMatch(/--reporter=json --outputFile\.json=windows-suite\.json/)
    expect(stepBlock(workflow, 'Triage')).not.toMatch(/continue-on-error/)
  })

  it('the triage step compares those results against the committed list, held to the tracked test-file floor (#252)', () => {
    expect(stepBlock(workflow, 'Tracked test files')).toContain("run: git ls-files 'packages/*.test.ts' 'packages/*.test.tsx' > windows-suite.tracked")
    expect(stepBlock(workflow, 'Triage')).toContain('bash scripts/windows-triage.sh windows-suite.json .windows-known-failures windows-suite.tracked')
    expect(stepBlock(workflow, 'Upload results')).toContain('windows-suite.tracked')
  })

  /** The text of one top-level key's block, from `key:` to the next top-level key. */
  function topLevelBlock(text: string, key: string): string {
    const blocks = text.split(/\n(?=\S)/)
    const block = blocks.find((b) => b.startsWith(`${key}:`))
    if (block === undefined) throw new Error(`windows-suite.yml has no top-level "${key}:" block`)
    return block
  }

  /**
   * The trigger checks, over any rendering of the workflow text. Anchored at
   * line start with the exact indent: a trigger moved into a comment
   * ("  # pull_request:") does not satisfy it, and branches: [main] is read
   * under push:, not anywhere in the file. Line endings are `\r?\n` because Git
   * for Windows checks the workflow out CRLF and this law runs on that runner
   * — the first version of this case anchored on a bare \n and was the one
   * unexpected failure on the wave PR's Windows run (#253).
   */
  function assertTriggers(text: string): void {
    const on = topLevelBlock(text, 'on')
    expect(on).toMatch(/^ {2}pull_request:\r?$/m)
    expect(on).toMatch(/^ {2}push:\r?\n {4}branches: \[main\]\r?$/m)
    // "Every push" also means unfiltered: a paths/paths-ignore/branches-ignore
    // or types filter under either trigger narrows the job while both keys
    // stay present (review of #252).
    expect(on).not.toMatch(/^ {4}(paths|paths-ignore|branches-ignore|types):/m)
  }

  it('runs on every pull request and on every push to main — the "every push" the README and AGENTS.md claim (#252)', () => {
    assertTriggers(workflow)
  })

  it('reads the workflow the way Git for Windows checks it out — CRLF — and still holds every shape above (#253)', () => {
    const crlf = workflow.replace(/\r?\n/g, '\r\n')
    expect(crlf).toContain('\r\n')
    assertTriggers(crlf)
    expect(stepBlock(crlf, 'Suite')).toMatch(/continue-on-error: true/)
    expect(stepBlock(crlf, 'Triage')).not.toMatch(/continue-on-error/)
    expect(stepBlock(crlf, 'Tracked test files')).toContain("run: git ls-files 'packages/*.test.ts' 'packages/*.test.tsx' > windows-suite.tracked")
  })

  it("never mentions a Linux-userland Windows — the same rule route-class-law holds every workflow to, named here so the failure names this file", () => {
    expect(workflow).not.toMatch(/\bwsl/i)
  })
})
