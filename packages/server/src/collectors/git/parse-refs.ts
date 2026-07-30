/** Pure parser for `git for-each-ref --format='%(refname:short) %(objectname)'`. */

export interface ParsedRef {
  branch: string
  head: string
}

export function parseForEachRef(output: string): ParsedRef[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(' ')
      return { branch: line.slice(0, separator), head: line.slice(separator + 1) }
    })
}
