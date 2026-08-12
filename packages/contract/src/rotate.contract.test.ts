import { readSessionEvents, sessionFilePath } from '@rhizomorph/server/log/session-log'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { requestRotation } from '@rhizomorph/web/replay/rotate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/rotate`'s contract test (prd-24 ruling 1) — moved here from
 * `web/src/replay/rotate.test.ts`'s seam block, claims intact: the REAL
 * served page, the REAL `readCapabilityToken`, the REAL `requestRotation`,
 * the REAL gate.
 */
describe('contract: rotation (#234, #310)', () => {
  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const rotation = await requestRotation(h.fetch)

    expect(rotation.closed.sessionId).toBe('2000')
    expect(rotation.opened.sessionId).toBe('9999')
    // The boundary really landed server-side, not just in the answer — BOTH
    // halves. The active recorder is session 2000 (see the harness), so that is
    // the log a rotation actually closes; the first port of this file lost the
    // close half by pointing at 1000, a history file no rotation touches.
    // Escape it now catches: `rotateSession` returning closed:{sessionId:'2000'}
    // and creating 9999 while never appending `session.closed` to 2000.
    const closed = await readSessionEvents(sessionFilePath(h.sessionDir, '2000'))
    expect(closed.map((event) => event.type)).toContain('session.closed')
    const opened = await readSessionEvents(sessionFilePath(h.sessionDir, '9999'))
    expect(opened.map((event) => event.type)).toContain('session.started')
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(requestRotation(h.fetch)).rejects.toThrow(
      /missing or invalid x-rhizomorph-capability/,
    )
    await expect(requestRotation(h.fetch)).rejects.toThrow(/reload this page/i)
    // The recording was NOT rotated: the ACTIVE log (2000) never got a
    // `session.closed`, and the would-be next session (9999) was never created.
    // Both target what a rotation actually writes — 1000 is a history file no
    // rotation touches, so asserting it "untouched" held whether the gate
    // refused or waved the request straight through.
    const active = await readSessionEvents(sessionFilePath(h.sessionDir, '2000'))
    expect(active.map((event) => event.type)).not.toContain('session.closed')
    // `readSessionEvents` yields [] for a file never written — an empty read,
    // not a throw.
    expect(await readSessionEvents(sessionFilePath(h.sessionDir, '9999'))).toEqual([])
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(requestRotation(transport)).rejects.toThrow(
      missingTokenMessage('end the session'),
    )
    expect(transport).not.toHaveBeenCalled()
  })
})
