#!/usr/bin/env node
// Vendors the server's runtime dependencies for the packaged app (#565).
//
// ── WHY THIS EXISTS, AND HOW IT WAS FOUND ────────────────────────────────────
//
// The server bundle is built `--external:fastify` (`packages/server`'s own
// `build` script), so a packaged app has to carry fastify beside it. The first
// version of `electron-builder.yml` copied `node_modules/fastify` and
// `node_modules/@fastify` and called it done — which packaged an app whose
// server died on its first boot with an unresolved transitive dependency,
// because fastify has a tree of its own and copying the top of it copies none
// of it.
//
// It was found by running the packaged binary rather than by reading the
// config: the app came up, reported "the server exited with code 1 before the
// shell asked it to" on its honest failure page, and the terminal said the
// same. That is the failure mode working; it is not a reason to leave it.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
//
// Resolves the root `package.json`'s runtime dependencies into a clean tree of
// their own, with `npm install --omit=dev`, so what ships is exactly the
// closure the server needs and nothing else — not the repo's development tree,
// and not a hand-listed subset that goes stale the first time fastify gains a
// dependency.
//
// The versions come from the repo's own `package.json`, so the vendored tree
// and the tree CI tests against are the same declaration. It is written to
// `dist-vendor/` at the repo root, gitignored beside `dist-desktop/`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const vendorDir = path.join(repoRoot, 'dist-vendor')

const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const dependencies = rootManifest.dependencies ?? {}

if (Object.keys(dependencies).length === 0) {
  // Not "nothing to do": the server is built `--external:fastify`, so an empty
  // dependency list means the packaged app would ship a server that cannot
  // resolve its own framework. Fail loudly rather than produce that.
  console.error('vendor-runtime: the root package.json declares no runtime dependencies — refusing to vendor nothing')
  process.exit(1)
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
writeFileSync(
  path.join(vendorDir, 'package.json'),
  `${JSON.stringify({ name: 'rhizomorph-vendored-runtime', version: '0.0.0', private: true, dependencies }, null, 2)}\n`,
)

console.log(`vendor-runtime: installing ${Object.entries(dependencies).map(([n, v]) => `${n}@${v}`).join(', ')}`)
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', vendorDir], {
  stdio: 'inherit',
  cwd: repoRoot,
})

console.log(`vendor-runtime: wrote ${path.join(vendorDir, 'node_modules')}`)
