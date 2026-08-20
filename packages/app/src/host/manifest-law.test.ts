import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The manifest a person actually receives.
 *
 * Every other workspace here is `0.0.0`, which is right: they are private, they
 * are never published, and a version on them would be a number nobody reads.
 * **This one is different, and it is the only one that is** — it is the package
 * `electron-builder` reads, so its version becomes the installer's filename,
 * the Windows uninstall entry, the macOS Get Info panel and whatever
 * `app.getVersion()` reports in the about box.
 *
 * Left at `0.0.0`, the release artifacts were `rhizomorph-0.0.0-x64.dmg`. That
 * is not a cosmetic complaint: a version of zero is how a build says it was
 * never meant to leave the machine that made it, and the whole point of the
 * doorstep is that a stranger installs this.
 *
 * So the app tracks the ROOT package's version — the product's — and this law
 * holds the two together. Two files stating one fact is the shape this repo
 * uses everywhere (the window ground mirrors `theme.css`, the frame mirrors
 * prd-32's prose); the law is what stops the copy going stale.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_MANIFEST = path.join(HERE, '..', '..', 'package.json')
const ROOT_MANIFEST = path.join(HERE, '..', '..', '..', '..', 'package.json')

function manifest(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe("the shipped manifest is the product's, not a placeholder", () => {
  it("the app's version matches the repo root's — the installer's filename comes from this", () => {
    const app = manifest(APP_MANIFEST)
    const root = manifest(ROOT_MANIFEST)
    expect(app['version']).toBe(root['version'])
  })

  it('is not 0.0.0 — a version of zero is how a build says it was never meant to ship', () => {
    expect(manifest(APP_MANIFEST)['version']).not.toBe('0.0.0')
  })

  it('names the product, so electron-builder does not derive filenames from the npm scope', () => {
    // Without `productName`, electron-builder took `@rhizomorph/app` and
    // produced a Debian package path with a directory in it, which fpm refused
    // outright. `electron-builder.yml` records that failure; this keeps the
    // field that fixed it from being dropped as redundant.
    expect(manifest(APP_MANIFEST)['productName']).toBe('rhizomorph')
  })

  it('points its homepage at the repository that actually exists', () => {
    // It read `KelliherL/rhizomorph` — a personal fork path, not where this
    // lives. A wrong homepage ends up in the Linux desktop entry and the
    // Windows uninstall metadata, which is exactly where nobody looks until a
    // stranger clicks it.
    const homepage = String(manifest(APP_MANIFEST)['homepage'] ?? '')
    expect(homepage).toContain('launchpad-26/rhizomorph')
  })

  it('declares the entry point electron-builder packages, and only bundled output', () => {
    expect(manifest(APP_MANIFEST)['main']).toBe('dist/main.js')
  })
})
