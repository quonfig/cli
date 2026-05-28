import {Flags} from '@oclif/core'

import {APICommand} from '../../index.js'
import {JsonObj} from '../../result.js'
import nameArg from '../../util/name-arg.js'

interface ConfigSparklineRow {
  counts: number[]
  days: string[]
  environment: string
}

interface ConfigSparklinesResponse {
  daysOfHistory: number
  rows: ConfigSparklineRow[]
}

function startOfDayUtcMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export default class CleanupVerify extends APICommand {
  static args = {...nameArg}

  static description = `Confirm zero evals for a flag in the trailing N days (default 7). Exits 0 if safe to delete, non-zero otherwise.

Read-only gate intended for chaining with \`qfg delete\` after a cleanup PR
has merged and the SDK has redeployed:

  qfg cleanup verify my.flag.key && qfg delete my.flag.key

The trailing window is stricter than the \`qfg cleanup remove\` 2-day gate on
purpose — \`remove\` only writes a payload describing the flag, but \`delete\`
permanently removes the flag definition, so we want a longer quiet period
before chaining. Bump --days N if you want a more conservative window.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag.key',
    '<%= config.bin %> <%= command.id %> my.flag.key --days 14',
    '<%= config.bin %> <%= command.id %> my.flag.key --json',
    '<%= config.bin %> <%= command.id %> my.flag.key && <%= config.bin %> delete my.flag.key',
  ]

  static flags = {
    days: Flags.integer({
      default: 7,
      description: 'Number of trailing calendar days that must have zero evals',
    }),
    json: Flags.boolean({default: false, description: 'Return structured object for agent consumption'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CleanupVerify)

    const key = args.name
    if (!key) return this.err('Key is required: `qfg cleanup verify <key>`')

    if (flags.days <= 0) return this.err('--days must be a positive integer')

    const flagReq = await this.apiClient.post('/api/v1/metadata/getByKey', {workspaceId: this.workspaceId, key})
    if (!flagReq.ok) {
      const errorMsg = flagReq.error?.error || `Failed to fetch flag: ${flagReq.status}`
      if (flagReq.status === 404) return this.err(`Flag ${key} not found`)
      return this.err(errorMsg, {serverError: flagReq.error})
    }

    const sparkReq = await this.apiClient.post('/api/v1/analytics/configSparklines', {
      workspaceId: this.workspaceId,
      configKey: key,
    })
    if (!sparkReq.ok) {
      return this.err(sparkReq.error?.error || `Failed to fetch sparklines: ${sparkReq.status}`)
    }

    const sparkResp = sparkReq.json as unknown as ConfigSparklinesResponse
    const todayMs = startOfDayUtcMs(new Date())

    let evals = 0
    let mostRecentDayAgo: number | null = null

    for (const row of sparkResp.rows ?? []) {
      for (const [i, day] of row.days.entries()) {
        const count = row.counts[i] ?? 0
        if (count <= 0) continue
        const dayMs = Date.parse(`${day}T00:00:00Z`)
        if (Number.isNaN(dayMs)) continue
        const daysAgo = Math.round((todayMs - dayMs) / 86_400_000)
        // --days 7 means "today (daysAgo=0) through 6 days ago" (a 7-day window).
        // --days 1 means "today only".
        if (daysAgo < 0 || daysAgo > flags.days - 1) continue
        evals += count
        if (mostRecentDayAgo === null || daysAgo < mostRecentDayAgo) mostRecentDayAgo = daysAgo
      }
    }

    const lastEval =
      mostRecentDayAgo === null ? null : new Date(todayMs - mostRecentDayAgo * 86_400_000).toISOString().slice(0, 10)
    const safe = evals === 0

    const payload: JsonObj = {
      key,
      daysChecked: flags.days,
      evals,
      lastEval,
      safe,
    }

    if (flags.json) {
      // --json always emits the payload and exits 0; agents read `safe` to decide.
      // Shell `verify && delete` chaining uses the text mode below where exit code
      // matters for the shell short-circuit.
      this.log(this.toSuccessJson(payload))
      return payload
    }

    if (safe) {
      this.log(`${key}: safe to delete — 0 evals in the last ${flags.days} day(s).`)
      return payload
    }

    return this.err(
      `${key}: ${evals} eval(s) in the last ${flags.days} day(s), latest ${lastEval}. ` +
        `Refusing to confirm safe-to-delete. Bump --days, wait for traffic to drain, or run ` +
        `\`qfg cleanup status ${key}\` for the full per-environment breakdown.`,
    )
  }
}
