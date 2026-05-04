import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'
import {resolveConfigByKey} from '../../util/activity-lookup.js'
import nameArg from '../../util/name-arg.js'

interface AuditMessage {
  scope: string
  message: string
}

interface HistoryEntry {
  sha: string
  authorName: string
  authorEmail: string
  date: string
  action: string
  messages: AuditMessage[]
}

function authorLabel(entry: HistoryEntry): string {
  if (entry.authorName && entry.authorName.trim().length > 0) return entry.authorName
  return entry.authorEmail || '(unknown)'
}

export default class ActivityHistory extends APICommand {
  static args = {...nameArg}

  static description = `Per-config audit trail for a flag, config, log-level, segment, or schema.

Resolves NAME against the workspace metadata (no need to specify type) and
returns the full commit history for that file with audit messages translated
by the server. Restored entries are rendered distinctly so a recovery doesn't
look like a fresh create.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag',
    '<%= config.bin %> <%= command.id %> request.timeout --json',
  ]

  public async run(): Promise<JsonObj | void> {
    const {args} = await this.parse(ActivityHistory)

    if (!args.name) {
      return this.err('Key is required. Usage: qfg activity history <name>')
    }

    const resolved = await resolveConfigByKey(this, args.name)
    if ('error' in resolved) {
      return this.err(resolved.error)
    }

    const request = await this.apiClient.post('/api/v1/activity/getRichHistory', {
      workspaceId: this.workspaceId,
      configType: resolved.configType,
      configKey: resolved.configKey,
    })

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to fetch history: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const entries = (Array.isArray(request.json) ? request.json : []) as HistoryEntry[]

    this.log(`History for ${resolved.configType}/${resolved.configKey}:`)
    this.log('')

    if (entries.length === 0) {
      this.log('  (no commits found)')
      return {configType: resolved.configType, configKey: resolved.configKey, entries: []}
    }

    const lines: string[] = []
    for (const entry of entries) {
      const sha = entry.sha.slice(0, 8)
      const who = authorLabel(entry)
      const date = entry.date.slice(0, 19).replace('T', ' ')
      const marker = entry.action === 'restored' ? '★ restored' : entry.action
      lines.push(`${sha}  ${marker.padEnd(11)}  ${date}  by ${who}`)
      for (const m of entry.messages) {
        lines.push(`    - ${m.message}`)
      }
      lines.push('')
    }

    this.log(lines.join('\n').trimEnd())

    return {configType: resolved.configType, configKey: resolved.configKey, entries}
  }
}
