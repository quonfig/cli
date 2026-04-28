import {Args, Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import {checkmark} from '../util/color.js'
import {LOG_LEVELS, LOG_LEVEL_KEY_PREFIX, isLogLevel} from '../util/log-levels.js'

const SDK_LOGGER_CONTEXT = 'quonfig-sdk-logging.key'

type LogLevelValue = {type: 'log_level'; value: string}
type StringListValue = {type: 'string_list'; value: string[]}
type Criterion = {operator: string; propertyName?: string; valueToMatch?: StringListValue | unknown}
type Rule = {criteria: Criterion[]; value: LogLevelValue}
type EnvRules = {id: string; rules: Rule[]}
type LogLevelConfig = {
  commitSha: string
  default: {rules: Rule[]}
  environments?: EnvRules[]
}

/**
 * Convenience command for log-level configs.
 *
 *   qfg log-level log-level.my-app --value=WARN
 *     → creates the config (delegates to `qfg create --type log_level`)
 *
 *   qfg log-level log-level.my-app --target=MyPackage.Service --value=INFO
 *     → adds a targeting rule on "${SDK_LOGGER_CONTEXT}" to an existing
 *       config, using PROP_STARTS_WITH_ONE_OF. Lets agents dial a single
 *       logger up/down without pull+edit+push.
 */
export default class LogLevel extends APICommand {
  static args = {
    name: Args.string({
      description: `log-level key (must start with "${LOG_LEVEL_KEY_PREFIX}", e.g. ${LOG_LEVEL_KEY_PREFIX}my-app)`,
      required: true,
    }),
  }

  static description = `Create or add targeting rules to a log-level config.

Log-level keys must start with "${LOG_LEVEL_KEY_PREFIX}" (e.g. ${LOG_LEVEL_KEY_PREFIX}my-app). The
default value applies to every logger in that service unless a targeting
rule matches first.

Two modes:

  1. Create a new log-level config with a default value:
       qfg log-level ${LOG_LEVEL_KEY_PREFIX}my-app --value=WARN

  2. Add a per-logger targeting rule to an existing config. SDKs populate
     the "${SDK_LOGGER_CONTEXT}" context automatically from the logger path,
     so this rule fires for any logger whose name starts with --target:
       qfg log-level ${LOG_LEVEL_KEY_PREFIX}my-app --target=MyPackage.Noisy --value=ERROR

     Pass --target multiple times to match any of several prefixes (OR).
     Pass --environment=<env> to scope the rule to a single environment.

To update the catch-all default for an existing log level, use set-default:
  qfg set-default ${LOG_LEVEL_KEY_PREFIX}my-app --value=DEBUG --environment=production

For more complex rules (regex, multi-criterion, exact match) edit the JSON:
  qfg pull && $EDITOR log-levels/${LOG_LEVEL_KEY_PREFIX}my-app.json
  qfg config-schema            # full operator reference`

  static examples = [
    `<%= config.bin %> <%= command.id %> ${LOG_LEVEL_KEY_PREFIX}my-app --value=WARN`,
    `<%= config.bin %> <%= command.id %> ${LOG_LEVEL_KEY_PREFIX}my-app --target=MyPackage.Noisy --value=ERROR`,
    `<%= config.bin %> <%= command.id %> ${LOG_LEVEL_KEY_PREFIX}my-app --target=A --target=B --value=DEBUG`,
    `<%= config.bin %> <%= command.id %> ${LOG_LEVEL_KEY_PREFIX}my-app --target=Chatty --value=INFO --environment=production`,
  ]

  static flags = {
    environment: Flags.string({
      description: 'when used with --target, scope the rule to this environment instead of the default',
    }),
    target: Flags.string({
      description: `logger path prefix (matched via PROP_STARTS_WITH_ONE_OF on "${SDK_LOGGER_CONTEXT}"); repeatable`,
      multiple: true,
    }),
    value: Flags.string({
      description: 'log level — either the new default (create mode) or the level for the targeted loggers',
      options: [...LOG_LEVELS],
      required: false,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(LogLevel)

    if (!args.name.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      return this.err(
        `Log level key "${args.name}" must start with "${LOG_LEVEL_KEY_PREFIX}". Try: ${LOG_LEVEL_KEY_PREFIX}${args.name}`,
      )
    }

    if (!flags.target || flags.target.length === 0) {
      // No targeting — delegate to create.
      if (flags.environment) {
        return this.err(
          '--environment requires --target. To change the default for an existing log level in an environment, use: qfg set-default',
        )
      }

      const argv = [args.name, '--type=log_level']
      if (flags.value) argv.push(`--value=${flags.value}`)
      if (this.jsonEnabled()) argv.push('--json')

      return this.config.runCommand('create', argv) as Promise<JsonObj | void>
    }

    // Targeting mode — add a rule on quonfig-sdk-logging.key.
    if (!flags.value) {
      return this.err('--value is required with --target (the level the targeted loggers should use)')
    }

    return this.addTargetingRule(args.name, flags.target, flags.value, flags.environment)
  }

  private async addTargetingRule(
    key: string,
    targets: string[],
    levelRaw: string,
    environment: string | undefined,
  ): Promise<JsonObj | void> {
    const level = levelRaw.toUpperCase()
    if (!isLogLevel(level)) {
      return this.err(`Invalid log level "${levelRaw}". Must be one of: ${LOG_LEVELS.join(', ')}`)
    }

    // Fetch current config — we need the commitSha for optimistic concurrency
    // plus the existing rules so we can merge rather than replace.
    const detailRequest = await this.apiClient.post('/api/v1/metadata/getByKey', {
      workspaceId: this.workspaceId,
      key,
    })

    if (!detailRequest.ok) {
      if (detailRequest.status === 404) {
        return this.err(`Log level "${key}" does not exist. Create it first:\n  qfg log-level ${key} --value=INFO`)
      }

      return this.err(`Failed to fetch log level: ${detailRequest.status}`, {serverError: detailRequest.error})
    }

    const current = detailRequest.json as unknown as LogLevelConfig

    const newRule: Rule = {
      criteria: [
        {
          operator: 'PROP_STARTS_WITH_ONE_OF',
          propertyName: SDK_LOGGER_CONTEXT,
          // Schema: CriterionSchema.valueToMatch is a Value, i.e. { type, value }.
          // For string-list operators like PROP_STARTS_WITH_ONE_OF this is a string_list.
          valueToMatch: {type: 'string_list', value: [...targets]},
        },
      ],
      value: {type: 'log_level', value: level},
    }

    // Merge semantics: if an existing rule has the same exact targeting
    // criterion (same propertyName, same valueToMatch set), replace its value.
    // Otherwise insert the new rule before the catch-all so it takes priority.
    const existingRules = environment ? findEnvRules(current, environment) : (current.default?.rules ?? [])

    const mergedRules = mergeTargetingRule(existingRules, newRule)

    const logLevelPatch: Record<string, unknown> = environment
      ? {environments: replaceEnvRules(current.environments ?? [], environment, mergedRules)}
      : {default: {rules: mergedRules}}

    const updateRequest = await this.apiClient.post('/api/v1/logLevels/update', {
      workspaceId: this.workspaceId,
      logLevelKey: key,
      logLevel: logLevelPatch,
      expectedCommitSha: current.commitSha,
    })

    if (!updateRequest.ok) {
      return this.err(`Failed to update log level: ${updateRequest.status}`, {serverError: updateRequest.error})
    }

    const scope = environment ? `environment=${environment}` : 'default'
    const targetList = targets.join(', ')
    return this.ok(
      `${checkmark} Set log level ${level} for loggers starting with [${targetList}] on ${key} (${scope})`,
      {
        key,
        targets,
        value: level,
        environment: environment ?? null,
      },
    )
  }
}

function findEnvRules(config: LogLevelConfig, environment: string): Rule[] {
  const env = (config.environments ?? []).find((e) => e.id === environment)
  return env?.rules ?? []
}

function replaceEnvRules(envs: EnvRules[], environment: string, rules: Rule[]): EnvRules[] {
  const hasEnv = envs.some((e) => e.id === environment)
  return hasEnv ? envs.map((e) => (e.id === environment ? {...e, rules} : e)) : [...envs, {id: environment, rules}]
}

function mergeTargetingRule(existing: Rule[], incoming: Rule): Rule[] {
  const incomingTargets = new Set(stringListTargets(incoming.criteria[0].valueToMatch))
  const incomingPropertyName = incoming.criteria[0].propertyName

  let replaced = false
  const next = existing.map((rule) => {
    if (rule.criteria.length !== 1) return rule
    const c = rule.criteria[0]
    if (c.operator !== 'PROP_STARTS_WITH_ONE_OF') return rule
    if (c.propertyName !== incomingPropertyName) return rule

    const existingTargets = new Set(stringListTargets(c.valueToMatch))
    if (existingTargets.size !== incomingTargets.size) return rule
    for (const t of existingTargets) if (!incomingTargets.has(t)) return rule

    replaced = true
    return {...rule, value: incoming.value}
  })

  if (replaced) return next

  // Prepend — it must win against any catch-all rule that's already there.
  return [incoming, ...existing]
}

/**
 * Pull the string array out of a `valueToMatch` value. Handles the wrapped
 * `{type: 'string_list', value: [...]}` envelope that the schema requires,
 * plus a defensive fallback for the bare-array shape (older data or tests).
 */
function stringListTargets(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[]
  if (v && typeof v === 'object' && Array.isArray((v as {value?: unknown}).value)) {
    return (v as {value: string[]}).value
  }

  return []
}
