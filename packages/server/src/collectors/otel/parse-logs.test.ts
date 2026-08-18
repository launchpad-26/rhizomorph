import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateLogsExport } from './parse-logs.js'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

describe('validateLogsExport', () => {
  it('accepts a structurally valid ExportLogsServiceRequest', () => {
    expect(validateLogsExport(fixture('logs-basic.json'))).toEqual({ malformed: false })
  })

  it('rejects a body whose resourceLogs is not an array', () => {
    const result = validateLogsExport(fixture('logs-malformed.json'))
    expect(result.malformed).toBe(true)
    expect(result.detail).toBeTruthy()
  })

  it('never throws on wildly wrong input', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      expect(() => validateLogsExport(body)).not.toThrow()
      expect(validateLogsExport(body).malformed).toBe(true)
    }
  })

  describe('gemini-cli (#323, ADR-0025)', () => {
    // This route never dispatches on a log record's name for any harness —
    // turning one into an event is sessionlog's job, over the transcript
    // file, not this route's (see this file's own top-of-file doc comment).
    // So gemini's real records (gemini_cli.api_request/.api_response/
    // .tool_call/.model_routing, gen_ai.client.inference.operation.details)
    // need no profile: the route's whole contract is "is this valid OTLP,"
    // and these captures answer yes, same as claude's records always have.
    it.each([
      'gemini-cli-0.55.1-otlp-3-logs.json',
      'gemini-cli-0.55.1-otlp-5-logs.json',
      'gemini-cli-0.55.1-otlp-7-logs.json',
    ])('accepts the real capture %s as a structurally valid ExportLogsServiceRequest', (name) => {
      expect(validateLogsExport(fixture(name))).toEqual({ malformed: false })
    })
  })
})
