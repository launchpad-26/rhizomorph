import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hashIngestKey, isIngestKeyHash } from '../src/keys/hash.js'
import { isWellFormedIngestKey } from '../src/keys/shape.js'
import { DEFAULT_FOLD_TICK_MS, ENV_FOLD_TICK_MS } from './report.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INIT_SH = path.join(HERE, 'init.sh')

const madeDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rz-team-init-'))
  madeDirs.push(dir)
  return dir
}

function runInit(dir: string, env: Record<string, string> = {}, args: string[] = []): { stdout: string } {
  // `RZ_TEAM_PROJECT` is deleted rather than merely not set: it is a real
  // variable an operator may have exported, and a default asserted against an
  // inherited value is a test that passes for the wrong reason on one machine.
  const inherited = { ...process.env }
  delete inherited.RZ_TEAM_PROJECT
  const stdout = execFileSync('bash', [INIT_SH, ...args], {
    env: { ...inherited, RZ_TEAM_DEPLOY_DIR: dir, ...env },
    encoding: 'utf8',
  })
  return { stdout }
}

/**
 * A run that is expected to refuse: BOTH its streams, and the fact that it exited non-zero.
 *
 * stdout matters as much as stderr on this path — a refusal that still printed a key would have
 * announced a credential the deployment is not getting, which is exactly the defect the duplicate
 * `RZ_TEAM_PROJECT` case below exists for.
 */
