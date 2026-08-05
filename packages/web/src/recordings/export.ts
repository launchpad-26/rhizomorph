import { buildRecord, type SessionRecord } from '@rhizomorph/core/src/record/index.js'
import { fetchSessionEvents, type FetchLike } from '../replay/api.js'

/**
 * THE PORTABLE RECORD, DOWNLOADED (prd16 ruling 4, item 4). `buildRecord`
 * (`@rhizomorph/core/src/record/`) is already written and already pure — no
 * Node-only crypto, so it runs in the browser exactly as it runs in
 * `cli/export-record.ts` — so this wires it to a download instead of
 * reimplementing it. The events it folds come from `GET
 * /api/sessions/:id/events`, the same read `replay/api.ts`'s
 * `fetchSessionEvents` already serves the scrubber; nothing here is a second
 * read of the log with a different shape.
 *
 * This is not the app's mutating call — every request it makes is a GET
 * (`/api/meta`, `/api/sessions/:id/events`); the download itself is a
 * client-side `Blob`, never a network write.
 */

export interface ExportOutcome {
  fileName: string
  record: SessionRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The live repo's own name, for the export's `repoSlug` and file name — a read, same route `app/StatusBar.tsx` already polls. */
async function fetchRepoName(fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl('/api/meta')
  if (!response.ok) throw new Error(`/api/meta responded ${response.status}`)
  const data: unknown = await response.json()
  const repoName = isRecord(data) ? data.repoName : undefined
  return typeof repoName === 'string' && repoName.length > 0 ? repoName : 'repo'
}

/** `document`/`URL` seam a test can replace with a spy, so this stays testable under jsdom without a real download landing on disk. */
export interface DownloadEnv {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  createAnchor(): { href: string; download: string; click(): void }
  appendAnchor(anchor: { click(): void }): void
  removeAnchor(anchor: { click(): void }): void
}

function defaultDownloadEnv(): DownloadEnv {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement('a'),
    appendAnchor: (anchor) => document.body.appendChild(anchor as unknown as Node),
    removeAnchor: (anchor) => document.body.removeChild(anchor as unknown as Node),
  }
}

function downloadJson(fileName: string, data: unknown, env: DownloadEnv): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' })
  const url = env.createObjectURL(blob)
  const anchor = env.createAnchor()
  anchor.href = url
  anchor.download = fileName
  env.appendAnchor(anchor)
  anchor.click()
  env.removeAnchor(anchor)
  env.revokeObjectURL(url)
}

/**
 * Builds the portable record for one recorded session and triggers its
 * download — the manifest plus the log's own lines verbatim under a hash
 * chain (prd11's federation wire format), exactly what `rhizomorph
 * export-record` writes to disk, here written to the browser's downloads
 * instead.
 */
export async function exportRecording(
  sessionId: string,
  fetchImpl: FetchLike = fetch,
  env: DownloadEnv = defaultDownloadEnv(),
): Promise<ExportOutcome> {
  const [repoName, { events }] = await Promise.all([
    fetchRepoName(fetchImpl),
    fetchSessionEvents(sessionId, fetchImpl),
  ])

  const record = buildRecord(events, {
    repoSlug: repoName,
    actor: { instance: sessionId, handle: 'browser export', declared: false },
  })

  const fileName = `${repoName}-${sessionId}.rhizorecord.json`
  downloadJson(fileName, record, env)
  return { fileName, record }
}
