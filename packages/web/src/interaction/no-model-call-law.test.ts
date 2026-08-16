import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * NOTHING IN THIS INSTRUMENT SENDS ANYTHING ANYWHERE (prd-9 ruling 9; ADR-0009;
 * "nothing leaves the machine") — and prd-31 ruling 6 is the clause that made it
 * worth a law of its own here.
 *
 * The card's verdict line is *the agent's own first sentence, quoted verbatim*.
 * The obvious next feature request is a summary, and the obvious way to build
 * one is a model call. Both are forbidden, and for the same reason: a summary is
 * an editorialisation of evidence, and a model call is bytes leaving the
 * machine. So this directory is greppable-clean of both.
 *
 * **Every scanner here is a pure function over `{name, text}` pairs**, and each
 * has a fixture proving it fires — the shape `disclosure/one-card-law.test.ts`
 * established, for its reason: a law shown to pass on an empty walk, a typo'd
 * regex or a directory nobody scanned is decoration.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

interface SourceFile {
  name: string
  text: string
}

function sourceFiles(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => ({ name: entry.name, text: readFileSync(path.join(dir, entry.name), 'utf8') }))
}

/** Comments blanked rather than stripped, so a failure's line count still matches the file. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

/** What is shipped — a test file has to be able to NAME the pattern it forbids. */
function shipped(files: readonly SourceFile[]): SourceFile[] {
  return files.filter((file) => !/\.test\.tsx?$/.test(file.name))
}

/**
 * Anything that sends bytes off this process. `fetch` is the one the app uses
 * everywhere else and would be the least remarkable line to add here; the rest
 * are the ways round it.
 */
export function outboundCalls(files: readonly SourceFile[]): string[] {
  return shipped(files)
    .filter((file) =>
      /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket|EventSource\s*\(|import\s*\(\s*['"]https?:/.test(
        withoutComments(file.text),
      ),
    )
    .map((file) => file.name)
}

/**
 * Anything that would produce prose the agent did not write. The list is the
 * vocabulary a summary feature would arrive under — and `anthropic`/`openai`,
 * which is what a model call looks like whatever it is called.
 */
export function summarisers(files: readonly SourceFile[]): string[] {
  return shipped(files)
    .filter((file) => /\bsummari[sz]e|\bparaphrase|\banthropic\b|\bopenai\b|\bcompletions?\b/i.test(withoutComments(file.text)))
    .map((file) => file.name)
}

describe('the walk reaches the directory it claims to', () => {
  it('sees this module’s own files', () => {
    const names = sourceFiles(HERE).map((file) => file.name)
    expect(names).toEqual(expect.arrayContaining(['model.ts', 'InteractionCard.tsx', 'index.ts']))
  })

  it('has shipped files left after the test files are dropped', () => {
    // An empty `shipped()` is how both laws below would pass vacuously.
    expect(shipped(sourceFiles(HERE)).length).toBeGreaterThan(2)
  })
})

describe('no model call — nothing here sends anything anywhere', () => {
  it('finds no outbound call in the whole module', () => {
    expect(outboundCalls(sourceFiles(HERE))).toEqual([])
  })

  it('would name a file that reached for the network', () => {
    expect(
      outboundCalls([
        { name: 'model.ts', text: 'const summary = await fetch("https://api.example.com/summarise")' },
        { name: 'InteractionCard.tsx', text: 'const quote = model.quote.headline' },
      ]),
    ).toEqual(['model.ts'])
  })

  it('does not count a call named in prose — the scanner reads code, not comments', () => {
    expect(outboundCalls([{ name: 'a.ts', text: '// a card that called fetch() would be lying\nconst x = 1' }])).toEqual([])
  })
})

describe('no summarisation — the words are quoted, never written', () => {
  it('finds no summariser in the whole module', () => {
    expect(summarisers(sourceFiles(HERE))).toEqual([])
  })

  it('would name a file that summarised instead of quoting', () => {
    expect(
      summarisers([
        { name: 'model.ts', text: 'const headline = summarise(block.text)' },
        { name: 'quote.ts', text: 'const headline = firstSentence(block.text)' },
      ]),
    ).toEqual(['model.ts'])
  })

  it('would name a model client under any of its usual names', () => {
    expect(
      summarisers([
        { name: 'a.ts', text: "import Anthropic from '@anthropic-ai/sdk'" },
        { name: 'b.ts', text: "const r = await client.completions.create({})" },
      ]).sort(),
    ).toEqual(['a.ts', 'b.ts'])
  })
})

describe('the quote is a SLICE, structurally', () => {
  it('builds its headline with `slice`, so every character is the agent’s', () => {
    // The strongest form of "not summarised" that a grep can state: the one
    // function that shortens a quote returns `text.slice(...)`. A paraphrase
    // cannot be written that way, so a later hand replacing this with anything
    // that composes a string fails here before it fails a render test.
    const source = readFileSync(path.join(HERE, 'model.ts'), 'utf8')
    const body = /export function firstSentence\([\s\S]*?\n}/.exec(source)?.[0] ?? ''
    expect(body, 'firstSentence is not in model.ts under that name').not.toBe('')
    expect(body).toContain('text.slice(')
    expect(body).not.toMatch(/`[^`]*\$\{/)
  })
})
