import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { labRdHelpText, parseLabRdArgs } from './lab-rd.js'

/**
 * `rhizomorph lab rd`'s argv contract (prd55 rulings 1 and 2).
 *
 * The two restated constants are pinned HERE against their literals and
 * checked against the engine's own source TEXT, never against an import: the
 * laboratory's namespace law allows exactly one importer of
 * `server/src/lab/`, and this file is not it. That is the same mitigation
 * `MODEL_GRAMMAR`'s two copies carry — duplicate deliberately, pin both ends,
 * and make a drift between them red.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_SOURCE = path.join(HERE, '..', 'lab', 'rd.ts')

const rdDefaults = {
  lane: 'w5b-412',
  model: 'opus',
  corpus: 'local' as const,
  maxTurns: undefined,
  agentCommand: undefined,
  path: undefined,
  json: false,
  help: false,
}

describe('parseLabRdArgs', () => {
  it('defaults the corpus to local — the tracker is a second act, never the default (prd55 ruling 2)', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'opus'])).toEqual(rdDefaults)
  })

  it('takes the lane and the model from prd55 ruling 1\'s own signature', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'claude-opus-5'])).toEqual({ ...rdDefaults, model: 'claude-opus-5' })
  })

  it('refuses a run with no model rather than picking one — a call that spends money does not choose its own', () => {
    expect(() => parseLabRdArgs(['w5b-412'])).toThrow(/missing required option: --model/)
    expect(() => parseLabRdArgs(['w5b-412', '--model', ''])).toThrow(/invalid --model/)
  })

  it('refuses a run with no lane — an R&D run is booked to a lane', () => {
    expect(() => parseLabRdArgs(['--model', 'opus'])).toThrow(/missing required argument: <lane>/)
  })

  it('takes the tracker corpus only when it is spelled, and refuses a third one', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'opus', '--corpus', 'local+tracker'])).toEqual({
      ...rdDefaults,
      corpus: 'local+tracker',
    })
    expect(() => parseLabRdArgs(['w5b-412', '--model', 'opus', '--corpus', 'everything'])).toThrow(
      /invalid --corpus value: "everything"/,
    )
    // The refusal says WHY there is no third one, not just that there isn't.
    expect(() => parseLabRdArgs(['w5b-412', '--model', 'opus', '--corpus', 'tracker'])).toThrow(
      /reading the tracker is a second act/,
    )
  })

  it('bounds the turns, and refuses a bound that is not a count', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'opus', '--max-turns', '3'])).toEqual({ ...rdDefaults, maxTurns: 3 })
    for (const bad of ['0', '-1', '2.5', 'three']) {
      expect(() => parseLabRdArgs(['w5b-412', '--model', 'opus', '--max-turns', bad]), bad).toThrow(/invalid --max-turns/)
    }
  })

  it('takes the operator\'s own binary name, and refuses one that is really a command line', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'opus', '--agent-command', 'my-claude'])).toEqual({
      ...rdDefaults,
      agentCommand: 'my-claude',
    })
    // A name with a space would read as two arguments to anyone looking at the
    // recorded argv, so it is refused here rather than surfacing later as a
    // binary that is not on PATH.
    expect(() => parseLabRdArgs(['w5b-412', '--model', 'opus', '--agent-command', 'claude --dangerous'])).toThrow(
      /a binary name is one word/,
    )
    expect(() => parseLabRdArgs(['w5b-412', '--model', 'opus', '--agent-command', ''])).toThrow(/invalid --agent-command/)
  })

  it('parses --json as a valueless switch — the document a route reads back through runCli', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'opus', '--json'])).toEqual({ ...rdDefaults, json: true })
    expect(() => parseLabRdArgs(['w5b-412', '--model', 'opus', '--json=yes'])).toThrow(/takes no value/)
  })

  it('parses --path, so the corpus is read from the watched repo rather than from wherever you typed', () => {
    expect(parseLabRdArgs(['w5b-412', '--model', 'opus', '--path', '../repo'])).toEqual({ ...rdDefaults, path: '../repo' })
  })

  it('answers --help without requiring the arguments it is explaining', () => {
    for (const flag of ['--help', '-h']) {
      const args = parseLabRdArgs([flag])
      expect(args.help, flag).toBe(true)
      expect(args.corpus, flag).toBe('local')
    }
  })
})

describe('labRdHelpText', () => {
  it('says what the hand is, whose credential it uses, and what it costs', () => {
    const text = labRdHelpText()
    expect(text).toContain('rhizomorph lab rd <lane> --model <m> [options]')
    expect(text).toContain('no\ntools granted')
    expect(text).toContain('this instrument holds no credential')
    expect(text).toContain('under your own login (ADR-0048)')
  })

  it('names the corpus ruling 2 fixes, and says the tracker is separately declared', () => {
    const text = labRdHelpText()
    expect(text).toContain("docs/research/*-retro.md")
    expect(text).toContain("docs/review/*.md")
    expect(text).toContain('--corpus local+tracker')
    expect(text).toContain('second, separately declared act')
  })

  it('says a refused proposal is recorded as a refusal, never patched (ruling 3)', () => {
    expect(labRdHelpText()).toContain('Nothing is patched into legality on the way through.')
  })

  it('documents every option this parser actually reads — a flag that works and is undocumented is the export-otlp defect, one level down', () => {
    const text = labRdHelpText()
    for (const flag of ['--model', '--corpus', '--max-turns', '--agent-command', '--path', '--json', '--help']) {
      expect(text, flag).toContain(flag)
    }
  })
})

describe('the two constants restated from the engine (the namespace law\'s split, ADR-0012\'s mitigation)', () => {
  const engine = readFileSync(ENGINE_SOURCE, 'utf8')

  it('the default binary name is the same word on both sides of the seam', () => {
    // This side, pinned to its literal…
    expect(labRdHelpText()).toContain('(default: "claude"')
    // …and the engine's side, read as TEXT because importing it would make
    // this file a second importer of `server/src/lab/`, which the namespace
    // law forbids. A drift in either copy turns this red.
    expect(engine).toContain("export const DEFAULT_AGENT_COMMAND = 'claude'")
  })

  it('the corpus vocabulary is the same two words on both sides, and there is no third', () => {
    const text = labRdHelpText()
    expect(text).toContain('"local" (default) or "local+tracker"')
    expect(engine).toContain("export type RdCorpusChoice = 'local' | 'local+tracker'")
    // The parser admits exactly those two and nothing else — proven by the
    // refusal above, and stated here as the closed set it is.
    expect(parseLabRdArgs(['l', '--model', 'm', '--corpus', 'local']).corpus).toBe('local')
    expect(parseLabRdArgs(['l', '--model', 'm', '--corpus', 'local+tracker']).corpus).toBe('local+tracker')
  })
})
