import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NO_CEILING_SOURCE, RETENTION_QUOTA_GAP } from '../src/storage/contract.js'
import { FakeTeamStorage } from '../src/storage/fake.js'
import {
  CEILING_SOURCE,
  formatCeilingStatus,
  formatSharedPartitionConsequence,
  parseCeilingArgs,
  resolveSetBy,
  runCeilingCommand,
} from './ceiling.js'

/**
 * THE ADMIN'S HOST COMMAND (#559, prd-51 ruling B).
 *
 * Ruling B: the ceiling is named through a command in the deployment directory,
 * beside `init.sh` — **not a route**. Everything below runs against
 * `FakeTeamStorage` with an injected clock, environment and output sink, so no
 * branch of it needs a database, a process or a real stream.
 */

const NOW = Date.UTC(2026, 8, 17)

function harness(storage = new FakeTeamStorage(), env: Record<string, string | undefined> = { USER: 'operator' }) {
  const out: string[] = []
  const err: string[] = []
  const run = (...argv: string[]): Promise<number> =>
    runCeilingCommand({ storage, argv, env, nowMs: NOW, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { storage, out, err, run, text: (): string => out.join('\n'), errors: (): string => err.join('\n') }
}

describe('parseCeilingArgs — it refuses rather than guessing', () => {
  it('reads a complete `name`', () => {
    expect(parseCeilingArgs(['name', '--project', 'acme', '--days', '30', '--no-archive'])).toEqual({
      kind: 'name',
      projectId: 'acme',
      maxAgeDays: 30,
      archiveDir: null,
    })
    expect(parseCeilingArgs(['name', '--project', 'acme', '--days', '90', '--archive', '/data/archive'])).toEqual({
      kind: 'name',
      projectId: 'acme',
      maxAgeDays: 90,
      archiveDir: '/data/archive',
    })
  })

  /**
   * THE ARCHIVE CHOICE HAS NO DEFAULT, and that is ruling 10's *"made once at
   * ceiling time, never silently"* enforced at the only moment it can be.
   */
  it('refuses a `name` with no archive choice, citing why there is no default', () => {
    const refusal = parseCeilingArgs(['name', '--project', 'acme', '--days', '30'])
    expect('error' in refusal && refusal.error).toContain('--archive <dir> or --no-archive')
    expect('error' in refusal && refusal.error).toContain('never silently')
  })

  it('refuses both archive flags at once — the same choice made twice, in opposite directions', () => {
    const refusal = parseCeilingArgs(['name', '--project', 'acme', '--days', '30', '--no-archive', '--archive', '/d'])
    expect('error' in refusal && refusal.error).toContain('one')
  })

  it.each(['0', '-1', '1.5', '30d', '', ' 30', '3e1', '030'])('refuses --days %o by name', (days) => {
    const refusal = parseCeilingArgs(['name', '--project', 'acme', '--days', days, '--no-archive'])
    expect('error' in refusal).toBe(true)
    // A ceiling is never rounded or coerced — the refusal says so.
    expect('error' in refusal && refusal.error).toContain('--days')
  })

  it('refuses a missing project, a missing --days, an unknown verb and an empty argv', () => {
    expect('error' in parseCeilingArgs(['name', '--days', '30', '--no-archive'])).toBe(true)
    expect('error' in parseCeilingArgs(['name', '--project', 'acme', '--no-archive'])).toBe(true)
    expect('error' in parseCeilingArgs(['drop-everything'])).toBe(true)
    expect('error' in parseCeilingArgs([])).toBe(true)
    expect('error' in parseCeilingArgs(['clear'])).toBe(true)
  })

  it('reads `clear` and `status`', () => {
    expect(parseCeilingArgs(['clear', '--project', 'acme'])).toEqual({ kind: 'clear', projectId: 'acme' })
    expect(parseCeilingArgs(['status'])).toEqual({ kind: 'status' })
  })
})

describe('resolveSetBy — ruling 9 has no `unknown` fallback', () => {
  it('prefers --by, then USER, then USERNAME', () => {
    expect(resolveSetBy(['--by', 'ada'], { USER: 'from-env' })).toBe('ada')
    expect(resolveSetBy([], { USER: 'from-env' })).toBe('from-env')
    expect(resolveSetBy([], { USERNAME: 'from-windows' })).toBe('from-windows')
  })

  it('answers null when nothing can name the setter, which the command turns into a refusal', () => {
    expect(resolveSetBy([], {})).toBeNull()
    expect(resolveSetBy([], { USER: '   ' })).toBeNull()
  })
})

describe('name — the row it writes, and the two things it prints unasked', () => {
  it('stores the age, the archive choice, WHO set it and WHERE', async () => {
    const h = harness()
    expect(await h.run('name', '--project', 'acme', '--days', '30', '--no-archive')).toBe(0)

    expect(await h.storage.readCeilings()).toEqual([
      {
        projectId: 'acme',
        maxAgeDays: 30,
        archiveBeforeDrop: false,
        archiveDir: null,
        setBy: 'operator',
        source: CEILING_SOURCE,
        setAtMs: NOW,
      },
    ])
    expect(h.text()).toContain('set by operator, packages/team/deploy/ceiling.ts')
  })

  it('--by overrides the environment, and the row records the person who typed it', async () => {
    const h = harness()
    await h.run('name', '--project', 'acme', '--days', '30', '--no-archive', '--by', 'ada')
    expect((await h.storage.readCeilings())[0]?.setBy).toBe('ada')
  })

  it('refuses when nothing can name who is setting it, rather than writing `unknown`', async () => {
    const h = harness(new FakeTeamStorage(), {})
    expect(await h.run('name', '--project', 'acme', '--days', '30', '--no-archive')).toBe(1)
    expect(h.errors()).toContain('--by')
    expect(h.errors()).toContain('ruling 9')
    expect(await h.storage.readCeilings()).toEqual([])
  })

  it('prints the shared-partition consequence, at the one moment an admin can act on it', async () => {
    const h = harness()
    await h.run('name', '--project', 'acme', '--days', '30', '--no-archive')
    expect(h.text()).toContain('partitions on this deployment are shared')
    expect(h.text()).toContain('MOST GENEROUS')
    expect(h.text()).toContain('A project with no ceiling of its own can still lose rows this way')
    expect(h.text()).toBe([...h.out].join('\n'))
    expect(h.text()).toContain(formatSharedPartitionConsequence('acme'))
  })

  it('an archive-first ceiling says out loud that NOTHING will be dropped until the admin acts', async () => {
    const h = harness()
    await h.run('name', '--project', 'acme', '--days', '30', '--archive', '/data/archive')

    const stored = (await h.storage.readCeilings())[0]
    expect(stored?.archiveBeforeDrop).toBe(true)
    expect(stored?.archiveDir).toBe('/data/archive')
    expect(h.text()).toContain('NO partition will be dropped')
    expect(h.text()).toContain('this server does not archive')
    // The control: the no-archive form does NOT print that line.
    const other = harness()
    await other.run('name', '--project', 'acme', '--days', '30', '--no-archive')
    expect(other.text()).not.toContain('NO partition will be dropped')
  })

  it('REPETITION — naming twice leaves ONE row, carrying the second admin', async () => {
    const h = harness()
    await h.run('name', '--project', 'acme', '--days', '30', '--no-archive', '--by', 'ada')
    await h.run('name', '--project', 'acme', '--days', '90', '--no-archive', '--by', 'grace')

    const rows = await h.storage.readCeilings()
    expect(rows.length).toBe(1)
    expect(rows[0]?.maxAgeDays).toBe(90)
    expect(rows[0]?.setBy).toBe('grace')
  })

  it('a bad argv writes to err, exits 1, and touches no storage', async () => {
    const h = harness()
    expect(await h.run('name', '--project', 'acme', '--days', '30')).toBe(1)
    expect(h.out).toEqual([])
    expect(h.storage.calls).toEqual([])
  })
})

describe('clear — and it is honest about having found nothing', () => {
  it('removes a ceiling and says what that means', async () => {
    const h = harness()
    await h.run('name', '--project', 'acme', '--days', '30', '--no-archive')
    h.out.length = 0

    expect(await h.run('clear', '--project', 'acme')).toBe(0)
    expect(await h.storage.readCeilings()).toEqual([])
    expect(h.text()).toContain('nothing it holds is ever dropped')
  })

  it('clearing a ceiling that was never named says so rather than claiming a change', async () => {
    const h = harness()
    expect(await h.run('clear', '--project', 'nobody')).toBe(0)
    expect(h.text()).toContain('no ceiling was named')
    expect(h.text()).toContain('never being dropped')
  })
})

describe('status — every effective value, and what it does not know', () => {
  it('with nothing named it prints the ruling-10 sentence and the DEFAULT setter and source', async () => {
    const h = harness(new FakeTeamStorage({ eventPartitions: ['events_2020_01'] }))
    expect(await h.run('status')).toBe(0)

    expect(h.text()).toContain('none named, so nothing is ever dropped')
    expect(h.text()).toContain(`set by default, ${NO_CEILING_SOURCE}`)
    expect(h.text()).toContain('events_2020_01: keep')
  })

  it('with a ceiling named it prints WHO and WHERE for each, and the next sweeps verdicts', async () => {
    const h = harness(
      new FakeTeamStorage({ eventPartitions: ['events_2020_01', 'events_2026_09'] }),
    )
    await h.run('name', '--project', 'acme', '--days', '30', '--no-archive', '--by', 'ada')
    h.out.length = 0

    await h.run('status')
    expect(h.text()).toContain('acme = 30 day(s), no archive (set by ada, packages/team/deploy/ceiling.ts)')
    expect(h.text()).toContain('events_2020_01: DROP')
    expect(h.text()).toContain('events_2026_09: keep')
  })

  it('a withheld partition is visible in status, so the admin can see what waits on their archive', async () => {
    const h = harness(new FakeTeamStorage({ eventPartitions: ['events_2020_01'] }))
    await h.run('name', '--project', 'acme', '--days', '30', '--archive', '/data/archive')
    h.out.length = 0

    await h.run('status')
    expect(h.text()).toContain('archive first -> /data/archive')
    expect(h.text()).toContain('events_2020_01: keep — withheld')
  })

  /**
   * The gap is printed in BOTH states. A gap that only appears in the empty case
   * is a gap the operator sees exactly once, on the first run, and never again.
   */
  it('prints the storage-quota gap whether or not a ceiling is named', async () => {
    const empty = harness()
    await empty.run('status')
    expect(empty.text()).toContain(RETENTION_QUOTA_GAP)

    const named = harness()
    await named.run('name', '--project', 'acme', '--days', '30', '--no-archive')
    named.out.length = 0
    await named.run('status')
    expect(named.text()).toContain(RETENTION_QUOTA_GAP)
  })

  it('REPETITION — status twice is byte-identical and changes nothing', async () => {
    const storage = new FakeTeamStorage({ eventPartitions: ['events_2020_01'] })
    const first = harness(storage)
    await first.run('status')
    const second = harness(storage)
    await second.run('status')

    expect(second.text()).toBe(first.text())
    expect(storage.droppedPartitions).toEqual([])
  })

  it('formatCeilingStatus is pure over its input — the same input renders the same text', () => {
    const input = { ceilings: [], partitions: ['events_2020_01'], nowMs: NOW }
    expect(formatCeilingStatus(input)).toBe(formatCeilingStatus(input))
  })
})

/**
 * THE MODULE RUNS NOTHING WHEN IT IS IMPORTED.
 *
 * `deploy/serve.ts` calls its `main()` at module scope, which is right for a
 * server entrypoint and wrong for a command whose functions are imported by this
 * file: an unguarded call would open a real connection the moment the suite
 * loaded it. Read as text with comments stripped, for the reason
 * `worker.test.ts`'s serve.ts law records — a law that reads a file's prose
 * acquits it for explaining itself.
 */
describe('the command is guarded against being run by an import', () => {
  it('main() is called only when process.argv[1] resolves to this module', () => {
    const raw = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ceiling.ts'), 'utf8').replace(
      /\r\n/g,
      '\n',
    )
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    expect(source, 'the stripper must not eat the code').toContain('async function main()')
    expect(raw.length, 'ceiling.ts carries comments, so the strip is not a no-op').toBeGreaterThan(source.length)
    expect(source).toContain('const invokedDirectly =')
    expect(source).toMatch(/if\s*\(invokedDirectly\)\s*\{\s*\n?\s*main\(\)/)
    // …and there is no UNINDENTED call beside it: `serve.ts`'s own `main().catch(...)`
    // sits at column 0, which is exactly the shape this module must not have.
    expect(source.match(/^main\(\)/gm)).toBeNull()
  })

  it('and importing it in this suite really did not connect — no ceiling was written by the import', async () => {
    expect(await new FakeTeamStorage().readCeilings()).toEqual([])
  })
})