function refusalRun(
  dir: string,
  env: Record<string, string> = {},
  args: string[] = [],
): { stdout: string; stderr: string } {
  const inherited = { ...process.env }
  delete inherited.RZ_TEAM_PROJECT
  try {
    execFileSync('bash', [INIT_SH, ...args], {
      env: { ...inherited, RZ_TEAM_DEPLOY_DIR: dir, ...env },
      encoding: 'utf8',
    })
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
  throw new Error(`init.sh ${args.join(' ')} was expected to refuse and exited 0`)
}

/** The same, when only the refusal's reasoning is under test. */
function refusal(dir: string, env: Record<string, string> = {}, args: string[] = []): string {
  return refusalRun(dir, env, args).stderr
}

/** The plaintext `init.sh` printed, from the one line that carries it. */
const PRINTED_KEY_RE = /ingest key for project \S+ \(save this now — it will not be printed again\): (rzk_[0-9a-f]{64})/

function printedKey(stdout: string): string {
  const match = PRINTED_KEY_RE.exec(stdout)
  expect(match).not.toBeNull()
  return match?.[1] as string
}

/** One `KEY=value` line out of a `.env`. */
function envValue(content: string, name: string): string | null {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(content)
  return match === null ? null : (match[1] as string)
}

afterEach(() => {
  // Some failure-path fixtures are chmod 000; restore permissions before rm so
  // cleanup itself does not fail on macOS/Linux.
  for (const dir of madeDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // best-effort
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('init.sh', () => {
  it('happy path (first run): writes a mode-600 .env with the generated secrets and prints the key once', () => {
    const dir = freshDir()
    const { stdout } = runInit(dir)

    expect(stdout).toContain('ingest key')
    expect(printedKey(stdout)).toMatch(/^rzk_[0-9a-f]{64}$/)

    const envPath = path.join(dir, '.env')
    const mode = statSync(envPath).mode & 0o777
    expect(mode).toBe(0o600)

    const content = readFileSync(envPath, 'utf8')
    expect(content).toContain('POSTGRES_PASSWORD=')
    expect(content).toContain('RZ_TEAM_DATABASE_URL=postgres://')
    expect(envValue(content, 'RZ_TEAM_PROJECT')).toBe('default')
    expect(isIngestKeyHash(envValue(content, 'RZ_TEAM_INGEST_KEY_SHA256') ?? '')).toBe(true)
  })

  /**
   * STORED ONLY AS SHA-256 (prd-51 ruling 8), asserted against the bytes the
   * script actually wrote rather than against the line it was meant to write.
   *
   * The near miss this closes: a `.env` that gained the digest and kept the
   * plaintext beside it would satisfy every assertion above, and would leave the
   * credential in an image layer, a `docker inspect` and any backup of the host.
   */
  it('the plaintext reaches stdout and NOTHING else — .env carries the digest and no key', () => {
    const dir = freshDir()
    const key = printedKey(runInit(dir).stdout)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')

    expect(content).not.toContain(key)
    // Not even a piece of one: a prefix of a secret is still a piece of one.
    expect(content).not.toContain(key.slice(0, 20))
    // …and no variable carries a key-shaped value at all.
    expect(content).not.toMatch(/=rzk_/)
  })

  /**
   * THE AGREEMENT, EXECUTED END TO END.
   *
   * `openssl dgst -sha256` in shell and `createHash('sha256')` in Node must
   * produce the same 64 characters for the same key, or the deployment's own key
   * is refused as unknown with nothing anywhere saying why. The failure is a
   * single trailing newline — `echo` instead of `printf` — and it is invisible to
   * any test that hashes with only one of the two tools. This runs the real
   * script and hashes the real printed key.
   */
  it('the digest in .env is what packages/team/src/keys/hash.ts computes for the printed key', () => {
    const dir = freshDir()
    const key = printedKey(runInit(dir).stdout)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')

    expect(envValue(content, 'RZ_TEAM_INGEST_KEY_SHA256')).toBe(hashIngestKey(key))
    // The bite: the `echo` form this comment warns about does NOT agree.
    expect(hashIngestKey(`${key}\n`)).toBe(hashIngestKey(key))
    expect(hashIngestKey(`${key} x`)).not.toBe(hashIngestKey(key))
  })

  it('the minted value is one the server will accept as well-formed', () => {
    const dir = freshDir()
    expect(isWellFormedIngestKey(printedKey(runInit(dir).stdout))).toBe(true)
  })

  it('RZ_TEAM_PROJECT names the project the key is scoped to, and defaults to `default`', () => {
    const named = freshDir()
    const { stdout } = runInit(named, { RZ_TEAM_PROJECT: 'acme-widgets' })
    expect(stdout).toContain('ingest key for project acme-widgets')
    expect(envValue(readFileSync(path.join(named, '.env'), 'utf8'), 'RZ_TEAM_PROJECT')).toBe('acme-widgets')

    const unnamed = freshDir()
    runInit(unnamed)
    expect(envValue(readFileSync(path.join(unnamed, '.env'), 'utf8'), 'RZ_TEAM_PROJECT')).toBe('default')
  })

  it("the DoD's actual claim (second run): the key is never re-printed, and the file is byte-identical", () => {
    const dir = freshDir()
    const first = runInit(dir)
    const firstKey = printedKey(first.stdout)

    const envPath = path.join(dir, '.env')
    const contentBefore = readFileSync(envPath)

    const second = runInit(dir)
    expect(second.stdout).not.toContain(firstKey)

    const contentAfter = readFileSync(envPath)
    // Byte-identical, not merely "the old key is absent from stdout" — the
    // latter would also pass against a bug that silently rotates the secret
    // on every run without ever printing the new value.
    expect(contentAfter.equals(contentBefore)).toBe(true)
  })

  it('failure path: an unwritable target directory refuses cleanly and leaves nothing behind', () => {
    const dir = freshDir()
    chmodSync(dir, 0o000)

    expect(() => runInit(dir)).toThrowError()

    let stderr = ''
    try {
      execFileSync('bash', [INIT_SH], {
        env: { ...process.env, RZ_TEAM_DEPLOY_DIR: dir },
        encoding: 'utf8',
      })
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? ''
    }
    expect(stderr).toContain(dir)
    expect(stderr).toContain('cannot write to')

    // No .env could plausibly have been written: the directory itself refuses
    // writes, so this also proves the atomic tmp-then-mv left nothing partial.
    chmodSync(dir, 0o700)
    expect(() => statSync(path.join(dir, '.env'))).toThrow()
  })
})

const GITHUB_ENV_NAMES = [
  'RZ_TEAM_GITHUB_ORG',
  'RZ_TEAM_GITHUB_APP_ID',
  'RZ_TEAM_GITHUB_INSTALLATION_ID',
  'RZ_TEAM_GITHUB_CLIENT_ID',
  'RZ_TEAM_GITHUB_CLIENT_SECRET',
  'RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH',
]

describe("init.sh's .env names the GitHub App's six values, empty", () => {
  it('all six names are present and empty', () => {
    const dir = freshDir()
    runInit(dir)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')
    for (const name of GITHUB_ENV_NAMES) {
      expect(envValue(content, name)).toBe('')
    }
  })

  it('each carries a comment saying where it comes from', () => {
    const dir = freshDir()
    runInit(dir)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')
    const lines = content.split('\n')
    for (const name of GITHUB_ENV_NAMES) {
      const idx = lines.findIndex((line) => line.startsWith(`${name}=`))
      expect(idx).toBeGreaterThan(0)
      const comment = lines[idx - 1] as string
      expect(comment.startsWith('#')).toBe(true)
      expect(comment.length).toBeGreaterThan(1)
    }
  })

  it('no credential is written, and none is generated', () => {
    const dir = freshDir()
    runInit(dir)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')
    expect(content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
    for (const name of GITHUB_ENV_NAMES) {
      expect(envValue(content, name)).toBe('')
    }

    const script = readFileSync(INIT_SH, 'utf8')
    const githubLines = script.split('\n').filter((line) => line.includes('GITHUB'))
    expect(githubLines.some((line) => line.includes('openssl'))).toBe(false)
  })

  it('the inline variable is documented but commented out', () => {
    const dir = freshDir()
    runInit(dir)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')
    expect(content).toContain('#RZ_TEAM_GITHUB_APP_PRIVATE_KEY=')
    expect(envValue(content, 'RZ_TEAM_GITHUB_APP_PRIVATE_KEY')).toBeNull()
  })

  it('the existing behaviour is untouched', () => {
    const dir = freshDir()
    const { stdout } = runInit(dir)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')
    expect(envValue(content, 'RZ_TEAM_PROJECT')).toBe('default')
    expect(isIngestKeyHash(envValue(content, 'RZ_TEAM_INGEST_KEY_SHA256') ?? '')).toBe(true)
    expect(printedKey(stdout)).toMatch(/^rzk_[0-9a-f]{64}$/)
  })
})

/**
 * BOTH BOUNDARIES, NOT JUST GIT'S (review of #454).
 *
 * `init.sh` writes two secret-bearing files — `.env`, and the `$ENV_FILE.tmp.$$`
 * the atomic write goes through — and each one leaves this directory by a
 * different door. `.gitignore` closes git's. **Docker's was open**:
 * `packages/team/Dockerfile`'s runtime stage does
 * `COPY packages/team/deploy packages/team/deploy`, the runbook's order is
 * `./init.sh` then `docker compose build`, and the repo carried no
 * `.dockerignore` at all — so the generated `.env` was copied into an image
 * layer, where it outlives even the runbook's own key-rotation recipe (which
 * restarts the app rather than rebuilding it).
 *
 * That is the same finding verify pass 1 caught on #433, one boundary out: the
 * temp file got an ignore rule and the build context did not. So this law is
 * written over BOTH ignore files at once, and derives the artefacts from the
 * script rather than naming them — a third secret-bearing path added to
 * `init.sh` has to be ignored in both places before this goes green.
 */
const REPO_ROOT = path.join(HERE, '..', '..', '..')

/**
 * The basenames `init.sh` writes secrets to, as ignore-file patterns. `$$` is
 * the shell's pid, so the temp file is a family and its pattern is a glob —
 * that translation is the one thing here not taken verbatim from the script,
 * and it is why the tmp case gets its own assertion below rather than riding
 * on `.env`'s.
 */
export function secretArtefactPatterns(script: string): string[] {
  const envFile = /^ENV_FILE="\$TARGET_DIR\/([^"]+)"$/m.exec(script)
  if (envFile === null) throw new Error('init.sh has no ENV_FILE assignment for this law to read')
  const envName = envFile[1] as string

  const tmpFile = /^tmp_file="\$ENV_FILE((?:\.[^"$]+|\.\$\$)+)"$/m.exec(script)
  if (tmpFile === null) throw new Error('init.sh has no tmp_file assignment for this law to read')
  const tmpSuffix = (tmpFile[1] as string).replace(/\$\$/g, '*')

  return [envName, `${envName}${tmpSuffix}`]
}

