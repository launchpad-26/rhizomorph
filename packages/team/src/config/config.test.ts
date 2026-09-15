import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATABASE_URL,
  ENV_DATABASE_URL,
  ENV_GITHUB_APP_ID,
  ENV_GITHUB_APP_PRIVATE_KEY,
  ENV_GITHUB_APP_PRIVATE_KEY_FILE,
  ENV_GITHUB_CLIENT_SECRET,
  ENV_GITHUB_ORG,
  ENV_MIGRATIONS_DIR,
  keyFileFault,
  redactDatabaseUrl,
  type ReadTextFileSync,
  resolveTeamConfig,
} from './config.js'

/** The literal used everywhere a fixture needs a password. Synthetic, and greppable. */
const PASSWORD = 'hunter2'

describe('case 33 — an override names the variable, a default names the file', () => {
  it('the overridden field says environment and names the variable', () => {
    const url = `postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph`
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: url })

    expect(config.databaseUrl.value).toBe(url)
    expect(config.databaseUrl.setBy).toBe('environment')
    expect(config.databaseUrl.source).toBe(ENV_DATABASE_URL)
  })

  it('the others stay default and keep naming the module that set them', () => {
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: 'postgres://db.invalid/rz' })
    expect(config.migrationsDir.setBy).toBe('default')
    expect(config.migrationsDir.source).toBe('packages/team/src/config/config.ts')
  })

  it('every environment variable this package reads is actually read', () => {
    const config = resolveTeamConfig({
      [ENV_DATABASE_URL]: 'postgres://db.invalid/one',
      [ENV_MIGRATIONS_DIR]: '/opt/rhizomorph/migrations',
    })
    expect(config.databaseUrl.value).toBe('postgres://db.invalid/one')
    expect(config.migrationsDir.value).toBe('/opt/rhizomorph/migrations')
    expect([config.databaseUrl.source, config.migrationsDir.source]).toEqual([ENV_DATABASE_URL, ENV_MIGRATIONS_DIR])
  })

  it('an empty environment variable is not an override — it is an unset variable spelled badly', () => {
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: '' })
    expect(config.databaseUrl.value).toBe(DEFAULT_DATABASE_URL)
    expect(config.databaseUrl.setBy).toBe('default')
  })

})

describe('case 34 — display never carries the password', () => {
  it('a URL with userinfo', () => {
    const url = `postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph`
    const display = resolveTeamConfig({ [ENV_DATABASE_URL]: url }).databaseUrl.display
    expect(display).not.toContain(PASSWORD)
    expect(display).toBe('postgres://***@db.invalid:5432/rhizomorph')
  })

  it('a URL with a username and no password still redacts the username', () => {
    const display = redactDatabaseUrl('postgres://rz@db.invalid:5432/rhizomorph')
    expect(display).toBe('postgres://***@db.invalid:5432/rhizomorph')
  })

  it('a URL with no userinfo passes through unchanged', () => {
    expect(redactDatabaseUrl(DEFAULT_DATABASE_URL)).toBe(DEFAULT_DATABASE_URL)
    expect(resolveTeamConfig({}).databaseUrl.display).toBe(DEFAULT_DATABASE_URL)
  })

  it('a malformed URL is redacted whole, because we cannot say where its parts are', () => {
    for (const malformed of [
      `postgres://rz:${PASSWORD}@`,
      `postgres://rz:${PASSWORD}`,
      `://rz:${PASSWORD}@db.invalid`,
      PASSWORD,
    ]) {
      const display = redactDatabaseUrl(malformed)
      expect(display).not.toContain(PASSWORD)
    }
  })

  it('the redaction is not vacuous — it really parsed a real URL and kept the host', () => {
    const display = redactDatabaseUrl(`postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph?sslmode=require`)
    expect(display).toContain('db.invalid:5432')
    expect(display).toContain('sslmode=require')
    expect(display).not.toContain(PASSWORD)
  })

  it('the value itself is NOT redacted — a redacted connection string would not connect', () => {
    const url = `postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph`
    expect(resolveTeamConfig({ [ENV_DATABASE_URL]: url }).databaseUrl.value).toBe(url)
  })

  /**
   * The ratchet. prd-51 ruling 4 states the `synchronous_commit=off` refusal
   * with no exception clause, and an escape hatch (`requireDurableCommit`,
   * `RZ_TEAM_REQUIRE_DURABLE_COMMIT`) was written during the build and removed
   * in review. Deleting it is not enough on its own: the next lane to want a
   * throwaway database will reach for exactly the same field, and a deletion
   * leaves no trace saying why it must not come back.
   *
   * So this asserts the SHAPE, not the absence of one identifier: no config
   * key, and no environment variable this module reads, may be named for
   * durability or commit behaviour. Re-adding the field under any spelling
   * reddens here, and the reader is sent to ruling 4.
   *
   * MUTATION: restore `requireDurableCommit` to `resolveTeamConfig` — red.
   */
  it('carries no key that could switch the durability refusal off — ruling 4 has no exception clause', () => {
    const forbidden = /durabl|synchronous|commit|fsync/i
    const keys = Object.keys(resolveTeamConfig({}))
    expect(keys).not.toHaveLength(0)
    expect(keys.filter((k) => forbidden.test(k))).toEqual([])

    const sources = Object.values(resolveTeamConfig({})).map((v) => v.source)
    expect(sources.filter((sourceName) => forbidden.test(sourceName))).toEqual([])
  })
})

