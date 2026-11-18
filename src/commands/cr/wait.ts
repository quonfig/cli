import {setTimeout as delay} from 'node:timers/promises'

import {Args, Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {
  crApiError,
  parseCrNumber,
  resolveCrWorkspace,
  runCr,
  workspaceFlag,
} from '../../change-requests/command-support.js'
import {getChangeRequest} from '../../change-requests/client.js'
import {maskFiles} from '../../change-requests/mask.js'
import {absoluteUrl, renderShow, sanitizeLine} from '../../change-requests/render.js'
import {parseDuration, runCrWait} from '../../change-requests/wait-flow.js'
import {BaseCommand} from '../../index.js'

export default class CrWait extends BaseCommand {
  static args = {
    ref: Args.string({
      description:
        'Change request number (7 or #7) or its branch name (refs/heads/<name> for a branch named like a number)',
      required: true,
    }),
  }

  static description = `Wait for a change request to be merged or closed, then show it.

Polls until the request settles and exits with:
  0    merged (it is live)
  2    closed without merging
  4    blocked by a conflict with main (prints how to fix it)
  124  timed out (still open)
While someone with rights has not merged it yet, it keeps waiting.

Agents: never merge a change request you did not author without a human telling you to.`

  static examples = [
    '<%= config.bin %> <%= command.id %> 7',
    '<%= config.bin %> <%= command.id %> 7 --timeout 2h --interval 30s',
    '<%= config.bin %> <%= command.id %> my-branch --json',
  ]

  static flags = {
    ...workspaceFlag,
    interval: Flags.string({default: '10s', description: 'How often to check (e.g. 10s, 1m)'}),
    timeout: Flags.string({default: '30m', description: 'Give up after this long (e.g. 30m, 2h); exits 124'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CrWait)
    const outcome = await runCr(this, async () => {
      const timeoutMs = parseDuration(flags.timeout, '--timeout')
      const intervalMs = Math.max(1, parseDuration(flags.interval, '--interval'))
      const {workspaceId, orgSlug} = await resolveCrWorkspace(this, flags.workspace)
      const raw = args.ref.trim()
      const numeric = /^#?\d+$/.exec(raw)
      const branch = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw
      const lookup = numeric ? {workspaceId, number: parseCrNumber(raw)} : {workspaceId, branch}
      const label =
        'number' in lookup ? `change request #${lookup.number}` : `the change request on ${sanitizeLine(branch)}`
      const notFound =
        'number' in lookup
          ? `Change request #${lookup.number} not found in this workspace.`
          : `No change request on branch ${sanitizeLine(branch)} in this workspace.`

      if (!this.jsonEnabled()) {
        this.logToStderr(
          `Waiting for ${label} to be merged or closed (timeout ${flags.timeout}, every ${flags.interval})...`,
        )
      }

      try {
        return await runCrWait(
          {intervalMs, timeoutMs},
          {
            get: () => getChangeRequest(lookup, orgSlug),
            now: () => Date.now(),
            async sleep(ms) {
              await delay(ms)
            },
            warn: (line) => this.logToStderr(line),
          },
        )
      } catch (error) {
        throw crApiError(error, 'Could not load the change request', notFound)
      }
    })

    const {detail} = outcome
    for (const line of renderShow(detail)) this.log(line)
    if (outcome.fix) this.log(outcome.fix)
    if (outcome.outcome === 'timeout') {
      this.logToStderr(
        `Timed out after ${flags.timeout} waiting for change request #${detail.number}; it is still open.`,
      )
    }

    const json: JsonObj = {
      ...detail,
      // --json carries the file text, so it is masked too (qfg-5bjew.48).
      files: maskFiles(detail.files),
      url: absoluteUrl(detail.url),
      wait: {exitCode: outcome.exitCode, outcome: outcome.outcome, ...(outcome.fix ? {fix: outcome.fix} : {})},
    }
    if (outcome.exitCode === 0) return json

    // Print the payload BEFORE exiting non-zero: this.exit() throws.
    if (this.jsonEnabled()) this.logJson(json)
    this.exit(outcome.exitCode)
  }
}
