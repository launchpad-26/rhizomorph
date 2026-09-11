import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createEvent, eventToLine } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionDirFor } from '../log/paths.js'
// Through the declared importer, never `../shipper/index.js`: this file is
// outside the hand, and `shipper/hand-law.test.ts`'s bounded sweep convicts
// ANY file outside it that reaches the hand by another route — a test file
// included.
import {
  connectHelpText,
  parseConnectTeamArgs,
  runConnectCommand,
  shipperCursorPath,
  shipperDoctorFacts,
  shipperKeyPath,
  shipperTeamConfigPath,
} from './connect-team.js'

const FIXTURE_KEY = 'rzk_CLIFIXTUREVALUE0123456789'
const OTHER_KEY = 'rzk_CLISECONDVALUE9876543210'
const POSIX = process.platform !== 'win32'

let repoPath: string
let dataRoot: string
let sessionDir: string
let logged: string[]
let errored: string[]

/** `process.exit`'s stand-in: throws so a command's `exit(n)` unwinds into the test instead of killing the runner. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const exit = (code: number): never => {
  throw new Exited(code)
}

const log = {
  log: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
} as unknown as Pick<Console, 'log' | 'warn'>

function stdinOf(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  return Readable.from([Buffer.from(text, 'utf8')]) as NodeJS.ReadableStream & { isTTY?: boolean }
}

function tty(): NodeJS.ReadableStream & { isTTY?: boolean } {
  return Object.assign(Readable.from([]), { isTTY: true }) as NodeJS.ReadableStream & { isTTY?: boolean }
}

function acceptingFetch(sent: unknown[] = []): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { batch: unknown[] }
    sent.push(body)
    return new Response(JSON.stringify({ accepted: body.batch.length, journalSeq: 1 }), { status: 202 })
  }) as typeof globalThis.fetch
}

/** Runs the command and returns its exit code, whatever it was. */
async function run(
  argv: readonly string[],
  seams: Parameters<typeof runConnectCommand>[4] = {},
): Promise<number> {
  try {
    await runConnectCommand(argv, log, exit, { dataRoot }, seams)
  } catch (err) {
    if (err instanceof Exited) return err.code
    throw err
  }
  throw new Error('the command returned without exiting')
}

beforeEach(async () => {
  repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-connect-repo-'))
  dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-connect-data-'))
  sessionDir = sessionDirFor(repoPath, dataRoot)
  logged = []
  errored = []
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errored.push(String(chunk))
    return true
  }) as never)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([
    rm(repoPath, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
  ])
})

describe('rhizomorph connect team — argv', () => {
  it('--help prints to stdout, exits 0, and shows no stack trace', async () => {
    expect(await run(['team', '--help'])).toBe(0)
    expect(logged.join('\n')).toContain('rhizomorph connect team')
    expect(logged.join('\n')).toContain('STANDARD INPUT')
    expect(errored).toEqual([])
    expect(logged.join('\n')).not.toContain('    at ')
  })

  it('a bare `connect` prints the usage table rather than guessing', async () => {
    expect(await run([])).toBe(0)
    expect(logged.join('\n')).toBe(connectHelpText())
  })

  it('an unknown connect subcommand fails cleanly on stderr with the usage table', async () => {
    expect(await run(['teem'])).toBe(1)
    expect(errored.join('')).toContain('unknown connect subcommand: "teem"')
    expect(errored.join('')).not.toContain('    at ')
  })

  it('parses the three forms, and refuses the shapes that contradict themselves', () => {
    expect(parseConnectTeamArgs(['https://team.example', '--project', 'acme'])).toMatchObject({
      mode: 'enable',
      url: 'https://team.example',
      project: 'acme',
    })
    expect(parseConnectTeamArgs(['--status'])).toMatchObject({ mode: 'status' })
    expect(parseConnectTeamArgs(['--ship', '--interval', '90', '--once'])).toMatchObject({
      mode: 'ship',
      intervalMs: 90_000,
      once: true,
    })

    expect(() => parseConnectTeamArgs(['--status', '--ship'])).toThrow(/one of them, not both/)
    expect(() => parseConnectTeamArgs(['--project', 'acme'])).toThrow(/<url>/)
    expect(() => parseConnectTeamArgs(['https://team.example'])).toThrow(/--project/)
    expect(() => parseConnectTeamArgs(['--status', '--interval', '30'])).toThrow(/--interval applies to --ship/)
    expect(() => parseConnectTeamArgs(['--ship', '--interval', 'soon'])).toThrow(/invalid --interval/)
  })

  it('has no --key flag at all — prd-38 ruling 4 puts a credential on argv on the never-list', () => {
    expect(connectHelpText()).not.toContain('--key')
    expect(() => parseConnectTeamArgs(['https://team.example', '--project', 'acme', '--key', FIXTURE_KEY])).toThrow(
      /unknown option: "--key"/,
    )
  })
})

