import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'

interface AuditMessage {
  message: string
  scope: string
}

interface FeedItem {
  action: string
  authorEmail: string
  authorName: string
  configKey: string | null
  configType: string | null
  date: string
  messages: AuditMessage[]
  sha: string
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Compact relative date — "5m ago", "3h ago", "2d ago", or ISO when older. */
function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const diff = now - t
  if (diff < MS_PER_MINUTE) return 'just now'
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}m ago`
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}h ago`
  if (diff < 14 * MS_PER_DAY) return `${Math.floor(diff / MS_PER_DAY)}d ago`
  return iso.slice(0, 10) // YYYY-MM-DD for older entries
}

/** Author column — fall back to email when authorName is empty (gitea bots). */
function authorLabel(item: FeedItem): string {
  if (item.authorName && item.authorName.trim().length > 0) return item.authorName
  return item.authorEmail || '(unknown)'
}

export default class ActivityFeed extends APICommand {
  static description = `Recent activity across the workspace, newest first.

Each entry shows who changed which config, the action (created/updated/deleted/restored),
and the human-readable audit message produced by the server. The server already
translates JSON diffs into messages — this command does not re-translate.`

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --limit 5',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    limit: Flags.integer({
      default: 30,
      description: 'Maximum number of feed entries (1-100)',
      max: 100,
      min: 1,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(ActivityFeed)

    const request = await this.apiClient.post('/api/v1/activity/getWorkspaceFeed', {
      workspaceId: this.workspaceId,
      limit: flags.limit,
    })

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to fetch activity feed: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const items = (Array.isArray(request.json) ? request.json : []) as FeedItem[]

    if (items.length === 0) {
      this.log('No recent activity in this workspace.')
      return {items: []}
    }

    const lines: string[] = []
    for (const item of items) {
      const sha = item.sha.slice(0, 8)
      const who = authorLabel(item)
      const when = relativeTime(item.date)
      const target = item.configType && item.configKey ? `${item.configType}/${item.configKey}` : '(workspace)'
      lines.push(`${sha}  ${item.action.padEnd(9)}  ${target}  by ${who}  ${when}`)
      for (const m of item.messages) {
        lines.push(`    - ${m.message}`)
      }
      lines.push('')
    }

    this.log(lines.join('\n').trimEnd())

    return {items}
  }
}
