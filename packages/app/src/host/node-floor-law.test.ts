import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const read = (...segments: string[]) => readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')

/**
 * THE NODE FLOOR IS ONE NUMBER, STATED IN FOUR PLACES (#403).
 *
 * `package.json`'s `engines.node` declares it, `.npmrc` makes npm *enforce* it,
 * `.nvmrc` makes a version manager switch to it, and CI's min-node leg pins it
 * exactly so a bump is verified rather than assumed. Four statements of one
 * fact is four chances to drift — and the drift is invisible in the direction
 * that matters: raise `engines` to 24 without touching `.nvmrc`, and every
 * contributor's `nvm use` quietly installs a Node npm will then refuse.
 *
 * **Why the floor needed enforcing at all**, kept here because it is the reason
 * this law is worth its lines: npm treats `engines` as advisory and installs
 * anyway. On Node 20 `jsdom`'s `undici` calls `webidl.util.markAsUncloneable`,
 * which only exists on Node 22, so every `web` test worker dies before running
 * and the suite prints green counts with a non-zero exit — green counts over a
 * run that checked nothing, which is this repo's own worst failure shape.
 *
 * **Why it lives in `packages/app`.** It is a repo-wide law in a fenced
 * package, which is not where it belongs — but #403 landed in this lane
 * (lockfile-adjacent, alongside the Electron dependency), this is the only
 * suite that can hold it today, and a law written now beats a law filed for
 * later. It reads from the repo root, so it moves to a repo-level home
 * unchanged the first time there is one. Same posture, and the same admission,
 * as `packages/web/src/disclosure/case-collision-law.test.ts`.
 */
describe('the declared Node floor', () => {
  const manifest = JSON.parse(read('package.json')) as { engines?: { node?: string } }
  const declared = manifest.engines?.node ?? ''
  const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(declared)?.[1]

  it('is declared as a `>=x.y.z` minimum', () => {
    // Every assertion below reads `floor`; an unparseable range would make them
    // all compare `undefined` to `undefined` and pass.
    expect(declared).not.toBe('')
    expect(floor).toBeDefined()
  })

  it('is what `.nvmrc` switches a contributor to', () => {
    expect(read('.nvmrc').trim()).toBe(floor)
  })

  it('is what CI\'s min-node leg pins, exactly', () => {
    expect(read('.github', 'workflows', 'ci.yml')).toContain(`node-version: '${floor}'`)
  })

  it('is pinned in BOTH jobs that claim to check the minimum', () => {
    const ci = read('.github', 'workflows', 'ci.yml')
    // `build-test-boot` and `pack-smoke` each have their own min-node step, and
    // a bump that updated one would leave the other testing a floor the repo no
    // longer declares.
    expect([...ci.matchAll(new RegExp(`node-version: '${floor}'`, 'g'))]).toHaveLength(2)
  })
})

describe('the floor is enforced, not merely declared (#403)', () => {
  const npmrc = read('.npmrc')

  it('makes npm refuse rather than warn', () => {
    expect(npmrc).toMatch(/^engine-strict=true$/m)
  })

  it('says why, so the next person to delete it reads the reason first', () => {
    expect(npmrc.toLowerCase()).toContain('advisory')
    expect(npmrc).toContain('markAsUncloneable')
  })
})
