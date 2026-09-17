import { type LaneManifest, parseLaneManifest } from '@rhizomorph/core'
import { digestOf, emptyDigest, type FleetDigest } from './digest.js'
import { SseParser } from './sse.js'
import { emptyFold, type FoldedStream, fleetOf, foldFrames } from './stream-fold.js'

/**
 * THE DAEMON'S OWN READING OF THE FLEET (#564, **S2**'s data source: "the
 * derived fleet, via the same stream the window uses").
 *
 * Opens `GET /api/stream`, folds what arrives with core's own reducer, and
 * hands a {@link FleetDigest} to the tray on a beat. Everything it does that
 * could be wrong is somewhere else — SSE framing in `sse.ts`, the fold in
 * `stream-fold.ts`, the projection in `digest.ts` — so what is left here is a
 * connection and a timer, both injected.
 *
 * **A beat, not an event.** `FleetContext.tsx` rebuilds the fleet once a second
 * for a reason this daemon shares exactly: the passage of time alone moves the
 * instrument (a lane crosses the frozen threshold because eight minutes went
 * by, not because anything arrived). A tray that only updated on an event would
 * sit calm over a fleet that had just gone quiet — the one failure mode a
 * flatline detector exists to prevent.
 *
 * **The stream carries no credential and needs none.** `/api/stream` is a read,
 * and ADR-0012's capability token guards mutations; this feed sends no header a
 * browser would not send and asks for nothing a browser could not ask for.
 *
 * **A dropped connection is a state, not an exception.** The server can be
 * restarted under a running shell (it is, on every update the *server* takes),
 * and S2 lists *server unreachable* as a state the shell survives: the feed
 * retries on a fixed delay, forever, and reports each attempt through
 * `onConnection` so the tray can say "no reading" rather than "all clear".
 */

/** One connection, as an async stream of decoded text. Injected, so a test needs no socket. */
export type ChunkSource = (url: string, signal: AbortSignal) => AsyncIterable<string>

/** The `/api/lanes` read, injected for the same reason. */
export type JsonSource = (url: string) => Promise<unknown>

export type ConnectionPhase = 'connecting' | 'open' | 'lost'

export interface FleetFeedOptions {
  /** The instrument's origin, e.g. `http://127.0.0.1:38211`. No trailing slash. */
  baseUrl: string
  chunks: ChunkSource
  json: JsonSource
  now: () => number
  /** How often the digest is rebuilt. Matches the window's own `FLEET_TICK_MS`. */
  tickMs?: number
  /** How long to wait before reconnecting a dropped stream. */
  retryMs?: number
  onDigest: (digest: FleetDigest) => void
  /**
   * How many lanes across EVERY watched colony need a person — prd-58 ruling 5.
   *
   * Separate from the digest on purpose: `digestOf` projects one `Fleet`, and
   * this is a fact about the machine rather than about the rendered colony.
   * Folding it into the digest would make "the badge reads the rung and nothing
   * else" stop being true of a type that says so.
   */
  onColonies?: (needsYouAcrossColonies: number | undefined) => void
  onConnection?: (phase: ConnectionPhase, detail: string | null) => void
}

/** `FleetContext.FLEET_TICK_MS`, restated: one second, because a glance is slower than that. */
export const FLEET_TICK_MS = 1_000
export const RECONNECT_MS = 2_000

export class FleetFeed {
  private readonly options: Required<Omit<FleetFeedOptions, 'onConnection' | 'onColonies'>> &
    Pick<FleetFeedOptions, 'onConnection' | 'onColonies'>
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private fold: FoldedStream = emptyFold()
  private manifest: LaneManifest | null = null
  /** The repo the manifest was last ASKED for — `undefined` until the first ask. Not "the repo we have one for": a repo with no manifest is an answer, and re-asking on every chunk because the answer was `null` is a request storm. */
  private manifestRepo: string | null | undefined = undefined
  private running = false
  private digest: FleetDigest = emptyDigest()

  constructor(options: FleetFeedOptions) {
    this.options = {
      ...options,
      tickMs: options.tickMs ?? FLEET_TICK_MS,
      retryMs: options.retryMs ?? RECONNECT_MS,
    }
  }