describe('enabling — the key arrives on stdin and is never displayed', () => {
  it('writes both files, exits 0, and prints what will leave without printing the key', async () => {
    expect(await run(['team', 'https://team.example', '--project', 'acme-widgets', repoPath], { stdin: stdinOf(`${FIXTURE_KEY}\n`), now: () => 42 })).toBe(0)

    expect(JSON.parse(await readFile(shipperTeamConfigPath(repoPath, dataRoot), 'utf8'))).toEqual({
      version: 1,
      url: 'https://team.example',
      project: 'acme-widgets',
      enabledAt: 42,
    })
    expect(await readFile(shipperKeyPath(repoPath, dataRoot), 'utf8')).toBe(`${FIXTURE_KEY}\n`)

    const printed = logged.join('\n')
    expect(printed).toContain('https://team.example')
    expect(printed).toContain('acme-widgets')
    expect(printed).toContain(shipperKeyPath(repoPath, dataRoot))
    expect(printed).toContain('delete')
    expect(printed).not.toContain(FIXTURE_KEY)
    // Not even a prefix of it: a piece of a secret is still a piece of one.
    expect(printed).not.toContain(FIXTURE_KEY.slice(0, 12))
  })

  it('refuses a TTY stdin by name, with the pipe form as its remedy', async () => {
    expect(await run(['team', 'https://team.example', '--project', 'acme', repoPath], { stdin: tty() })).toBe(1)
    expect(errored.join('')).toContain('no key on stdin — pipe it:')
    expect(errored.join('')).toContain('| rhizomorph connect team')
    await expect(stat(shipperTeamConfigPath(repoPath, dataRoot))).rejects.toThrow()
  })

  it('refuses an empty stdin, and a value that is not an ingest key', async () => {
    expect(await run(['team', 'https://team.example', '--project', 'acme', repoPath], { stdin: stdinOf('\n') })).toBe(1)
    expect(errored.join('')).toContain('nothing arrived on stdin')

    errored = []
    expect(
      await run(['team', 'https://team.example', '--project', 'acme', repoPath], {
        stdin: stdinOf('ghp_notoursatall0123456789\n'),
      }),
    ).toBe(1)
    expect(errored.join('')).toContain('rzk_')
    await expect(stat(shipperTeamConfigPath(repoPath, dataRoot))).rejects.toThrow()
  })

  it('refuses a destination it will not ship to, and stores nothing when it does', async () => {
    expect(
      await run(['team', 'http://team.example', '--project', 'acme', repoPath], { stdin: stdinOf(FIXTURE_KEY) }),
    ).toBe(1)
    expect(errored.join('')).toContain('loopback')
    await expect(stat(shipperTeamConfigPath(repoPath, dataRoot))).rejects.toThrow()
  })

  it('repetition: enabling again replaces the key, keeps the mode, and leaves the cursor alone', async () => {
    await run(['team', 'https://team.example', '--project', 'acme', repoPath], { stdin: stdinOf(FIXTURE_KEY), now: () => 1 })
    await writeFile(
      path.join(sessionDir, 'session-1785900000000.jsonl'),
      `${eventToLine(createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 }))}\n`,
    )
    await run(['team', '--ship', '--once', repoPath], { fetch: acceptingFetch() })
    const cursorBefore = await readFile(shipperCursorPath(repoPath, dataRoot), 'utf8')

    expect(
      await run(['team', 'https://team.example', '--project', 'acme', repoPath], { stdin: stdinOf(OTHER_KEY), now: () => 2 }),
    ).toBe(0)

    expect(await readFile(shipperKeyPath(repoPath, dataRoot), 'utf8')).toBe(`${OTHER_KEY}\n`)
    if (POSIX) expect((await stat(shipperKeyPath(repoPath, dataRoot))).mode & 0o777).toBe(0o600)
    expect(await readFile(shipperCursorPath(repoPath, dataRoot), 'utf8')).toBe(cursorBefore)
  })
})

