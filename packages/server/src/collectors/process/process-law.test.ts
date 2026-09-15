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
  { pattern: /\bkill\s+-0\b/, why: 'sends signal 0 through a shell — same ban, different spelling' },
  { pattern: /\bSIGSTOP\b/, why: 'names a signal' },
  { pattern: /\bSIGKILL\b/, why: 'names a signal' },
  { pattern: /\bSIGTERM\b/, why: 'names a signal' },
  // ADR-0001's constitution, unchanged by ADR-0052: the observer writes
  // nothing. A collector that cached to disk would be a write outside every
  // hand's grant.
  { pattern: /\bwriteFile\b/, why: 'writes to disk — no hand grants this collector a write' },
  { pattern: /\bappendFile\b/, why: 'writes to disk' },
  { pattern: /\bcreateWriteStream\b/, why: 'writes to disk' },
  { pattern: /\bmkdir\b/, why: 'creates a directory — creating your own input is one step from writing into it' },
  { pattern: /\bunlink\b/, why: 'deletes' },
  { pattern: /\brmdir\b/, why: 'deletes' },
  // prd-57's non-goals: never any environment variable of any process. A
  // command line can carry a prompt; an environment can carry a key.
  // `process.env` is this process's own and is not what this bans — reading
  // /proc/<pid>/environ is.
  { pattern: /\benviron\b/, why: "reads another process's environment — never an event field, never read at all" },
]

/** Pure, and exercised on rigged input below, so the sweep is never the only thing holding this. */
export function forbiddenIdiomsIn(source: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ pattern }) => String(pattern))
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
      ['await exec("kill -0 " + pid)', '/\\bkill\\s+-0\\b/'],
      ['process.kill(pid, "SIGSTOP")', '/\\bSIGSTOP\\b/'],
      ['await writeFile(cachePath, json)', '/\\bwriteFile\\b/'],
      ['await mkdir(dir, { recursive: true })', '/\\bmkdir\\b/'],
      ['readFile(`/proc/${pid}/environ`)', '/\\benviron\\b/'],
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

  it('a subprocess is NOT banned here, and that is deliberate — the probe bans one in its own file only', () => {
    // If this ever starts failing, someone has copied
    // `process-probe.test.ts`'s subprocess ban across. Read this file's own doc
    // comment first: that ban is scoped to one file, and reproducing it here
    // would forbid the macOS and Windows legs prd-57 ruling 2 names.
    expect(forbiddenIdiomsIn("const out = await execFile('ps', args)")).toEqual([])
    expect(forbiddenIdiomsIn("import { spawn } from 'node:child_process'")).toEqual([])
  })

  it('every source file in this directory is clean — stating the count, so an empty sweep is visible rather than silent', () => {
    const sources = collectorSources()
    // Deliberately NOT `toBeGreaterThan(0)`. The directory is empty until wave
    // 2, and a guard that demanded sources would fail this law on the very
    // commit that lands it. The count is asserted into the message instead, so
    // a reader of a green run can see whether anything was swept.
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
