import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_COMMANDS } from '../sessionlog/process-probe.js'
import { DECLARED_HARNESSES, IMPLEMENTED_HARNESS_IDS } from '../../harness-roster.js'

/**
 * THE PROCESS COLLECTOR'S LAW — landed before the collector's first source
 * file, which is ADR-0019 clause 7's precedent applied to a collector rather
 * than to a hand (prd-57 ruling 2). The point of the ordering is that the fence
 * is fixed before anything is built inside it, never fitted around whatever got
 * built.
 *
 * ## Why this file is not vacuous today, even though the directory is empty
 *
 * A law whose only assertion is "every source file here is clean" passes on an
 * empty directory, and would go on passing while someone wrote a collector that
 * signalled every process on the machine. That is the exact shape this repo
 * calls a test that cannot fail for the reason it claims.
 *
 * So the detector is a pure function, and it is exercised on RIGGED INPUT in
 * every run: {@link forbiddenIdiomsIn} is shown to bite on each idiom it bans
 * and to pass on clean text, whether or not a single real source file exists.
 * The sweep over real files is then a third assertion on top of a detector that
 * has already been proved to work — the same shape `doc-citation-law.test.ts`
 * and `scene/tripwire-law.test.ts` both use.
 *
 * ## What is banned here, and what deliberately is NOT
 *
 * `collectors/sessionlog/process-probe.test.ts` bans `spawn`, `execFile`,
 * `child_process` and `exec(` — but **in one file only**, its own probe's
 * source (its `SOURCE` const reads `./process-probe.ts` and nothing else). Its
 * directory-wide law bans filesystem WRITES, never a subprocess.
 *
 * That asymmetry is load-bearing and this law reproduces it deliberately rather
 * than copying the stricter half. prd-57 ruling 2 puts the macOS and Windows
 * legs behind base-system reads — `ps`, `lsof`, `Get-CimInstance` — through
 * ADR-0004's injected `Exec`. A directory-wide subprocess ban here would
 * forbid the very legs this collector exists to make possible, while adding
 * nothing: a subprocess is not what the constitution objects to. **Reaching AT
 * the observed process is.**
 *
 * So the ban here is: no signal of any kind, no filesystem write, and no read
 * of another process's environment. A subprocess that READS the process table
 * is admitted, and ADR-0052's never-signal clause is what the first of those
 * enforces.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Every idiom this directory may not name, with the reason it is banned rather
 * than merely discouraged. Kept as data so the bite tests below can walk it and
 * a new entry cannot be added without a fixture proving it fires.
 */
