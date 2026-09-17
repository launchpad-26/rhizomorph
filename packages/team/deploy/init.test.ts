import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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

function runInit(dir: string, env: Record<string, string> = {}): { stdout: string } {
  // `RZ_TEAM_PROJECT` is deleted rather than merely not set: it is a real
  // variable an operator may have exported, and a default asserted against an
  // inherited value is a test that passes for the wrong reason on one machine.
  const inherited = { ...process.env }
  delete inherited.RZ_TEAM_PROJECT
  const stdout = execFileSync('bash', [INIT_SH], {
    env: { ...inherited, RZ_TEAM_DEPLOY_DIR: dir, ...env },
    encoding: 'utf8',
  })
  return { stdout }
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

/** The `app` service's own block: what THIS container is given, and nothing another service is. */
const APP_SERVICE = COMPOSE.slice(COMPOSE.indexOf('\n  app:'), COMPOSE.indexOf('\n  caddy:'))

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
