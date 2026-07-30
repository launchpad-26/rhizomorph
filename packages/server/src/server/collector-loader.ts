import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnyCollector } from '@observatory/core'

const COLLECTOR_SLUGS = ['git', 'tmux', 'workmux'] as const

const collectorsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'collectors')

function isCollectorLike(value: unknown): value is AnyCollector {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AnyCollector).name === 'string' &&
    typeof (value as AnyCollector).initialSnapshot === 'function' &&
    typeof (value as AnyCollector).poll === 'function'
  )
}

/**
 * Loads whatever collectors are actually present under `src/collectors/*`.
 * Wave 2 builds git/tmux/workmux collectors in parallel worktrees, so at any
 * given moment some, none, or all of them may be merged into this checkout —
 * the server must boot and run happily with whatever's there. A directory
 * that doesn't exist yet is skipped without so much as a warning; a
 * directory that exists but fails to import (mid-merge breakage) logs a
 * warning and is skipped rather than crashing the CLI.
 */
export async function loadCollectors(
  log: { warn: (msg: string) => void } = console,
): Promise<AnyCollector[]> {
  const collectors: AnyCollector[] = []

  for (const slug of COLLECTOR_SLUGS) {
    const dir = path.join(collectorsRoot, slug)
    if (!existsSync(dir) && !existsSync(`${dir}.ts`)) continue

    try {
      const mod: Record<string, unknown> = await import(`../collectors/${slug}/index.js`)
      for (const exported of Object.values(mod)) {
        if (isCollectorLike(exported)) collectors.push(exported)
      }
    } catch (error) {
      log.warn(
        `observatory: failed to load collector "${slug}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  return collectors
}
