import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OS_WARNINGS, SIGN_ENV, signingPlan, unsignedNote, type Platform } from './signing.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const read = (...segments: string[]) => readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')

const PLATFORMS: Platform[] = ['mac', 'win', 'linux']

describe('signing is off, and that is the shipped default (ruling 9)', () => {
  it.each(PLATFORMS)('is off for %s with an empty environment', (platform) => {
    const plan = signingPlan({}, platform)
    expect(plan.enabled).toBe(false)
    expect(plan.reason).toContain('deferred')
  })

  it('stays off when credentials happen to be in the environment', () => {
    // The surprise this prevents: a build machine with an unrelated `CSC_LINK`
    // quietly switching a release on. The switch is one variable, on purpose.
    const plan = signingPlan({ CSC_LINK: 'file.p12', APPLE_ID: 'someone@example.com' }, 'mac')
    expect(plan.enabled).toBe(false)
  })

  it('turns on with the one variable, and nothing else changes', () => {
    expect(signingPlan({ [SIGN_ENV]: '1' }, 'win').enabled).toBe(true)
    expect(signingPlan({ [SIGN_ENV]: 'true' }, 'win').enabled).toBe(false)
    expect(signingPlan({ [SIGN_ENV]: '0' }, 'win').enabled).toBe(false)
  })
})

describe('the costs are stated where the decision is', () => {
  it('names Apple\'s and Azure\'s prices, and says Linux costs nothing', () => {
    expect(signingPlan({}, 'mac').cost).toContain('$99')
    expect(signingPlan({}, 'win').cost).toContain('$120')
    expect(signingPlan({}, 'linux').cost).toContain('nothing')
  })

  it('names the credentials each platform would need — nobody guesses at release week', () => {
    expect(signingPlan({}, 'mac').credentials).toContain('APPLE_TEAM_ID')
    expect(signingPlan({}, 'win').credentials).toContain('AZURE_CLIENT_SECRET')
    expect(signingPlan({}, 'linux').credentials).toEqual([])
  })
})

describe('the note the build shows about itself (S3)', () => {
  it('says it is unsigned while it is', () => {
    expect(unsignedNote(signingPlan({}, 'mac'))).toContain('not signed')
  })

  it('says nothing once it is signed', () => {
    expect(unsignedNote(signingPlan({ [SIGN_ENV]: '1' }, 'mac'))).toBeNull()
  })
})

/**
 * "Builds ship unsigned with install instructions that say plainly what the
 * operating system will warn and why" — which is only honest if the
 * instructions and the dialog match. The warnings are data here and prose in
 * `INSTALL.md`; this is the law that keeps them the same.
 */
describe('the documented warnings are the real ones (#565)', () => {
  const install = read('packages', 'app', 'INSTALL.md')

  it('found the install notes to read', () => {
    expect(install).toContain('unsigned')
    expect(install.length).toBeGreaterThan(500)
  })

  it.each(OS_WARNINGS)('quotes what $platform actually says, verbatim', (warning) => {
    // Verbatim, not paraphrased: the phrase in the doc is the phrase on the
    // screen, which is what makes it searchable and what makes "honest
    // instructions" mean anything.
    if (warning.quote !== null) expect(install).toContain(warning.quote)
    expect(install.toLowerCase()).toContain(warning.platform === 'win' ? 'windows' : warning.platform)
  })

  it('quotes two of the three — a doc that quoted none would pass an every-null table', () => {
    expect(OS_WARNINGS.filter((warning) => warning.quote !== null)).toHaveLength(2)
  })

  it('names the remedy for each, not only the warning', () => {
    expect(install).toContain('Run anyway')
    expect(install).toContain('com.apple.quarantine')
    expect(install).toContain('chmod +x')
  })

  it('says why it is unsigned, rather than leaving it looking like an oversight', () => {
    expect(install).toContain('ruling 9')
    expect(install).toMatch(/\$99|\$120/)
  })
})

describe('the packaging config carries the switch, not a decision', () => {
  const builder = read('packages', 'app', 'electron-builder.yml')

  it('reads identity from the environment rather than hard-coding one', () => {
    expect(builder).toContain('CSC_IDENTITY_AUTO_DISCOVERY')
  })

  it('ships the server and the SPA at their repo-relative paths', () => {
    // `layout.ts` depends on exactly this shape: `run.ts`'s own relative walk
    // to `packages/web/dist` only lands when the copy mirrors the repo.
    expect(builder).toContain('packages/server/bin')
    expect(builder).toContain('packages/server/dist')
    expect(builder).toContain('packages/web/dist')
  })

  it('builds all three platforms', () => {
    expect(builder).toContain('mac:')
    expect(builder).toContain('win:')
    expect(builder).toContain('linux:')
  })
})
