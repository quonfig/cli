import {Flags} from '@oclif/core'

import {APICommand} from '../../index.js'
import {JsonObj} from '../../result.js'
import nameArg from '../../util/name-arg.js'
import {isCatchAllRule} from '../../util/rules.js'

interface ConfigRule {
  criteria?: Array<{operator: string}>
  value?: Record<string, unknown>
}

interface ConfigEnvironment {
  id: string
  rules?: ConfigRule[]
}

interface StoredFlag {
  default?: {rules?: ConfigRule[]}
  environments?: ConfigEnvironment[]
  key: string
  readyForCleanup?: boolean
  type: string
  valueType: string
}

interface ConfigSparklineRow {
  counts: number[]
  days: string[]
  environment: string
}

interface ConfigSparklinesResponse {
  daysOfHistory: number
  rows: ConfigSparklineRow[]
}

interface EnvSummary {
  environment: string
  evals_2d: number
  evals_7d: number
  evals_24h: number
  evals_30d: number
  last_eval: string | null
  total: number
}

function startOfDayUtcMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function formatRuleValue(value: Record<string, unknown> | undefined): string {
  if (!value) return '(no value)'
  // Old format: {type: 'bool', value: true}
  if (typeof value.type === 'string' && value.value !== undefined) {
    return String(value.value)
  }

  // New format: {bool: true} / {string: "..."} / etc.
  for (const k of ['bool', 'string', 'int', 'double']) {
    if (value[k] !== undefined) return String(value[k])
  }

  if (value.stringList !== undefined) {
    return Array.isArray(value.stringList) ? value.stringList.join(',') : JSON.stringify(value.stringList)
  }

  if (value.json !== undefined) return JSON.stringify(value.json)
  return JSON.stringify(value)
}

function summarizeRules(rules: ConfigRule[] | undefined): string {
  if (!rules || rules.length === 0) return '[inherit default]'
  // Both catch-all spellings count as the fallback (qfg-9kr8): a strict
  // single-ALWAYS_TRUE find reported a targeting rule's value as the fallback
  // for every scope written by an older `qfg set-default`.
  const fallback = rules.find((r) => isCatchAllRule(r))
  const overrides = rules.filter((r) => r !== fallback)
  const fallbackStr = fallback ? formatRuleValue(fallback.value) : formatRuleValue(rules[0].value)
  if (overrides.length === 0) return fallbackStr
  return `${fallbackStr} (+${overrides.length} override rule${overrides.length === 1 ? '' : 's'})`
}

export default class CleanupStatus extends APICommand {
  static args = {...nameArg}

