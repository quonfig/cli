import {type ConfigFile} from '../types.js'

export interface BaseGeneratorArgs {
  configFile: ConfigFile
  log: (category: string | unknown, message?: unknown) => void
  /**
   * Channel for user-facing warnings (identifier-collision dedup, qfg-hbuy.8).
   * Unlike `log` (verbose-only), warnings must always reach the user.
   * Defaults to `console.warn`.
   */
  warn?: (message: string) => void
}

export abstract class BaseGenerator {
  protected configFile: ConfigFile
  protected log: (category: string | unknown, message?: unknown) => void
  protected warn: (message: string) => void

  constructor({configFile, log, warn}: BaseGeneratorArgs) {
    this.configFile = configFile
    this.log = log
    this.warn = warn ?? ((message: string) => console.warn(message))
  }

  abstract generate(): string
}
