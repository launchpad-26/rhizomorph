import { describe, expect, it } from 'vitest'
import { IngestKey, REDACTED_KEY } from './key.js'
import { INGEST_KEY_HEADER, MAX_BODY_DETAIL, postBatch, type FetchLike } from './post.js'

const FIXTURE_KEY = 'rzk_POSTFIXTUREVALUE0123456789'

interface Captured {
  url: string
  method: string | undefined
  headers: Headers
  body: unknown
}

function recordingFetch(answer: () => Response | Promise<Response>): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof URL ? input.toString() : String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    return answer()
  }) as FetchLike
  return { fetch, calls }
}

function accepted(accepted = 1, journalSeq = 7): Response {
  return new Response(JSON.stringify({ accepted, journalSeq }), { status: 202 })
}

function post(fetch: FetchLike, url = 'https://team.example', batch = [{ n: 1, line: '{"a":1}' }]) {
  return postBatch({
    url,
    project: 'acme-widgets',
    actorInstance: '1785900000000',
    key: new IngestKey(FIXTURE_KEY),
    batch,
    fetch,
  })
}

describe('the one outbound call — protocol v1 to one team server', () => {
  it('posts to <base>/v1/rhizomorph/ingest, with and without a trailing slash on the base', async () => {
    for (const base of ['https://team.example', 'https://team.example/']) {
      const { fetch, calls } = recordingFetch(() => accepted())
      await post(fetch, base)
      expect(calls[0]?.url).toBe('https://team.example/v1/rhizomorph/ingest')
      expect(calls[0]?.method).toBe('POST')
    }
  })

  it('carries the value on x-rz-ingest-key and on no other header', async () => {
    const { fetch, calls } = recordingFetch(() => accepted())
    await post(fetch)

    const headers = calls[0]?.headers as Headers
    expect(headers.get(INGEST_KEY_HEADER)).toBe(FIXTURE_KEY)
    const elsewhere: string[] = []
    headers.forEach((value, name) => {
      if (name !== INGEST_KEY_HEADER && value.includes(FIXTURE_KEY)) elsewhere.push(name)
    })
    expect(elsewhere).toEqual([])
    expect(JSON.stringify(calls[0]?.body)).not.toContain(FIXTURE_KEY)
  })

  it('sends the protocol v1 envelope the wire module defines, and nothing else', async () => {
    const { fetch, calls } = recordingFetch(() => accepted(2, 9))
    const result = await post(fetch, 'https://team.example', [
      { n: 4, line: '{"a":1}' },
      { n: 5, line: '{"a":2}' },
    ])

    expect(calls[0]?.body).toEqual({
      protocolVersion: 1,
      project: 'acme-widgets',
      actorInstance: '1785900000000',
      batch: [
        { n: 4, line: '{"a":1}' },
        { n: 5, line: '{"a":2}' },
      ],
    })
    expect(result).toEqual({ ok: true, accepted: 2, journalSeq: 9 })
  })

  it('a 202 without the acknowledgement is NOT an ack — durability was never stated', async () => {
    const { fetch } = recordingFetch(() => new Response('{}', { status: 202 }))
    const result = await post(fetch)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unreadable-response')
    expect(result.ok === false && result.detail).toMatch(/accepted, journalSeq/)
  })

  it('a 202 whose body is not JSON at all is named as that, not as an ack', async () => {
    const { fetch } = recordingFetch(() => new Response('<html>hi</html>', { status: 202 }))
    const result = await post(fetch)
    expect(result.ok === false && result.reason).toBe('unreadable-response')
    expect(result.ok === false && result.detail).toMatch(/not JSON/)
  })

  it('401 and 403 are "refused" and name the re-enable command', async () => {
    for (const status of [401, 403]) {
      const { fetch } = recordingFetch(() => new Response('nope', { status }))
      const result = await post(fetch)
      expect(result.ok === false && result.reason).toBe('refused')
      expect(result.ok === false && result.detail).toContain('rhizomorph connect team')
    }
  })

  it('another 4xx is "rejected" and carries at most the first 200 characters of the server\'s own words', async () => {
    const long = 'x'.repeat(500)
    const { fetch } = recordingFetch(() => new Response(long, { status: 413 }))
    const result = await post(fetch)
    expect(result.ok === false && result.reason).toBe('rejected')
    expect(result.ok === false && result.detail).toContain('413')
    expect(result.ok === false && (result.detail.match(/x/g) ?? []).length).toBe(MAX_BODY_DETAIL)
  })

  it('a 5xx and a thrown fetch are both "unreachable" — the next tick retries', async () => {
    const { fetch: five } = recordingFetch(() => new Response('boom', { status: 500 }))
    const server = await post(five)
    expect(server.ok === false && server.reason).toBe('unreachable')
    expect(server.ok === false && server.detail).toContain('500')

    const thrower = (async () => {
      throw new Error('getaddrinfo ENOTFOUND team.example')
    }) as FetchLike
    const result = await post(thrower)
    expect(result.ok === false && result.reason).toBe('unreachable')
    expect(result.ok === false && result.detail).toContain('ENOTFOUND')
  })

  it('redacts the key out of a server body and out of a thrown error, before either becomes a detail', async () => {
    const { fetch: echoing } = recordingFetch(
      () => new Response(`key ${FIXTURE_KEY} is revoked`, { status: 500 }),
    )
    const echoed = await post(echoing)
    expect(echoed.ok === false && echoed.detail).not.toContain(FIXTURE_KEY)
    expect(echoed.ok === false && echoed.detail).toContain(REDACTED_KEY)

    const leaky = (async () => {
      throw new Error(`connect failed while sending ${FIXTURE_KEY}`)
    }) as FetchLike
    const thrown = await post(leaky)
    expect(thrown.ok === false && thrown.detail).not.toContain(FIXTURE_KEY)
    expect(thrown.ok === false && thrown.detail).toContain(REDACTED_KEY)
  })

  it('redacts BEFORE truncating, so a key straddling the 200-character cut cannot survive as a fragment', async () => {
    const padding = 'p'.repeat(MAX_BODY_DETAIL - 10)
    const { fetch } = recordingFetch(() => new Response(`${padding}${FIXTURE_KEY} tail`, { status: 400 }))
    const result = await post(fetch)
    const detail = result.ok === false ? result.detail : ''
    expect(detail).not.toContain(FIXTURE_KEY)
    expect(detail).not.toContain(FIXTURE_KEY.slice(0, 12))
  })

  it('refuses a locally invalid request before fetch is called — a shipper defect is a local error', async () => {
    const { fetch, calls } = recordingFetch(() => accepted())
    const empty = await post(fetch, 'https://team.example', [])
    expect(empty.ok === false && empty.reason).toBe('invalid-request')
    expect(calls).toEqual([])

    const badN = await post(fetch, 'https://team.example', [{ n: 0, line: 'x' }])
    expect(badN.ok === false && badN.reason).toBe('invalid-request')
    expect(calls).toEqual([])
  })
})