const FORBIDDEN: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  // ADR-0052: the observer never signals a process. `process.kill(pid, 0)` is
  // the usual POSIX liveness idiom and is refused for the reason the probe
  // already gives — it is a call AT the process, and a recycled pid answers it
  // happily.
  { pattern: /\.kill\(/, why: 'sends a signal — ADR-0052 forbids the observer any signal, including 0' },
  // ANY signal through a shell, not just 0. The review of #553 round 2 ran
  // `execSync('kill -9 <pid>')` against this list and it walked straight past a
  // law whose own comment says "ADR-0052 forbids the observer any signal,
  // including 0" — the pattern matched exactly the one signal the comment names
  // as the *least* of them. `.kill(` covers the node API; these cover the shell.
  { pattern: /\bkill\s+-\w+/, why: 'sends a signal through a shell — ADR-0052 forbids the observer any signal' },
  { pattern: /\bkill\s+[$`'"(\d]/, why: 'a bare `kill <pid>` is SIGTERM through a shell — the same ban' },
  { pattern: /\bpkill\b/, why: 'signals by name through a shell — the same ban, by a different selector' },
  // Windows has its own spelling, and this repo now ships a Windows leg.
  { pattern: /\btaskkill\b/, why: 'the Windows spelling of the same ban' },
  { pattern: /\bSIGSTOP\b/, why: 'names a signal' },
  { pattern: /\bSIGKILL\b/, why: 'names a signal' },
  { pattern: /\bSIGTERM\b/, why: 'names a signal' },
  // ADR-0001's constitution, unchanged by ADR-0052: the observer writes
  // nothing. A collector that cached to disk would be a write outside every
  // hand's grant.
  //
  // `(?:Sync)?` on each, found by the review of #553. A trailing `\b` after
  // `writeFile` lets `writeFileSync` straight through, and that is not academic:
  // `packages/server/src/log/installation-id.ts` — landed in this same wave —
  // uses `mkdirSync` and `writeFileSync`, so the sync spelling is the idiom a
  // collector author working in this repo would reach for first. The rigged
  // cases below exercise both spellings, so the closure is asserted rather than
  // assumed. `collectors/sessionlog/process-probe.test.ts` shares the hole and
  // is a separate file with its own law; it wants its own issue, not a
  // widening from here.
  { pattern: /\bwriteFile(?:Sync)?\b/, why: 'writes to disk — no hand grants this collector a write' },
  { pattern: /\bappendFile(?:Sync)?\b/, why: 'writes to disk' },
  { pattern: /\bcreateWriteStream\b/, why: 'writes to disk' },
  { pattern: /\bmkdir(?:Sync)?\b/, why: 'creates a directory — creating your own input is one step from writing into it' },
  { pattern: /\bunlink(?:Sync)?\b/, why: 'deletes' },
  { pattern: /\brmdir(?:Sync)?\b/, why: 'deletes' },
  // prd-57's non-goals: never any environment variable of any process. A
  // command line can carry a prompt; an environment can carry a key.
  // `process.env` is this process's own and is not what this bans — reading
  // /proc/<pid>/environ is.
  { pattern: /\benviron\b/, why: "reads another process's environment — never an event field, never read at all" },
]

/**
 * Comments stripped before the sweep — the shape
 * `concierge/harness/harness-law.test.ts:33` already uses for its own
 * source law, and for the same reason.
 *
 * A law nobody can DESCRIBE inside the file it governs is a trap: the first
 * writer to document the ban trips it, and the second works around the law
 * instead. `read-table.ts`'s doc comment is the live case — it explains what
 * may not be read, by naming it. A comment cannot reach a process, so the
 * narrowing costs nothing real, and the fixture below proves it does not hide
 * an idiom that merely shares a line with one.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Pure, and exercised on rigged input below, so the sweep is never the only thing holding this. */
export function forbiddenIdiomsIn(source: string): string[] {
  const code = codeOf(source)
  return FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ pattern }) => String(pattern))
}

/**
 * THE WRITE BAN'S SECOND LAYER, AND THE ONE THAT ACTUALLY HOLDS IT — an
 * ALLOWLIST over what this directory may import from `node:fs`.
 *
 * ## Why the list above cannot do this job, proven rather than argued
 *
 * The review of #553 ran eleven write and delete spellings against
 * {@link forbiddenIdiomsIn} and **ten of them passed the ban**: `rm`, `rmSync`,
 * `cpSync`, `copyFileSync`, `renameSync`, `openSync`+`writeSync`,
 * `truncateSync`, `mkdtempSync`, and two shell kills. Two of those are not
 * exotic alternatives — they are the PRIMARY spellings. `rm`/`rmSync` is the
 * API that deprecated the `rmdir` this list does ban, so a collector clearing a
 * cache directory reaches for it first and for `rmdir` never.
 *
 * The obvious patch is more names. It does not work, and the reason is the
 * reason this second layer exists instead: `\brename\b` and `\btruncate\b` are
 * ordinary English, this law reads whole source files with their comments, and
 * `openSync(p, 'w')` is distinguished from `openSync(p, 'r')` by an argument
 * rather than by a name. A denylist over prose cannot separate those; it can
 * only grow until it is either porous or noisy.
 *
 * **So this bans the class at the boundary every one of them must cross.** Every
 * write, delete, copy, rename and truncate in Node comes out of `node:fs` or
 * `node:fs/promises`, and an import is a declaration rather than prose — it
 * cannot appear in a comment and mean something else. A name absent from
 * {@link READ_ONLY_FS} is refused whether or not anyone listed it, which is the
 * property a denylist can never have.
 *
 * **This is not a new idea in this repo — it is the sibling law's shape.**
 * `collectors/sessionlog/process-probe.ts` is already pinned to *"exactly three
 * filesystem imports"*, which is cited in this PRD as the reason that file
 * could not delegate to this collector even if we wanted it to. Adopting it
 * here is the third time this wave that the fix was to draw the boundary around
 * the CLASS rather than around the names, after the collector roster literal
 * and `.symbol-citation-baseline`.
 *
 * The name list above is kept as the outer layer: it still catches a
 * `fs.writeFileSync` reached through something this one cannot see.
 */
const READ_ONLY_FS: ReadonlySet<string> = new Set([
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'readlink',
  'readlinkSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'realpath',
  'realpathSync',
  'access',
  'accessSync',
  'existsSync',
  'constants',
])

/** `import … from 'node:fs'` / `'node:fs/promises'`, in every form that binds a name. */
const FS_IMPORT_RE = /import\s+(?:type\s+)?([^'"]+?)\s+from\s+['"]node:fs(?:\/promises)?['"]/g

/**
 * Every fs binding this directory takes that is not provably read-only.
 *
 * A namespace or default import (`import * as fs`, `import fs`) is refused
 * outright and not inspected further: it binds the whole module, so the
 * allowlist has nothing to check and `fs.writeFileSync(…)` is one property
 * access away. That is the hole a named-import allowlist would otherwise have,
 * and closing it is what makes this layer load-bearing rather than advisory.
 */
export function forbiddenFsImportsIn(source: string): string[] {
  const offenders: string[] = []
  for (const match of source.matchAll(FS_IMPORT_RE)) {
    const clause = (match[1] ?? '').trim()
    if (!clause.startsWith('{')) {
      offenders.push(`${clause} (a namespace or default fs import binds every writer in the module)`)
      continue
    }
    for (const raw of clause.replace(/[{}]/g, '').split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim()
      if (name === undefined || name.length === 0) continue
      if (!READ_ONLY_FS.has(name)) offenders.push(name)
    }
  }
  return offenders
}

/** Non-test TypeScript in this directory. Empty today; wave 2 is what fills it. */
function collectorSources(): { name: string; text: string }[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(path.join(HERE, name), 'utf8') }))
}

describe('the process collector may look at the table and may not reach the process (prd-57 ruling 2, ADR-0052)', () => {
  it('the detector bites on every idiom it bans — rigged input, so this holds with no source files at all', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['process.kill(pid, 0)', '/\\.kill\\(/'],
      // Was pinned to `/\bkill\s+-0\b/`, which matched exactly the one signal
      // this law's own comment calls the LEAST of them. Widened in the review of
      // #553 round 2, and this line is how the widening was noticed — the bite
      // test pins the pattern, so changing it here is a deliberate act.
      ['await exec("kill -0 " + pid)', '/\\bkill\\s+-\\w+/'],
      ['process.kill(pid, "SIGSTOP")', '/\\bSIGSTOP\\b/'],
      ['await writeFile(cachePath, json)', '/\\bwriteFile(?:Sync)?\\b/'],
      ['await mkdir(dir, { recursive: true })', '/\\bmkdir(?:Sync)?\\b/'],
      ['readFile(`/proc/${pid}/environ`)', '/\\benviron\\b/'],
      // The SYNC spellings. Every one of these passed the detector until the
      // review of #553, and `installation-id.ts` in this same wave uses two of
      // them — so this is the spelling a collector author here reaches for.
      ['writeFileSync(cachePath, json)', '/\\bwriteFile(?:Sync)?\\b/'],
      ['mkdirSync(dir, { recursive: true })', '/\\bmkdir(?:Sync)?\\b/'],
      ['appendFileSync(logPath, line)', '/\\bappendFile(?:Sync)?\\b/'],
      ['unlinkSync(stalePath)', '/\\bunlink(?:Sync)?\\b/'],
      ['rmdirSync(dir)', '/\\brmdir(?:Sync)?\\b/'],
    ]
    for (const [source, expected] of cases) {
      expect(forbiddenIdiomsIn(source), `"${source}" should have been caught`).toContain(expected)
    }
  })

  it('the detector passes the reads this collector is FOR — a ban that caught them would be useless', () => {
    // Every one of these is something ruling 2 explicitly admits: the /proc
    // reads on Linux, and the base-system reads the macOS and Windows legs are
    // named for. A detector that reddened on these would forbid the collector.
    const admitted = [
      "const entries = await readdir('/proc')",
      "const cwd = await readlink(`/proc/${pid}/cwd`)",
      "const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8')",
      "await exec('ps', ['-axo', 'pid=,command='])",
      "await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])",
      "await exec('powershell', ['-Command', 'Get-CimInstance Win32_Process'])",
      'const timeout = options.timeoutMs ?? DEFAULT',
    ]
    for (const source of admitted) {
      expect(forbiddenIdiomsIn(source), `"${source}" is admitted by ruling 2 and must not be caught`).toEqual([])
    }
  })

  it('prose about the ban is not the ban — but an idiom SHARING A LINE with a comment still is', () => {
    // Both halves matter. The first is why `codeOf` exists at all; the second
    // is the hole a careless stripper would open, and it is the one worth
    // pinning, because `// harmless` at the end of a real call is exactly how
    // someone would smuggle one past a line-based filter.
    expect(forbiddenIdiomsIn('// never call process.kill(pid, 0) here')).toEqual([])
    expect(forbiddenIdiomsIn('/** SIGTERM is refused, see ADR-0052 */')).toEqual([])
    expect(forbiddenIdiomsIn('process.kill(pid, 0) // harmless, honest')).toContain('/\\.kill\\(/')
  })

  it('a subprocess is NOT banned here, and that is deliberate — the probe bans one in its own file only', () => {
    // If this ever starts failing, someone has copied
    // `process-probe.test.ts`'s subprocess ban across. Read this file's own doc
    // comment first: that ban is scoped to one file, and reproducing it here
    // would forbid the macOS and Windows legs prd-57 ruling 2 names.
    expect(forbiddenIdiomsIn("const out = await execFile('ps', args)")).toEqual([])
    expect(forbiddenIdiomsIn("import { spawn } from 'node:child_process'")).toEqual([])
  })

  it('every source file in this directory is clean, however many there are', () => {
    const sources = collectorSources()
    // Deliberately NOT `toBeGreaterThan(0)`. The directory is empty until wave
    // 2, and a guard that demanded sources would fail this law on the very
    // commit that lands it.
    //
    // This test was named "stating the count, so an empty sweep is visible
    // rather than silent" and it did not do that — vitest prints an assertion
    // message only when the assertion FAILS, so on the green run the name was
    // describing, the count is printed nowhere (review of #553). The reasoning
    // for dropping the guard is unchanged and right; the name overclaimed what
    // replaced it, so the name went rather than the reasoning.
    const offenders = sources
      .map(({ name, text }) => ({ name, hits: forbiddenIdiomsIn(text) }))
      .filter(({ hits }) => hits.length > 0)
    expect(offenders, `swept ${sources.length} source file(s) in ${path.basename(HERE)}/`).toEqual([])
  })
})

