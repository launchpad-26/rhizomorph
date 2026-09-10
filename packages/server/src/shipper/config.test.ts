import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertShippableUrl,
  cursorPath,
  ingestKeyPath,
  readTeamConfig,
  shipperDirFor,
  TEAM_CONFIG_VERSION,
  teamConfigPath,
  writeTeamConfig,
} from './config.js'

let sessionDir: string

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-config-'))
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe('the enable record — absent is off, and off is the only state in which nothing can leave', () => {
  it('puts all four files in one flat directory beside the session logs', () => {
    const dir = shipperDirFor(sessionDir)
    expect(dir).toBe(path.join(sessionDir, 'shipper'))
    expect(teamConfigPath(sessionDir)).toBe(path.join(dir, 'team.json'))
    expect(ingestKeyPath(sessionDir)).toBe(path.join(dir, 'ingest.key'))
    expect(cursorPath(sessionDir)).toBe(path.join(dir, 'cursor.json'))
  })

  it('reads an absent record as null — the hand is off', async () => {
    expect(await readTeamConfig(sessionDir)).toBeNull()
  })

  it('round-trips, and stores no credential of any kind in the enable record', async () => {
    const config = {
      version: TEAM_CONFIG_VERSION,
      url: 'https://team.example/',
      project: 'acme-widgets',
      enabledAt: 1785900000000,
    } as const
    await writeTeamConfig(sessionDir, config)

    expect(await readTeamConfig(sessionDir)).toEqual(config)
    const raw = await readFile(teamConfigPath(sessionDir), 'utf8')
    expect(raw).not.toMatch(/rzk_/)
    expect(JSON.parse(raw)).toEqual(config)
  })

  it('writes the enable record 0644 — it is configuration, not a credential', async () => {
    if (process.platform === 'win32') return
    await writeTeamConfig(sessionDir, {
      version: TEAM_CONFIG_VERSION,
      url: 'https://team.example/',
      project: 'acme-widgets',
      enabledAt: 1,
    })
    expect((await stat(teamConfigPath(sessionDir))).mode & 0o777).toBe(0o644)
  })

  it('a corrupt record throws and names the path — it must never read as "off"', async () => {
    await mkdir(shipperDirFor(sessionDir), { recursive: true })
    await writeFile(teamConfigPath(sessionDir), '{ not json')
    await expect(readTeamConfig(sessionDir)).rejects.toThrow(teamConfigPath(sessionDir))

    await writeFile(teamConfigPath(sessionDir), JSON.stringify({ version: 9, url: 'https://x/', project: 'p', enabledAt: 0 }))
    await expect(readTeamConfig(sessionDir)).rejects.toThrow(/version 1 record/)
  })
})

describe('the destination is https, or loopback http, and nothing else', () => {
  it('accepts https anywhere', () => {
    expect(assertShippableUrl('https://team.example').protocol).toBe('https:')
    expect(assertShippableUrl('https://team.example:8443/base/').protocol).toBe('https:')
    // A prefix WITHOUT a trailing slash is accepted too, and deliberately: a
    // team server behind a proxy mounted on a path is an ordinary deployment.
    // Keeping that prefix is `ingestUrlFor`'s job in `post.ts`, and pinned there.
    expect(assertShippableUrl('https://team.example:8443/base').pathname).toBe('/base')
  })

  it('accepts plain http only for a loopback host, so a team server can be developed against', () => {
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080/', 'http://[::1]:8080']) {
      expect(assertShippableUrl(url).protocol).toBe('http:')
    }
  })

  it('refuses plain http to anywhere else, by name and with the remedy', () => {
    expect(() => assertShippableUrl('http://team.example')).toThrow(/loopback/)
    expect(() => assertShippableUrl('http://team.example')).toThrow(/https:\/\//)
  })

  it('refuses a scheme this hand does not speak, and a value that is not a URL at all', () => {
    expect(() => assertShippableUrl('file:///etc/passwd')).toThrow(/"file:" is not a scheme/)
    expect(() => assertShippableUrl('ws://team.example')).toThrow(/"ws:" is not a scheme/)
    expect(() => assertShippableUrl('team.example')).toThrow(/not a URL/)
  })

  /**
   * The sibling of the path case above, and the one the path case makes
   * tempting to get wrong: `assertShippableUrl` checked scheme and hostname
   * only, so a base spelled `https://user:pw@team.example` was accepted, and
   * `writeTeamConfig` then wrote it verbatim into a file this suite pins at
   * `0644` four cases up. `cli/doctor.ts` prints that url in the same sentence
   * that says a credential's value is never shown, and `no-key-in-output-law`
   * cannot see it because the value never passes through `IngestKey`.
   */
  it('refuses a base carrying userinfo — the enable record is 0644, and a URL password would land in it', () => {
    expect(() => assertShippableUrl('https://svc:s3cr3t@team.example/rhizo')).toThrow(/username or password/)
    expect(() => assertShippableUrl('https://svc:s3cr3t@team.example/rhizo')).toThrow(/0644/)
    // A username with no password is the same leak one field smaller.
    expect(() => assertShippableUrl('https://svc@team.example')).toThrow(/username or password/)
    // Loopback http takes the same refusal: the file it would be written to is the same file.
    expect(() => assertShippableUrl('http://svc:s3cr3t@127.0.0.1:8080')).toThrow(/username or password/)
  })

  it('does not put the value it refuses into the message it throws', () => {
    // The refusal is printed to a terminal and can reach a log, so the message
    // may name the destination but never the secret. `raw` carries it, which is
    // why this refusal does not go through `failUrl`.
    let message = ''
    try {
      assertShippableUrl('https://svc:s3cr3t@team.example/rhizo')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/username or password/)
    expect(message).not.toContain('s3cr3t')
    expect(message).not.toContain('svc:')
    expect(message).toContain('https://team.example/rhizo')
  })

  it('refuses a query string or a fragment on the base, which appending the ingest path would silently drop', () => {
    expect(() => assertShippableUrl('https://team.example/rhizo?tok=abc')).toThrow(/query string/)
    expect(() => assertShippableUrl('https://team.example/rhizo#frag')).toThrow(/fragment/)
  })

  it('refuses userinfo at WRITE, so the value never reaches the 0644 file', async () => {
    await expect(
      writeTeamConfig(sessionDir, {
        version: TEAM_CONFIG_VERSION,
        url: 'https://svc:s3cr3t@team.example/rhizo',
        project: 'acme-widgets',
        enabledAt: 1,
      }),
    ).rejects.toThrow(/username or password/)
    expect(await readTeamConfig(sessionDir)).toBeNull()
  })

  it('refuses at WRITE, so an unusable destination is never stored', async () => {
    await expect(
      writeTeamConfig(sessionDir, {
        version: TEAM_CONFIG_VERSION,
        url: 'http://team.example',
        project: 'acme-widgets',
        enabledAt: 1,
      }),
    ).rejects.toThrow(/loopback/)
    expect(await readTeamConfig(sessionDir)).toBeNull()
  })
})
