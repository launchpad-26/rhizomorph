/**
 * THE NO-FORK DETECTORS (prd-34 ruling 1 / success 4; #563's "a test or check
 * asserts no forked server/web code exists in the app package").
 *
 * prd-34's whole claim is that the instrument gains a doorstep and loses
 * nothing: the Fastify server and the React SPA ship **unmodified**, and the
 * shell is packaging around them. There are exactly two ways to break that, and
 * only one of them is visible in a diff of `packages/server` or `packages/web`:
 *
 * 1. a shell-only code path grows *inside* those packages — which this lane's
 *    fence forbids outright, and a reviewer reading the diff would see;
 * 2. a copy of them grows *here*, where no reviewer of those packages is
 *    looking. A window that "just needed a small status view", a route the
 *    shell "just needed to answer itself", a second React tree for a wizard.
 *
 * The second is the one that needs a law, and this module is it: four
 * detectors, each returning the offending evidence rather than a boolean, so a
 * red says what to delete. They are deliberately structural rather than
 * clever — a fork of a surface cannot happen without importing its framework,
 * rendering its markup, or copying its file.
 *
 * The detectors are pure over `(path, source)` pairs so
 * `no-fork-law.test.ts` can run each against a **rigged** input that proves it
 * bites, as well as against the real package. A law nobody has watched fail is
 * a law nobody knows works.
 */

export interface SourceFile {
  /** Repo-relative, forward-slashed. */
  path: string
  source: string
}

export interface ForkFinding {
  path: string
  /** What was found, quoted, so the failure names the line rather than the file. */
  evidence: string
  /** Why this is a fork rather than a style question. */
  why: string
}

/**
 * Packages whose presence in the shell means a surface is being rebuilt. React
 * and Fastify are the two frameworks the two surfaces are made of; the two
 * workspace packages are the surfaces themselves.
 *
 * `@rhizomorph/core` is deliberately absent: the shell reduces the same event
 * log the window reduces, with the same reducer, because ruling 8 requires the
 * badge and the instrument to never disagree. Sharing the derivation is the
 * opposite of forking it — a second implementation of the ladder is exactly
 * what would let them disagree.
 */
export const FORBIDDEN_IMPORTS = [
  'react',
  'react-dom',
  'fastify',
  '@rhizomorph/server',
  '@rhizomorph/web',
] as const

const IMPORT_PATTERN = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every module specifier a file reaches for, static or dynamic. */
export function importedModules(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2]
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

/** Detector 1 — the shell reaching for a framework only a surface needs. */
export function forbiddenImports(files: readonly SourceFile[]): ForkFinding[] {
  const findings: ForkFinding[] = []
  for (const file of files) {
    for (const specifier of importedModules(file.source)) {
      const root = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      if (root === undefined) continue
      if (!(FORBIDDEN_IMPORTS as readonly string[]).includes(root)) continue
      findings.push({
        path: file.path,
        evidence: specifier,
        why: `the shell imports ${root}, which it can only need in order to rebuild a surface the instrument already has`,
      })
    }
  }
  return findings
}

/** Detector 2 — a React tree, whatever it imports. JSX is not something a process supervisor grows by accident. */
export function renderingFiles(files: readonly SourceFile[]): ForkFinding[] {
  return files
    .filter((file) => /\.[jt]sx$/.test(file.path))
    .map((file) => ({
      path: file.path,
      evidence: file.path,
      why: 'a `.tsx`/`.jsx` file in the shell is a second UI: the SPA is the only thing that draws',
    }))
}

/** Detector 3 — an HTTP surface of the shell's own. The shell adds no route (prd-34, and #565 restates it). */
const SERVER_SHAPES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /createServer\s*\(/, what: 'creates an HTTP server' },
  { pattern: /\bfastify\s*\(/, what: 'builds a Fastify app' },
  { pattern: /\.(get|post|put|delete|patch)\s*\(\s*['"]\/api\//, what: 'declares an /api route' },
]

export function servingFiles(files: readonly SourceFile[]): ForkFinding[] {
  const findings: ForkFinding[] = []
  for (const file of files) {
    for (const shape of SERVER_SHAPES) {
      const match = shape.pattern.exec(file.source)
      if (match === null) continue
      findings.push({
        path: file.path,
        evidence: match[0],
        why: `the shell ${shape.what} — the instrument already has one, and prd-34 adds no route to it`,
      })
    }
  }
  return findings
}

/**
 * Detector 4 — a literal copy. Compares whitespace-normalised bodies, so a
 * reformatted paste is still caught, and reports the pair rather than only the
 * copy.
 */
export function copiedFiles(shell: readonly SourceFile[], instrument: readonly SourceFile[]): ForkFinding[] {
  const byBody = new Map<string, string>()
  for (const file of instrument) {
    const body = normalise(file.source)
    if (body.length < 200) continue // too small to be a fork of anything
    if (!byBody.has(body)) byBody.set(body, file.path)
  }

  const findings: ForkFinding[] = []
  for (const file of shell) {
    const origin = byBody.get(normalise(file.source))
    if (origin === undefined) continue
    findings.push({
      path: file.path,
      evidence: origin,
      why: `this file is a copy of ${origin} — the shell forks nothing; it spawns and embeds`,
    })
  }
  return findings
}

function normalise(source: string): string {
  return source.replace(/\s+/g, ' ').trim()
}

/** Every finding across every detector — what the law asserts is empty. */
export function auditShell(shell: readonly SourceFile[], instrument: readonly SourceFile[]): ForkFinding[] {
  return [
    ...forbiddenImports(shell),
    ...renderingFiles(shell),
    ...servingFiles(shell),
    ...copiedFiles(shell, instrument),
  ]
}

/** A finding, said out loud — what was found, where, and why it is a fork. */
export function describeFinding(finding: ForkFinding): string {
  return `${finding.path}: ${finding.evidence} — ${finding.why}`
}