describe('--status and --ship', () => {
  it('reports off before anything is enabled, and exits 0', async () => {
    expect(await run(['team', '--status', repoPath])).toBe(0)
    expect(logged.join('\n')).toContain('shipper: off')
    expect(logged.join('\n')).toContain('echo "$RZK_INGEST_KEY"')
  })

  it('--ship refuses when the hand is not enabled, and names the enable command', async () => {
    expect(await run(['team', '--ship', repoPath])).toBe(1)
    expect(errored.join('')).toContain('not enabled for this repo')
    expect(errored.join('')).toContain('rhizomorph connect team <url> --project <id>')
  })

  it('--ship --once posts one batch and exits 0', async () => {
    await run(['team', 'https://team.example', '--project', 'acme-widgets', repoPath], { stdin: stdinOf(FIXTURE_KEY) })
    await writeFile(
      path.join(sessionDir, 'session-1785900000000.jsonl'),
      [
        eventToLine(createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 })),
        eventToLine(createEvent('pane.activity', { paneId: '%2', contentHash: 'h2', previousHash: null }, { id: 'e2', ts: 1785900000001 })),
        '',
      ].join('\n'),
    )
    const sent: unknown[] = []

    expect(await run(['team', '--ship', '--once', repoPath], { fetch: acceptingFetch(sent) })).toBe(0)

    expect(sent).toHaveLength(1)
    expect(logged.join('\n')).toContain('shipped 2 lines')
  })

  it('--status after a pass reports the destination, the project and each session\'s n, and never the key', async () => {
    await run(['team', 'https://team.example', '--project', 'acme-widgets', repoPath], { stdin: stdinOf(FIXTURE_KEY) })
    await writeFile(
      path.join(sessionDir, 'session-1785900000000.jsonl'),
      `${eventToLine(createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 }))}\n`,
    )
    await run(['team', '--ship', '--once', repoPath], { fetch: acceptingFetch() })
    logged = []

    expect(await run(['team', '--status', repoPath])).toBe(0)
    const printed = logged.join('\n')
    expect(printed).toContain('shipper: on')
    expect(printed).toContain('https://team.example')
    expect(printed).toContain('acme-widgets')
    expect(printed).toContain('session 1785900000000  through n=1')
    expect(printed).toContain('credential  present')
    expect(printed).not.toContain(FIXTURE_KEY)
  })
})

describe("the doctor's read — presence and counts, never a value", () => {
  it('reports the off state with nothing else in it', async () => {
    expect(await shipperDoctorFacts(repoPath, dataRoot)).toMatchObject({
      enabled: false,
      url: null,
      keyPresent: false,
      maxN: 0,
    })
  })

  it('reports presence, the destination and how far, and carries no value on any field', async () => {
    await run(['team', 'https://team.example', '--project', 'acme-widgets', repoPath], { stdin: stdinOf(FIXTURE_KEY) })
    await writeFile(
      path.join(sessionDir, 'session-1785900000000.jsonl'),
      `${eventToLine(createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 }))}\n`,
    )
    await run(['team', '--ship', '--once', repoPath], { fetch: acceptingFetch() })

    const facts = await shipperDoctorFacts(repoPath, dataRoot)
    expect(facts).toMatchObject({
      enabled: true,
      url: 'https://team.example',
      project: 'acme-widgets',
      keyPresent: true,
      maxN: 1,
      sessionCount: 1,
      configError: null,
    })
    if (POSIX) expect(facts.keyMode).toBe(0o600)
    expect(JSON.stringify(facts)).not.toContain(FIXTURE_KEY)
  })

  it('a corrupt enable record is a configError, not a quiet "off"', async () => {
    await run(['team', 'https://team.example', '--project', 'acme', repoPath], { stdin: stdinOf(FIXTURE_KEY) })
    await writeFile(shipperTeamConfigPath(repoPath, dataRoot), '{ not json')

    const facts = await shipperDoctorFacts(repoPath, dataRoot)
    expect(facts.enabled).toBe(false)
    expect(facts.configError).toContain('team.json')
  })
})
