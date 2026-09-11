#!/usr/bin/env node
// packaging-guard.mjs — asserts `npm pack` ships the allowlist and nothing
// else. Extracted verbatim from the `Packaging guard` step of
// `.github/workflows/ci.yml`, which carried it as an inline heredoc; the
// logic is unchanged, only its home is. Run after `npm run build` at the repo
// root — the caller owns that step, the same contract `pack-smoke.sh` states.
//
// The guard flags only UNEXPECTED files, so it passes VACUOUSLY over an empty
// `dist/`. That is why ci.yml gated it on Build's own outcome rather than
// always(), and why `ci-local.sh` skips it when Build went red: a green here
// on an unbuilt tree has verified nothing.
import { execSync } from 'node:child_process'

const allowed = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^packages\/server\/dist\//,
  /^packages\/server\/bin\//,
  /^packages\/web\/dist\//,
]

const root = execSync('git rev-parse --show-toplevel').toString().trim()
const out = execSync('npm pack --dry-run --json', { cwd: root }).toString()
const [pkg] = JSON.parse(out)
const files = pkg.files.map((f) => f.path)
const unexpected = files.filter((f) => !allowed.some((re) => re.test(f)))

if (unexpected.length > 0) {
  console.error('Packaging guard failed — unexpected files in npm pack output:')
  for (const f of unexpected) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`Packaging guard passed — ${files.length} files, all allowlisted.`)
