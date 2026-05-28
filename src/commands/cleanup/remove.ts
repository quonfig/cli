import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {APICommand} from '../../index.js'
import {JsonObj} from '../../result.js'
import {getAppUrl} from '../../util/domain-urls.js'
import nameArg from '../../util/name-arg.js'

const SKILL_NAME = 'qfg-flag-cleanup'
const GITIGNORE_ENTRY = '.qf/cleanup/'

// SDK client method names worth grepping for in the customer's codebase.
// Based on the surfaces the official Quonfig SDKs expose (sdk-node /
// sdk-javascript / sdk-react / sdk-go / sdk-ruby) plus the OpenFeature
// wrappers. The skill consumes this list, the CLI doesn't run the grep
// itself — keeping the lookup explicit lets a future SDK ship a new method
// without breaking older payloads.
const GREP_PATTERNS = [
  'get',
  'getBoolean',
  'getString',
  'getInt',
  'getDouble',
  'getStringList',
  'getDuration',
  'getJson',
  'getLogLevel',
  'isFeatureEnabled',
  'booleanValue',
  'stringValue',
  'numberValue',
  'objectValue',
]

interface ConfigRule {
  criteria?: Array<{operator: string; propertyName?: string; valueToMatch?: unknown}>
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

interface EnvSparklineSummary {
  environment: string
  evals_2d: number
  evals_4h: number
  evals_7d: number
  evals_24h: number
  evals_30d: number
  last_eval: string | null
  total: number
}

interface EvalSummary {
  evals_2d: number
  evals_4h: number
  evals_7d: number
  evals_24h: number
  evals_30d: number
  last_eval: string | null
}

function startOfDayUtcMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function summarizeSparklines(resp: ConfigSparklinesResponse): {
  envSummaries: EnvSparklineSummary[]
  totals: EvalSummary
} {
  const todayMs = startOfDayUtcMs(new Date())
  // 4h is finer than the daily bucket the server returns; we approximate it
  // as "today's bucket" (same window the UI sparkline popover shows). It will
  // overlap evals_24h but stays distinct in the payload so the skill / agent
  // can tell "any evals today" from "any evals in last 24 calendar hours".
  let totalEvals4h = 0
  let totalEvals24h = 0
  let totalEvals2d = 0
  let totalEvals7d = 0
  let totalEvals30d = 0
  let overallLast: number | null = null
  const envSummaries: EnvSparklineSummary[] = []

  for (const row of resp.rows ?? []) {
    let envTotal = 0
    let envEvals4h = 0
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
      if (daysAgo === 0) {
        envEvals4h += count
        envEvals24h += count
      }

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
      evals_4h: envEvals4h,
      evals_24h: envEvals24h,
      evals_2d: envEvals2d,
      evals_7d: envEvals7d,
      evals_30d: envEvals30d,
      last_eval,
    })
    totalEvals4h += envEvals4h
    totalEvals24h += envEvals24h
    totalEvals2d += envEvals2d
    totalEvals7d += envEvals7d
    totalEvals30d += envEvals30d
    if (envLastDayAgo !== null && (overallLast === null || envLastDayAgo < overallLast)) {
      overallLast = envLastDayAgo
    }
  }

  const last_eval =
    overallLast === null ? null : new Date(todayMs - overallLast * 86_400_000).toISOString().slice(0, 10)

  return {
    envSummaries,
    totals: {
      evals_4h: totalEvals4h,
      evals_24h: totalEvals24h,
      evals_2d: totalEvals2d,
      evals_7d: totalEvals7d,
      evals_30d: totalEvals30d,
      last_eval,
    },
  }
}

function ensureGitignoreEntry(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore')
  let existing = ''
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8')
    const lines = new Set(existing.split('\n').map((l) => l.trim()))
    if (lines.has('.qf/cleanup') || lines.has('.qf/cleanup/')) return
  }

  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(gitignorePath, `${existing}${sep}${GITIGNORE_ENTRY}\n`, 'utf8')
}

export default class CleanupRemove extends APICommand {
  static args = {...nameArg}

