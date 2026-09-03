import { describe, expect, it, vi } from 'vitest'
import { CAPABILITY_TOKEN_HEADER } from '../api/security.js'
import {
  CAPABILITY_META_NAME,
  capabilityAwareFetch,
  dashboardUrl,
  fetchCapabilityToken,
  parseRotateArgs,
  readCapabilityTokenFromHtml,
  renderRotation,
  requestRotation,
  rotateHelpText,
  rotateUrl,
  type RotationSummary,
} from './rotate.js'

/**
 * `rhizomorph rotate`'s client half. The rotation itself is the server's
 * (`recorder/rotate.ts`) — what these tests pin is that the command asks the
 * right place, carries the capability token the route requires since #234,
 * refuses to guess when the answer isn't a rotation, and fails with a sentence
 * that says what to do instead of a stack trace.
 */

const ROTATION: RotationSummary = {
  closed: { sessionId: '1000', filePath: '/data/repo-abc/session-1000.jsonl', eventCount: 1234 },
  opened: { sessionId: '5000', filePath: '/data/repo-abc/session-5000.jsonl' },
}

const TOKEN = 'a'.repeat(64)

/** The app shell the server really serves, token stamped in as `server/static.ts` stamps it. */
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>the Rhizomorph</title>
  <meta name="rhizomorph-capability" content="${TOKEN}">
  </head>
  <body><div id="root"></div></body>
</html>
`

/** The shell a server with no built dashboard serves instead — no token anywhere in it. */
const SHELL_WITHOUT_TOKEN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Rhizomorph — web build missing</title></head>
<body><h1>The dashboard hasn't been built yet</h1></body></html>
`

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function htmlResponse(html: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  } as Response
}

/**
 * The two-request conversation `requestRotation` now has: a `GET /` for the
 * token, then the `POST`. Answers each by URL so a test can assert both,
 * rather than assuming an order.
 */
function serving(html: string, rotation: unknown, rotationStatus = 200) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/api/rotate')) return jsonResponse(rotation, rotationStatus)
    void init
    return htmlResponse(html)
  }) as unknown as typeof globalThis.fetch
}

describe('rotateUrl', () => {
  it('points at the local server on the given port — never anywhere else', () => {
    expect(rotateUrl(4321)).toBe('http://127.0.0.1:4321/api/rotate')
  })

  it('reads the token from the same local server, at the page it serves', () => {
    expect(dashboardUrl(4321)).toBe('http://127.0.0.1:4321/')
  })
})

/**
 * #234: `rhizomorph rotate` is a SEPARATE PROCESS from the server that minted
 * the token, so it cannot read it out of memory the way the route's own tests
 * can. It reads it the way the browser does — off the page the server serves
 * (ADR-0012). These pin the meta name literally, because it is duplicated
 * across three modules with no shared package to hold one copy (the ADR's own
 * recorded consequence): a one-sided rename must fail a test rather than drift
 * silently into #249 on a third caller.
 */
