import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hashIngestKey, isIngestKeyHash } from '../src/keys/hash.js'
import { isWellFormedIngestKey } from '../src/keys/shape.js'

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