describe('the signature set is roster ids, never a list of its own (prd-57 ruling 2)', () => {
  /**
   * Ruling 2 keeps two sets apart on purpose. The roster's `command` field
   * exists only on its NOT-implemented entries, and two of its three values are
   * `null` — so "derive the signatures from the roster" is not a set that
   * exists, and `harness-roster.ts`'s own comment shows the borrowing running
   * the other way: it cites the probe's `AGENT_COMMANDS` as the one thing this
   * repo records about pi.
   *
   * What CAN be checked, and is checked here, is membership: every signature
   * names a harness this instrument knows the name of. That holds today against
   * the probe's set, and wave 2's collector list is held to the same assertion
   * when it lands.
   */
  const rosterIds = new Set<string>([...IMPLEMENTED_HARNESS_IDS, ...DECLARED_HARNESSES.map((entry) => entry.id)])

  it('the roster is non-empty and names more than the signatures do — otherwise the check below is trivially true', () => {
    expect(rosterIds.size).toBeGreaterThan(AGENT_COMMANDS.length)
  })

  it('every agent signature is a harness the roster names', () => {
    const strangers = AGENT_COMMANDS.filter((command) => !rosterIds.has(command))
    expect(strangers, `signature(s) naming no harness in the roster: ${strangers.join(', ')}`).toEqual([])
  })

  it('bites — a signature for a harness nobody declared is named, not waved through', () => {
    const invented = ['claude', 'definitely-not-a-harness']
    expect(invented.filter((command) => !rosterIds.has(command))).toEqual(['definitely-not-a-harness'])
  })
})

