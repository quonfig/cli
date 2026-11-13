import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {
  crApiError,
  numberArg,
  parseCrNumber,
  resolveCrWorkspace,
  runCr,
  workspaceFlag,
} from '../../change-requests/command-support.js'
import {closeChangeRequest} from '../../change-requests/client.js'
import {absoluteUrl} from '../../change-requests/render.js'
import {BaseCommand} from '../../index.js'

export default class CrClose extends BaseCommand {
  static args = {...numberArg}

  static description = `Close a change request without merging it. Nothing goes live.

The proposer can always close their own request; anyone else needs the
permissions a merge of it would need. The branch is deleted on the server if
it still points at the proposed commit.`

  static examples = [
    '<%= config.bin %> <%= command.id %> 7',
    '<%= config.bin %> <%= command.id %> 7 --note "superseded by #8"',
  ]

  static flags = {
    ...workspaceFlag,
    note: Flags.string({description: 'Why it was closed (shown on the change request)'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CrClose)
    return runCr(this, async () => {
      const number = parseCrNumber(args.number)
      const {workspaceId, orgSlug} = await resolveCrWorkspace(this, flags.workspace)

      let res
      try {
        res = await closeChangeRequest(
          {workspaceId, number, ...(flags.note === undefined ? {} : {note: flags.note})},
          orgSlug,
        )
      } catch (error) {
        throw crApiError(
          error,
          `Change request #${number} was not closed`,
          `Change request #${number} not found in this workspace.`,
        )
      }

      this.log(`Closed change request #${res.number}.`)
      this.log(
        res.branchDeleted
          ? 'Its branch was deleted on the server.'
          : 'Its branch was kept on the server (it had moved, or the delete failed).',
      )
      return {
        closed: true,
        number: res.number,
        url: absoluteUrl(res.url),
        closedAt: res.closedAt,
        branchDeleted: res.branchDeleted,
      }
    })
  }
}
