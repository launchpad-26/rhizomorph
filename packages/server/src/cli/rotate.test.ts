import { describe, expect, it, vi } from 'vitest'
import {
  parseRotateArgs,
  renderRotation,
  requestRotation,
  rotateHelpText,
  rotateUrl,
  type RotationSummary,
} from './rotate.js'

/**
 * `rhizomorph rotate`'s client half. The rotation itself is the server's
 * (`recorder/rotate.ts`) — what these tests pin is that the command asks the
 * right place, refuses to guess when the answer isn't a rotation, and fails
 * with a sentence that says what to do instead of a stack trace.
 */

const ROTATION: RotationSummary = {
  closed: { sessionId: '1000', filePath: '/data/repo-abc/session-1000.jsonl', eventCount: 1234 },
  opened: { sessionId: '5000', filePath: '/data/repo-abc/session-5000.jsonl' },
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('rotateUrl', () => {
  it('points at the local server on the given port — never anywhere else', () => {
    expect(rotateUrl(4321)).toBe('http://127.0.0.1:4321/api/rotate')
  })
})

describe('requestRotation', () => {
  it('POSTs the rotation and returns what closed and what opened', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ROTATION))

    const rotation = await requestRotation(4321, { fetch: fetchImpl as unknown as typeof globalThis.fetch })

    expect(rotation).toEqual(ROTATION)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4321/api/rotate', { method: 'POST' })
  })

  it('says what to start when nothing is listening', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed')
    })

    await expect(
      requestRotation(4321, { fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/cannot rotate the session on port 4321[\s\S]*npm start -- --port 4321/)
  })

  it("passes the server's own refusal through — a replay server has nothing to rotate", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'this server is replaying a session record' }, 409),
    )

    await expect(
      requestRotation(4321, { fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow('rotation refused by the Rhizomorph on port 4321: this server is replaying a session record')
  })

  it('falls back to the status when a refusal carries no message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('not an object', 500))

    await expect(
      requestRotation(4321, { fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow('HTTP 500')
  })

  it('refuses to invent a rotation from an answer that is not one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ closed: { sessionId: '1000' } }))

    await expect(
      requestRotation(4321, { fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/answered something other than a rotation/)
  })
})

describe('renderRotation', () => {
  it('names what ended, how big it was, and what is being recorded now', () => {
    const output = renderRotation(ROTATION)
    expect(output).toContain('closed session 1000 — 1,234 events')
    expect(output).toContain('/data/repo-abc/session-1000.jsonl')
    expect(output).toContain('opened session 5000 — recording to /data/repo-abc/session-5000.jsonl')
  })
})

describe('parseRotateArgs', () => {
  it('defaults to the standard port — rotation asks the running instrument', () => {
    expect(parseRotateArgs([])).toEqual({ port: 4321, help: false })
  })

  it('parses --port in both forms', () => {
    expect(parseRotateArgs(['--port', '5000'])).toEqual({ port: 5000, help: false })
    expect(parseRotateArgs(['--port=5000'])).toEqual({ port: 5000, help: false })
  })

  it('rejects a non-integer port', () => {
    expect(() => parseRotateArgs(['--port', 'nope'])).toThrow(/invalid --port value/)
  })

  it('rejects a path, and says why rotation does not take one', () => {
    expect(() => parseRotateArgs(['../other-repo'])).toThrow(/unexpected argument.*rotate takes no path/is)
  })

  it('parses --help', () => {
    expect(parseRotateArgs(['--help']).help).toBe(true)
    expect(parseRotateArgs(['-h']).help).toBe(true)
  })
})

describe('rotateHelpText', () => {
  it('says what rotation does, that the server must be running, and names the button', () => {
    const text = rotateHelpText()
    expect(text).toContain('rhizomorph rotate')
    expect(text).toContain('session.closed')
    expect(text).toContain('--port')
    expect(text).toContain('end session · start fresh')
  })
})