describe('the write ban is a CLASS, not a list of spellings (review of #553 round 2)', () => {
  /**
   * The eleven spellings the review ran against {@link forbiddenIdiomsIn}.
   * **Ten of them passed the ban**, and two were not exotic alternatives but
   * the primary form: `rm`/`rmSync` is the API that deprecated the `rmdir` the
   * name list bans, and `kill -9` walked past a pattern matching only `kill -0`
   * under a comment reading "any signal, including 0".
   *
   * Each case below is the exact source line the review ran. They are asserted
   * against the real exported functions, and the assertion is that SOMETHING
   * catches each — the name list or the import allowlist. Which layer does the
   * catching is deliberately not asserted: that is an implementation detail of
   * the fence, and pinning it would make a later improvement look like a break.
   */
  const caughtBy = (source: string): string[] => [...forbiddenIdiomsIn(source), ...forbiddenFsImportsIn(source)]

  it.each([
    ["import { rm } from 'node:fs/promises'\nawait rm(dir, { recursive: true, force: true })", 'rm'],
    ["import { rmSync } from 'node:fs'\nrmSync(cachePath, { force: true })", 'rmSync'],
    ["import { cpSync } from 'node:fs'\ncpSync(src, dst)", 'cpSync'],
    ["import { copyFileSync } from 'node:fs'\ncopyFileSync(src, dst)", 'copyFileSync'],
    ["import { renameSync } from 'node:fs'\nrenameSync(tmp, final)", 'renameSync'],
    ["import { openSync, writeSync } from 'node:fs'\nconst fd = openSync(cachePath, 'w')", 'openSync + writeSync'],
    ["import { truncateSync } from 'node:fs'\ntruncateSync(cachePath, 0)", 'truncateSync'],
    ["import { mkdtempSync } from 'node:fs'\nmkdtempSync(path.join(tmpdir(), 'proc-'))", 'mkdtempSync'],
    ["import { writeFileSync } from 'node:fs'\nwriteFileSync(cachePath, json)", 'writeFileSync'],
  ])('catches %s — the fs spellings a name list could not enumerate', (source) => {
    expect(caughtBy(source), `this source walked past the fence:\n${source}`).not.toEqual([])
  })

  it.each([
    ['execSync(`kill -9 ${pid}`)', 'kill -9 through a shell'],
    ['await exec(`kill -TERM ${pid}`)', 'kill -TERM through a shell'],
    ['await exec(`kill ${pid}`)', 'a bare kill, which is SIGTERM'],
    ['await exec(`pkill -f claude`)', 'pkill by name'],
    ['await exec(`taskkill /PID ${pid} /F`)', 'the Windows spelling'],
  ])('catches %s — %s', (source) => {
    expect(forbiddenIdiomsIn(source), `this source walked past the fence: ${source}`).not.toEqual([])
  })

  it('still catches the one spelling that was already caught — no regression in the name list', () => {
    expect(forbiddenIdiomsIn('writeFileSync(cachePath, json)')).not.toEqual([])
    expect(forbiddenIdiomsIn('process.kill(pid, 0)')).not.toEqual([])
  })
})

