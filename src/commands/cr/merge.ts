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
import {getChangeRequest, mergeChangeRequest} from '../../change-requests/client.js'
import {runCrMerge} from '../../change-requests/merge-flow.js'
import {absoluteUrl} from '../../change-requests/render.js'
import {BaseCommand} from '../../index.js'
import {confirmYesNo} from '../../push/confirm.js'
import isInteractive from '../../util/is-interactive.js'

export default class CrMerge extends BaseCommand {
  static args = {...numberArg}

  static description = `Merge a change request into main. It goes live.

Shows the changes that would land, asks for confirmation, then merges only if
the branch still points at the commit you were shown (if the proposer pushed
since, nothing is merged and you are asked to look again). The server checks
your permissions on every changed file against main as it is now.

Agents: never merge a change request you did not author without a human telling you to.`

  static examples = ['<%= config.bin %> <%= command.id %> 7', '<%= config.bin %> <%= command.id %> 7 --yes']

  static flags = {
    ...workspaceFlag,
    yes: Flags.boolean({default: false, description: 'Skip the confirmation prompt'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CrMerge)
    return runCr(this, async () => {
      const number = parseCrNumber(args.number)
      const {workspaceId, orgSlug} = await resolveCrWorkspace(this, flags.workspace)

      const outcome = await runCrMerge(
        {number, yes: flags.yes, canPrompt: !this.jsonEnabled() && isInteractive(flags)},
        {
          async get(n) {
            try {
              return await getChangeRequest({workspaceId, number: n}, orgSlug)
            } catch (error) {
              throw crApiError(
                error,
                'Could not load the change request',
                `Change request #${n} not found in this workspace.`,
              )
            }
          },
          merge: (n, expectedHeadSha) => mergeChangeRequest({workspaceId, number: n, expectedHeadSha}, orgSlug),
          confirm: (prompt) => confirmYesNo(prompt, {}),
          log: (line) => this.log(line),
        },
      )

      if (outcome.kind === 'declined') return {merged: false, aborted: true, number}

      const r = outcome.result
      return {
        merged: true,
        number: r.number,
        url: absoluteUrl(r.url),
        mergeCommitSha: r.mergeCommitSha,
        mergedAt: r.mergedAt,
        selfMerged: r.selfMerged,
        expectedHeadSha: outcome.expectedHeadSha,
      }
    })
  }
}
