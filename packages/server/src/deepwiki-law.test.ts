import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #472's law — the generated wiki points at THIS repository, and reaching it
 * costs no credential.
 *
 * ADR-0050 accepted a third party generating a public wiki over this repo, and
 * was explicit that the generated page itself is beyond any law here: it is
 * written by a model, refreshed on a vendor's schedule, and nothing in this tree
 * can redden when it is wrong. What this law holds is the half that IS in the
 * tree — the badge, the endpoint, and which repository they name.
 *
 * Two failures worth catching, and neither is hypothetical:
 *
 *   * **A badge that points somewhere else.** The badge is copied from a vendor
 *     README with another project's slug in it, and it renders perfectly. A
 *     reader clicks through to a wiki for a different codebase and has no way to
 *     tell — the image is identical. `manifest-law.test.ts` makes the same
 *     argument about clone URLs and pins them the same way, by DERIVING the
 *     owner/repo from the package manifest rather than accepting a second
 *     hand-typed copy of it.
 *   * **A credential arriving quietly.** The public endpoint needs none, which is
 *     the entire basis on which ADR-0050 was acceptable — ADR-0019 rejected a
 *     hand holding a credential because "a hand that holds a credential has
 *     something worth stealing", and ADR-0034 granted one only after a public
 *     argument and a law per clause. A documentation convenience does not earn
 *     that, so an auth header appearing in this config is a decision that must be
 *     argued, not a config edit.
 *
 * The endpoint spelling is pinned too. The vendor serves both a streamable HTTP
 * endpoint and a deprecated server-sent-events one; a config that drifts onto the
 * deprecated path keeps working until it does not, which is the shape of failure
 * nobody notices until it is load-bearing.
 *
 * Lives under `packages/server/` for the reason every sibling repo-scope law here
 * records: the root vitest config globs `packages/*`, so a root-level test would
 * never run and would be its own vacuous law.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

/**
 * `owner/repo` out of a github.com `repository.url`, validating the WHOLE url.
 *
 * Deliberately the same shape as `manifest-law.test.ts`'s parser rather than a
 * looser search for `github.com/owner/repo` inside the string: that form accepts
 * `https://mirror.github.com/...`, a different host entirely. Dots are legal in
 * repository names, so the name is not truncated at one.
 */
function ownerRepoFromManifest(): string {
  const manifest = JSON.parse(read('package.json')) as { repository?: { url?: string } }
  const url = manifest.repository?.url ?? ''
  const match = url.match(/^git\+https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
  expect(match, `package.json repository.url is not a github https url this law can parse: ${url}`).not.toBeNull()
  return `${match![1]}/${match![2]}`
}

interface McpConfig {
  mcpServers?: Record<string, Record<string, unknown>>
}

function mcpConfig(): McpConfig {
  return JSON.parse(read('.mcp.json')) as McpConfig
}

/** Every deepwiki.com link target in a document, as `owner/repo` where one is named. */
function deepwikiRepoLinks(text: string): string[] {
  return [...text.matchAll(/https:\/\/deepwiki\.com\/([^/\s)]+)\/([^/\s)]+)/g)]
    .map((m) => `${m[1]}/${m[2]}`)
    .filter((slug) => !slug.startsWith('badge.'))
}

describe('the generated wiki names this repository, and reaching it holds no credential (#472)', () => {
  it('.mcp.json is tracked — an untracked config reaches no other checkout', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '.mcp.json'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    expect(tracked).toBe('.mcp.json')
  })

  it('the MCP endpoint is the streamable HTTP one, not the deprecated SSE path', () => {
    const server = mcpConfig().mcpServers?.deepwiki
    expect(server, '.mcp.json no longer declares a "deepwiki" server').toBeDefined()
    expect(server!.url).toBe('https://mcp.deepwiki.com/mcp')
    expect(String(server!.url)).not.toMatch(/\/sse$/)
  })

  it('the MCP server declaration carries no credential — the public endpoint needs none, and that is what makes ADR-0050 cheap', () => {
    const server = mcpConfig().mcpServers?.deepwiki ?? {}
    // Asserted over the serialized declaration rather than a list of known key
    // names: a token can arrive under any spelling, and a law that enumerates
    // spellings misses the next one (prd-46's whole argument).
    const serialized = JSON.stringify(server)
    for (const smell of ['headers', 'Authorization', 'token', 'apiKey', 'api_key', 'secret', 'env']) {
      expect(serialized, `.mcp.json's deepwiki server declares "${smell}" — a credential here is an ADR, not a config edit`).not.toMatch(
        new RegExp(smell, 'i'),
      )
    }
  })

  it("every deepwiki link in the README names THIS repository, derived from the manifest and not retyped", () => {
    const ownerRepo = ownerRepoFromManifest()
    const links = deepwikiRepoLinks(read('README.md'))
    expect(links.length, 'the README carries no deepwiki link — the badge is what buys auto-refresh').toBeGreaterThan(0)
    for (const slug of links) expect(slug).toBe(ownerRepo)
  })

  it('the README carries the badge, because the badge is the refresh mechanism and not decoration', () => {
    const readme = read('README.md')
    expect(readme, 'the badge image').toContain('https://deepwiki.com/badge.svg')
    expect(readme, `the badge links to this repo's own wiki`).toContain(`https://deepwiki.com/${ownerRepoFromManifest()}`)
  })

  it('the detectors bite — each failure this law exists to catch, run through the same code the checks above use', () => {
    const ownerRepo = ownerRepoFromManifest()

    // A badge copied from another project's README. It renders identically.
    expect(deepwikiRepoLinks('[![x](https://deepwiki.com/badge.svg)](https://deepwiki.com/someone-else/other-repo)')).toEqual([
      'someone-else/other-repo',
    ])
    expect(deepwikiRepoLinks('[![x](https://deepwiki.com/badge.svg)](https://deepwiki.com/someone-else/other-repo)')[0]).not.toBe(ownerRepo)

    // The badge asset alone names no repository, and must not be read as one.
    expect(deepwikiRepoLinks('![x](https://deepwiki.com/badge.svg)')).toEqual([])

    // A host that merely CONTAINS github.com is not github.com.
    expect('git+https://mirror.github.com/launchpad-26/rhizomorph.git'.match(/^git\+https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)).toBeNull()

    // A dotted repository name is not truncated at the dot — that would silently
    // resolve to a different repository.
    const dotted = 'git+https://github.com/launchpad-26/rhizomorph.archive.git'.match(/^git\+https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
    expect(`${dotted![1]}/${dotted![2]}`).toBe('launchpad-26/rhizomorph.archive')

    // And the control: the real README is not pointing anywhere else, so the
    // checks above are reporting planted faults rather than a standing one.
    for (const slug of deepwikiRepoLinks(read('README.md'))) expect(slug).toBe(ownerRepo)
  })
})