/** Whether an ignore file's text carries a rule for `packages/team/deploy/<pattern>`. */
export function ignores(ignoreText: string, pattern: string): boolean {
  const wanted = `packages/team/deploy/${pattern}`
  return ignoreText
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === wanted || line === `/${wanted}`)
}

describe("init.sh's secrets are ignored by git AND by docker", () => {
  const patterns = secretArtefactPatterns(readFileSync(INIT_SH, 'utf8'))

  it('derives both artefacts from the script, not from a list kept here', () => {
    expect(patterns).toEqual(['.env', '.env.tmp.*'])
  })

  it.each(['.gitignore', '.dockerignore'])('%s covers every secret-bearing path init.sh writes', (ignoreFile) => {
    const text = readFileSync(path.join(REPO_ROOT, ignoreFile), 'utf8')
    for (const pattern of patterns) {
      expect({ ignoreFile, pattern, covered: ignores(text, pattern) }).toEqual({
        ignoreFile,
        pattern,
        covered: true,
      })
    }
  })

  it('THE LAW BITES — the tree as it actually shipped fails it', () => {
    // No .dockerignore at all was the shipped state; a .dockerignore that
    // remembers only .env is the near miss that closes half of it.
    expect(ignores('', '.env')).toBe(false)
    expect(ignores('packages/team/deploy/.env\n', '.env')).toBe(true)
    expect(ignores('packages/team/deploy/.env\n', '.env.tmp.*')).toBe(false)
  })
})

/**
 * EVERY VARIABLE `deploy/serve.ts` READS IS ACCOUNTED FOR IN `compose.yml` (#584).
 *
 * The defect this closes was not a bug in any function. `compose.yml`'s `app` service forwarded
 * neither `RZ_TEAM_FOLD_TICK_MS` nor `RZ_TEAM_JOURNAL_DIR` while `serve.ts` read both off
 * `process.env`, so a `deploy/.env` line for either was inert — **including the one
 * `docs/team-server-runbook.md` told operators to set**. Every sentence in that paragraph was true
 * of the code and useless to an operator.
 *
 * That is #543's finding one layer out. #543 bound two REFUSAL STRINGS to the knobs they name;
 * nothing bound the deployment's own wiring to them, so the same shape shipped again in the lane
 * that cited the lesson. This is the missing binding.
 *
 * ## It derives the variables rather than listing them, and that is the point
 *
 * A list would have to be edited to cover a fourth variable, and the edit is exactly what nobody
 * does. So the set is taken from `serve.ts`'s own text, with comments stripped, in three shapes:
 *
 * 1. `process.env.NAME` — the name is right there.
 * 2. `process.env[IDENT]` — `IDENT` is resolved by importing the module `serve.ts` imports it
 *    from and reading the exported constant, so `ENV_PROJECT` becomes `RZ_TEAM_PROJECT` without
 *    that string appearing here.
 * 3. `ident(process.env)` — the whole environment is handed to a function, so the FUNCTION is
 *    asked what it reads: it is called with a `Proxy` that records every key. This is where
 *    `resolveTeamConfig`'s database URL, migrations dir and GitHub names come from, and where a
 *    value added to `TeamConfig` later arrives on its own.
 *
 * No variable name is written down in this law. A variable added to `serve.ts` tomorrow — directly
 * or through a new resolver — is covered with no edit here.
 *
 * ## Forwarded, or excused BY NAME in the same file
 *
 * Three of the derived variables are withheld from the container on purpose, and "on purpose" has
 * to be legible or it is indistinguishable from the oversight this law exists to catch. So each
 * one carries a `# NOT FORWARDED: <NAME> — <reason>` clause in the `app` service's own
 * `environment:` block, and an empty reason does not count. The falsifier on #584 asked for
 * exactly that for `RZ_TEAM_JOURNAL_DIR`: the `team_journal` volume fixes the path, so forwarding
 * the app's side alone would orphan the journal.
 *
 * Each name is asserted in its OWN case, never as a set. #543's sibling case was a list-shaped
 * assertion that stayed green when two names were reordered while the defect was re-introduced;
 * `it.each` over the derived names means a failure prints the variable that is unaccounted for.
 *
 * ## Why it lives in this file
 *
 * It is a law about `compose.yml`, not about `init.sh`. #584's fence carries `init.sh`,
 * `init.test.ts`, `compose.yml` and the runbook — `serve.ts` and `report.ts` belong to other
 * lanes — so this is the test file that could hold it. Fence, not taxonomy.
 */
const COMPOSE = readFileSync(path.join(HERE, 'compose.yml'), 'utf8')

/**
 * The `app` service's own block: what THIS container is given, and nothing another service is.
 *
 * THE END OF THE BLOCK IS DERIVED FROM INDENTATION, NOT FROM THE NAME OF THE SERVICE BELOW IT.
 * This slice used to run from `\n  app:` to `\n  caddy:`, and `indexOf` returns -1 for a marker
 * that is not there — so renaming `caddy` widened this window to the whole rest of the file and
 * the law then read every other service's `environment:` block as the app's. EXECUTED at review
 * of #599: with `caddy` renamed and the fold-tick line moved into that service, the app container
 * received nothing and all 68 cases stayed green — #584's own defect, restored, with its law
 * silent. A boundary anchored at one end is the sibling case this file names elsewhere.
 */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  if (start < 0) {
    throw new Error(`compose.yml declares no \`${name}:\` service, so this law has no block to read`)
  }
  const after = lines.findIndex((line, at) => at > start && /^ {0,2}\S/.test(line))
  return lines.slice(start, after < 0 ? lines.length : after).join('\n')
}

