import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionDirFor } from '@rhizomorph/server/log/paths'
import { requestRetarget } from '@rhizomorph/web/concierge/retarget'
import { CAPABILITY_TOKEN_HEADER } from '@rhizomorph/web/recordings/capability'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, HARNESS_LIVE_SESSION_ID, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/retarget`'s contract test (prd-24 rulings 1 and 2) — the sixth
 * mutating route, and the file `contract-coverage-law.test.ts` names for it.
 *
 * **Unlike its five siblings, this one CAN complete the act — and does, in the
 * first case.** The clone downloads a repository, the launch spawns a real
 * conductor, and both contract tests decline for exactly that reason. The
 * retarget's write is a session boundary inside the harness's OWN temp
 * directories: nothing it closes or opens ever leaves `mkdtemp`'s reach, and
 * `afterEach` removes every directory the route created, not only the ones
 * `buildContractHarness` made. That is what makes driving the switch to
 * completion here — rather than stopping at the gate, the way the clone and
 * the launch do — the right call: it is the one mutating route in this family
 * whose real effect is cheap, local, and fully cleaned up.
 *
 * **The adopted repo is a second git work tree this test builds itself**,
 * with `makeRepo`'s own shape (`api/retarget.test.ts`'s fixture, copied
 * rather than imported across a package boundary): `validateRetargetTarget`
 * needs a real `git rev-parse --is-inside-work-tree` to succeed, and no
 * fixture can fake that away from a real `git` binary.
 */
describe('contract: the retarget (#216)', () => {
  let h: ContractHarness
  let adopted: string

  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  async function makeRepo(dir: string): Promise<string> {
    git(dir, ['init', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'tracked.txt'), 'v1\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'initial commit'])
    return dir
  }

  beforeEach(async () => {
    h = await buildContractHarness()
    adopted = await mkdtemp(path.join(tmpdir(), 'rhizomorph-contract-adopted-'))
    await makeRepo(adopted)
  })

  afterEach(async () => {
    await h.close()
    await rm(adopted, { recursive: true, force: true })
    // The directory the route opens the new recording in — derived the SAME
    // way the route derives it (`sessionDirFor`, off the data root the
    // harness's own `sessionDir` sits directly inside) — so a completed
    // switch leaves nothing behind on the real machine running this suite.
    await rm(sessionDirFor(adopted, path.dirname(h.sessionDir)), { recursive: true, force: true })
  })

  it('succeeds end to end: the switch really lands server-side, not merely in the client’s read of it', async () => {
    const outcome = await requestRetarget({ path: adopted }, h.fetch)

    expect(outcome.kind).toBe('switched')
    if (outcome.kind !== 'switched') throw new Error('expected a switch')
    expect(outcome.to.repoPath).toBe(path.resolve(adopted))
    expect(outcome.opened.sessionId).toBe(outcome.telemetry.instance)
    expect(outcome.closed.sessionId).toBe(HARNESS_LIVE_SESSION_ID)
    expect(Array.isArray(outcome.telemetry.lanes)).toBe(true)

    const meta = await h.app.inject({ method: 'GET', url: '/api/meta', headers: { [CAPABILITY_TOKEN_HEADER]: h.app.capabilityToken } })
    expect(meta.json().repoPath).toBe(path.resolve(adopted))
  })

  it('already-watching is a value, and nothing changes', async () => {
    const outcome = await requestRetarget({ path: h.repoPath }, h.fetch)

    expect(outcome).toMatchObject({ kind: 'refused', code: 'already-watching' })
    if (outcome.kind !== 'refused') throw new Error('expected a refusal')
    expect(outcome.message.length).toBeGreaterThan(0)

    const meta = await h.app.inject({ method: 'GET', url: '/api/meta', headers: { [CAPABILITY_TOKEN_HEADER]: h.app.capabilityToken } })
    expect(meta.json().repoPath).toBe(h.repoPath)
  })

  it('a tampered token is refused by the real gate, and nothing changes', async () => {
    tamperCapabilityToken()

    await expect(requestRetarget({ path: adopted }, h.fetch)).rejects.toThrow(
      /missing or invalid x-rhizomorph-capability/,
    )
    await expect(requestRetarget({ path: adopted }, h.fetch)).rejects.toThrow(/reload this page/i)

    const meta = await h.app.inject({ method: 'GET', url: '/api/meta', headers: { [CAPABILITY_TOKEN_HEADER]: h.app.capabilityToken } })
    expect(meta.json().repoPath).toBe(h.repoPath)
  })

  it('no token never reaches the wire', async () => {
    stripCapabilityToken()
    const sent = vi.fn(h.fetch)

    await expect(requestRetarget({ path: adopted }, sent)).rejects.toThrow(missingTokenMessage('switch the watched repo'))
    expect(sent).not.toHaveBeenCalled()
  })

  it('the client asks the route the server registers', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(here, '..', '..', '..')
    const routeSource = readFileSync(path.join(repoRoot, 'packages', 'server', 'src', 'api', 'retarget.ts'), 'utf8')
    const clientSource = readFileSync(path.join(repoRoot, 'packages', 'web', 'src', 'concierge', 'retarget.ts'), 'utf8')

    expect(routeSource).toContain("'/api/retarget'")
    const clientUrl = /export const RETARGET_URL = '([^']+)'/.exec(clientSource)?.[1]
    expect(clientUrl).toBe('/api/retarget')
    expect(routeSource).toContain(`'${clientUrl as string}'`)
  })
})
