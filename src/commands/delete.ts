import {Args, Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {confirmTypedSlug} from '../push/confirm.js'
import isInteractive from '../util/is-interactive.js'
import {checkmark} from '../util/color.js'
import {loadTokens} from '../util/token-storage.js'
import type {JsonObj} from '../result.js'

interface MetadataItem {
  description?: string
  key: string
  name?: string
  type: string
  valueType: string
  version?: string
}

interface MetadataListResponse {
  configs: MetadataItem[]
}

const DELETE_ROUTES: Record<string, {endpoint: string; keyField: string}> = {
  config: {endpoint: '/api/v1/configs/delete', keyField: 'configKey'},
  feature_flag: {endpoint: '/api/v1/flags/delete', keyField: 'flagKey'},
  log_level: {endpoint: '/api/v1/logLevels/delete', keyField: 'logLevelKey'},
}

export default class Delete extends APICommand {
  static args = {
    name: Args.string({description: 'flag/config/log-level key to delete', required: true}),
  }

  static description = `Delete a flag, config, or log-level from the workspace.

DESTRUCTIVE — removes the underlying JSON file from the workspace git repo
and commits with the actor's identity. The commit history preserves the
prior content; this is a hard-delete on the file but a soft-delete on
history.

Confirmation is required:
  --yes                       skip the prompt (for scripts and CI)
  interactive (default)       you'll be asked to type the key name back

Examples
  qfg delete my.flag --yes
  qfg delete my.flag                          # interactive: type the key back to confirm
  qfg delete my.config --yes`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag --yes',
    '<%= config.bin %> <%= command.id %> my.config --yes',
  ]

  static flags = {
    yes: Flags.boolean({default: false, description: 'skip confirmation prompt'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Delete)

    const tokens = await loadTokens()
    if (!tokens?.accessToken) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const key = args.name

    const metaRes = await this.apiClient.post('/api/v1/metadata/list', {workspaceId: this.workspaceId})
    if (!metaRes.ok) {
      return this.err(`Failed to look up ${key}: ${metaRes.status} ${JSON.stringify(metaRes.error)}`)
    }

    const items = (metaRes.json as unknown as MetadataListResponse)?.configs ?? []
    const item = items.find((i) => i.key === key)
    if (!item) {
      return this.err(`${key} not found in this workspace.`)
    }

    const route = DELETE_ROUTES[item.type]
    if (!route) {
      return this.err(`Cannot delete ${key}: unsupported type "${item.type}". Supported: flag, config, log-level.`)
    }

    if (!flags.yes) {
      if (!isInteractive(flags)) {
        return this.err(`Refusing to delete ${key} without confirmation. Pass --yes or run interactively.`)
      }

      this.log(`About to delete ${item.type.replaceAll('_', ' ')}: ${key}`)
      this.log('This rewrites the workspace repo and is destructive.')
      const confirmed = await confirmTypedSlug(key, `Type "${key}" to confirm: `)
      if (!confirmed) {
        return this.err(`Aborted: ${key} was not typed back exactly. No changes made.`)
      }
    }

    const payload = {
      workspaceId: this.workspaceId,
      [route.keyField]: key,
    }

    this.verboseLog(`RPC ${route.endpoint}`, payload)

    const res = await this.apiClient.post(route.endpoint, payload)
    if (!res.ok) {
      if (res.status === 404) {
        return this.err(`${key} not found on the server (it may have been deleted by someone else).`)
      }

      return this.err(`Failed to delete ${key}: ${res.status} ${JSON.stringify(res.error)}`)
    }

    const commitSha = (res.json as {commitSha?: string})?.commitSha
    const shaSuffix = commitSha ? ` (commit ${commitSha})` : ''
    return this.ok(`${checkmark} Deleted ${item.type.replaceAll('_', ' ')}: ${key}${shaSuffix}`, {
      key,
      type: item.type,
      ...(commitSha ? {commitSha} : {}),
    })
  }
}