const APP_SERVICE = serviceBlock(COMPOSE, 'app')

/**
 * Comments stripped before anything is read out of the source — `serve.ts`'s docblocks discuss
 * `process.env` at length, and counting those as reads would make the classification guard below
 * assert nothing.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Local identifier → module specifier, from the importing file's own `import { … } from '…'`. */
function importedFrom(source: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const statement of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    const specifier = statement[2] as string
    for (const piece of (statement[1] as string).split(',')) {
      const cleaned = piece.trim().replace(/^type\s+/, '')
      if (cleaned === '') continue
      const parts = cleaned.split(/\s+as\s+/)
      const local = (parts[1] ?? parts[0] ?? '').trim()
      if (local !== '') map.set(local, specifier)
    }
  }
  return map
}

async function moduleHolding(imports: Map<string, string>, identifier: string): Promise<Record<string, unknown>> {
  const specifier = imports.get(identifier)
  if (specifier === undefined) {
    throw new Error(`serve.ts hands \`${identifier}\` the environment but imports it from nowhere this law can follow`)
  }
  return (await import(specifier)) as Record<string, unknown>
}

/** What a function reads out of an environment, asked of the function itself rather than guessed. */
async function keysReadBy(imports: Map<string, string>, identifier: string): Promise<string[]> {
  const resolver = (await moduleHolding(imports, identifier))[identifier]
  if (typeof resolver !== 'function') {
    throw new Error(`serve.ts calls \`${identifier}(process.env)\` but its module exports no such function`)
  }
  const seen = new Set<string>()
  const recorder = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'string') seen.add(property)
        return undefined
      },
    },
  )
  ;(resolver as (env: unknown) => unknown)(recorder)
  return [...seen]
}

interface ServeEnvReads {
  /** Every environment variable name `serve.ts` consults, however it reaches it. */
  readonly names: string[]
  /** `process.env` mentions in the code — the denominator of the vacuity guard. */
  readonly occurrences: number
  /** How many of those a rule above recognised. Anything less, and the derivation is blind. */
  readonly classified: number
}

async function envNamesServeReads(): Promise<ServeEnvReads> {
  const source = withoutComments(readFileSync(path.join(HERE, 'serve.ts'), 'utf8'))
  const imports = importedFrom(source)
  const names = new Set<string>()
  let classified = 0

  for (const read of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(read[1] as string)
    classified += 1
  }
  for (const read of source.matchAll(/process\.env\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
    const identifier = read[1] as string
    const value = (await moduleHolding(imports, identifier))[identifier]
    if (typeof value !== 'string') {
      throw new Error(`serve.ts reads process.env[${identifier}] but that export is not a string`)
    }
    names.add(value)
    classified += 1
  }
  for (const handed of source.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\(\s*process\.env\s*\)/g)) {
    for (const key of await keysReadBy(imports, handed[1] as string)) names.add(key)
    classified += 1
  }

  return {
    names: [...names].sort(),
    occurrences: (source.match(/process\.env/g) ?? []).length,
    classified,
  }
}

const SERVE_READS = await envNamesServeReads()

/**
 * THE DERIVED SET ITSELF, WRITTEN OUT BY HAND — because counting the source cannot see a name
 * leave it (#596).
 *
 * `classified === occurrences` below is an aggregate over CALL SITES, and one call site is one
 * number however many names come out of it: `resolveTeamConfig(process.env)` is a single
 * occurrence contributing nine. So when such a resolver stops reading one of its names — a
 * renamed constant, a field dropped in a refactor, a read moved behind a condition the Proxy
 * walk in `keysReadBy` does not enter — `seen` shrinks, both counts hold, the fold-tick anchor
 * still matches, and `it.each` quietly runs one fewer case. EXECUTED at the verification of
 * #584: one name dropped from the collection with the counts untouched left 47/47 green.
 *
 * WHY THE SORTED LIST AND NOT A PINNED COUNT. A count of the derived names does redden on a
 * pure drop, and it is the cheaper pin to maintain — but it is the same move one layer up, an
 * aggregate guarding a derivation, and it is blind to the sibling of the defect it was chosen
 * to fix: rename one variable inside a multi-name resolver and the set loses a name and gains a
 * name while the cardinality never moves. `compose.yml` would then forward a variable nothing
 * reads, fail to forward the one that is read, and this law would be green through both.
 * `toEqual` over the list catches the drop, the rename and the swap, and its diff NAMES the
 * entry that moved, which a count cannot.
 *
 * THE COST IS THE FEATURE. Every legitimate new read in `serve.ts` must edit this literal, in
 * the same commit — prd-51 ruling 12's rule applied to a law. If you are here because the pin
 * went red, the fix is to add or remove the name deliberately and say why in the commit, never
 * to loosen this to a length or a `toContain`.
 *
 * Typed out by hand, never pasted from a failure message: a pin re-derived from the thing it
 * pins is not a pin.
 */
const SERVE_READS_PINNED: readonly string[] = [
  'HOST',
  'PORT',
  'RZ_TEAM_DATABASE_URL',
  'RZ_TEAM_FOLD_TICK_MS',
  'RZ_TEAM_GITHUB_APP_ID',
  'RZ_TEAM_GITHUB_APP_PRIVATE_KEY',
  'RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE',
  'RZ_TEAM_GITHUB_CLIENT_ID',
  'RZ_TEAM_GITHUB_CLIENT_SECRET',
  'RZ_TEAM_GITHUB_INSTALLATION_ID',
  'RZ_TEAM_GITHUB_ORG',
  'RZ_TEAM_INGEST_KEY_SHA256',
  'RZ_TEAM_JOURNAL_DIR',
  'RZ_TEAM_MIGRATIONS_DIR',
  'RZ_TEAM_PROJECT',
]

