import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'

interface DeletedItem {
  configKey: string
  configType: string
  deletedAt: string
  deletedBy: string
}

export default class ActivityDeleted extends APICommand {
  static description = `List configs that were deleted from the workspace and have not been restored.

Useful for "did somebody delete X?" — pair with \`qfg activity restore NAME\`
to undelete a tombstoned config.`

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']

  public async run(): Promise<JsonObj | void> {
    const request = await this.apiClient.post('/api/v1/activity/getDeletedItems', {
      workspaceId: this.workspaceId,
    })

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to fetch deleted items: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const items = (Array.isArray(request.json) ? request.json : []) as DeletedItem[]

    if (items.length === 0) {
      this.log('No deleted items in this workspace.')
      return {items: []}
    }

    const maxTypeLen = Math.max(4, ...items.map((i) => i.configType.length))
    const maxKeyLen = Math.max(3, ...items.map((i) => i.configKey.length))
    const maxByLen = Math.max(2, ...items.map((i) => i.deletedBy.length))

    const header = `${'TYPE'.padEnd(maxTypeLen)}  ${'KEY'.padEnd(maxKeyLen)}  ${'BY'.padEnd(maxByLen)}  DELETED AT`
    const sep = `${'-'.repeat(maxTypeLen)}  ${'-'.repeat(maxKeyLen)}  ${'-'.repeat(maxByLen)}  ${'-'.repeat(20)}`
    const rows = items.map(
      (i) =>
        `${i.configType.padEnd(maxTypeLen)}  ${i.configKey.padEnd(maxKeyLen)}  ${i.deletedBy.padEnd(maxByLen)}  ${i.deletedAt.slice(0, 19).replace('T', ' ')}`,
    )

    this.log([header, sep, ...rows].join('\n'))
    this.log('')
    this.log('Restore one with: qfg activity restore <key>')

    return {items}
  }
}
