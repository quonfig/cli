import {Args} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {
  crApiError,
  parseCrNumber,
  resolveCrWorkspace,
  runCr,
  workspaceFlag,
} from '../../change-requests/command-support.js'
import {getChangeRequest} from '../../change-requests/client.js'
import {absoluteUrl, renderShow, sanitizeLine} from '../../change-requests/render.js'
import {BaseCommand} from '../../index.js'

export default class CrShow extends BaseCommand {
  static args = {
    ref: Args.string({
      description:
        'Change request number (7 or #7) or its branch name (refs/heads/<name> for a branch named like a number)',
      required: true,
    }),
  }

  static description = `Show a change request: the changes a merge would land (read these first),
then its status, who proposed it, conflicts with main, and whether you can
merge or close it.

The title and description are the proposer's own words and are not checked
by Quonfig; the diff is what lands.`

  static examples = [
    '<%= config.bin %> <%= command.id %> 7',
    '<%= config.bin %> <%= command.id %> my-branch',
    '<%= config.bin %> <%= command.id %> 7 --json',
  ]

  static flags = {...workspaceFlag}

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CrShow)
    return runCr(this, async () => {
      const {workspaceId, orgSlug} = await resolveCrWorkspace(this, flags.workspace)
      const raw = args.ref.trim()
      const numeric = /^#?\d+$/.exec(raw)
      const branch = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw
      // All digits = a number (validated like merge/close). A branch named
      // like a number is reached as refs/heads/<name>.
      const lookup = numeric ? {workspaceId, number: parseCrNumber(raw)} : {workspaceId, branch}
      const notFound =
        'number' in lookup
          ? `Change request #${lookup.number} not found in this workspace.`
          : `No change request on branch ${sanitizeLine(branch)} in this workspace.`

      let detail
      try {
        detail = await getChangeRequest(lookup, orgSlug)
      } catch (error) {
        throw crApiError(error, 'Could not load the change request', notFound)
      }

      for (const line of renderShow(detail)) this.log(line)
      return {...detail, url: absoluteUrl(detail.url)}
    })
  }
}