describe('case 36 — the GitHub App identity names its setter, same as every other field', () => {
  it('an empty environment leaves all six fields default, empty, and pointed at this file', () => {
    const config = resolveTeamConfig({})
    for (const field of [
      config.githubOrgLogin,
      config.githubAppId,
      config.githubInstallationId,
      config.githubAppPrivateKey,
      config.githubClientId,
      config.githubClientSecret,
    ]) {
      expect(field.setBy).toBe('default')
      expect(field.value).toBe('')
      expect(field.source).toBe('packages/team/src/config/config.ts')
    }
  })

  it('one override flips only that field to environment, and names the variable', () => {
    const config = resolveTeamConfig({ [ENV_GITHUB_ORG]: 'rhizomorph-team' })
    expect(config.githubOrgLogin.value).toBe('rhizomorph-team')
    expect(config.githubOrgLogin.setBy).toBe('environment')
    expect(config.githubOrgLogin.source).toBe(ENV_GITHUB_ORG)

    expect(config.githubAppId.setBy).toBe('default')
    expect(config.githubInstallationId.setBy).toBe('default')
    expect(config.githubAppPrivateKey.setBy).toBe('default')
    expect(config.githubClientId.setBy).toBe('default')
    expect(config.githubClientSecret.setBy).toBe('default')
  })

  it('an empty-string override is not an override, for the identity fields too', () => {
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_ID]: '' })
    expect(config.githubAppId.value).toBe('')
    expect(config.githubAppId.setBy).toBe('default')
  })
})

