import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INIT_SH = path.join(HERE, 'init.sh')

const madeDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rz-team-init-'))
  madeDirs.push(dir)
  return dir
}

function runInit(dir: string): { stdout: string } {
  const stdout = execFileSync('bash', [INIT_SH], {
    env: { ...process.env, RZ_TEAM_DEPLOY_DIR: dir },
    encoding: 'utf8',
  })
  return { stdout }
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
    const hexMatch = /ingest key \(save this now — it will not be printed again\): (rzk_[0-9a-f]{64})/.exec(stdout)
    expect(hexMatch).not.toBeNull()

    const envPath = path.join(dir, '.env')
    const mode = statSync(envPath).mode & 0o777
    expect(mode).toBe(0o600)

    const content = readFileSync(envPath, 'utf8')
    expect(content).toContain('POSTGRES_PASSWORD=')
    expect(content).toContain('RZ_TEAM_DATABASE_URL=postgres://')
    expect(content).toContain('RZ_TEAM_INGEST_KEY=rzk_')
  })

  it("the DoD's actual claim (second run): the key is never re-printed, and the file is byte-identical", () => {
    const dir = freshDir()
    const first = runInit(dir)
    const firstKeyMatch = /ingest key \(save this now — it will not be printed again\): (rzk_[0-9a-f]{64})/.exec(first.stdout)
    expect(firstKeyMatch).not.toBeNull()
    const firstKey = firstKeyMatch?.[1] as string

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