/** A line in the `app` service that hands this variable to the container. */
function forwards(name: string): boolean {
  return new RegExp(`^\\s+${name}:`, 'm').test(APP_SERVICE)
}

/** The stated reason this variable is withheld, or `null` — an empty reason is not a reason. */
function excuseFor(name: string): string | null {
  const clause = new RegExp(`^\\s*#\\s*NOT FORWARDED: ${name} — (.*)$`, 'm').exec(APP_SERVICE)
  const reason = (clause?.[1] ?? '').trim()
  return reason === '' ? null : reason
}

describe('every variable deploy/serve.ts reads is accounted for in compose.yml', () => {
  /**
   * THE GUARD AGAINST THIS LAW PASSING BY READING NOTHING.
   *
   * `it.each([])` runs zero cases and reports success, so a derivation that silently stops
   * matching — a new idiom like `const env = process.env`, a renamed export, a resolver that
   * throws — would turn the whole law green rather than red. Both halves matter: the count
   * proves every `process.env` in the file was recognised, and the anchor proves the variable
   * this issue exists for actually came out of the derivation rather than out of a coincidence.
   */
  it('the derivation reads the whole of serve.ts, and the fold tick came out of it', () => {
    expect({ classified: SERVE_READS.classified }).toEqual({ classified: SERVE_READS.occurrences })
    expect(SERVE_READS.occurrences).toBeGreaterThan(0)
    expect(SERVE_READS.names).toContain(ENV_FOLD_TICK_MS)
  })

  /**
   * THE GUARD ABOVE COUNTS CALL SITES; THIS ONE PINS THE SET THEY PRODUCE.
   *
   * They are a pair and neither subsumes the other. The count answers "did the derivation
   * recognise every `process.env` in the file", which is what catches a brand-new reading idiom
   * producing no names at all. This one answers "is the set of names still the set of names",
   * which is what catches a name falling out of — or swapping inside — an idiom the derivation
   * already recognises. `SERVE_READS_PINNED`'s docblock carries why this is a list and not a
   * count.
   */
  it('the derived set of names is exactly the pinned list, so a name that falls out reddens here', () => {
    expect(SERVE_READS.names).toEqual([...SERVE_READS_PINNED])
  })

  it.each(SERVE_READS.names)('%s is forwarded to the app container, or excused there by name', (name) => {
    const accountedFor = forwards(name) || excuseFor(name) !== null
    expect({ name, accountedFor }).toEqual({ name, accountedFor: true })
  })

  /**
   * A stale excuse is its own defect: a `# NOT FORWARDED:` clause left beside a variable that is
   * now forwarded reads, to the next person, as the reason it is not — which is how the runbook
   * paragraph this issue fixes came to be wrong.
   */
  it.each(SERVE_READS.names)('%s is not both forwarded and excused', (name) => {
    const contradicted = forwards(name) && excuseFor(name) !== null
    expect({ name, contradicted }).toEqual({ name, contradicted: false })
  })
})

describe("init.sh writes the fold tick into .env, with the server's own default", () => {
  it('the value is DEFAULT_FOLD_TICK_MS, read out of a real run rather than out of the script', () => {
    const dir = freshDir()
    runInit(dir)
    const content = readFileSync(path.join(dir, '.env'), 'utf8')
    expect(envValue(content, ENV_FOLD_TICK_MS)).toBe(String(DEFAULT_FOLD_TICK_MS))
  })

  /**
   * The two facts an operator cannot recover from the value: `0` is a setting rather than a
   * fault, and a non-number is `0` rather than "immediately". `RZ_TEAM_FOLD_TICK_MS=5s` is the
   * typo a reader of the runbook's fold section will make, and it DISABLES the tick.
   */
  it('and the comment above it says what 0 and a non-number do', () => {
    const dir = freshDir()
    runInit(dir)
    const lines = readFileSync(path.join(dir, '.env'), 'utf8').split('\n')
    const at = lines.findIndex((line) => line.startsWith(`${ENV_FOLD_TICK_MS}=`))
    expect(at).toBeGreaterThan(0)

    const comment: string[] = []
    for (let i = at - 1; i >= 0 && (lines[i] as string).startsWith('#'); i -= 1) comment.unshift(lines[i] as string)
    const block = comment.join('\n')

    expect(comment.length).toBeGreaterThan(0)
    expect(block).toContain('MILLISECONDS')
    expect(block).toMatch(/0 disables the periodic tick/)
    expect(block).toMatch(/NOT A NUMBER also reads as 0/)
    expect(block).toContain(`${ENV_FOLD_TICK_MS}=5s`)
  })
})

/**
 * ROTATION, AGAINST THE STATE A ROTATION ACTUALLY RUNS AGAINST (#591).
 *
 * Every test above this line runs `init.sh` against a FRESH directory, and that is the one state
 * in which the two defects #591 records are both invisible: there is no Postgres volume for a
 * regenerated password to mismatch, and there are no hand-entered values for a recreated file to
 * lose. The documented procedure was `rm .env` then first boot, and on 2026-09-17 it took the live
 * deployment down twice over — a DSN the database had never heard of, and six `RZ_TEAM_GITHUB_*`
 * values wiped, one of which GitHub shows exactly once.
 *
 * So these fixtures are deliberately NOT fresh. Each one boots, fills the App values in by hand
 * the way an operator does, and only then rotates.
 *
 * ## The assertion that does the work is derived, not enumerated
 *
 * `changedLines` diffs the whole file and returns which line numbers moved. The claim is
 * "exactly one line changed, and it is the digest" — which covers the Postgres password, the six
 * App values, the project id, the fold tick, every comment, and any variable a later PRD adds to
 * this file, with no edit here. The named assertions below it are kept because #591's Definition
 * of done names those values specifically; they are the enumeration, and they would each pass on
 * their own against a rewrite that lost something nobody listed.
 */
const ROTATE = ['--rotate-ingest-key']

/**
 * What an operator types in after first boot. Synthetic by construction — no value here is a real
 * credential, and the private-key path is the one `docs/team-server-runbook.md` uses as its
 * example. The client secret's value says what it is, because THAT is the one GitHub will not show
 * a second time and the one a recreated `.env` destroyed unrecoverably.
 */
