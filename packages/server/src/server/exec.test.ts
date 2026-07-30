import { describe, expect, it } from 'vitest'
import { exec } from './exec.js'

describe('exec', () => {
  it('resolves stdout for a successful command', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write("hi")'])
    expect(result).toEqual({ stdout: 'hi', stderr: '', code: 0, failed: false })
  })

  it('reports failure with an exit code for a nonzero exit', async () => {
    const result = await exec('node', ['-e', 'process.exit(3)'])
    expect(result.failed).toBe(true)
    expect(result.code).toBe(3)
  })

  it('reports failure with an error message for a missing binary', async () => {
    const result = await exec('observatory-definitely-not-a-real-binary', [])
    expect(result.failed).toBe(true)
    expect(result.code).toBeNull()
    expect(result.errorMessage).toBeTruthy()
  })
})
