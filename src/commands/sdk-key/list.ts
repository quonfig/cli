import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'

interface SdkKeySummary {
  createdAt: string | null
  createdByUserEmail: string | null
  createdByUserName: string | null
  environmentId: string
  environmentName: string
  id: string
  keyType: 'backend' | 'frontend'
}

export default class SdkKeyList extends APICommand {
  static description = 'List SDK keys for your workspace'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --environment production',
  ]

  static flags = {
    environment: Flags.string({
      char: 'e',
      description: 'Filter by environment name',
      required: false,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(SdkKeyList)

    const request = await this.apiClient.post('/api/v1/sdkKeys/list', {workspaceId: this.workspaceId})

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to fetch SDK keys: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    let keys = (Array.isArray(request.json) ? request.json : []) as SdkKeySummary[]

    if (flags.environment) {
      const envFilter = flags.environment.toLowerCase()
      keys = keys.filter((k) => k.environmentName.toLowerCase() === envFilter)
    }

    if (keys.length === 0) {
      const envSuffix = flags.environment ? ` for environment "${flags.environment}"` : ''
      this.log(`No SDK keys found${envSuffix}.`)
      this.log(`\nCreate one with: qfg sdk-key create --environment <name> --type server|browser`)
      return {keys: []}
    }

    const maxEnvLength = Math.max(11, ...keys.map((k) => k.environmentName.length))
    const maxTypeLength = 7 // "browser" is longest
    const maxIdLength = Math.max(2, ...keys.map((k) => k.id.length))

    const header = `${'ID'.padEnd(maxIdLength)}  ${'ENVIRONMENT'.padEnd(maxEnvLength)}  ${'TYPE'.padEnd(maxTypeLength)}  ${'PREFIX'.padEnd(28)}  CREATED`
    const separator = `${'-'.repeat(maxIdLength)}  ${'-'.repeat(maxEnvLength)}  ${'-'.repeat(maxTypeLength)}  ${'-'.repeat(28)}  ${'-'.repeat(24)}`

    const rows = keys.map((k) => {
      const typeLabel = k.keyType === 'backend' ? 'server' : 'browser'
      const prefix = k.keyType === 'backend' ? `qf_sk_${k.environmentName}_...` : `qf_pk_${k.environmentName}_...`
      const created = k.createdAt ? new Date(k.createdAt).toISOString().slice(0, 10) : 'unknown'
      return `${k.id.padEnd(maxIdLength)}  ${k.environmentName.padEnd(maxEnvLength)}  ${typeLabel.padEnd(maxTypeLength)}  ${prefix.padEnd(28)}  ${created}`
    })

    this.log([header, separator, ...rows].join('\n'))

    return {keys}
  }
}