const HAND_ENTERED: ReadonlyArray<readonly [string, string]> = [
  ['RZ_TEAM_GITHUB_ORG', 'example-org'],
  ['RZ_TEAM_GITHUB_APP_ID', '123456'],
  ['RZ_TEAM_GITHUB_INSTALLATION_ID', '87654321'],
  ['RZ_TEAM_GITHUB_CLIENT_ID', 'Iv1.0123456789abcdef'],
  ['RZ_TEAM_GITHUB_CLIENT_SECRET', 'shown-once-by-github-and-never-again'],
  ['RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH', '/srv/rhizomorph/github-app-private-key.pem'],
]

/** Fill the six App values in, the way an operator does, and prove each one landed. */
function fillInByHand(envPath: string): void {
  let content = readFileSync(envPath, 'utf8')
  for (const [name, value] of HAND_ENTERED) {
    const before = content
    content = content.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${value}`)
    // Without this the whole fixture could silently become "rotate an .env whose App values are
    // still empty", which is the fresh-directory case again wearing a different name.
    expect({ name, filled: content !== before }).toEqual({ name, filled: true })
  }
  writeFileSync(envPath, content, { mode: 0o600 })
}

/** A booted, hand-filled deployment: the `.env` path, and its bytes before anything rotates. */
function deployedDir(project = 'acme-widgets'): { dir: string; envPath: string; before: string } {
  const dir = freshDir()
  runInit(dir, { RZ_TEAM_PROJECT: project })
  const envPath = path.join(dir, '.env')
  fillInByHand(envPath)
  return { dir, envPath, before: readFileSync(envPath, 'utf8') }
}

/** The line numbers at which two versions of a file disagree, plus each side's text. */
function changedLines(before: string, after: string): Array<{ at: number; from: string; to: string }> {
  const a = before.split('\n')
  const b = after.split('\n')
  const changed: Array<{ at: number; from: string; to: string }> = []
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const from = a[i] ?? '<absent>'
    const to = b[i] ?? '<absent>'
    if (from !== to) changed.push({ at: i, from, to })
  }
  return changed
}

/** Any `.env.tmp.*` the atomic write left behind. A refusal must leave none. */
function strayTempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.env.tmp.'))
}

describe('init.sh --rotate-ingest-key: the rotation path, against live state', () => {
  it('rewrites EXACTLY ONE line — the digest — and every other byte of .env survives', () => {
    const { dir, envPath, before } = deployedDir()

    runInit(dir, {}, ROTATE)

    const after = readFileSync(envPath, 'utf8')
    const changed = changedLines(before, after)
    expect(changed).toHaveLength(1)
    expect(changed[0]?.from).toMatch(/^RZ_TEAM_INGEST_KEY_SHA256=[0-9a-f]{64}$/)
    expect(changed[0]?.to).toMatch(/^RZ_TEAM_INGEST_KEY_SHA256=[0-9a-f]{64}$/)
    expect(changed[0]?.to).not.toBe(changed[0]?.from)
    // The file did not gain or lose lines either, which a one-line diff over an
    // index-aligned compare would otherwise report as a long run of changes.
    expect(after.split('\n')).toHaveLength(before.split('\n').length)
  })

  it("the DoD's named survivors, asserted by name: six App values, the Postgres password, the DSN and the project", () => {
    const { dir, envPath, before } = deployedDir()

    runInit(dir, {}, ROTATE)
    const after = readFileSync(envPath, 'utf8')

    for (const [name, value] of HAND_ENTERED) {
      expect({ name, value: envValue(after, name) }).toEqual({ name, value })
    }
    // THE DEFECT THAT TOOK THE DEPLOYMENT DOWN. The postgres image applies
    // POSTGRES_PASSWORD only at initdb, so a rotation that mints a new one hands
    // the app a DSN the database has never accepted and the stack never returns.
    expect(envValue(after, 'POSTGRES_PASSWORD')).toBe(envValue(before, 'POSTGRES_PASSWORD'))
    expect(envValue(after, 'RZ_TEAM_DATABASE_URL')).toBe(envValue(before, 'RZ_TEAM_DATABASE_URL'))
    // …and the two agree with each other, so neither could have been rewritten alone.
    expect(envValue(after, 'RZ_TEAM_DATABASE_URL')).toContain(envValue(after, 'POSTGRES_PASSWORD') as string)
    expect(envValue(after, 'RZ_TEAM_PROJECT')).toBe('acme-widgets')
    expect(envValue(after, ENV_FOLD_TICK_MS)).toBe(String(DEFAULT_FOLD_TICK_MS))
  })

  it('mints a new key, prints it once, and stores only its digest — the same agreement first boot keeps', () => {
    const { dir, envPath, before } = deployedDir()
    const oldKeyDigest = envValue(before, 'RZ_TEAM_INGEST_KEY_SHA256')

    const { stdout } = runInit(dir, {}, ROTATE)
    const newKey = printedKey(stdout)
    const after = readFileSync(envPath, 'utf8')

    expect(isWellFormedIngestKey(newKey)).toBe(true)
    expect(envValue(after, 'RZ_TEAM_INGEST_KEY_SHA256')).toBe(hashIngestKey(newKey))
    expect(envValue(after, 'RZ_TEAM_INGEST_KEY_SHA256')).not.toBe(oldKeyDigest)
    // The plaintext reaches stdout and nothing else, on this path as on first boot.
    expect(after).not.toContain(newKey)
    expect(after).not.toContain(newKey.slice(0, 20))
    expect(after).not.toMatch(/=rzk_/)
    // Rotation is not a first boot wearing a hat: it says which project it rotated,
    // read out of the file rather than out of the environment.
    expect(stdout).toContain('ingest key for project acme-widgets')
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    expect(strayTempFiles(dir)).toEqual([])
  })

  it('rotating twice gives three distinct digests, each the hash of that run’s printed key, App values intact throughout', () => {
    const { dir, envPath, before } = deployedDir()

    const first = printedKey(runInit(dir, {}, ROTATE).stdout)
    const afterFirst = readFileSync(envPath, 'utf8')
    const second = printedKey(runInit(dir, {}, ROTATE).stdout)
    const afterSecond = readFileSync(envPath, 'utf8')

    const digests = [
      envValue(before, 'RZ_TEAM_INGEST_KEY_SHA256'),
      envValue(afterFirst, 'RZ_TEAM_INGEST_KEY_SHA256'),
      envValue(afterSecond, 'RZ_TEAM_INGEST_KEY_SHA256'),
    ]
    expect(new Set(digests).size).toBe(3)
    expect(digests[1]).toBe(hashIngestKey(first))
    expect(digests[2]).toBe(hashIngestKey(second))
    expect(first).not.toBe(second)

    // Repetition is where a rewrite that drifts shows up: the second rotation reads
    // what the first one wrote, so a lost value would compound rather than recur.
    expect(changedLines(before, afterSecond)).toHaveLength(1)
    for (const [name, value] of HAND_ENTERED) {
      expect({ name, value: envValue(afterSecond, name) }).toEqual({ name, value })
    }
  })

  it('an exported RZ_TEAM_PROJECT that AGREES with the file is accepted', () => {
    const { dir, envPath, before } = deployedDir()
    runInit(dir, { RZ_TEAM_PROJECT: 'acme-widgets' }, ROTATE)
    expect(changedLines(before, readFileSync(envPath, 'utf8'))).toHaveLength(1)
  })
})

describe('init.sh --rotate-ingest-key refuses rather than guessing, and leaves the file alone', () => {
  it('refuses when there is no .env at all, and writes nothing', () => {
    const dir = freshDir()

    const stderr = refusal(dir, {}, ROTATE)

    expect(stderr).toContain('nothing to rotate')
    expect(stderr).toContain(dir)
    expect(stderr).toContain('./init.sh with no arguments')
    expect(() => statSync(path.join(dir, '.env'))).toThrow()
    expect(strayTempFiles(dir)).toEqual([])
  })

  it.each(['RZ_TEAM_INGEST_KEY_SHA256', 'RZ_TEAM_PROJECT'])(
    'refuses an .env with no %s line, and the file is byte-identical afterwards',
    (name) => {
      const { dir, envPath, before } = deployedDir()
      writeFileSync(envPath, before.replace(new RegExp(`^${name}=.*$`, 'm'), '# removed by hand'), { mode: 0o600 })
      const mangled = readFileSync(envPath, 'utf8')

      const stderr = refusal(dir, {}, ROTATE)

      expect(stderr).toContain(`has no ${name} line`)
      expect(readFileSync(envPath, 'utf8')).toBe(mangled)
      expect(strayTempFiles(dir)).toEqual([])
    },
  )

  /**
   * ONE GUARD, BOTH NAMES — AND THE SECOND IS HERE BECAUSE IT WAS MISSING (verify of #591).
   *
   * The first cut of this change guarded the digest line's count and then read the project with
   * `sed … | head -n 1`, which is the guard's own argument applied to one name and not to its
   * structurally identical sibling. Executed against that build: an `.env` carrying
   * `RZ_TEAM_PROJECT` twice **rotated successfully** and announced the FIRST value, while compose's
   * last-wins parsing hands the container the SECOND — so the operator wrote down a key they were
   * told was scoped to a project the boot would never seed it for.
   *
   * Both names are one loop now, and each is asserted in its OWN case rather than as a set, so a
   * failure prints which name stopped being guarded.
   */
  it.each([
    ['RZ_TEAM_INGEST_KEY_SHA256', `RZ_TEAM_INGEST_KEY_SHA256=${'0'.repeat(64)}`],
    ['RZ_TEAM_PROJECT', 'RZ_TEAM_PROJECT=second-project'],
  ])('refuses an .env carrying two %s lines rather than acting on the one compose will not use', (name, duplicate) => {
    const { dir, envPath, before } = deployedDir()
    writeFileSync(envPath, `${before}${duplicate}\n`, { mode: 0o600 })
    const doubled = readFileSync(envPath, 'utf8')

    const stderr = refusal(dir, {}, ROTATE)

    expect(stderr).toContain(`has 2 ${name} lines, not 1`)
    expect(stderr).toContain('last-wins')
    expect(readFileSync(envPath, 'utf8')).toBe(doubled)
    expect(strayTempFiles(dir)).toEqual([])
  })

  /**
   * The consequence, asserted rather than inferred. The defect was not that rotation wrote the
   * wrong bytes — it wrote none of them wrong — but that it PRINTED a scope the deployment does not
   * use. So this reads stdout of the refused run and proves no key was announced at all.
   */
  it('announces no key at all when the file names two projects — the printed scope was the whole defect', () => {
    const { dir, envPath, before } = deployedDir('first-project')
    writeFileSync(envPath, `${before}RZ_TEAM_PROJECT=second-project\n`, { mode: 0o600 })

    const { stdout, stderr } = refusalRun(dir, {}, ROTATE)

    expect(stdout).not.toContain('first-project')
    expect(stdout).not.toMatch(PRINTED_KEY_RE)
    expect(stdout).not.toMatch(/rzk_/)
    expect(stderr).toContain('RZ_TEAM_PROJECT')
    // …and the hazard was real: last-wins is the second value, not the one a
    // `head -n 1` read announces.
    const projectLines = readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('RZ_TEAM_PROJECT='))
    expect(projectLines).toEqual(['RZ_TEAM_PROJECT=first-project', 'RZ_TEAM_PROJECT=second-project'])
  })

  it('refuses when the file names no project, naming what to set', () => {
    const { dir, envPath, before } = deployedDir()
    writeFileSync(envPath, before.replace(/^RZ_TEAM_PROJECT=.*$/m, 'RZ_TEAM_PROJECT='), { mode: 0o600 })
    const emptied = readFileSync(envPath, 'utf8')

    const stderr = refusal(dir, {}, ROTATE)

    expect(stderr).toContain('names no project')
    expect(stderr).toContain('scoped to one project')
    expect(readFileSync(envPath, 'utf8')).toBe(emptied)
  })

  /**
   * An exported `RZ_TEAM_PROJECT` that disagrees is REFUSED, not ignored. Ignoring it would be a
   * knob an operator sets that silently does nothing — the shape #584 closed for
   * `RZ_TEAM_FOLD_TICK_MS` one issue earlier — and the old procedure's own hazard was exactly this
   * value being wrong: it minted for the other project and left the original key live.
   */
  it('refuses an exported RZ_TEAM_PROJECT that disagrees with the file, naming both', () => {
    const { dir, envPath, before } = deployedDir()

    const stderr = refusal(dir, { RZ_TEAM_PROJECT: 'some-other-project' }, ROTATE)

    expect(stderr).toContain('some-other-project')
    expect(stderr).toContain('acme-widgets')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
    expect(strayTempFiles(dir)).toEqual([])
  })

  it('refuses an unknown argument with a usage that names both modes, and writes nothing', () => {
    const dir = freshDir()

    const stderr = refusal(dir, {}, ['--rotate'])

    expect(stderr).toContain('unknown argument: --rotate')
    expect(stderr).toContain('--rotate-ingest-key')
    expect(stderr).toContain('FIRST BOOT')
    expect(() => statSync(path.join(dir, '.env'))).toThrow()
  })

  /**
   * THE FLAG IS THE ONLY DOOR, AND THE GUARD IT SITS BESIDE IS NOT WEAKENED.
   *
   * The early return on an existing `.env` is what made `init.sh` safe to re-run; the failure
   * #591 records came from the documented workaround for it (`rm .env`), not from the guard. So
   * rotation is its MIRROR — it requires the file the guard refuses to overwrite — and a bare run
   * must still change nothing at all.
   */
  it('a bare ./init.sh against an existing .env still refuses to touch it, and points at the flag', () => {
    const { dir, envPath, before } = deployedDir()

    const { stdout } = runInit(dir)

    expect(stdout).toContain('not regenerating, ingest key not re-printed')
    expect(stdout).toContain('--rotate-ingest-key')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
  })
})

/**
 * NO SHIPPED INSTRUCTION TELLS AN OPERATOR TO DELETE `.env` (#591).
 *
 * The destructive procedure was written down in two places, and only one of them is a document.
 * `packages/team/deploy/doctor.ts` carried it as a remedy string — printed at the exact moment an
 * operator is already in trouble, which is the worse of the two positions. Fixing the runbook and
 * leaving the doctor saying it is the sibling-case defect `AGENTS.md` names, so this law reads
 * both sources at once.
 *
 * It is scoped to what an operator TYPES: the runbook's fenced command blocks, and `doctor.ts`'s
 * source. Prose explaining what the old procedure did is not the hazard and is not caught here —
 * the runbook's rotation section deliberately still describes it, because an operator with the old
 * recipe in their shell history needs to know why it broke.
 *
 * Both halves of the vacuity guard matter: the sources must be non-empty, and each must carry the
 * NEW command, so a law that silently stopped reading the right file (a renamed heading, a moved
 * path) goes red rather than green.
 */
const RUNBOOK = readFileSync(path.join(HERE, '..', '..', '..', 'docs', 'team-server-runbook.md'), 'utf8')
const DOCTOR_TS = readFileSync(path.join(HERE, 'doctor.ts'), 'utf8')

/** The contents of every ``` fenced block in a markdown document. */
export function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const lines = markdown.split('\n')
  let open: string[] | null = null
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (open === null) open = []
      else {
        blocks.push(open.join('\n'))
        open = null
      }
      continue
    }
    if (open !== null) open.push(line)
  }
  return blocks
}

