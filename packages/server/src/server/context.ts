import type { PollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'

/**
 * Everything the API routes need, threaded through from the CLI bootstrap so
 * routes stay unit-testable.
 *
 * RE-POINTABLE (prd20 ruling 5, retarget spike Q1/Q4): `repoPath`, `repoName`
 * and `sessionDir` are read live by every route that needs them — none of
 * them is captured into a closure at registration, `registerDoctorRoute`'s
 * memoized probe (`api/doctor.ts`) excepted, which carries its own
 * invalidation for exactly this reason. A retarget mutates these three
 * fields directly on the object every route already holds; `buildApp` never
 * copies this context (`build-app.ts`'s own doc explains why that copy used
 * to be the trap), so the mutation is visible everywhere at once.
 */
export interface ServerContext {
  repoPath: string
  repoName: string
  /** Directory holding this repo's session-*.jsonl files, past and present. */
  sessionDir: string
  recorder: SessionRecorder
  /**
   * The poll loop this boot is running, when there is one (a replay server
   * has none). Exposed here — rather than left a `cli/run.ts`-local variable
   * — so a mutating route that needs to react to a session boundary (today,
   * `POST /api/rotate`'s snapshot reset; prd20 ruling 5's retarget tomorrow)
   * can reach it without a new plumbing seam of its own.
   */
  pollLoop?: PollLoop
  /** Path to the built web app (packages/web/dist), if it should be served statically. */
  webDistDir?: string
  /** Flatline threshold in ms, for routes/selectors that derive agent liveness. Defaults to the core selector's own default. */
  flatlineMs?: number
  /**
   * Injectable clock for the one route that writes (`POST /api/rotate`), so a
   * test can rotate at a pinned instant. Defaults to `Date.now`; no read-only
   * route needs it, since a fold's "now" comes from the events themselves.
   */
  now?: () => number
  /**
   * True when this server is serving a portable session record
   * (`rhizomorph replay`) rather than watching a repo. A record is a finished
   * thing: the recorder's hand (prd16 ruling 2) is refused here, so nothing
   * can rotate a recording someone else made.
   */
  readOnly?: boolean
  /**
   * The per-process capability token (2026-08-06 audit; `api/security.ts`)
   * every mutating route requires. Optional here because `buildApp` mints
   * one at boot when a caller doesn't supply one — a test that needs a
   * specific value (or none at all, to assert the default-generated path)
   * is the only reason to set this directly.
   */
  capabilityToken?: string
  /**
   * The port this Rhizomorph is (or will be) listening on — what
   * `POST /api/concierge/launch` (prd-20 ruling 4) hands a harness adapter as
   * `HarnessLaunchContext.port`, so the launched process's OTLP export points
   * back at this same server. Optional for the same reason `capabilityToken`
   * is: only that one route reads it, `cli/run.ts` and `cli/replay.ts` always
   * supply the real `--port` value, and no other route has a reason to set it.
   *
   * Read at `buildApp` time, not from the live socket: `app.server.address()`
   * is `null` until `app.listen()` resolves, which is *after* `ServerContext`
   * exists and is unreachable under Fastify's `.inject()` (no real socket is
   * ever bound), so a route reading the socket directly could never be unit
   * tested. This field is therefore the value the CLI *asked* `--port` for —
   * identical to the real bound port whenever it resolves, except the
   * `--port 0` "let the OS pick" form (a real, documented CLI value, not only
   * a test convenience), which this does not chase: the launch route treats
   * `0` the same as `undefined` — an honest refusal rather than a harness
   * wired to a port nothing is listening on.
   */
  port?: number
}
