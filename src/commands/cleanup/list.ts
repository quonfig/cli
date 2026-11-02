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

interface EvalWindows {
  evals_2d: number
  evals_7d: number
  evals_24h: number
  evals_30d: number
}

interface EvalActivityRow extends EvalWindows {
  config_key: string
  environment: string
  last_eval: string
}

interface EvalActivityResponse {
  available: boolean
  rows: EvalActivityRow[]
  windowDays: number
}

interface EnvironmentActivity extends EvalWindows {
  environment: string
  last_eval: string
}

interface CleanupRow extends EvalWindows {
  class: 'active' | 'quiet'
  key: string
  kind: 'config' | 'flag'
  last_eval: string | null
  per_environment: EnvironmentActivity[]
  ready_for_cleanup: boolean
  type: string
}

// Entity types whose evaluations SDKs count. Log levels are excluded by the
// SDKs' eval summaries and schemas/segments are never evaluated directly.
const KIND_BY_TYPE: Record<string, CleanupRow['kind']> = {config: 'config', feature_flag: 'flag'}

function rollUp(perEnv: EnvironmentActivity[]): {last_eval: string | null} & EvalWindows {
  let last_eval: string | null = null
  const totals: EvalWindows = {evals_24h: 0, evals_2d: 0, evals_7d: 0, evals_30d: 0}
  for (const env of perEnv) {
    totals.evals_24h += env.evals_24h
    totals.evals_2d += env.evals_2d
    totals.evals_7d += env.evals_7d
    totals.evals_30d += env.evals_30d
    // YYYY-MM-DD strings compare chronologically.
    if (last_eval === null || env.last_eval > last_eval) last_eval = env.last_eval
  }

  return {...totals, last_eval}
}

