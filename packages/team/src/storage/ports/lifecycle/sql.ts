import type { SqlLike } from '../../driver.js'
import type { LifecyclePort } from './port.js'

export function createLifecycleSql(sql: SqlLike): LifecyclePort {
  return {
    async close(): Promise<void> {
      await sql.end()
    },
  }
}