  static description = `Drill into one ready-for-cleanup flag — show telemetry across all environments and the current rule shape.

Use this after \`qfg cleanup list\` to inspect a specific flag before handing
removal off to the qfg-flag-cleanup Claude skill. The eval counts come from
analytics.configSparklines (the same backing data the per-flag sparklines on
the flag detail page use), summed into 24h/2d/7d/30d windows so you can decide
whether it's safe to retire.

Pass --json for the structured object including the full rule shape per
environment — the cleanup skill consumes this directly.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag.key',
    '<%= config.bin %> <%= command.id %> my.flag.key --json',
  ]

  static flags = {
    json: Flags.boolean({default: false, description: 'Return structured object for agent consumption'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CleanupStatus)

    const key = args.name
    if (!key) return this.err('Key is required: `qfg cleanup status <key>`')

    const flagReq = await this.apiClient.post('/api/v1/metadata/getByKey', {workspaceId: this.workspaceId, key})
    if (!flagReq.ok) {
      const errorMsg = flagReq.error?.error || `Failed to fetch flag: ${flagReq.status}`
      if (flagReq.status === 404) return this.err(`Flag ${key} not found`)
      return this.err(errorMsg, {serverError: flagReq.error})
    }

    const flag = flagReq.json as unknown as StoredFlag

    const sparkReq = await this.apiClient.post('/api/v1/analytics/configSparklines', {
      workspaceId: this.workspaceId,
      configKey: key,
    })
    if (!sparkReq.ok) {
      return this.err(sparkReq.error?.error || `Failed to fetch sparklines: ${sparkReq.status}`)
    }

    const sparkResp = sparkReq.json as unknown as ConfigSparklinesResponse
    const todayMs = startOfDayUtcMs(new Date())

    const envSummaries: EnvSummary[] = []
    let totalEvals24h = 0
    let totalEvals2d = 0
    let totalEvals7d = 0
    let totalEvals30d = 0
    let overallLast: number | null = null

    for (const row of sparkResp.rows ?? []) {
      let envTotal = 0
      let envEvals24h = 0
      let envEvals2d = 0
      let envEvals7d = 0
      let envEvals30d = 0
      let envLastDayAgo: number | null = null

      for (const [i, day] of row.days.entries()) {
        const count = row.counts[i] ?? 0
        if (count <= 0) continue
        const dayMs = Date.parse(`${day}T00:00:00Z`)
        if (Number.isNaN(dayMs)) continue
        const daysAgo = Math.round((todayMs - dayMs) / 86_400_000)
        envTotal += count
        if (daysAgo === 0) envEvals24h += count
        if (daysAgo <= 1) envEvals2d += count
        if (daysAgo <= 6) envEvals7d += count
        if (daysAgo <= 29) envEvals30d += count
        if (envLastDayAgo === null || daysAgo < envLastDayAgo) envLastDayAgo = daysAgo
      }

      const last_eval =
        envLastDayAgo === null ? null : new Date(todayMs - envLastDayAgo * 86_400_000).toISOString().slice(0, 10)

      envSummaries.push({
        environment: row.environment,
        total: envTotal,
        evals_24h: envEvals24h,
        evals_2d: envEvals2d,
        evals_7d: envEvals7d,
        evals_30d: envEvals30d,
        last_eval,
      })
      totalEvals24h += envEvals24h
      totalEvals2d += envEvals2d
      totalEvals7d += envEvals7d
      totalEvals30d += envEvals30d
      if (envLastDayAgo !== null && (overallLast === null || envLastDayAgo < overallLast)) {
        overallLast = envLastDayAgo
      }
    }

    // Drop env summaries with zero evals so the human view stays terse; the
    // --json output below includes the same array.
    const nonEmptyEnvs = envSummaries.filter((e) => e.total > 0)

    const overallLastEval =
      overallLast === null ? null : new Date(todayMs - overallLast * 86_400_000).toISOString().slice(0, 10)

    const defaultRulesSummary = summarizeRules(flag.default?.rules)
    const envRules: Array<{environment: string; rules: string}> = (flag.environments ?? []).map((env) => ({
      environment: env.id,
      rules: summarizeRules(env.rules),
    }))

    const payload = {
      key: flag.key,
      type: flag.valueType,
      readyForCleanup: flag.readyForCleanup === true,
      defaultRule: defaultRulesSummary,
      environmentRules: envRules,
      evals: {
        evals_24h: totalEvals24h,
        evals_2d: totalEvals2d,
        evals_7d: totalEvals7d,
        evals_30d: totalEvals30d,
        last_eval: overallLastEval,
      },
      environments: nonEmptyEnvs,
    }

    if (flags.json) {
      this.log(this.toSuccessJson(payload))
      return payload as unknown as JsonObj
    }

    this.log(`${flag.key} (${flag.valueType})`)
    this.log(`  readyForCleanup: ${flag.readyForCleanup === true ? 'yes' : 'no'}`)
    this.log(`  default rule: ${defaultRulesSummary}`)
    if (envRules.length > 0) {
      this.log('  per-environment rules:')
      for (const er of envRules) this.log(`    - env ${er.environment}: ${er.rules}`)
    }

    this.log('')
    this.log('Evaluations:')
    this.log(`  evals_24h: ${totalEvals24h}`)
    this.log(`  evals_2d:  ${totalEvals2d}`)
    this.log(`  evals_7d:  ${totalEvals7d}`)
    this.log(`  evals_30d: ${totalEvals30d}`)
    this.log(`  last_eval: ${overallLastEval ?? '-'}`)
    if (nonEmptyEnvs.length > 0) {
      this.log('')
      this.log('Per-environment:')
      for (const env of nonEmptyEnvs) {
        this.log(
          `  ${env.environment}: total=${env.total}  24h=${env.evals_24h}  2d=${env.evals_2d}  7d=${env.evals_7d}  30d=${env.evals_30d}  last=${env.last_eval ?? '-'}`,
        )
      }
    } else {
      this.log('')
      this.log('No evaluations in the retained window — this flag looks quiet.')
    }

    return payload as unknown as JsonObj
  }
}
