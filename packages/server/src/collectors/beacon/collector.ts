import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  AdapterCapabilities,
  Collector,
  CollectorContext,
  DeclaredAttention,
  PollResult,
  RhizomorphEvent,
} from '@rhizomorph/core'
import { canonicalize } from '../../paths/containment.js'
import { parseBeaconLine } from './parse-beacon-line.js'
import { BEACON_FILE_SUFFIX, beaconDirFor, beaconLineBelongsTo, installationBeaconDir } from './paths.js'
import { readBeaconLines } from './read-beacon-lines.js'
import type { BeaconSnapshot } from './types.js'

export const BEACON_COLLECTOR_NAME = 'beacon'

export interface BeaconCollectorConfig {
  /** Where `<repoSlug>/beacons/` lives; defaults to the instrument's data root at each tick, exactly as the pi collector defaults its own. Tests point it at a temp dir. */
  dataRoot?: string
}

/**
 * The beacon collector's **static** manifest (prd-15 ruling 5) — what the organ
 * can say before a single beacon has arrived in this session.
 *
 * `attention` is `partial`, which is prd-27 ruling 3's amendment applied
 * literally: *configured-but-silent reads `partial`, with the reason said*.
 * #217 could not write that and had to say `absent` instead, and ADR-0036's
 * own record says why — `attention: partial` + `telemetry: absent` was the
 * PTY-wrapper signature, so a hook that had never spoken would have read as
 * L3, a rung on a promise. #218 closed that by type rather than by level:
 * the detail is signed `witness: 'beacon'` (ADR-0039), `deriveRung` never
 * reads a beacon's `partial` as the PTY rung, and it reads a beacon's
 * `provided` as L2 rather than L4.
 *
 * The live counterpart is {@link beaconCapabilitiesFor}: this object is what
 * the organ answers when no lane has ever been declared for.
 */
