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
})
