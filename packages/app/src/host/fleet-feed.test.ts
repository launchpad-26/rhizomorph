import { fixtureHistory, pathologySpec, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
import { FleetFeed, type ChunkSource } from './fleet-feed.js'
import type { FleetDigest } from './digest.js'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

function sseOf(events: readonly RhizomorphEvent[]): string {
  return events.map((event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** A chunk source that yields what it is given, then ends — one connection's worth. */
function saying(...chunks: string[]): ChunkSource {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  })
}

const noManifest = async () => {
  throw new Error('404')
}

function feedWith(chunks: ChunkSource, options: Partial<Parameters<typeof makeFeed>[1]> = {}) {
  return makeFeed(chunks, options)
}

function makeFeed(
  chunks: ChunkSource,
  options: {
    json?: (url: string) => Promise<unknown>
    onDigest?: (digest: FleetDigest) => void
    onConnection?: (phase: string, detail: string | null) => void
    retryMs?: number
    tickMs?: number
  } = {},
) {
  const digests: FleetDigest[] = []
  const connections: [string, string | null][] = []
  const feed = new FleetFeed({
    baseUrl: 'http://127.0.0.1:4321',
    chunks,
    json: options.json ?? noManifest,
    now: () => NOW,
    tickMs: options.tickMs ?? 10_000, // the beat is driven explicitly unless a test asks for it
    retryMs: options.retryMs ?? 10_000,
    onDigest: (digest) => {
      digests.push(digest)
      options.onDigest?.(digest)
    },
    onConnection: (phase, detail) => {
      connections.push([phase, detail])
      options.onConnection?.(phase, detail)
    },
  })
  return { feed, digests, connections }
}

/** Lets the feed's own async loop run to its next await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the feed folds what the stream sends', () => {
  it('reaches a digest that reads the staged fixture as needing a human', async () => {
    const events = fixtureHistory(pathologySpec(), NOW, 7)
    const { feed, digests } = feedWith(saying(sseOf(events)))

    feed.start()
    await settle()
    feed.publish()
    feed.stop()

    const digest = digests.at(-1)
    expect(digest).toBeDefined()
    expect(digest?.laneCount).toBeGreaterThan(0)
    expect((digest?.needsYou.length ?? 0) + (digest?.broken.length ?? 0)).toBeGreaterThan(0)
    expect(feed.folded().folded).toBe(events.length)
    expect(feed.folded().unparsed).toBe(0)
  })

  it('reassembles a frame split across chunks', async () => {
    const events = fixtureHistory(pathologySpec(), NOW, 3)
    const wire = sseOf(events)
    const cut = Math.floor(wire.length / 2)
    const { feed } = feedWith(saying(wire.slice(0, cut), wire.slice(cut)))

    feed.start()
    await settle()
    feed.stop()

    expect(feed.folded().folded).toBe(events.length)
    expect(feed.folded().unparsed).toBe(0)
  })

  it('counts what it could not parse instead of dropping it silently', async () => {
    const { feed } = feedWith(saying('data: not json\n\ndata: {"nope":true}\n\n'))
    feed.start()
    await settle()
    feed.stop()
    expect(feed.folded().unparsed).toBe(2)
    expect(feed.folded().folded).toBe(0)
  })
})

describe('the beat', () => {
  it('rebuilds on the timer even when nothing has arrived', () => {
    vi.useFakeTimers()
    try {
      // A connection that opens and says nothing — the case a tray that only
      // updated on an event would sit calm through, while lanes aged past the
      // frozen threshold on screen.
      const silent: ChunkSource = () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
        },
      })
      const { feed, digests } = makeFeed(silent, { tickMs: 1_000 })

      feed.start()
      vi.advanceTimersByTime(3_000)
      feed.stop()

      expect(digests.length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes nothing more once it is stopped', () => {
    vi.useFakeTimers()
    try {
      const silent: ChunkSource = () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
        },
      })
      const { feed, digests } = makeFeed(silent, { tickMs: 1_000 })
      feed.start()
      vi.advanceTimersByTime(2_000)
      feed.stop()
      const after = digests.length
      vi.advanceTimersByTime(10_000)
      expect(digests.length).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a dropped connection is a state, not an exception', () => {
  it('reports the loss rather than throwing', async () => {
    const { feed, connections } = feedWith(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('ECONNREFUSED')
      },
    }))

    feed.start()
    await settle()
    feed.stop()

    expect(connections.map(([phase]) => phase)).toContain('lost')
    expect(connections.find(([phase]) => phase === 'lost')?.[1]).toContain('ECONNREFUSED')
  })

  it('reports a stream that simply ends', async () => {
    const { feed, connections } = feedWith(saying('data: {"nope":1}\n\n'))
    feed.start()
    await settle()
    feed.stop()
    expect(connections.some(([phase, detail]) => phase === 'lost' && detail === 'the stream ended')).toBe(true)
  })

  it('stops for good when asked, rather than reconnecting forever', async () => {
    let opened = 0
    const { feed } = feedWith(
      () => {
        opened += 1
        return {
          async *[Symbol.asyncIterator]() {
            throw new Error('nope')
          },
        }
      },
      { retryMs: 1 },
    )

    feed.start()
    await settle()
    feed.stop()
    const after = opened
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toBe(after)
  })
})

describe('the lane manifest', () => {
  it('is asked for once per repo, not once per chunk', async () => {
    const events = fixtureHistory(pathologySpec(), NOW, 5)
    const wire = sseOf(events)
    const asked: string[] = []
    const { feed } = feedWith(saying(...wire.match(/[\s\S]{1,200}/g) ?? []), {
      json: async (url) => {
        asked.push(url)
        return { lanes: [] }
      },
    })

    feed.start()
    await settle()
    feed.stop()

    // One ask before the stream, and at most one more when the fold learns the
    // repo from `session.started`. Never one per chunk — that would be dozens.
    expect(asked.length).toBeLessThanOrEqual(2)
    expect(asked[0]).toBe('http://127.0.0.1:4321/api/lanes')
  })

  it('does not re-ask forever when the answer is "there is no manifest"', async () => {
    const events = fixtureHistory(pathologySpec(), NOW, 5)
    const wire = sseOf(events)
    let asked = 0
    const { feed } = feedWith(saying(...(wire.match(/[\s\S]{1,200}/g) ?? [])), {
      json: async () => {
        asked += 1
        throw new Error('404')
      },
    })

    feed.start()
    await settle()
    feed.stop()

    expect(asked).toBeLessThanOrEqual(2)
  })
})
