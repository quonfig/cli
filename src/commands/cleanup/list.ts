import {Flags} from '@oclif/core'

import {getEnvironments} from '../../api/get-environments.js'
import {APICommand} from '../../index.js'
import {JsonObj} from '../../result.js'

interface MetadataConfig {
  description?: string
  key: string
  name?: string
  readyForCleanup?: boolean
  type: string
  valueType: string
}

interface MetadataListResponse {
  configs: MetadataConfig[]
}

interface SparklineRow {
  config_key: string
  counts: number[]
  days: string[]
}

interface SparklinesResponse {
  daysOfHistory: number
  rows: SparklineRow[]
}

interface CleanupRow {
  class: 'active' | 'quiet'
  evals_2d: number
  evals_7d: number
  evals_24h: number
  evals_30d: number
  key: string
  last_eval: string | null
  type: string
}

function startOfDayUtcMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function deriveWindows(
  daysAgoByKey: Map<string, Map<number, number>>,
  key: string,
): Omit<CleanupRow, 'key' | 'type' | 'class'> {
  const buckets = daysAgoByKey.get(key) ?? new Map<number, number>()
  let evals_24h = 0
  let evals_2d = 0
  let evals_7d = 0
  let evals_30d = 0
  let mostRecentDayAgo: number | null = null

  for (const [daysAgo, count] of buckets) {
    if (count <= 0) continue
    if (daysAgo === 0) evals_24h += count
    if (daysAgo <= 1) evals_2d += count
    if (daysAgo <= 6) evals_7d += count
    if (daysAgo <= 29) evals_30d += count
    if (mostRecentDayAgo === null || daysAgo < mostRecentDayAgo) {
      mostRecentDayAgo = daysAgo
    }
  }

  let last_eval: string | null = null
  if (mostRecentDayAgo !== null) {
    const ms = startOfDayUtcMs(new Date()) - mostRecentDayAgo * 86_400_000
    last_eval = new Date(ms).toISOString().slice(0, 10)
  }

  return {evals_24h, evals_2d, evals_7d, evals_30d, last_eval}
}

export default class CleanupList extends APICommand {
  static description = `List feature flags marked readyForCleanup=true, with eval volume per window.

Columns:
  KEY         the flag key
  TYPE        the flag's valueType (bool, string, int, etc.)
  EVALS_24H   evals counted in today's bucket (latest day)
  EVALS_2D    evals in the last 2 calendar days
  EVALS_7D    evals in the last 7 calendar days
  EVALS_30D   evals in the last 30 calendar days
  LAST_EVAL   most recent calendar day with any evals (UTC), blank if none
  CLASS       quiet (zero evals in last 2 days) or active

Default sort: quiet first, oldest LAST_EVAL at top.

Pass --json for the structured object (rows[]). Each row carries the columns
above plus the raw eval counts your agent can reason about itself.

Once you've picked a candidate, run \`qfg cleanup status <key>\` for the
drill-in or hand off the removal to the qfg-flag-cleanup Claude skill.`

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']

  static flags = {
    json: Flags.boolean({default: false, description: 'Return structured rows for agent consumption'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(CleanupList)

    const metadataReq = await this.apiClient.post('/api/v1/metadata/list', {workspaceId: this.workspaceId})
    if (!metadataReq.ok) {
      const errorMsg = metadataReq.error?.error || `Failed to fetch configs: ${metadataReq.status}`
      return this.err(errorMsg, {serverError: metadataReq.error})
    }

    const metadata = metadataReq.json as unknown as MetadataListResponse
    const readyFlags = metadata.configs.filter((c) => c.type === 'feature_flag' && c.readyForCleanup === true)

    if (readyFlags.length === 0) {
      this.log('No feature flags are marked readyForCleanup. Mark a flag in the UI to start the retirement workflow.')
      if (flags.json) {
        return {rows: []}
      }

      return
    }

    const environments = await getEnvironments(this)

    // Per-env sparklines, aggregated client-side into a per-key (daysAgo → count) map.
    const todayMs = startOfDayUtcMs(new Date())
    const daysAgoByKey = new Map<string, Map<number, number>>()

     
    for (const env of environments) {
      // eslint-disable-next-line no-await-in-loop
      const req = await this.apiClient.post('/api/v1/analytics/sparklines', {
        workspaceId: this.workspaceId,
        environment: env.name,
      })
      if (!req.ok) {
        this.verboseLog('cleanup list', `sparklines failed for env ${env.name}: ${req.status}`)
        continue
      }

      const resp = req.json as unknown as SparklinesResponse
      for (const row of resp.rows ?? []) {
        const bucket = daysAgoByKey.get(row.config_key) ?? new Map<number, number>()
        for (const [i, day] of row.days.entries()) {
          const count = row.counts[i] ?? 0
          if (count <= 0) continue
          // Day strings are YYYY-MM-DD in UTC (ClickHouse Date). Parsing as UTC midnight.
          const dayMs = Date.parse(`${day}T00:00:00Z`)
          if (Number.isNaN(dayMs)) continue
          const daysAgo = Math.round((todayMs - dayMs) / 86_400_000)
          bucket.set(daysAgo, (bucket.get(daysAgo) ?? 0) + count)
        }

        daysAgoByKey.set(row.config_key, bucket)
      }
    }

    const rows: CleanupRow[] = readyFlags.map((flag) => {
      const windows = deriveWindows(daysAgoByKey, flag.key)
      const klass: 'active' | 'quiet' = windows.evals_2d === 0 ? 'quiet' : 'active'
      return {
        key: flag.key,
        type: flag.valueType,
        ...windows,
        class: klass,
      }
    })

    // Safest-first sort: quiet before active; within each class, oldest last_eval first
    // (null last_eval is "never seen" — sort to the top of the quiet group).
    rows.sort((a, b) => {
      if (a.class !== b.class) return a.class === 'quiet' ? -1 : 1
      if (a.last_eval === b.last_eval) return a.key.localeCompare(b.key)
      if (a.last_eval === null) return -1
      if (b.last_eval === null) return 1
      return a.last_eval.localeCompare(b.last_eval)
    })

    if (flags.json) {
      // Returning a JsonObj — the table-style printing below is skipped.
      this.log(this.toSuccessJson({rows}))
      return {rows: rows as unknown as JsonObj[]}
    }

    // Plain-text table for human consumption.
    const headers = ['KEY', 'TYPE', 'EVALS_24H', 'EVALS_2D', 'EVALS_7D', 'EVALS_30D', 'LAST_EVAL', 'CLASS']
    const cells: string[][] = rows.map((r) => [
      r.key,
      r.type,
      String(r.evals_24h),
      String(r.evals_2d),
      String(r.evals_7d),
      String(r.evals_30d),
      r.last_eval ?? '-',
      r.class,
    ])

    const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)))
    const padRow = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ')

    this.log(padRow(headers))
    this.log(widths.map((w) => '-'.repeat(w)).join('  '))
    for (const row of cells) this.log(padRow(row))
    this.log('')
    this.log(`${rows.length} flag(s) marked readyForCleanup. Run \`qfg cleanup status <key>\` for drill-in.`)

    return {rows: rows as unknown as JsonObj[]}
  }
}