describe('case 37 — secrets redact in display, identity does not', () => {
  /** Synthetic fixtures only — never a real key or secret. */
  const FAKE_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----'
  const FAKE_CLIENT_SECRET = 'shhh-client-secret'

  it('an unset secret displays as unset, not empty and not the value', () => {
    const config = resolveTeamConfig({})
    expect(config.githubAppPrivateKey.display).toBe('<unset>')
    expect(config.githubClientSecret.display).toBe('<unset>')
  })

  it('an unset identity field also displays as unset, never as an empty string', () => {
    const config = resolveTeamConfig({})
    expect(config.githubOrgLogin.display).toBe('<unset>')
    expect(config.githubAppId.display).toBe('<unset>')
    expect(config.githubInstallationId.display).toBe('<unset>')
    expect(config.githubClientId.display).toBe('<unset>')
  })

  it('a set secret displays as redacted, and the literal never survives into display', () => {
    const config = resolveTeamConfig({
      [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_PRIVATE_KEY,
      [ENV_GITHUB_CLIENT_SECRET]: FAKE_CLIENT_SECRET,
    })
    expect(config.githubAppPrivateKey.display).toBe('<redacted>')
    expect(config.githubClientSecret.display).toBe('<redacted>')

    const allDisplays = JSON.stringify(Object.values(config).map((v) => v.display))
    expect(allDisplays).not.toContain(FAKE_PRIVATE_KEY)
    expect(allDisplays).not.toContain(FAKE_CLIENT_SECRET)

    // The value itself is NOT redacted — a redacted key could not sign anything.
    expect(config.githubAppPrivateKey.value).toBe(FAKE_PRIVATE_KEY)
    expect(config.githubClientSecret.value).toBe(FAKE_CLIENT_SECRET)
  })

  it('identity fields are not secrets and display their real value', () => {
    const config = resolveTeamConfig({
      [ENV_GITHUB_ORG]: 'rhizomorph-team',
      [ENV_GITHUB_APP_ID]: '123456',
    })
    expect(config.githubOrgLogin.display).toBe('rhizomorph-team')
    expect(config.githubAppId.display).toBe('123456')
  })
})

describe('case 38 — the private key is a file, and a bad file is a named fault', () => {
  const FAKE_KEY_FILE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nFAKE-FROM-FILE\n-----END RSA PRIVATE KEY-----\n'
  const FAKE_INLINE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nFAKE-INLINE\n-----END RSA PRIVATE KEY-----'
  const KEY_PATH = '/run/secrets/github-app-private-key.pem'

  function countingReader(result: string | (() => never)): { read: ReadTextFileSync; paths: string[] } {
    const paths: string[] = []
    const read: ReadTextFileSync = (filePath) => {
      paths.push(filePath)
      if (typeof result === 'string') return result
      return result()
    }
    return { read, paths }
  }

  it('the file wins when both are set', () => {
    const { read, paths } = countingReader(FAKE_KEY_FILE_PEM)
    const config = resolveTeamConfig(
      { [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH, [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_INLINE_PEM },
      read,
    )
    expect(config.githubAppPrivateKey.value).toBe(FAKE_KEY_FILE_PEM)
    expect(config.githubAppPrivateKey.value).not.toBe(FAKE_INLINE_PEM)
    expect(config.githubAppPrivateKey.setBy).toBe('environment')
    expect(config.githubAppPrivateKey.source).toBe(ENV_GITHUB_APP_PRIVATE_KEY_FILE)
    expect(config.githubAppPrivateKey.display).toBe('<redacted>')
    expect(paths).toEqual([KEY_PATH])
  })

  it('the inline variable is used, unchanged, when only it is set', () => {
    const { read, paths } = countingReader(FAKE_KEY_FILE_PEM)
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_INLINE_PEM }, read)
    expect(config.githubAppPrivateKey.value).toBe(FAKE_INLINE_PEM)
    expect(config.githubAppPrivateKey.source).toBe(ENV_GITHUB_APP_PRIVATE_KEY)
    expect(paths).toEqual([])
  })

  /**
   * THE COMPOSE SHAPE, NOT JUST THE ABSENT-VARIABLE SHAPE (found in review).
   *
   * `docker compose config` on an unconfigured deployment resolves
   * `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE` to `''` — an EMPTY STRING, never an
   * absent key — because `compose.yml` writes
   * `${RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH:+/run/secrets/...}` and an unset
   * `_PATH` makes `:+` substitute nothing. Every other case in this describe
   * block resolves `{}`, which never exercises that branch of
   * `privateKeyValue`'s guard (`filePath === undefined || filePath === ''`).
   * Without this, deleting the `|| filePath === ''` half of that guard leaves
   * the whole suite green while a real unconfigured deployment reports
   * `<key file unreadable: : ENOENT …>` against a path nobody set — the exact
   * undiagnosable refusal this issue exists to prevent.
   *
   * MUTATION: in `config.ts`, change
   * `if (filePath === undefined || filePath === '')` to
   * `if (filePath === undefined)` — red on both assertions below.
   */
  it('an empty-string `_FILE` is treated the same as an absent one — compose\'s actual unconfigured shape', () => {
    const { read, paths } = countingReader(FAKE_KEY_FILE_PEM)
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: '' }, read)
    expect(config.githubAppPrivateKey.display).toBe('<unset>')
    expect(config.githubAppPrivateKey.value).toBe('')
    expect(config.githubAppPrivateKey.setBy).toBe('default')
    expect(keyFileFault(config.githubAppPrivateKey)).toBeNull()
    expect(paths).toEqual([])

    const withInline = resolveTeamConfig(
      { [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: '', [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_INLINE_PEM },
      read,
    )
    expect(withInline.githubAppPrivateKey.value).toBe(FAKE_INLINE_PEM)
    expect(withInline.githubAppPrivateKey.source).toBe(ENV_GITHUB_APP_PRIVATE_KEY)
  })

  it('neither set is `<unset>`, `default`, and this file as the source', () => {
    const config = resolveTeamConfig({})
    expect(config.githubAppPrivateKey.value).toBe('')
    expect(config.githubAppPrivateKey.setBy).toBe('default')
    expect(config.githubAppPrivateKey.source).toBe('packages/team/src/config/config.ts')
    expect(config.githubAppPrivateKey.display).toBe('<unset>')
    expect(keyFileFault(config.githubAppPrivateKey)).toBeNull()
  })

  it('an absent file is a NAMED fault, and not the same observation as unset', () => {
    const read: ReadTextFileSync = () => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${KEY_PATH}'`), { code: 'ENOENT' })
    }
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(config.githubAppPrivateKey.value).toBe('')
    expect(config.githubAppPrivateKey.display).not.toBe('<unset>')
    expect(config.githubAppPrivateKey.display).toContain('unreadable')
    expect(config.githubAppPrivateKey.display).toContain(KEY_PATH)
    expect(config.githubAppPrivateKey.display).toContain('ENOENT')
    expect(keyFileFault(config.githubAppPrivateKey)).not.toBeNull()
    expect(config.githubAppPrivateKey.source).toBe(ENV_GITHUB_APP_PRIVATE_KEY_FILE)
  })

  it('an unreadable file is a different fault from an absent one only in its reason, and both are distinguishable from empty', () => {
    const read: ReadTextFileSync = () => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${KEY_PATH}'`), { code: 'EACCES' })
    }
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(config.githubAppPrivateKey.display).toContain('EACCES')

    const enoent = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, () => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${KEY_PATH}'`), { code: 'ENOENT' })
    })
    expect(config.githubAppPrivateKey.display).not.toBe(enoent.githubAppPrivateKey.display)
  })

  it('an empty file is its own fault', () => {
    const read: ReadTextFileSync = () => '   \n'
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(config.githubAppPrivateKey.display).toContain('empty')
    expect(config.githubAppPrivateKey.display).toContain(KEY_PATH)
    expect(config.githubAppPrivateKey.display).not.toBe('<unset>')
    expect(config.githubAppPrivateKey.display).not.toBe('<redacted>')
    expect(config.githubAppPrivateKey.value).toBe('')
  })

  it('a non-Error throw still produces a fault, not a crash', () => {
    const read: ReadTextFileSync = () => {
      throw 'boom'
    }
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(keyFileFault(config.githubAppPrivateKey)).not.toBeNull()
    expect(config.githubAppPrivateKey.display).toContain('boom')
  })

  it('the inline path is untouched by all of this', () => {
    expect(resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_INLINE_PEM }).githubAppPrivateKey.display).toBe(
      '<redacted>',
    )
  })

  it("the fault display never carries the key's bytes", () => {
    const read: ReadTextFileSync = () => FAKE_KEY_FILE_PEM
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(config.githubAppPrivateKey.display).not.toContain(FAKE_KEY_FILE_PEM)
    expect(config.githubAppPrivateKey.display).not.toContain(FAKE_KEY_FILE_PEM.slice(0, 40))
  })

  it('`keyFileFault` is not vacuous', () => {
    expect(keyFileFault(resolveTeamConfig({}).githubAppPrivateKey)).toBeNull()
    expect(
      keyFileFault(resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_INLINE_PEM }).githubAppPrivateKey),
    ).toBeNull()

    const unreadable = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, () => {
      throw new Error('boom')
    })
    expect(keyFileFault(unreadable.githubAppPrivateKey)).not.toBeNull()

    const empty = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, () => '   ')
    expect(keyFileFault(empty.githubAppPrivateKey)).not.toBeNull()
  })

  it('repetition — one read per resolve, not a cache and not a double read', () => {
    const { read, paths } = countingReader(FAKE_KEY_FILE_PEM)
    const first = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(paths.length).toBe(1)
    const second = resolveTeamConfig({ [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: KEY_PATH }, read)
    expect(paths.length).toBe(2)
    expect(second).toEqual(first)
  })
})
