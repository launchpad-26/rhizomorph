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
    const hexMatch = /ingest key \(save this now — it will not be printed again\): ([0-9a-f]{64})/.exec(stdout)
    expect(hexMatch).not.toBeNull()

    const envPath = path.join(dir, '.env')
    const mode = statSync(envPath).mode & 0o777
    expect(mode).toBe(0o600)

    const content = readFileSync(envPath, 'utf8')
    expect(content).toContain('POSTGRES_PASSWORD=')
    expect(content).toContain('RZ_TEAM_DATABASE_URL=postgres://')
    expect(content).toContain('RZ_TEAM_INGEST_KEY=')
  })

  it("the DoD's actual claim (second run): the key is never re-printed, and the file is byte-identical", () => {
    const dir = freshDir()
    const first = runInit(dir)
    const firstKeyMatch = /ingest key \(save this now — it will not be printed again\): ([0-9a-f]{64})/.exec(first.stdout)
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
