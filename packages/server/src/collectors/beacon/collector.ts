import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AdapterCapabilities, Collector, CollectorContext, PollResult, RhizomorphEvent } from '@rhizomorph/core'
import { beaconDirFor, BEACON_FILE_SUFFIX } from './paths.js'
import { parseBeaconLine } from './parse-beacon-line.js'
import { readBeaconLines } from './read-beacon-lines.js'
import type { BeaconSnapshot } from './types.js'

export const BEACON_COLLECTOR_NAME = 'beacon'

export interface BeaconCollectorConfig {
  /** Where `<repoSlug>/beacons/` lives; defaults to the instrument's data root at each tick, exactly as the pi collector defaults its own. Tests point it at a temp dir. */
  dataRoot?: string
}

/**
 * The beacon collector's manifest (prd-15 ruling 5).
 *
 * Why `attention` is `absent` here and not `partial`: prd-27 ruling 3's
 * amendment says a configured-but-silent beacon reads `partial` with the
 * reason said — but this wave cannot tell "configured" from "never offered"
 * (no emitter exists yet), and `deriveRung` reads `attention: partial` +
 * `telemetry: absent` as L3, the PTY rung, when merged over a fleet with no
 * transcript organ. That would be a false rung on a promise. `absent` with the
 * reason is the honest static answer until #218 gives attention a per-lane
 * reading. The sessionlog collector's own `attention.remedy` — "a hook beacon
 * would declare it" — is deliberately not edited: it now names a collector
 * that exists, and it is still true.
 */
export const BEACON_CAPABILITIES: AdapterCapabilities = {
  identity: {
    level: 'partial',
    reason: 'a beacon names its lane by the handle the writer chose; nothing here verifies it against a worktree',
    remedy: 'the fold that reads beacons (prd-27 w2, #218) joins it to the lane the other collectors know',
  },
  liveness: {
    level: 'absent',
    reason: 'a beacon is an occurrence, not a heartbeat — silence means nothing until the lapse mechanism exists',
    remedy: 'prd-27 ruling 6 / w2 (#218): declared attention lapses after a measured interval',
  },
  activity: { level: 'absent', reason: 'no beacon kind is folded yet', remedy: 'prd-27 w2 (#218)' },
  attention: {
    level: 'absent',
    reason:
      'a beacon declares attention per lane only once one has arrived (prd-27 ruling 3), and nothing reads one yet — declaring provided here would put every lane on L4 on a promise',
    remedy: 'prd-27 w2 (#218): the fold, the lapse and the disagreement voice; then per-lane declared attention reads provided',
  },
  telemetry: { level: 'absent', reason: 'a beacon carries no tokens', remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP' },
  cost: { level: 'absent', reason: 'a beacon carries no dollars', remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP' },
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
export function createBeaconCollector(config: BeaconCollectorConfig = {}): Collector<BeaconSnapshot> {
  const dataRoot = config.dataRoot
  return {
    name: BEACON_COLLECTOR_NAME,
    capabilities: BEACON_CAPABILITIES,
    initialSnapshot: () => ({ disabled: false, files: {} }),
    async poll(previous, context) {
      // The resilience wrapper flips this off before every attempt it schedules.
      if (previous.disabled) return { nextSnapshot: previous, events: [] }

      const dir = beaconDirFor(context.repoPath, dataRoot)
      let entries
      try {
        const info = await stat(dir)
        if (!info.isDirectory()) return disable(context, `beacon path is not a directory: ${dir}`)
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { nextSnapshot: { disabled: false, files: {} }, events: [] }
        }
        return disable(context, `cannot read beacon directory ${dir}: ${String(error)}`)
      }

      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(BEACON_FILE_SUFFIX))
        .map((entry) => entry.name)
        .sort()
      const nextFiles: BeaconSnapshot['files'] = {}
      const events: RhizomorphEvent[] = []

      for (const file of files) {
        const prior = previous.files[file]
        let result
        try {
          result = await readBeaconLines(path.join(dir, file), prior?.offset ?? 0, prior?.identity)
        } catch {
          // The file vanished between readdir and open: drop it from the
          // snapshot this tick, emit nothing for it. Not a tick failure.
          continue
        }

        let malformed = 0
        let firstReason: string | undefined
        let firstOffset = 0
        for (const line of result.lines) {
          const parsed = parseBeaconLine(line.text)
          if (parsed.kind === 'beacon') {
            events.push(
              context.emit(
                'beacon.received',
                {
                  ...parsed.payload,
                  digest: createHash('sha256').update(line.text, 'utf8').digest('hex'),
                  file,
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
              message: `malformed beacon line skipped in ${file}`,
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
