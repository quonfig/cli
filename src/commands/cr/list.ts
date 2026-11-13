import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {crApiError, resolveCrWorkspace, runCr, workspaceFlag} from '../../change-requests/command-support.js'
import {type ListInput, listChangeRequests} from '../../change-requests/client.js'
import {absoluteUrl, renderList} from '../../change-requests/render.js'
import {BaseCommand} from '../../index.js'

export default class CrList extends BaseCommand {
  static description = `List change requests in the workspace (open ones by default).

A change request is a proposed change on a branch (qfg push --propose). It is
not live until someone with rights merges it (qfg cr merge).`

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --mine',
    '<%= config.bin %> <%= command.id %> --status merged --limit 10 --json',
  ]

  static flags = {
    ...workspaceFlag,
    mine: Flags.boolean({default: false, description: 'Only change requests you proposed'}),
    status: Flags.string({
      description: 'Which change requests to list (default: open)',
      options: ['open', 'merged', 'closed', 'all'],
    }),
    limit: Flags.integer({description: 'Most rows to return (1-200; server default 50)', min: 1, max: 200}),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(CrList)
    return runCr(this, async () => {
      const {workspaceId, orgSlug} = await resolveCrWorkspace(this, flags.workspace)
      const input: ListInput = {
        workspaceId,
        ...(flags.mine ? {mine: true} : {}),
        ...(flags.status ? {status: flags.status as ListInput['status']} : {}),
        ...(flags.limit === undefined ? {} : {limit: flags.limit}),
      }

      let res
      try {
        res = await listChangeRequests(input, orgSlug)
      } catch (error) {
        throw crApiError(error, 'Could not list change requests')
      }

      const rows = res.changeRequests ?? []
      for (const line of renderList(rows, flags.status ?? 'open')) this.log(line)
      return {changeRequests: rows.map((r) => ({...r, url: absoluteUrl(r.url)}))}
    })
  }
}
