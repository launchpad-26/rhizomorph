import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseForEachRef } from './parse-refs.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/for-each-ref/${name}`, import.meta.url), 'utf8')
}

describe('parseForEachRef', () => {
  it('parses branch name / head sha pairs', () => {
    expect(parseForEachRef(fixture('basic.txt'))).toEqual([
      { branch: 'feature/alpha', head: '6e164406fdc3e92168183601862506dbce13cec4' },
      { branch: 'feature/locked', head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d' },
      { branch: 'main', head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d' },
    ])
  })

  it('returns an empty array for empty output', () => {
    expect(parseForEachRef('')).toEqual([])
  })
})
