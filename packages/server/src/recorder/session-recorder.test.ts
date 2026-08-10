import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { SessionLogWriter } from './session-log-writer.js'
import { SessionRecorder } from './session-recorder.js'

const FIRST = '1000'

describe('SessionRecorder#closeWith', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('releases the seal instead of hanging forever when the closing write fails', async () => {
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    await expect(recorder.closeWith(closeEvent)).rejects.toThrow('ENOSPC')
    expect(recorder.isSealed).toBe(false)

    // A record() call after a failed close must resolve promptly, not hang
    // forever on a seal nobody released.
    await expect(
      recorder.record(createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: 'evt-2', ts: 1001 })),
    ).resolves.toBeUndefined()
  })
})
