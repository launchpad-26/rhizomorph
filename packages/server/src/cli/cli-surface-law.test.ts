import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `cli/index.ts`'s dispatch table and README's CLI reference must name the
 * same set of top-level subcommands, in both directions (prd43 w3, #21).
 *
 * `rhizomorph export-otlp` shipped in `cli/index.ts` and appeared nowhere in
 * `README.md`, while `CHANGELOG.md`'s semver policy makes the CLI's public
 * surface — its subcommands, flags, and their meaning — the breaking-change
 * contract. A surface nobody can read is a contract nobody can review before
 * it changes. Checking only "every registered command is documented" would
 * still let a REMOVED subcommand's stale README row survive forever — the
 * README then advertises something that 404s the moment someone tries it —
 * so both directions are asserted, independently.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_INDEX = path.join(HERE, 'index.ts')
const README = path.join(HERE, '..', '..', '..', '..', 'README.md')

/** Every `argv[0] === '<name>'` branch `runCli` dispatches on — the actual, live top-level surface. */
function registeredSubcommands(source: string): Set<string> {
  return new Set([...source.matchAll(/argv\[0\] === '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!))
}

/**
 * README's own "## CLI reference" section, bounded to the next level-2
 * heading — scoped rather than swept whole, so a `rhizomorph <word>` mention
 * in unrelated prose elsewhere in the file (there are several) can't feed
 * this law a set it never meant to declare.
 */
function cliReferenceSection(readme: string): string {
  const match = readme.match(/\n## CLI reference\n([\s\S]*?)\n## /)
  if (!match) throw new Error('README.md has no "## CLI reference" section for this law to check')
  return match[1]!
}

/** Every backtick-quoted `` `rhizomorph <word>` `` in a section — the bare `` `rhizomorph [path]` `` fallback row is excluded on purpose: `[` is not `[a-z]`, and it dispatches to no branch above. */
function documentedSubcommands(section: string): Set<string> {
  return new Set([...section.matchAll(/`rhizomorph ([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))
}

/** Every member of `from` absent from `comparedTo`, sorted — the one function both directional checks below share, so the bite test proves the mechanism the real checks run, not a re-implementation of it. */
function missing(from: ReadonlySet<string>, comparedTo: ReadonlySet<string>): string[] {
  return [...from].filter((item) => !comparedTo.has(item)).sort()
}

const KNOWN_SURFACE = new Set([
  'doctor',
  'env',
  'export-otlp',
  'export-record',
  'label',
  'lab',
  'replay',
  'rotate',
  'sessions',
])

describe("the CLI surface law: cli/index.ts and README's CLI reference name the same subcommands, both directions (prd43 w3, #21)", () => {
  const registered = registeredSubcommands(readFileSync(CLI_INDEX, 'utf8'))
  const documented = documentedSubcommands(cliReferenceSection(readFileSync(README, 'utf8')))

  it('pins the current registered surface — independent of the README read below, so the two checks cannot pass by both collapsing to empty', () => {
    expect(registered).toEqual(KNOWN_SURFACE)
  })

  it('pins the current documented surface — independently derived from README, not copied from the registered set above', () => {
    expect(documented).toEqual(KNOWN_SURFACE)
  })

  it('every registered subcommand is documented — a shipped subcommand cannot go undocumented (this is exactly what export-otlp was)', () => {
    expect(missing(registered, documented)).toEqual([])
  })

  it('every documented subcommand is actually registered — a stale README row cannot survive a removed subcommand', () => {
    expect(missing(documented, registered)).toEqual([])
  })

  it('bites: missing() reports a real one-sided gap — the exact shape export-otlp\'s absence was, spelled differently than the issue did', () => {
    expect(missing(new Set(['doctor', 'a-hypothetical-new-command']), new Set(['doctor']))).toEqual([
      'a-hypothetical-new-command',
    ])
    expect(missing(new Set(['doctor']), new Set(['doctor', 'a-hypothetical-new-command']))).toEqual([])
  })

  it('the bare "rhizomorph [path]" fallback row is not mistaken for a subcommand named "[path]"', () => {
    expect(documentedSubcommands('| `rhizomorph [path]` | boots the server |')).toEqual(new Set())
  })
})
