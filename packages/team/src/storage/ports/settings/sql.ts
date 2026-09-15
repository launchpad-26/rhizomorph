import type { SqlLike } from '../../driver.js'
import type { SettingsPort } from './port.js'

export function createSettingsSql(sql: SqlLike): SettingsPort {
  return {
    async readSetting(name: string): Promise<string> {
      const rows = await sql<{ setting: string | null }[]>`SELECT current_setting(${name}, true) AS setting`
      return rows[0]?.setting ?? ''
    },
  }
}