/** A command that deletes the deployment's `.env`, in whatever spelling. */
export function deletesEnvFile(text: string): boolean {
  return /\brm\b[^\n]*(?<![\w.-])\.env\b/.test(text)
}

describe('no shipped instruction tells an operator to delete .env', () => {
  it('the law read the files it claims to read, and both carry the rotation command', () => {
    expect(RUNBOOK.length).toBeGreaterThan(0)
    expect(DOCTOR_TS.length).toBeGreaterThan(0)
    expect(RUNBOOK).toContain('--rotate-ingest-key')
    expect(DOCTOR_TS).toContain('--rotate-ingest-key')
    expect(fencedBlocks(RUNBOOK).length).toBeGreaterThan(0)
    expect(fencedBlocks(RUNBOOK).some((block) => block.includes('./init.sh --rotate-ingest-key'))).toBe(true)
  })

  it('no fenced command block in the runbook removes .env', () => {
    const offending = fencedBlocks(RUNBOOK).filter(deletesEnvFile)
    expect(offending).toEqual([])
  })

  it("no remedy in the doctor's source removes .env", () => {
    const offending = DOCTOR_TS.split('\n').filter(deletesEnvFile)
    expect(offending).toEqual([])
  })

  it('THE LAW BITES — the procedure as it actually shipped fails it', () => {
    expect(deletesEnvFile('cd packages/team/deploy\nrm .env\n./init.sh')).toBe(true)
    expect(deletesEnvFile('rm -f .env')).toBe(true)
    expect(deletesEnvFile('cd packages/team/deploy && rm .env && RZ_TEAM_PROJECT=<id> ./init.sh')).toBe(true)
    // …and does not fire on what a runbook legitimately says.
    expect(deletesEnvFile('./init.sh --rotate-ingest-key')).toBe(false)
    expect(deletesEnvFile('docker compose up -d')).toBe(false)
    expect(deletesEnvFile('rm /srv/rhizomorph/old.env.bak')).toBe(false)
    expect(fencedBlocks('a\n```\none\n```\nb\n```\ntwo\n```\n')).toEqual(['one', 'two'])
  })
})
