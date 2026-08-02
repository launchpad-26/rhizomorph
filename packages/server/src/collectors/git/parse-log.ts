import type { Author, FileChange, FileStatus } from '@rhizomorph/core'

/**
 * Pure parser for `git log --raw --numstat -M --pretty=format:<LOG_PRETTY>`.
 *
 * `--raw` and `--numstat` are the one pair of diff formats git will render
 * together in a single pass: `--raw` carries status letters (including
 * rename/copy source paths) and `--numstat` carries insertion/deletion
 * counts. Neither alone has both, and combining `--name-status` with
 * `--numstat` collapses to whichever was passed last. Each commit's raw
 * block and numstat block list the same files in the same order, so we zip
 * them by index rather than re-parsing numstat's `{old => new}` shorthand.
 */

const RECORD_SEPARATOR = '\x01'
const FIELD_SEPARATOR = '\x1f'

/** Pass as `--pretty=format:${LOG_PRETTY}`. */
export const LOG_PRETTY = `${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%at${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%s`

export interface ParsedCommit {
  sha: string
  shortSha: string
  author: Author
  authoredAt: number
  parents: string[]
  subject: string
  files: FileChange[]
  insertions: number
  deletions: number
}

export function parseGitLog(output: string): ParsedCommit[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map(parseChunk)
}

function parseChunk(chunk: string): ParsedCommit {
  const [headerLine = '', ...bodyLines] = chunk.split(/\r?\n/)
  const [sha = '', shortSha = '', authorName = '', authorEmail = '', authoredAtSeconds = '0', parentsRaw = '', subject = ''] =
    headerLine.split(FIELD_SEPARATOR)

  const rawLines = bodyLines.filter((line) => line.startsWith(':'))
  const numstatLines = bodyLines.filter((line) => /^(?:\d+|-)\t(?:\d+|-)\t/.test(line))

  const files = rawLines.map((rawLine, index) => parseFile(rawLine, numstatLines[index]))
  const insertions = files.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)

  return {
    sha,
    shortSha,
    author: authorEmail ? { name: authorName, email: authorEmail } : { name: authorName },
    authoredAt: Number(authoredAtSeconds) * 1000,
    parents: parentsRaw.split(' ').filter(Boolean),
    subject,
    files,
    insertions,
    deletions,
  }
}

const RAW_LINE_PATTERN = /^:\d+ \d+ [0-9a-f]+\.{0,3} [0-9a-f]+\.{0,3} ([A-Z])\d*\t(.+)$/

function parseFile(rawLine: string, numstatLine: string | undefined): FileChange {
  const match = RAW_LINE_PATTERN.exec(rawLine)
  if (!match) throw new Error(`unparseable git raw diff line: ${rawLine}`)
  const [, statusCode = 'M', pathsField = ''] = match
  const paths = pathsField.split('\t')
  const isRenameOrCopy = statusCode === 'R' || statusCode === 'C'

  const path = (isRenameOrCopy ? paths[1] : paths[0]) ?? ''
  const previousPath = isRenameOrCopy ? paths[0] : undefined
  const { insertions, deletions } = parseNumstat(numstatLine)

  return { path, status: mapStatus(statusCode), previousPath, insertions, deletions }
}

function parseNumstat(line: string | undefined): { insertions?: number; deletions?: number } {
  if (!line) return {}
  const [insertions, deletions] = line.split('\t')
  return {
    insertions: insertions === '-' ? undefined : Number(insertions),
    deletions: deletions === '-' ? undefined : Number(deletions),
  }
}

function mapStatus(code: string): FileStatus {
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'unmerged'
    default:
      return 'modified'
  }
}