  static description = `Write a cleanup payload for a ready-for-cleanup flag and hand off to the qfg-flag-cleanup Claude skill.

Modeled on \`qfg migrate my-code\` — this command never edits source files
itself. It validates that the flag is marked readyForCleanup=true, refuses to
proceed if there are still evals_2d > 0 (use --force to override), writes
\`.qf/cleanup/<key>.json\` describing the flag's current rule shape +
telemetry, and prints instructions to invoke the qfg-flag-cleanup skill which
asks the engineer which value should "win" and applies the inlining.

The payload deliberately does NOT suggest a winning value; that's the
engineer's call. Run \`qfg cleanup status <key>\` first if you want to inspect
telemetry before retiring.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag.key',
    '<%= config.bin %> <%= command.id %> my.flag.key --force',
    '<%= config.bin %> <%= command.id %> my.flag.key --json',
  ]

  static flags = {
    force: Flags.boolean({
      default: false,
      description: 'Skip the evals_2d > 0 safety gate (useful when telemetry is delayed but you know the flag is dead)',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(CleanupRemove)

    const key = args.name
    if (!key) return this.err('Key is required: `qfg cleanup remove <key>`')

    const flagReq = await this.apiClient.post('/api/v1/metadata/getByKey', {workspaceId: this.workspaceId, key})
    if (!flagReq.ok) {
      const errorMsg = flagReq.error?.error || `Failed to fetch flag: ${flagReq.status}`
      if (flagReq.status === 404) return this.err(`Flag ${key} not found`)
      return this.err(errorMsg, {serverError: flagReq.error})
    }

    const flag = flagReq.json as unknown as StoredFlag

    if (flag.readyForCleanup !== true) {
      return this.err(
        `Flag ${key} is not marked readyForCleanup=true. ` +
          `Flip it in the UI first (Flag detail page → mark "Ready for cleanup"), then re-run \`qfg cleanup remove ${key}\`.`,
      )
    }

    const sparkReq = await this.apiClient.post('/api/v1/analytics/configSparklines', {
      workspaceId: this.workspaceId,
      configKey: key,
    })
    if (!sparkReq.ok) {
      return this.err(sparkReq.error?.error || `Failed to fetch sparklines: ${sparkReq.status}`)
    }

    const sparkResp = sparkReq.json as unknown as ConfigSparklinesResponse
    const {envSummaries, totals} = summarizeSparklines(sparkResp)

    if (totals.evals_2d > 0 && !flags.force) {
      return this.err(
        `Flag ${key} still has evals_2d=${totals.evals_2d} (evals in the last 2 days). ` +
          `Refusing to write a cleanup payload — call sites are still hitting it. ` +
          `Run \`qfg cleanup status ${key}\` for the full per-environment breakdown. ` +
          `Use --force if you're sure the flag is dead and the telemetry is stale.`,
      )
    }

    if (!this.workspaceId) {
      return this.err('Workspace ID not found. Please run `qfg login`.')
    }

    const flagUrl = `${getAppUrl()}/workspaces/${this.workspaceId}/flags/${key}`

    const payload = {
      $schema: 'https://api.quonfig.com/schemas/v1/cleanup-payload.json',
      generatedAt: new Date().toISOString(),
      skill: SKILL_NAME,
      forced: flags.force && totals.evals_2d > 0,
      key: flag.key,
      type: flag.valueType,
      readyForCleanup: true,
      flagUrl,
      default: flag.default ?? {rules: []},
      environments: flag.environments ?? [],
      evals: totals,
      environmentSparklines: envSummaries,
      grepPatterns: GREP_PATTERNS,
    }

    const cwd = process.cwd()
    const cleanupDir = path.join(cwd, '.qf', 'cleanup')
    fs.mkdirSync(cleanupDir, {recursive: true})
    const payloadPath = path.join(cleanupDir, `${key}.json`)
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    ensureGitignoreEntry(cwd)

    const relPayloadPath = path.relative(cwd, payloadPath) || payloadPath

    this.log(`Skill:        ${SKILL_NAME}`)
    this.log(`Flag:         ${flag.key} (${flag.valueType})`)
    this.log(`Flag URL:     ${flagUrl}`)
    this.log(`Payload:      ${relPayloadPath}`)
    this.log(`Evals (2d):   ${totals.evals_2d}${payload.forced ? ' (--force overrode the safety gate)' : ''}`)
    this.log('')
    this.log(`To remove this flag's call sites, invoke Claude with the ${SKILL_NAME} skill:`)
    this.log('')
    this.log(`  claude "/${SKILL_NAME} ${key}"`)
    this.log('')
    this.log(`The skill will:`)
    this.log(`  1. Read ${relPayloadPath}`)
    this.log(`  2. Grep the repo for SDK call sites that reference ${flag.key}`)
    this.log(`  3. Ask you which value should "win" (the cleanup direction)`)
    this.log(`  4. Inline that value and delete the unreachable branches`)
    this.log(`  5. Run your formatter / tests and open a PR`)
    this.log('')
    this.log(`Once the PR merges and the SDK redeploys, run \`qfg delete ${key}\` to remove the flag definition.`)

    const output: JsonObj = {
      skill: SKILL_NAME,
      payloadPath: relPayloadPath,
      key: flag.key,
      type: flag.valueType,
      flagUrl,
      forced: payload.forced,
      evals: totals as unknown as JsonObj,
    }
    return output
  }
}