export default class CleanupList extends APICommand {
  static description = `List feature flags marked readyForCleanup=true, with eval volume per window.

Pass --all to prospect instead: every flag AND config in the workspace,
marked or not, so you can find what has gone quiet.

Columns:
  KEY         the flag or config key
  KIND        flag or config (--all only)
  TYPE        the valueType (bool, string, int, etc.)
  EVALS_24H   evals counted in today's bucket (latest day)
  EVALS_2D    evals in the last 2 calendar days
  EVALS_7D    evals in the last 7 calendar days
  EVALS_30D   evals in the last 30 calendar days
  LAST_EVAL   most recent calendar day with any evals (UTC); "-" if none
              in the last 90 days (the retention window), not "never"
  MARKED      yes if the flag is marked readyForCleanup (--all only)
  CLASS       quiet (zero evals in last 2 days) or active

Counts are summed across environments; --environment scopes them to one.

Default sort: quiet first, oldest LAST_EVAL at top.

Quiet is not proof of unused: a config read once at process start, an SDK
with eval telemetry turned off, or a code path that runs yearly can all look
quiet. Check the code before deleting.

Pass --json for the structured object (rows[]). Each row carries the columns
above plus per_environment breakdowns your agent can reason about itself.

Once you've picked a flag, mark it ready for cleanup in the UI, then run
\`qfg cleanup status <key>\` for the drill-in, or \`qfg cleanup remove <key>\` to
hand the removal to your coding agent with the Quonfig agent skill.`

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --all',
    '<%= config.bin %> <%= command.id %> --all --environment production --json',
  ]

  static flags = {
    all: Flags.boolean({
      default: false,
      description: 'Every flag and config in the workspace, not only flags marked readyForCleanup',
    }),
    environment: Flags.string({description: 'Count evals in this environment only (default: all environments)'}),
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
    const candidates = metadata.configs.filter((c) =>
      flags.all ? c.type in KIND_BY_TYPE : c.type === 'feature_flag' && c.readyForCleanup === true,
    )

    if (candidates.length === 0) {
      if (flags.all) {
        this.log('No flags or configs in this workspace.')
      } else {
        this.log('No feature flags are marked readyForCleanup. Mark a flag in the UI to start the retirement workflow.')
        this.log('To find candidates by eval activity, run `qfg cleanup list --all`.')
      }

      if (flags.json) {
        return {rows: []}
      }

      return
    }

    if (flags.environment !== undefined) {
      // An unknown name would come back with zero rows and make every key
      // look quiet, so check it before querying.
      const names = (await getEnvironments(this)).map((env) => env.name)
      if (!names.includes(flags.environment)) {
        return this.err(`Unknown environment "${flags.environment}". Known environments: ${names.join(', ')}`)
      }
    }

    const activityReq = await this.apiClient.post('/api/v1/analytics/evalActivity', {
      workspaceId: this.workspaceId,
      ...(flags.environment === undefined ? {} : {environment: flags.environment}),
    })
    if (!activityReq.ok) {
      const errorMsg = activityReq.error?.error || `Failed to fetch eval activity: ${activityReq.status}`
      return this.err(errorMsg, {serverError: activityReq.error})
    }

    const activity = activityReq.json as unknown as EvalActivityResponse
    if (!activity.available) {
      return this.err(
        'Eval data is temporarily unavailable, so quiet and active keys cannot be told apart. Try again shortly.',
      )
    }

    const perEnvByKey = new Map<string, EnvironmentActivity[]>()
    for (const {config_key, ...envActivity} of activity.rows ?? []) {
      const list = perEnvByKey.get(config_key) ?? []
      list.push(envActivity)
      perEnvByKey.set(config_key, list)
    }

    const rows: CleanupRow[] = candidates.map((entity) => {
      const perEnv = perEnvByKey.get(entity.key) ?? []
      const windows = rollUp(perEnv)
      return {
        key: entity.key,
        kind: KIND_BY_TYPE[entity.type],
        type: entity.valueType,
        ...windows,
        ready_for_cleanup: entity.readyForCleanup === true,
        class: windows.evals_2d === 0 ? 'quiet' : 'active',
        per_environment: perEnv,
      }
    })

    // Safest-first sort: quiet before active; within each class, oldest last_eval first
    // (null last_eval is "none in the window" — sort to the top of the quiet group).
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

    // Plain-text table for human consumption. KIND/MARKED only appear with
    // --all, where rows mix kinds and marked/unmarked flags.
    const columns: Array<[string, (r: CleanupRow) => string]> = [
      ['KEY', (r) => r.key],
      ...(flags.all ? [['KIND', (r: CleanupRow) => r.kind] as [string, (r: CleanupRow) => string]] : []),
      ['TYPE', (r) => r.type],
      ['EVALS_24H', (r) => String(r.evals_24h)],
      ['EVALS_2D', (r) => String(r.evals_2d)],
      ['EVALS_7D', (r) => String(r.evals_7d)],
      ['EVALS_30D', (r) => String(r.evals_30d)],
      ['LAST_EVAL', (r) => r.last_eval ?? '-'],
      ...(flags.all
        ? [['MARKED', (r: CleanupRow) => (r.ready_for_cleanup ? 'yes' : '-')] as [string, (r: CleanupRow) => string]]
        : []),
      ['CLASS', (r) => r.class],
    ]
    const headers = columns.map(([header]) => header)
    const cells: string[][] = rows.map((r) => columns.map(([, cell]) => cell(r)))

    const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)))
    const padRow = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ')

    this.log(padRow(headers))
    this.log(widths.map((w) => '-'.repeat(w)).join('  '))
    for (const row of cells) this.log(padRow(row))
    this.log('')
    if (flags.all) {
      const quiet = rows.filter((r) => r.class === 'quiet').length
      this.log(
        `${rows.length} flag(s) and config(s), ${quiet} quiet. LAST_EVAL "-" means no evals in the last ${activity.windowDays} days.`,
      )
    } else {
      this.log(`${rows.length} flag(s) marked readyForCleanup. Run \`qfg cleanup status <key>\` for drill-in.`)
    }

    return {rows: rows as unknown as JsonObj[]}
  }
}
