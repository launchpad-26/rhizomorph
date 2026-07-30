export interface CliArgs {
  /** Target repo path, or undefined to default to cwd. */
  path: string | undefined
  port: number
}

const DEFAULT_PORT = 4321

/** Parses `observatory [path] [--port <n>]`. The first non-flag token is the path. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let path: string | undefined
  let portArg: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
      portArg = argv[i + 1]
      i += 1
    } else if (arg?.startsWith('--port=')) {
      portArg = arg.slice('--port='.length)
    } else if (arg !== undefined && !arg.startsWith('-') && path === undefined) {
      path = arg
    }
  }

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  // 0 is a legitimate value ("let the OS pick a free port"), used by tests.
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}"`)
  }

  return { path, port }
}
