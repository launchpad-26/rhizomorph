/**
 * Reverses git's C-style path quoting (`quote.c:quote_c_style`), applied by
 * `git status --porcelain` to any path with a space or byte >= 0x80, and by
 * `git log --raw`/`--numstat` to any path with a control byte or byte >= 0x80.
 *
 * `-z` (NUL-delimited, unquoted) output was considered instead of unquoting
 * on parse, and rejected: `git log`'s custom `\x01`/`\x1f` pretty format
 * zips `--raw`/`--numstat` blocks by line index, and `-z` NUL-terminates
 * those blocks and splits rename paths across separate NUL fields, which
 * collides with that scheme. Unquoting on parse keeps one convention across
 * both status and log, and leaves the `git-collector.ts` invocations and
 * fixture formats untouched.
 */
export function unquotePath(field: string): string {
  if (field.length < 2 || field[0] !== '"' || field[field.length - 1] !== '"') return field

  const body = field.slice(1, -1)
  const bytes: number[] = []

  let i = 0
  while (i < body.length) {
    // A full code point, not `body[i]`: an astral-plane character (emoji) is
    // two UTF-16 code units, and encoding each surrogate half separately
    // turns it into two U+FFFDs. Raw non-ASCII lands inside quotes whenever
    // the user has `core.quotePath=false` — git then quotes for the space
    // but leaves the bytes raw — and the collector inherits user config.
    const char = String.fromCodePoint(body.codePointAt(i) ?? 0)
    if (char !== '\\') {
      pushChar(bytes, char)
      i += char.length
      continue
    }

    const next = body[i + 1]
    if (next === undefined) {
      bytes.push(0x5c)
      i += 1
      continue
    }

    const named = NAMED_ESCAPES[next]
    if (named !== undefined) {
      bytes.push(named)
      i += 2
      continue
    }

    if (next >= '0' && next <= '7') {
      let octal = ''
      let j = i + 1
      while (j < body.length && octal.length < 3 && (body[j] ?? '') >= '0' && (body[j] ?? '') <= '7') {
        octal += body[j]
        j += 1
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff)
      i = j
      continue
    }

    bytes.push(0x5c)
    i += 1
  }

  return Buffer.from(bytes).toString('utf8')
}

const NAMED_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c,
}

function pushChar(bytes: number[], char: string): void {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) {
    bytes.push(code)
    return
  }
  for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte)
}
