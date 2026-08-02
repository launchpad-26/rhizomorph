import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The root `package.json` next to wherever this module ends up running from
 * — `packages/server/src/cli` unbuilt, `packages/server/dist/cli` once
 * esbuild has bundled it (see `packages/server/package.json`'s `build`
 * script), both four levels below the repo root. Same convention as
 * doctor.ts's `defaultRootPackageJsonPath`, duplicated rather than imported
 * to avoid a circular cli/index.ts <-> doctor.ts import.
 */
export function defaultRootPackageJsonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', '..', 'package.json')
}

/**
 * `--version`'s only source of truth: the published package's own
 * `package.json`, read fresh rather than baked into a constant, so the two
 * cannot drift apart from each other by construction.
 */
export async function readPackageVersion(rootPackageJsonPath: string = defaultRootPackageJsonPath()): Promise<string> {
  const raw = await readFile(rootPackageJsonPath, 'utf8')
  const pkg = JSON.parse(raw) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`no "version" string in ${rootPackageJsonPath}`)
  }
  return pkg.version
}
