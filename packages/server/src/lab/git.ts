import type { Exec } from '@rhizomorph/core'

/**
 * The lab's one way of running git: argv form, cwd explicit, non-zero exit
 * turned into a thrown Error naming the command. Shared by every lab module
 * so the namespace law test has one grep surface to check rather than one per
 * file — see `namespace-law.test.ts`, which reads these argv literals.
 */
export async function runGit(
  exec: Exec,
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await exec('git', args, { cwd, env })
  if (result.failed) {
    const detail = result.stderr.trim() || result.errorMessage || `exit ${result.code}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout
}