describe('the fs import allowlist admits exactly what the collector is FOR', () => {
  it('admits the three reads the Linux leg actually needs — a ban that refused these would forbid the collector', () => {
    // This is the import line `read-table.ts` carries in wave 2, verbatim. A
    // fence that refused it would be a fence around an empty directory forever.
    expect(forbiddenFsImportsIn("import { readFile, readdir, readlink } from 'node:fs/promises'")).toEqual([])
  })

  it('admits the read-only sync forms and an aliased read', () => {
    expect(forbiddenFsImportsIn("import { readFileSync, existsSync, statSync } from 'node:fs'")).toEqual([])
    expect(forbiddenFsImportsIn("import { readFile as read } from 'node:fs/promises'")).toEqual([])
  })

  it('refuses a name nobody listed — which is the property a denylist cannot have', () => {
    // The whole argument for this layer. `futimesSync` appears in no ban list
    // anywhere in this repo and is refused anyway, because the allowlist does
    // not need to have heard of a writer to keep it out.
    expect(forbiddenFsImportsIn("import { futimesSync } from 'node:fs'")).toEqual(['futimesSync'])
  })

  it('refuses a NAMESPACE import outright — it binds every writer in the module', () => {
    // The hole a named-import allowlist would otherwise have: `fs.writeFileSync`
    // is one property access away and no import name ever says so.
    expect(forbiddenFsImportsIn("import * as fs from 'node:fs'")).not.toEqual([])
    expect(forbiddenFsImportsIn("import fs from 'node:fs'")).not.toEqual([])
  })

  it('reads BOTH module spellings, since either would do', () => {
    expect(forbiddenFsImportsIn("import { writeFile } from 'node:fs/promises'")).toEqual(['writeFile'])
    expect(forbiddenFsImportsIn("import { writeFileSync } from 'node:fs'")).toEqual(['writeFileSync'])
  })

  it('says nothing about a file that imports no filesystem at all', () => {
    // The vacuity control. A checker that returned offenders for everything
    // would pass every assertion above and mean nothing.
    expect(forbiddenFsImportsIn("import { z } from 'zod'\nexport const x = 1")).toEqual([])
  })

  it('sweeps this directory too, so the allowlist is not only a rigged-input claim', () => {
    for (const { name, text } of collectorSources()) {
      expect(forbiddenFsImportsIn(text), `${name} imports a filesystem name this collector may not have`).toEqual([])
    }
  })
})
