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

/** Pulls `owner/repo` out of a `git+https://github.com/owner/repo.git`-shaped `repository.url`. */
function ownerRepoFrom(repositoryUrl: string): string | undefined {
  return repositoryUrl.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1]
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

/**
 * The root manifest's published siblings of the field above.
 *
 * `homepage` was guarded on the app manifest alone; `repository.url` and
 * `bugs.url` — the fields npm actually publishes from the ROOT package, and
 * what `npm repo` / `npm bugs` and every registry listing resolve through —
 * had no law at all. Same defect (prd43 w3, #21): a personal fork path
 * instead of where this repo actually lives.
 */
describe("the root manifest's published repository identity", () => {
  const root = manifest(ROOT_MANIFEST)

  it('points its homepage at the repository that actually exists', () => {
    expect(String(root['homepage'] ?? '')).toContain('launchpad-26/rhizomorph')
  })

  it("points repository.url at the same repo — what 'npm repo' resolves", () => {
    const repository = root['repository'] as { url?: string } | undefined
    expect(String(repository?.url ?? '')).toContain('launchpad-26/rhizomorph')
  })

  it("points bugs.url at the same repo's issues — what 'npm bugs' resolves", () => {
    const bugs = root['bugs'] as { url?: string } | undefined
    expect(String(bugs?.url ?? '')).toContain('launchpad-26/rhizomorph')
  })
})

/**
 * Every tracked clone instruction derives from the root manifest's own
 * `repository.url`, rather than typing the owner/repo a second (third,
 * fourth…) time. #21's audit found six copies agreeing with the manifest and
 * needing hand-correction — the shape the sibling law above exists to close
 * for the manifest itself, and this one closes for its readers: a future
 * transfer that updates `repository.url` and forgets a doc is caught here,
 * instead of leaving a dead clone URL for the next stranger to hit.
 *
 * `docs/prds/`, `docs/review/` and `manifest-law.test.ts`'s own comment above
 * are excluded on purpose — they are dated records of what this repo's
 * install identity used to be (prd43 ruling 1's law draws the same line for
 * citations), not live instructions a reader will act on today.
 */
describe("every tracked clone instruction names the manifest's own repository (prd43 w3, #21)", () => {
  const root = manifest(ROOT_MANIFEST)
  const repositoryUrl = String((root['repository'] as { url?: string } | undefined)?.url ?? '')
  const ownerRepo = ownerRepoFrom(repositoryUrl)

  it("the root manifest's repository.url names a github.com owner/repo to derive from", () => {
    expect(ownerRepo).toBe('launchpad-26/rhizomorph')
  })

  const cloneCommand = `git clone https://github.com/${ownerRepo}`
  const REPO_ROOT = path.join(HERE, '..', '..', '..', '..')
  const CLONE_SITES = ['README.md', 'docs/demo.md', 'docs/user-guide/getting-started.md']

  for (const relPath of CLONE_SITES) {
    it(`${relPath} clones the repository the manifest names, not a hand-typed copy`, () => {
      const text = readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
      expect(text).toContain(cloneCommand)
    })
  }

  it('bites: ownerRepoFrom does not accept a fork path the manifest never named — a spelling #21\'s own audit never used', () => {
    expect(ownerRepoFrom('git+https://github.com/a-forked-mirror/rhizomorph.git')).toBe('a-forked-mirror/rhizomorph')
    expect(ownerRepoFrom('git+https://github.com/a-forked-mirror/rhizomorph.git')).not.toBe(ownerRepo)
  })
})