describe('reading the capability token off the served page (#234)', () => {
  it('pins the meta name the server stamps — the same string server/static.ts writes', () => {
    expect(CAPABILITY_META_NAME).toBe('rhizomorph-capability')
  })

  it('reads the token out of a real app shell', () => {
    expect(readCapabilityTokenFromHtml(SHELL)).toBe(TOKEN)
  })

  it('reads it regardless of attribute order or quote style — the tag is HTML, not a fixed string', () => {
    expect(readCapabilityTokenFromHtml(`<meta content="${TOKEN}" name="rhizomorph-capability">`)).toBe(TOKEN)
    expect(readCapabilityTokenFromHtml(`<meta name='rhizomorph-capability' content='${TOKEN}'>`)).toBe(TOKEN)
    expect(readCapabilityTokenFromHtml(`<meta name="rhizomorph-capability" content="${TOKEN}" />`)).toBe(TOKEN)
  })

  it('is not fooled by another meta tag, and never guesses', () => {
    expect(readCapabilityTokenFromHtml('<meta name="description" content="not the token">')).toBeNull()
    expect(readCapabilityTokenFromHtml('<meta name="rhizomorph-capability" content="">')).toBeNull()
    expect(readCapabilityTokenFromHtml(SHELL_WITHOUT_TOKEN)).toBeNull()
    expect(readCapabilityTokenFromHtml('')).toBeNull()
  })

  it('picks the capability tag out of a page full of other ones', () => {
    expect(
      readCapabilityTokenFromHtml(
        `<meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
          `<meta name="rhizomorph-capability" content="${TOKEN}">`,
      ),
    ).toBe(TOKEN)
  })

  /**
   * The honest failure ADR-0012's known dev-mode gap demands. A server with no
   * built dashboard — or a page served by vite under `npm run dev:web` — has
   * no token to hand out, and the operator must be told THAT, not handed a
   * 401 about a header they have no way to supply.
   */
  it('refuses with what is missing and what to run, never a bare status', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(SHELL_WITHOUT_TOKEN)) as unknown as typeof globalThis.fetch

    const failure = await fetchCapabilityToken(4321, { fetch: fetchImpl }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('carries no capability token')
    expect(message).toContain('npm run build --workspace packages/web')
    expect(message).toContain('dev:web')
    // It names the port it asked, so an operator with two servers up knows which.
    expect(message).toContain('4321')
  })

  it('says the same when the page itself could not be served', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('', 500)) as unknown as typeof globalThis.fetch

    await expect(fetchCapabilityToken(4321, { fetch: fetchImpl })).rejects.toThrow(/HTTP 500[\s\S]*npm run build/)
  })
})

describe('requestRotation', () => {
  it('fetches the token off the served page, then POSTs the rotation carrying it', async () => {
    const fetchImpl = serving(SHELL, ROTATION)

    const rotation = await requestRotation(4321, { fetch: fetchImpl })

    expect(rotation).toEqual(ROTATION)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4321/')
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4321/api/rotate', {
      method: 'POST',
      headers: { [CAPABILITY_TOKEN_HEADER]: TOKEN },
    })
  })

  it('never POSTs at all when there is no token to carry — no bare request, no 401 to explain', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(SHELL_WITHOUT_TOKEN)) as unknown as typeof globalThis.fetch

    await expect(requestRotation(4321, { fetch: fetchImpl })).rejects.toThrow(/carries no capability token/)
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/')
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
    const fetchImpl = serving(SHELL, { error: 'this server is replaying a session record' }, 409)

    await expect(requestRotation(4321, { fetch: fetchImpl })).rejects.toThrow(
      'rotation refused by the Rhizomorph on port 4321: this server is replaying a session record',
    )
  })

  it('falls back to the status when a refusal carries no message', async () => {
    const fetchImpl = serving(SHELL, 'not an object', 500)

    await expect(requestRotation(4321, { fetch: fetchImpl })).rejects.toThrow('HTTP 500')
  })

  it('refuses to invent a rotation from an answer that is not one', async () => {
    const fetchImpl = serving(SHELL, { closed: { sessionId: '1000' } })

    await expect(requestRotation(4321, { fetch: fetchImpl })).rejects.toThrow(
      /answered something other than a rotation/,
    )
  })
})

/**
 * THE SHARED SCRAPE HELPER (prd-29 ruling 7, #59). `rhizomorph env`'s
 * instance-id read and `rhizomorph doctor`'s own-server probe both reach a
 * `gated-read` route through this — one place that fetches the token and
 * attaches it, rather than each growing its own copy of `fetchCapabilityToken`
 * plus a header. `requestRotation` above is exercised separately and is left
 * as-is (not refactored onto this helper) so its own pinned assertions about
 * the exact two-call conversation stay exactly what they were.
 */
describe('capabilityAwareFetch (prd-29 ruling 7, #59)', () => {
  it('attaches the capability header to a request made through it', async () => {
    const fetchImpl = serving(SHELL, { ok: true })

    const rhizomorphFetch = capabilityAwareFetch(4321, { fetch: fetchImpl })
    const response = await rhizomorphFetch('http://127.0.0.1:4321/api/rotate')

    expect(response.ok).toBe(true)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4321/')
    const [secondUrl, secondInit] = vi.mocked(fetchImpl).mock.calls[1] ?? []
    expect(secondUrl).toBe('http://127.0.0.1:4321/api/rotate')
    expect(new Headers(secondInit?.headers).get(CAPABILITY_TOKEN_HEADER)).toBe(TOKEN)
  })

  it('caches the token across multiple calls through the SAME returned function — one GET / for many requests', async () => {
    const fetchImpl = serving(SHELL, { ok: true })
    const rhizomorphFetch = capabilityAwareFetch(4321, { fetch: fetchImpl })

    await rhizomorphFetch('http://127.0.0.1:4321/api/meta')
    await rhizomorphFetch('http://127.0.0.1:4321/api/doctor')
    await rhizomorphFetch('http://127.0.0.1:4321/api/lanes')

    const dashboardCalls = vi
      .mocked(fetchImpl)
      .mock.calls.filter((call) => String(call[0]) === 'http://127.0.0.1:4321/')
    // Three requests through the same returned function, one token scrape —
    // that reuse is this helper's whole reason to cache at all.
    expect(dashboardCalls).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it("a fresh capabilityAwareFetch(port) call pays the extra request again — nothing survives across separate calls", async () => {
    const fetchImpl = serving(SHELL, { ok: true })

    await capabilityAwareFetch(4321, { fetch: fetchImpl })('http://127.0.0.1:4321/api/meta')
    await capabilityAwareFetch(4321, { fetch: fetchImpl })('http://127.0.0.1:4321/api/meta')

    const dashboardCalls = vi
      .mocked(fetchImpl)
      .mock.calls.filter((call) => String(call[0]) === 'http://127.0.0.1:4321/')
    expect(dashboardCalls).toHaveLength(2)
  })

  it("preserves the caller's other init fields and headers — the token is added, not a replacement", async () => {
    const fetchImpl = serving(SHELL, { ok: true })
    const rhizomorphFetch = capabilityAwareFetch(4321, { fetch: fetchImpl })

    await rhizomorphFetch('http://127.0.0.1:4321/api/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    const [, init] = vi.mocked(fetchImpl).mock.calls[1] ?? []
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get(CAPABILITY_TOKEN_HEADER)).toBe(TOKEN)
  })

  it('does not cache a failed token fetch — the next call through the same function retries rather than replaying the rejection', async () => {
    let dashboardCallCount = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const s = String(url)
      if (s.endsWith('/api/meta')) return jsonResponse({ ok: true })
      dashboardCallCount++
      if (dashboardCallCount === 1) throw new Error('fetch failed')
      return htmlResponse(SHELL)
    }) as unknown as typeof globalThis.fetch

    const rhizomorphFetch = capabilityAwareFetch(4321, { fetch: fetchImpl })

    await expect(rhizomorphFetch('http://127.0.0.1:4321/api/meta')).rejects.toThrow(
      /cannot rotate the session on port 4321/,
    )
    const response = await rhizomorphFetch('http://127.0.0.1:4321/api/meta')
    expect(response.ok).toBe(true)
    expect(dashboardCallCount).toBe(2)
  })

  it('refuses with the same "what is missing" sentence when the server has no dashboard to hand the token out through', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(SHELL_WITHOUT_TOKEN)) as unknown as typeof globalThis.fetch
    const rhizomorphFetch = capabilityAwareFetch(4321, { fetch: fetchImpl })

    await expect(rhizomorphFetch('http://127.0.0.1:4321/api/meta')).rejects.toThrow(/carries no capability token/)
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
