/** THE SETTINGS PORT — the preflight's only read (prd-51 ruling 4). */
export interface SettingsPort {
  /**
   * Reads one Postgres GUC by name. The preflight's only read (ruling 4).
   * Returns the empty string when the setting is unknown.
   */
  readSetting(name: string): Promise<string>
}
