import {type ConfigFile} from '../types.js'

export interface BaseGeneratorArgs {
  configFile: ConfigFile
  log: (category: string | unknown, message?: unknown) => void
}

export abstract class BaseGenerator {
  protected configFile: ConfigFile
  protected log: (category: string | unknown, message?: unknown) => void

  constructor({configFile, log}: BaseGeneratorArgs) {
    this.configFile = configFile
    this.log = log
  }

  abstract generate(): string
}