export const BEACON_CAPABILITIES: AdapterCapabilities = {
  identity: {
    level: 'partial',
    reason: 'a beacon names its lane by the handle the writer chose; the fold joins it by equality only (#283)',
    remedy: 'the identity join across handle spellings is prd-27 follow-up work',
  },
  liveness: {
    level: 'absent',
    reason:
      'a beacon is an occurrence, not a heartbeat; its silence is read per lane by the lapse (BEACON_LAPSE_MS, #218), and liveness itself is the transcript organ’s',
    remedy: 'the sessionlog organ provides liveness wherever a transcript exists',
  },
  activity: {
    level: 'absent',
    reason: 'a beacon’s kind is an attention word, not an activity record',
    remedy: 'the sessionlog organ provides activity',
  },
  attention: {
    level: 'partial',
    witness: 'beacon',
    reason:
      'configured-but-silent reads partial (prd-27 ruling 3): the beacon organ declares attention per lane only once a beacon for that lane has arrived, and none has in this session',
    remedy: 'install the hooks — `rhizomorph env <lane> --hooks claude` — and the lane’s next prompt declares it',
  },
  telemetry: { level: 'absent', reason: 'a beacon carries no tokens', remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP' },
  cost: { level: 'absent', reason: 'a beacon carries no dollars', remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP' },
}

/**
 * The organ’s live manifest for one session (prd-27 ruling 3, #218): attention
 * `provided` — signed `beacon`, so `deriveRung` reads L2 — once any lane has
 * been declared for, else the static configured-but-silent manifest. Lapse is
 * per lane and does not lower this: the manifest says what the organ can
 * provide in this session; `attentionReading` says whether it is speaking now.
 */
export function beaconCapabilitiesFor(declared: Readonly<Record<string, DeclaredAttention>>): AdapterCapabilities {
  if (Object.keys(declared).length === 0) return BEACON_CAPABILITIES
  return { ...BEACON_CAPABILITIES, attention: { level: 'provided', witness: 'beacon' } }
}

/**
 * Tails every `*.jsonl` file in the watched repo's beacon directory
 * (`beaconDirFor`, ADR-0036) and records each complete one-line JSON beacon
 * as a `beacon.received` event — prd-27 ruling 1's door, and prd-17 ruling
 * 2's, ruled to be the same door on 2026-08-24. Never a route.
 *
 * Three conditions that a collector written from `sessionlog`'s template
 * would collapse into one, kept apart on purpose:
 *
 * - **A missing directory is the ordinary state**, not a fault: no writer
 *   exists yet, or none has spoken. Empty result, `disabled: false`, no
 *   `collector.error`. The collector never creates the directory (`paths.ts`).
 * - **A per-line fault is a `collector.error`**, coalesced to one per file per
 *   tick with `count`, the first reason and its byte offset. It is not a tick
 *   failure and never disables: a collector that died on one bad line would
 *   take attention down with it.
 * - **A tick fault** — the path is a file, the directory is unreadable — is a
 *   `collector.disabled` with `disabled: true` on the snapshot, exactly as
 *   `sessionlog` reports its own, so `withResilience` degrades, disables and
 *   probes on the shared policy.
 *
 * The event's `ts` is the writer's own `at`, never the tick clock; `digest` is
 * sha256 over the line's exact bytes; `file` + `offset` point back at those
 * bytes (sidecar for content, event for occurrence). The directory is derived
 * from `context.repoPath` every tick, so a retarget re-points it with nothing
 * else to thread. The collector reads: no `mkdir`, no write, no exec.
 */
/**
 * The line's `cwd`, canonicalised — the same obligation `placementOf` already
 * carries for `process.seen.worktreePath`, and for the same reason.
 *
 * prd-57 ruling 3's declared join compares these two values for string
 * equality, in `packages/core`, where `node:fs` cannot go (ADR-0003). So they
 * have to be comparable BY CONSTRUCTION, and the only place that can make them
 * so is a collector. The process leg canonicalises; this one did not, and wrote
 * the harness's string verbatim — so on a repo reached through a symlink
 * (#217's standing macOS case) the two could never match and every lane-less
 * beacon declined, permanently and silently.
 *
 * The canonicalisation was already being computed here and thrown away:
 * `beaconLineBelongsTo` routes the line through `isInside`, which resolves both
 * sides. Found in the fifth review of #589, which also pointed out that the
 * trade the join was agonising over — believe a stale path, or lose the symlink
 * case — was a false one, because this cause can simply be removed.
 *
 * **A deleted directory is not a failure here.** `canonicalize` walks up to the
 * nearest existing ancestor and re-joins the tail, so a worktree removed since
 * the hook fired still yields a canonical, comparable path. It throws only on
 * ELOOP or EACCES, and the `catch` keeps the string AS WRITTEN for those: it is
 * still the writer's own account of where it was, the digest still covers the
 * original bytes, and the join declines on an unmatched path as it does on any
 * other. That branch is **defensive and untested** — neither condition is
 * portably reproducible — and saying so is better than a test that names it and
 * exercises something else, which is what the first attempt at one did.
 */
function canonicalCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  try {
    return canonicalize(cwd)
  } catch {
    return cwd
  }
}

export function createBeaconCollector(config: BeaconCollectorConfig = {}): Collector<BeaconSnapshot> {
  const dataRoot = config.dataRoot
  return {
    name: BEACON_COLLECTOR_NAME,
    capabilities: BEACON_CAPABILITIES,
    initialSnapshot: () => ({ disabled: false, files: {} }),
    async poll(previous, context) {
      // The resilience wrapper flips this off before every attempt it schedules.
      if (previous.disabled) return { nextSnapshot: previous, events: [] }

      /**
       * TWO doors, read in one tick — prd-57 ruling 6 / ADR-0055.
       *
       * The installation door (`<dataRoot>/beacons`) is where the hook runner
       * writes, because a hook fires for whatever repo the agent is in and the
       * writer cannot be asked to compute the reader's slug. The per-repo door
       * is still read because one written before this wave holds real lines,
       * and dropping them silently would lose beacons already collected.
       *
       * Keyed by FULL path in the snapshot rather than by basename: two doors
       * can hold a file of the same name, and a shared key would make one
       * file's cursor resume the other's — re-emitting or skipping arbitrarily.
       */
      const doors = [
        { dir: installationBeaconDir(dataRoot), shared: true },
        { dir: beaconDirFor(context.repoPath, dataRoot), shared: false },
      ]
      const files: { path: string; shared: boolean }[] = []
      for (const { dir, shared } of doors) {
        let entries
        try {
          const info = await stat(dir)
          if (!info.isDirectory()) return disable(context, `beacon path is not a directory: ${dir}`)
          entries = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          // A door that does not exist yet is the ordinary state, not a fault:
          // this collector never creates one, and an operator who has never
          // enlisted has no installation door at all.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          return disable(context, `cannot read beacon directory ${dir}: ${String(error)}`)
        }
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(BEACON_FILE_SUFFIX))
            files.push({ path: path.join(dir, entry.name), shared })
        }
      }
      files.sort((left, right) => left.path.localeCompare(right.path))
      const nextFiles: BeaconSnapshot['files'] = {}
      const events: RhizomorphEvent[] = []

      for (const { path: file, shared } of files) {
        const prior = previous.files[file]
        let result
        try {
          result = await readBeaconLines(file, prior?.offset ?? 0, prior?.identity)
        } catch {
          // Not a tick failure either way, but the two reasons a read fails
          // here need different cursors. A file that **vanished** between
          // readdir and open is gone from the next readdir too, so dropping
          // it is right and it drops out one tick later with no events. Any
          // **transient** fault — EACCES while a writer re-permissions its
          // file, EMFILE, a Windows share lock — leaves the file exactly
          // where it was, and dropping its cursor makes the next successful
          // tick read it from byte 0 and re-emit every beacon already on the
          // log. Carrying the prior cursor forward covers both: the vanished
          // file still disappears, the readable one resumes where it stopped.
          if (prior !== undefined) nextFiles[file] = prior
          continue
        }

        let malformed = 0
        let firstReason: string | undefined
        let firstOffset = 0
        for (const line of result.lines) {
          const parsed = parseBeaconLine(line.text)
          if (parsed.kind === 'beacon') {
            /**
             * THE ROUTING RULE (prd-57 ruling 6 / ADR-0055). ADR-0036's guarantee
             * — a beacon from one repo's swarm never folds into another repo's
             * session — is kept, and enforced here rather than by the shape of
             * the directory.
             *
             * A line whose `cwd` is not inside the watched repo is RETAINED and
             * attributed to none: the cursor still advances past it, so it is not
             * re-read forever, and no event is emitted for it. That covers both
             * cases a shared door creates — another repo's swarm, and a hook that
             * fired somewhere this instrument has never watched.
             *
             * An absent `cwd` is the honest unknown and is also not a match.
             * Guessing would be precisely the fold this rule exists to prevent.
             *
             * **Only the SHARED door is routed.** The per-repo door keeps
             * ADR-0036's structural scoping — a line in it is already known to
             * belong to this repo by the directory it sits in, and its writers
             * predate `cwd` entirely. Routing those would drop every beacon
             * ever written by the existing hooks, which is not a rule change
             * but a regression wearing one.
             */
            if (shared && !beaconLineBelongsTo(context.repoPath, parsed.payload.cwd)) continue
            events.push(
              context.emit(
                'beacon.received',
                {
                  ...parsed.payload,
                  cwd: canonicalCwd(parsed.payload.cwd),
                  digest: createHash('sha256').update(line.text, 'utf8').digest('hex'),
                  file: path.basename(file),
                  offset: line.offset,
                },
                { ts: parsed.at },
              ),
            )
          } else {
            malformed += 1
            if (firstReason === undefined) {
              firstReason = parsed.reason
              firstOffset = line.offset
            }
          }
        }
        if (malformed > 0) {
          events.push(
            context.emit('collector.error', {
              collector: BEACON_COLLECTOR_NAME,
              message: `malformed beacon line skipped in ${path.basename(file)}`,
              detail: `${firstReason} (first at byte ${firstOffset})`,
              count: malformed,
            }),
          )
        }
        nextFiles[file] = { offset: result.nextOffset, identity: result.identity }
      }

      return { nextSnapshot: { disabled: false, files: nextFiles }, events }
    },
  }
}

function disable(context: CollectorContext, reason: string): PollResult<BeaconSnapshot> {
  return {
    nextSnapshot: { disabled: true, files: {} },
    events: [context.emit('collector.disabled', { collector: BEACON_COLLECTOR_NAME, reason })],
  }
}
