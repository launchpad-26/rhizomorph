import type { Exec } from '@rhizomorph/core'

/**
 * prd11 ruling 6b, phase 1 — the structural judge organ's symbol-extraction
 * half (research `docs/research/2026-08-04-semantic-judge-spike.md`, verdict
 * §1). Reads one lane's diff against main with read-only git plumbing
 * (`git diff --unified=0 <main>...<branch>`, three-dot: the branch's own
 * changes since it diverged, ignoring what main did meanwhile) and pulls out
 * the names of functions/consts/classes/types/interfaces the diff ADDS.
 *
 * This is a HEURISTIC, not a parse: a pragmatic regex-per-line pass over
 * TS/TSX source text, not an AST. It will miss a declaration whose signature
 * line didn't itself change (only a body edit), miss non-TS/TSX languages
 * entirely, and can't see a renamed symbol that means the same thing
 * (`formatDuration` vs `humanizeTime`) — that residue is exactly what the
 * spike's semantic (LLM) layer exists for. What it DOES catch reliably: two
 * lanes independently adding a same-named export in different files, the
 * spike's own headline example, at zero cost and zero judgement.
 */

export interface SymbolExtractionOptions {
  exec: Exec
  repoPath: string
  mainBranch: string
  branch: string
}

export interface ExtractedSymbols {
  branch: string
  /** Sorted, deduped declaration names this lane's diff adds, across every TS/TSX file it touches. */
  symbols: string[]
}

/** Only a pragmatic TS/TSX pass — see the module doc comment. */
const TS_FILE_RE = /\.tsx?$/

/**
 * One capture group each, tried in order per added line. Intentionally loose
 * (no attempt to reject strings/comments containing lookalike text) — a false
 * positive here costs nothing worse than a slightly noisier symbol set; a
 * false negative silently loses a real collision, which is the worse failure
 * for a corroboration signal.
 */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
]

function declaredSymbol(line: string): string | null {
  for (const pattern of DECLARATION_PATTERNS) {
    const match = pattern.exec(line)
    if (match?.[1]) return match[1]
  }
  return null
}

/** Strips a `+++ b/<path>` (or `--- a/<path>`) diff header down to the bare path. */
function headerPath(line: string, prefix: string): string | null {
  const raw = line.slice(prefix.length)
  if (raw === '/dev/null') return null
  return raw.replace(/^[ab]\//, '')
}

/**
 * Parses a `git diff --unified=0` text and returns every declaration name an
 * ADDED line introduces, restricted to TS/TSX files. Exported for direct unit
 * testing against captured diff text, without shelling out to git.
 */
export function parseAddedDeclarations(diffText: string): string[] {
  const symbols = new Set<string>()
  let currentFile: string | null = null

  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('+++ ')) {
      currentFile = headerPath(rawLine, '+++ ')
      continue
    }
    if (currentFile === null || !TS_FILE_RE.test(currentFile)) continue
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue

    const symbol = declaredSymbol(rawLine.slice(1))
    if (symbol) symbols.add(symbol)
  }

  return [...symbols].sort()
}

/** Runs the real diff and extracts this lane's declared symbols. Throws on a git failure — the caller decides how to degrade. */
export async function extractLaneSymbols(options: SymbolExtractionOptions): Promise<ExtractedSymbols> {
  const { exec, repoPath, mainBranch, branch } = options
  const result = await exec('git', ['diff', '--unified=0', `${mainBranch}...${branch}`], { cwd: repoPath })
  if (result.failed) {
    throw new Error(`git diff failed for branch "${branch}": ${result.errorMessage ?? result.stderr}`)
  }
  return { branch, symbols: parseAddedDeclarations(result.stdout) }
}

/** Sorted intersection of two lanes' symbol sets — the pairwise overlap the collector reports. */
export function intersectSymbols(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b)
  return [...new Set(a.filter((symbol) => bSet.has(symbol)))].sort()
}
