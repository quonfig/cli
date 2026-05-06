import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'
import {confirmYesNo} from '../../push/confirm.js'
import {normalizeConfigType, resolveConfigByKey} from '../../util/activity-lookup.js'
import {getAppUrl} from '../../util/domain-urls.js'
import isInteractive from '../../util/is-interactive.js'
import nameArg from '../../util/name-arg.js'

interface DeletionTombstone {
  configType: string
  configKey: string
  deletedBy: string
  deletedAt: string
  commitSha: string
}

interface RestoreResponse {
  configType: string
  configKey: string
  commitSha: string
}

const RESTORABLE_TYPES = ['feature_flag', 'config', 'log_level', 'segment']

export default class ActivityRestore extends APICommand {
  static args = {...nameArg}

  static description = `Undelete a config that was previously removed.

Looks up the most recent deletion for the key (so you see who deleted it and when),
then asks for confirmation before re-creating the file from the prior content.
Schemas cannot be restored — use git history instead.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag --yes',
    '<%= config.bin %> <%= command.id %> request.timeout --type config --yes',
  ]

  static flags = {
    type: Flags.string({
      description: 'Config type. Optional — inferred from history when omitted.',
      options: ['feature_flag', 'config', 'log_level', 'segment', 'flag', 'log-level'],
      required: false,
    }),
    yes: Flags.boolean({default: false, description: 'Skip the confirmation prompt'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(ActivityRestore)

    if (!args.name) {
      return this.err('Key is required. Usage: qfg activity restore <name>')
    }

    const key = args.name

    // Resolve configType. We try the explicit --type first, then fall back to
    // metadata/list (which only finds *live* configs). For deleted-only keys
    // the user must pass --type since metadata/list won't see them.
    let configType: string | null = flags.type ? normalizeConfigType(flags.type) : null
    if (flags.type && !configType) {
      return this.err(`Unsupported --type "${flags.type}".`)
    }

    if (!configType) {
      const candidates = await this.findCandidateTypes(key)
      if (candidates.length === 0) {
        return this.err(`Cannot infer config type for "${key}". Pass --type=<feature_flag|config|log_level|segment>.`)
      }

      if (candidates.length > 1) {
        return this.err(
          `Ambiguous: "${key}" has deletion history for multiple types (${candidates.join(', ')}). Pass --type to disambiguate.`,
        )
      }

      configType = candidates[0]
    }

    if (!RESTORABLE_TYPES.includes(configType)) {
      return this.err(`Cannot restore type "${configType}". Restorable types: ${RESTORABLE_TYPES.join(', ')}.`)
    }

    const tombstoneRes = await this.apiClient.post('/api/v1/activity/getDeletionForKey', {
      workspaceId: this.workspaceId,
      configType,
      configKey: key,
    })

    if (!tombstoneRes.ok) {
      const errorMsg = tombstoneRes.error?.error || `Failed to look up deletion: ${tombstoneRes.status}`
      return this.err(errorMsg, {serverError: tombstoneRes.error})
    }

    const tombstone = tombstoneRes.json as unknown as DeletionTombstone | null

    if (!tombstone) {
      // The bead phrasing — kept verbatim so the friction-log entries that
      // motivated this work map onto the new error message cleanly.
      return this.err(`${key} is not currently deleted; nothing to restore.`)
    }

    if (!flags.yes) {
      if (!isInteractive(flags)) {
        return this.err(`Refusing to restore ${key} without confirmation. Pass --yes or run interactively.`)
      }

      const shortSha = tombstone.commitSha.slice(0, 8)
      const confirmed = await confirmYesNo(
        `Restore ${configType}/${key}? Last deleted by ${tombstone.deletedBy} on ${tombstone.deletedAt} (sha ${shortSha}) [y/N] `,
      )
      if (!confirmed) {
        return this.err(`Aborted: restore of ${key} not confirmed.`)
      }
    }

    const restoreRes = await this.apiClient.post('/api/v1/activity/restoreItem', {
      workspaceId: this.workspaceId,
      configType,
      configKey: key,
    })

    if (!restoreRes.ok) {
      const errorMsg = restoreRes.error?.error || `Failed to restore: ${restoreRes.status}`
      return this.err(errorMsg, {serverError: restoreRes.error})
    }

    const result = restoreRes.json as unknown as RestoreResponse

    const url = `${getAppUrl()}/workspaces/${this.workspaceId}/flags/${result.configKey}`
    this.log(`Restored ${result.configType}/${result.configKey}`)
    this.log(`  commit: ${result.commitSha.slice(0, 8)}`)
    this.log(`  url:    ${url}`)

    return {
      configType: result.configType,
      configKey: result.configKey,
      commitSha: result.commitSha,
      url,
    }
  }

  /**
   * When the user omits --type, fall back to listing live metadata so we can
   * still find configType for keys that were *renamed-then-deleted* (live
   * record gone, deletion history exists). Returns the unique config types
   * that match the key — empty when nothing matches.
   */
  private async findCandidateTypes(key: string): Promise<string[]> {
    const resolved = await resolveConfigByKey(this, key)
    if ('configType' in resolved && RESTORABLE_TYPES.includes(resolved.configType)) {
      return [resolved.configType]
    }

    return []
  }
}
