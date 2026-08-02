import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerContext } from '../server/context.js'

/**
 * The prd3 lane manifest (ruling 19) — written by the conductor's dispatch
 * tooling at `<repo>/.swarm/lanes.json` every time it dispatches a wave:
 * handle, branch, and fence globs per lane, so "where is this agent" can be
 * derived downstream (recently-touched files vs fence globs) without a new
 * collector. `issue`/`model`/`dispatchedAt` are dispatch metadata the
 * Rhizomorph doesn't require to do off-fence detection.
 */
/**
 * Accepts `null` as well as absent and normalises both to `undefined`. A
 * manifest is operator input, not a compiled artifact — a dispatch tool that
 * briefly wrote `issue: null` should not un-fence the whole repo by failing
 * the entire manifest. This is field-level tolerance, the same spirit as the
 * web validator's `parseFenceEntry` coercing a stray non-string `issue` to
 * `null` rather than rejecting the entry — it only diverges from the web
 * validator's *structural* flat-refusal (a bad `handle`/`fence` still fails
 * the whole manifest there, and a bad `fence` still fails it here too).
 */
const nullableOptionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)

const laneSchema = z.object({
  handle: z.string(),
  branch: z.string(),
  fence: z.array(z.string()),
  issue: nullableOptionalString,
  model: nullableOptionalString,
  dispatchedAt: z.string().optional(),
  /**
   * Operator-declared (prd4 ruling 5) — an operator marks a lane parked in
   * `.swarm/lanes.json` so the fleet view stops alarming on silence it
   * already knows about. Optional and defaults to absent; only ever `true`
   * on the wire, matching the web validator's `LaneFence.parked`.
   */
  parked: z.boolean().optional(),
})
export type Lane = z.infer<typeof laneSchema>

const lanesManifestSchema = z.object({
  version: z.number(),
  lanes: z.array(laneSchema),
})
export type LanesManifest = z.infer<typeof lanesManifestSchema>

export type LanesResult = ({ available: true } & LanesManifest) | { available: false; reason: string }

/** Relative to the watched repo root — the contract dispatch tooling writes to. */
export const LANES_MANIFEST_RELATIVE_PATH = path.join('.swarm', 'lanes.json')

/** Absolute path to the lane manifest inside `repoPath`. */
export function lanesManifestPath(repoPath: string): string {
  return path.join(repoPath, LANES_MANIFEST_RELATIVE_PATH)
}

/**
 * Reads and validates the lane manifest, re-read fresh on every call (no
 * caching — dispatch rewrites it on every wave and it is tiny). An absent
 * file is an honest, expected state; a present-but-unparseable-or-invalid
 * file is a loud degradation with the parse/schema detail attached, never a
 * silent empty list.
 */
export async function readLanesManifest(repoPath: string): Promise<LanesResult> {
  const manifestPath = lanesManifestPath(repoPath)

  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (isEnoent(error)) {
      return { available: false, reason: 'no lane manifest — dispatch has not written .swarm/lanes.json' }
    }
    return { available: false, reason: `could not read .swarm/lanes.json: ${errorMessage(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { available: false, reason: `.swarm/lanes.json is not valid JSON: ${errorMessage(error)}` }
  }

  const result = lanesManifestSchema.safeParse(parsed)
  if (!result.success) {
    return {
      available: false,
      reason: `.swarm/lanes.json does not match the lane manifest schema: ${result.error.message}`,
    }
  }

  return { available: true, ...result.data }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerLanesRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/lanes', async () => readLanesManifest(ctx.repoPath))
}
