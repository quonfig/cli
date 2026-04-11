import {Flags} from '@oclif/core'
import {select} from '@inquirer/prompts'

import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'
import {getEnvironments} from '../../api/get-environments.js'

type KeyType = 'backend' | 'frontend'

interface CreatedSdkKey {
  id: string
  environmentId: string
  environmentName: string
  keyType: KeyType
  createdAt: string | null
  rawKey: string
}

export default class SdkKeyCreate extends APICommand {
  static description = 'Create a new SDK key'

  static examples = [
    '<%= config.bin %> <%= command.id %> --environment production --type server',
    '<%= config.bin %> <%= command.id %> --environment staging --type browser',
  ]

  static flags = {
    environment: Flags.string({
      char: 'e',
      description: 'Environment name (e.g. production, staging)',
      required: false,
    }),
    type: Flags.string({
      char: 't',
      description: 'Key type: server (backend) or browser (frontend)',
      options: ['server', 'browser'],
      required: false,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(SdkKeyCreate)

    // Fetch available environments
    const environments = await getEnvironments(this)

    if (environments.length === 0) {
      return this.err('No environments found for this workspace.')
    }

    // Resolve environment
    let environmentId: string
    let environmentName: string

    if (flags.environment) {
      const match = environments.find((e) => e.name.toLowerCase() === flags.environment!.toLowerCase())
      if (!match) {
        const names = environments.map((e) => e.name).join(', ')
        return this.err(`Environment "${flags.environment}" not found. Available: ${names}`)
      }
      environmentId = match.id
      environmentName = match.name
    } else {
      if (environments.length === 1) {
        environmentId = environments[0].id
        environmentName = environments[0].name
        this.log(`Using environment: ${environmentName}`)
      } else {
        const chosen = await select({
          choices: environments.map((e) => ({name: e.name, value: e.id})),
          message: 'Select environment:',
        })
        const match = environments.find((e) => e.id === chosen)!
        environmentId = match.id
        environmentName = match.name
      }
    }

    // Resolve key type
    let keyType: KeyType
    if (flags.type) {
      keyType = flags.type === 'server' ? 'backend' : 'frontend'
    } else {
      const chosen = await select({
        choices: [
          {name: 'server (backend SDK — Node.js, Go, etc.)', value: 'backend'},
          {name: 'browser (frontend SDK — JavaScript/React)', value: 'frontend'},
        ],
        message: 'Select key type:',
      })
      keyType = chosen as KeyType
    }

    const request = await this.apiClient.post('/api/v1/sdkKeys/create', {
      workspaceId: this.workspaceId,
      environmentId,
      keyType,
    })

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to create SDK key: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const key = request.json as unknown as CreatedSdkKey
    const typeLabel = keyType === 'backend' ? 'server' : 'browser'

    this.log(`\nSDK key created successfully!\n`)
    this.log(`Environment:  ${environmentName}`)
    this.log(`Type:         ${typeLabel}`)
    this.log(`Key ID:       ${key.id}`)
    this.log(`\nYour SDK key (shown only once — copy it now):\n`)
    this.log(`  ${key.rawKey}\n`)
    this.log(`To revoke this key:  qfg sdk-key revoke ${key.id}`)

    return {
      environmentId: key.environmentId,
      environmentName: key.environmentName,
      id: key.id,
      keyType: typeLabel,
      rawKey: key.rawKey,
    }
  }
}
