import type { SqlLike } from './driver.js'

/**
 * A DRIVER DOUBLE — records what the adapter sends, returns what a test scripts.
 *
 * This is not `FakeTeamStorage`, and conflating the two loses the thing each
 * one is for. `fake.ts` stands in for the *port*, so the runner and the
 * bootstrap can be tested above it. This stands in for the *driver*, so
 * `postgres.ts` — the one module the port cannot abstract away — has a
 * falsifiable test at all.
 *
 * What it records is deliberately two different things:
 *
 * - the **statement text**, as `strings.raw.join('?')`, so a test can assert
 *   that a value was bound rather than interpolated: an interpolated value
 *   changes the text, a bound one does not.
 * - the **bound values**, verbatim, so a test can assert bytes rather than
 *   round-tripped objects. That is the only way "`line` is stored verbatim" can
 *   fail for the reason it claims.
 *
 * `log` additionally carries `BEGIN` and `COMMIT` markers around a `begin()`
 * block, so transaction membership is assertable by position.
 */

export interface RecordedQuery {
  /** The template's literal text with every `${}` replaced by `?`. */
  readonly sql: string
  readonly values: readonly unknown[]
}

export interface RecordingSql {
  /** The double itself, satisfying the driver slice structurally. */
  readonly sql: SqlLike
  /** Every tagged-template query and every `unsafe()` statement, in order. */
  readonly queries: RecordedQuery[]
  /** `BEGIN` / `COMMIT` / `ROLLBACK` markers interleaved with each query's text. */
  readonly log: string[]
  /** `end()` was called. */
  readonly ended: () => boolean
  /** Rows the next tagged-template call returns. Queued; an empty queue yields `[]`. */
  script(rows: readonly unknown[]): void
  /** Makes the next tagged-template call reject with this error. */
  scriptFailure(error: Error): void
}

/** `` sql`a ${1} b ${2}` `` -> `a ? b ?` — the text the server would see, with values elided. */
function templateText(strings: TemplateStringsArray): string {
  return strings.raw.join('?')
}

export function createRecordingSql(): RecordingSql {
  const queries: RecordedQuery[] = []
  const log: string[] = []
  const scripted: (readonly unknown[])[] = []
  const failures: (Error | null)[] = []
  let ended = false

  function record(sql: string, values: readonly unknown[]): unknown[] {
    queries.push({ sql, values })
    log.push(sql)
    const failure = failures.shift()
    if (failure) throw failure
    const rows = scripted.shift()
    return rows ? [...rows] : []
  }

  function build(): SqlLike {
    const tag = (strings: TemplateStringsArray, ...values: readonly unknown[]): PromiseLike<unknown[]> => {
      try {
        return Promise.resolve(record(templateText(strings), values))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    const withMembers = Object.assign(tag, {
      unsafe(text: string) {
        return {
          simple(): PromiseLike<unknown> {
            try {
              return Promise.resolve(record(text, []))
            } catch (error) {
              return Promise.reject(error)
            }
          },
        }
      },
      async begin<T>(fn: (tx: SqlLike) => Promise<T>): Promise<T> {
        log.push('BEGIN')
        try {
          const value = await fn(build())
          log.push('COMMIT')
          return value
        } catch (error) {
          log.push('ROLLBACK')
          throw error
        }
      },
      async end(): Promise<void> {
        ended = true
      },
    })

    // The one cast. `SqlLike`'s call signature is generic in its row type and a
    // concrete implementation cannot be generic in the caller's `T`; every
    // stand-in for a tagged-template driver has this shape.
    return withMembers as unknown as SqlLike
  }

  return {
    sql: build(),
    queries,
    log,
    ended: () => ended,
    script(rows: readonly unknown[]): void {
      scripted.push(rows)
    },
    scriptFailure(error: Error): void {
      failures.push(error)
    },
  }
}