  current(): FleetDigest {
    return this.digest
  }

  /** The fold, for a caller that needs the raw counts — the unparsed tally in particular. */
  folded(): FoldedStream {
    return this.fold
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.publish(), this.options.tickMs)
    this.timer.unref?.()
    void this.loop()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.controller?.abort()
    this.controller = null
  }

  /**
   * The cross-colony count, or `undefined` when this server does not report
   * colonies at all.
   *
   * An empty list and a missing field are the same answer here and both mean
   * "no colonies reported" — a replay server, or one that predates prd-58. That
   * is a GAP, and `undefined` is how the badge renders nothing rather than a
   * confident zero.
   */
  private async readColonyNeedsYou(): Promise<number | undefined> {
    try {
      const body = await this.options.json(`${this.options.baseUrl}/api/meta`)
      if (typeof body !== 'object' || body === null) return undefined
      const colonies = (body as { colonies?: unknown }).colonies
      if (!Array.isArray(colonies) || colonies.length === 0) return undefined
      return colonies.reduce((total: number, entry: unknown) => {
        const needsYou = (entry as { needsYou?: unknown }).needsYou
        return total + (typeof needsYou === 'number' ? needsYou : 0)
      }, 0)
    } catch {
      // A meta read that fails must never take the stream down with it: the
      // shell watching a fleet without a colony count beats the shell watching
      // nothing. The badge simply shows the rung, as it always did.
      return undefined
    }
  }

  /** Rebuilds the fleet against the current clock and publishes the digest. */
  publish(): void {
    const fleet = fleetOf(this.fold, this.options.now(), this.manifest)
    this.digest = digestOf(fleet)
    this.options.onDigest(this.digest)
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const controller = new AbortController()
      this.controller = controller
      this.options.onConnection?.('connecting', null)

      try {
        await this.refreshManifest()
        const parser = new SseParser()
        for await (const chunk of this.options.chunks(`${this.options.baseUrl}/api/stream`, controller.signal)) {
          this.fold = foldFrames(this.fold, parser.push(chunk))
          // A session boundary can re-point the fold at another repo (#390's
          // retarget), and a manifest fetched for repo A would then fence
          // repo B's lanes — the exact defect `manifest.ts` records. The
          // manifest is therefore re-asked on the fold's own repo, not once
          // per connection.
          await this.refreshManifest()
          if (!this.running) break
        }
        this.options.onConnection?.('lost', 'the stream ended')
      } catch (error) {
        if (!this.running) return
        this.options.onConnection?.('lost', error instanceof Error ? error.message : String(error))
      }

      if (!this.running) return
      await delay(this.options.retryMs)
    }
  }

  /**
   * The lane manifest, asked for once per repo the fold describes. Absence is a
   * named gap in the fleet object rather than a guess (`manifest.ts`'s own
   * rule): off-fence detection is simply unavailable, and the badge is honest
   * about a fleet with no fences the same way the window is.
   */
  private async refreshManifest(): Promise<void> {
    const repo = this.fold.session.session?.repoPath ?? null
    if (repo === this.manifestRepo) return
    this.manifestRepo = repo
    try {
      this.manifest = parseLaneManifest(await this.options.json(`${this.options.baseUrl}/api/lanes`))
      // prd-58 ruling 5: the tray is visible when the app is not, so a badge
      // counting only the rendered colony would make ruling 1 unsafe in exactly
      // the way ruling 5 exists to prevent. Read beside the manifest, on the
      // same connection, so it costs no extra round trip of its own.
      this.options.onColonies?.(await this.readColonyNeedsYou())
    } catch {
      // A server older than #76 answers 404 and a server that is not there
      // throws. Both mean the same thing to the instrument.
      this.manifest = null
    }
  }
}

/** The default chunk source: `fetch`, decoded. Node 22 gives us both halves of this. */
export function fetchChunks(url: string, signal: AbortSignal): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal })
      if (!response.ok || response.body === null) {
        throw new Error(`${url} answered ${response.status}`)
      }
      const decoder = new TextDecoder()
      for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        yield decoder.decode(piece, { stream: true })
      }
    },
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
