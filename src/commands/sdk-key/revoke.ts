import {Args} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'

export default class SdkKeyRevoke extends APICommand {
  static args = {
    keyId: Args.string({
      description: 'ID of the SDK key to revoke',
      required: true,
    }),
  }

  static description = 'Revoke an SDK key by its ID'

  static examples = ['<%= config.bin %> <%= command.id %> a1b2c3d4-e5f6-7890-abcd-ef1234567890']

  public async run(): Promise<JsonObj | void> {
    const {args} = await this.parse(SdkKeyRevoke)

    const request = await this.apiClient.post('/api/v1/sdkKeys/delete', {
      workspaceId: this.workspaceId,
      keyId: args.keyId,
    })

    if (!request.ok) {
      if (request.status === 404) {
        return this.err(`SDK key "${args.keyId}" not found or already revoked.`)
      }
      const errorMsg = request.error?.error || `Failed to revoke SDK key: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    this.log(`SDK key ${args.keyId} has been revoked.`)

    return {keyId: args.keyId, revoked: true}
  }
}
