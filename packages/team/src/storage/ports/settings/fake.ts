import type { SettingsPort } from './port.js'

export interface SettingsFakeOptions {
  /** What `readSetting` returns, by name. Anything unnamed reads as `''`. */
  readonly settings?: Readonly<Record<string, string>>
}

/**
 * `calls` is the shared call log, a plain `string[]` handed in by the composing
 * fake. There is deliberately no shared fake-state module: an array is the whole
 * contract, so a new port needs no edit to anything shared to join the log.
 */
export function createSettingsFake(calls: string[], options: SettingsFakeOptions): SettingsPort {
  const settings = options.settings ?? {}
  return {
    async readSetting(name: string): Promise<string> {
      calls.push('readSetting')
      return settings[name] ?? ''
    },
  }
}
