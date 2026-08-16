import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOST_PREFS } from './prefs.js'
import { STREAM_SOURCE_KEY } from './demo-mode.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const read = (...segments: string[]) => readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')

/**
 * RULING 6'S ONE HARD RULE, as a law over this package: **a screenshot of demo
 * mode must never be mistakable for telemetry**, and the chrome that guarantees
 * it "cannot be themed away, dismissed or hidden".
 *
 * The shell cannot enforce that inside the SPA — the chrome is the SPA's, and
 * prd-35 ruling 2's list is what protects it there. What the shell CAN be held
 * to, and is held to here, is the half it could break on its own:
 *
 * 1. it offers no preference that could dim, hide or default the distinction;
 * 2. it has no way to summon a fixture EXCEPT the page's own key, so the
 *    chrome always comes with it;
 * 3. it never folds or renders a fixture itself.
 *
 * The third is the one that would be invisible in review: a shell that folded
 * `fleet20` in the main process and drew its own view of it would produce
 * exactly the screenshot ruling 6 forbids, and no test of `packages/web` would
 * have any way to notice.
 */
describe('the shell cannot weaken the simulated/real distinction (#565)', () => {
  it('declares no preference that names it', () => {
    const spelled = HOST_PREFS.map((entry) => `${entry.id} ${entry.label} ${entry.what}`).join(' ')
    expect(spelled).not.toMatch(/simulat|\bdemo\b|\bfixture\b|synthetic|sample fleet/i)
  })

  it('reaches a fixture ONLY by raising the page\'s own key event', () => {
    const entry = read('packages', 'app', 'src', 'main', 'entry.ts')
    // The one call that switches the driving log, and it is the page's own
    // keydown — dispatched rather than typed, for the reason `demo-mode.ts`
    // records, and read back to check it took.
    expect(entry).toContain('demoDispatchScript(source)')
    expect(entry).toContain('DEMO_VERIFY_SCRIPT')
    // …and there is no other channel: no fixture spec is imported, no fixture
    // history is built, no source is set through IPC.
    expect(entry).not.toContain('fleet20Spec')
    expect(entry).not.toContain('pathologySpec')
    expect(entry).not.toContain('fixtureHistory')
    expect(entry).not.toContain('setSource')
  })

  it('folds no fixture anywhere in the package, tests aside', () => {
    const sources = execFileSync('git', ['ls-files', '-z', '--', 'packages/app/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((entry) => entry !== '' && !entry.endsWith('.test.ts'))

    expect(sources.length).toBeGreaterThan(10)
    for (const file of sources) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(source, `${file} builds a fixture fleet of its own`).not.toMatch(
        /fixtureHistory|fleet20Spec|pathologySpec|specFor\(/,
      )
    }
  })

  it('drives the three keys the page binds, and nothing else', () => {
    expect(Object.values(STREAM_SOURCE_KEY).sort()).toEqual(['1', '2', '3'])
  })
})

/**
 * The other half, stated as what the shell RELIES on. These assertions read
 * `packages/web` and change nothing there: if the SPA ever stopped marking a
 * fixture, the shell's whole demo-mode design — press the key, get the chrome
 * with it — would silently stop being honest, and this is where that is caught.
 */
describe('the chrome the shell relies on is still in the page', () => {
  it('replaces the connection label with the fixture\'s provenance, app-wide', () => {
    const badge = read('packages', 'web', 'src', 'app', 'ConnectionBadge.tsx')
    expect(badge).toContain("const label = source === 'live' ? CONNECTION_LABEL[status] : provenance")
    // …and it is in the shell's own top dock, on every route.
    expect(read('packages', 'web', 'src', 'app', 'Shell.tsx')).toContain('<ConnectionBadge status={status} />')
  })

  it('says which log is driving, in the fixture\'s own words', () => {
    const stream = read('packages', 'web', 'src', 'app', 'StreamContext.tsx')
    expect(stream).toContain("provenance: source === 'live' ? `live · ${url}` : specFor(source).provenance")
  })

  it('keeps the sample control\'s banner on the connect page while a fixture drives', () => {
    const sample = read('packages', 'web', 'src', 'connect', 'sample.tsx')
    expect(sample).toContain("if (source !== 'live')")
    expect(sample).toContain('reading {provenance} — not the live log')
  })
})
