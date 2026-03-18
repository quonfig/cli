import {Flags} from '@oclif/core'

import {APICommand} from '../index.js'

interface ConfigMetadata {
  description: string
  id: number
  key: string
  name: string
  type: string
  version: number
}

interface ConfigMetadataResponse {
  configs: ConfigMetadata[]
}

export default class List extends APICommand {
  static description = `Show keys for your config/feature flags/etc.

  All types are returned by default. If you pass one or more type flags (e.g. --configs), only those types will be returned`

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --feature-flags']

  static flags = {
    configs: Flags.boolean({default: false, description: 'include configs'}),
    'feature-flags': Flags.boolean({default: false, description: 'include flags'}),
    'log-levels': Flags.boolean({default: false, description: 'include log levels'}),
    schemas: Flags.boolean({default: false, description: 'include schemas'}),
    segments: Flags.boolean({default: false, description: 'include segments'}),
  }

  public async run() {
    const {flags} = await this.parse(List)

    const request = await this.apiClient.get('/all-config-types/v1/metadata')

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to fetch configs: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const response = request.json as unknown as ConfigMetadataResponse
    let configs = response.configs

    const selectedTypes: string[] = []

    if (flags.configs) {
      selectedTypes.push('config')
    }

    if (flags['feature-flags']) {
      selectedTypes.push('feature_flag')
    }

    if (flags['log-levels']) {
      selectedTypes.push('log_level')
    }

    if (flags.schemas) {
      selectedTypes.push('schema')
    }

    if (flags.segments) {
      selectedTypes.push('segment')
    }

    if (selectedTypes.length > 0) {
      configs = configs.filter((config) => selectedTypes.includes(config.type.toLowerCase()))
    }

    // Calculate column widths
    const maxKeyLength = Math.max(10, ...configs.map((c) => c.key.length))
    const maxTypeLength = Math.max(10, ...configs.map((c) => c.type.length))
    const maxNameLength = Math.max(20, ...configs.map((c) => (c.name || '').length))

    // Build output
    const header = `${'KEY'.padEnd(maxKeyLength)}  ${'TYPE'.padEnd(maxTypeLength)}  ${'NAME'.padEnd(maxNameLength)}  DESCRIPTION`
    const separator = `${'-'.repeat(maxKeyLength)}  ${'-'.repeat(maxTypeLength)}  ${'-'.repeat(maxNameLength)}  ${'-'.repeat(20)}`

    const rows = configs.map((config) => {
      const key = config.key.padEnd(maxKeyLength)
      const type = config.type.padEnd(maxTypeLength)
      const name = (config.name || '').padEnd(maxNameLength)
      const description = config.description || ''
      return `${key}  ${type}  ${name}  ${description}`
    })

    const output = [header, separator, ...rows].join('\n')
    const keys = configs.map((config) => config.key)

    return this.ok(output, {keys})
  }
}
