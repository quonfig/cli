import {Args, Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {checkmark} from '../util/color.js'
import {loadTokens} from '../util/token-storage.js'
import type {JsonObj} from '../result.js'

interface RuleValue {
  type: string
  value: unknown
}

interface ConfigCriterion {
  operator?: string
  propertyName?: string
  valueToMatch?: {type?: string; value?: unknown}
}

interface ConfigRule {
  criteria?: ConfigCriterion[]
  value?: RuleValue
}

interface ConfigEnvironment {
  id: string
  rules?: ConfigRule[]
}

interface FlagSummary {
  commitSha?: string
  default?: {rules?: ConfigRule[]}
  environments?: ConfigEnvironment[]
  key: string
  valueType?: string
}

const OVERRIDE_PROP = 'quonfig-user.email'
const OVERRIDE_OP = 'PROP_IS_ONE_OF'

/**
 * Parse the fresh SHA out of a 409 conflict message of the form
 *   "<path> was modified (expected <oldSha>, got <newSha>)"
 * Returns undefined if the message doesn't match.
 */
function parseFreshShaFromConflict(message: string | undefined): string | undefined {
  if (!message) return undefined
  const match = message.match(/got\s+([\w.-]+)\)/)
  return match?.[1]
}

/**
 * Coerce a raw CLI value string into the typed Value the server expects.
 * Order matters: bool → int → double → json → string.
 */
function inferValue(raw: string): RuleValue {
  if (raw === 'true' || raw === 'false') {
    return {type: 'bool', value: raw === 'true'}
  }

  if (/^-?\d+$/.test(raw)) {
    return {type: 'int', value: Number.parseInt(raw, 10)}
  }

  if (/^-?\d+\.\d+$/.test(raw)) {
    return {type: 'double', value: Number.parseFloat(raw)}
  }

  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return {type: 'json', value: JSON.parse(trimmed)}
    } catch {
      // Fall through to string — looked like JSON but didn't parse.
    }
  }

  return {type: 'string', value: raw}
}

/**
 * Find the existing override rule for a user in a specific env. Returns the
 * value the user is currently overridden to, or undefined.
 */
function findExistingOverride(flag: FlagSummary, env: string, userEmail: string): RuleValue | undefined {
  const envEntry = flag.environments?.find((e) => e.id === env)
  for (const rule of envEntry?.rules ?? []) {
    if (!rule.criteria || rule.criteria.length !== 1) continue
    const c = rule.criteria[0]
    if (c.propertyName !== OVERRIDE_PROP || c.operator !== OVERRIDE_OP) continue
    const emails = (c.valueToMatch?.value as string[] | undefined) ?? []
    if (emails.includes(userEmail) && rule.value) {
      return rule.value as RuleValue
    }
  }
  return undefined
}

function valuesEqual(a: RuleValue, b: RuleValue): boolean {
  if (a.type !== b.type) return false
  return JSON.stringify(a.value) === JSON.stringify(b.value)
}

export default class Override extends APICommand {
  static args = {
    name: Args.string({description: 'flag/config key to override'}),
    value: Args.string({description: 'new value (type inferred: bool/int/double/json/string)'}),
  }

  static description = `Override a flag value for your dev user.

Writes a top-priority rule keyed on the dev-only quonfig-user.email property,
so the override only fires for SDK clients that set quonfig-user.email in
their context. Production SDKs typically don't set this property, which makes
overrides effectively inert in production.

Examples
  qfg override                                # list flags where you have an override
  qfg override my.flag true                   # set bool override
  qfg override my.flag 42                     # set int override
  qfg override my.flag '{"a":1}'              # set json override
  qfg override my.flag --remove               # remove your override on my.flag
  qfg override --clear                        # remove ALL of your overrides in this env`

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> my.flag true',
    '<%= config.bin %> <%= command.id %> my.flag --remove',
    '<%= config.bin %> <%= command.id %> --clear',
    '<%= config.bin %> <%= command.id %> my.flag true --env=staging',
  ]

  static flags = {
    clear: Flags.boolean({default: false, description: 'remove ALL of your overrides in this env'}),
    env: Flags.string({description: 'environment to operate in (default: $QUONFIG_ENVIRONMENT)'}),
    remove: Flags.boolean({default: false, description: 'remove your override on this key'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Override)

    // TODO(qfg-kr7.5): pick the token set keyed by the resolved workosOrgId.
    const store = await loadTokens()
    const tokens = store ? Object.values(store.tokensByOrg)[0] : undefined
    const userEmail = tokens?.user_email
    if (!userEmail) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const env = flags.env || process.env.QUONFIG_ENVIRONMENT
    if (!env) {
      return this.err('No environment specified. Pass --env=<env> or set QUONFIG_ENVIRONMENT.')
    }

    if (env === 'production') {
      this.warn(
        'Overrides on production are inert for SDK clients that do not set quonfig-user.email (most production SDKs do not). Continuing anyway.',
      )
    }

    if (flags.clear) {
      return this.runClear({env, userEmail})
    }

    if (!args.name) {
      return this.runList({env, userEmail})
    }

    if (flags.remove) {
      return this.runRemove({env, key: args.name, userEmail})
    }

    if (args.value === undefined) {
      return this.err('Missing value. Usage: qfg override <key> <value> [--env=<env>]')
    }

    return this.runSet({env, key: args.name, rawValue: args.value, userEmail})
  }

  private async callFindOrCreate(opts: {
    currentSha: string
    env: string
    key: string
    userEmail: string
    value: RuleValue
  }): Promise<JsonObj | void> {
    let sha = opts.currentSha
    let attempt = 0

    // One stale-SHA retry: parse the fresh SHA from the 409 message and try again.
    while (attempt < 2) {
      attempt += 1
      // eslint-disable-next-line no-await-in-loop
      const res = await this.apiClient.post('/api/v1/flags/findOrCreateOverride', {
        currentSha: sha,
        env: opts.env,
        flagKey: opts.key,
        userEmail: opts.userEmail,
        value: opts.value,
        workspaceId: this.workspaceId,
      })

      if (res.ok) {
        const commitSha = (res.json as {commitSha?: string})?.commitSha
        return this.ok(
          `${checkmark} Set override ${opts.key}=${JSON.stringify(opts.value.value)} (${opts.value.type}) for ${opts.userEmail} in env=${opts.env} (commit ${commitSha}).`,
          {commitSha, env: opts.env, key: opts.key, value: opts.value},
        )
      }

      if (res.status === 409 && attempt === 1) {
        const fresh = parseFreshShaFromConflict((res.error as {message?: string} | undefined)?.message)
        if (fresh) {
          this.verboseLog(`Stale SHA — retrying once with fresh SHA ${fresh}`)
          sha = fresh
          continue
        }
      }

      return this.err(`Failed to set override on ${opts.key}: ${res.status} ${JSON.stringify(res.error)}`)
    }
  }

  private async callRemove(opts: {env: string; flag: FlagSummary; key: string; userEmail: string}): Promise<boolean> {
    let sha = opts.flag.commitSha ?? ''
    let attempt = 0

    while (attempt < 2) {
      attempt += 1
      // eslint-disable-next-line no-await-in-loop
      const res = await this.apiClient.post('/api/v1/flags/removeOverride', {
        currentSha: sha,
        env: opts.env,
        flagKey: opts.key,
        userEmail: opts.userEmail,
        workspaceId: this.workspaceId,
      })

      if (res.ok) return true

      if (res.status === 409 && attempt === 1) {
        const fresh = parseFreshShaFromConflict((res.error as {message?: string} | undefined)?.message)
        if (fresh) {
          this.verboseLog(`Stale SHA — retrying remove with fresh SHA ${fresh}`)
          sha = fresh
          continue
        }
      }

      this.err(`Failed to remove override on ${opts.key}: ${res.status} ${JSON.stringify(res.error)}`)
      return false
    }
    return false
  }

  private async fetchFlag(key: string): Promise<FlagSummary | undefined> {
    const res = await this.apiClient.post('/api/v1/flags/getByKey', {
      flagKey: key,
      workspaceId: this.workspaceId,
    })
    if (!res.ok) {
      if (res.status === 404) return undefined
      this.err(`Failed to fetch flag ${key}: ${res.status} ${JSON.stringify(res.error)}`)
      return undefined
    }
    return res.json as unknown as FlagSummary
  }

  private async runClear(opts: {env: string; userEmail: string}): Promise<JsonObj | void> {
    const res = await this.apiClient.post('/api/v1/flags/list', {workspaceId: this.workspaceId})
    if (!res.ok) {
      return this.err(`Failed to list flags: ${res.status} ${JSON.stringify(res.error)}`)
    }
    const flags = (res.json as unknown as FlagSummary[]) ?? []
    const targets = flags.filter((f) => findExistingOverride(f, opts.env, opts.userEmail) !== undefined)

    if (targets.length === 0) {
      return this.ok(`No overrides to clear in env=${opts.env}.`)
    }

    const cleared: string[] = []
    for (const f of targets) {
      // eslint-disable-next-line no-await-in-loop
      const removed = await this.callRemove({
        env: opts.env,
        flag: f,
        key: f.key,
        userEmail: opts.userEmail,
      })
      if (removed) cleared.push(f.key)
    }

    return this.ok(`${checkmark} Cleared ${cleared.length} override(s) in env=${opts.env}: ${cleared.join(', ')}`)
  }

  private async runList(opts: {env: string; userEmail: string}): Promise<JsonObj | void> {
    const res = await this.apiClient.post('/api/v1/flags/list', {workspaceId: this.workspaceId})
    if (!res.ok) {
      return this.err(`Failed to list flags: ${res.status} ${JSON.stringify(res.error)}`)
    }
    const flags = (res.json as unknown as FlagSummary[]) ?? []
    const overridden = flags.filter((f) => findExistingOverride(f, opts.env, opts.userEmail) !== undefined)

    if (overridden.length === 0) {
      return this.ok(`You have no overrides in env=${opts.env}.`)
    }

    this.log(`Your overrides in env=${opts.env}:`)
    for (const f of overridden) {
      const v = findExistingOverride(f, opts.env, opts.userEmail)
      this.log(`  ${f.key} = ${JSON.stringify(v?.value)} (${v?.type})`)
    }
    return {env: opts.env, overrides: overridden.map((f) => f.key)}
  }

  private async runRemove(opts: {env: string; key: string; userEmail: string}): Promise<JsonObj | void> {
    const flag = await this.fetchFlag(opts.key)
    if (!flag) {
      return this.err(`Flag ${opts.key} not found.`)
    }

    const existing = findExistingOverride(flag, opts.env, opts.userEmail)
    if (!existing) {
      return this.ok(`You have no override on ${opts.key} in env=${opts.env}.`)
    }

    const removed = await this.callRemove({env: opts.env, flag, key: opts.key, userEmail: opts.userEmail})
    return removed ? this.ok(`${checkmark} Removed override on ${opts.key} in env=${opts.env}.`) : undefined
  }

  private async runSet(opts: {env: string; key: string; rawValue: string; userEmail: string}): Promise<JsonObj | void> {
    const value = inferValue(opts.rawValue)
    const flag = await this.fetchFlag(opts.key)
    if (!flag) {
      return this.err(`Flag ${opts.key} not found.`)
    }

    const existing = findExistingOverride(flag, opts.env, opts.userEmail)
    if (existing && valuesEqual(existing, value)) {
      return this.ok(
        `${opts.key} is already set to ${JSON.stringify(value.value)} (${value.type}) for ${opts.userEmail} in env=${opts.env}.`,
      )
    }

    const sha = flag.commitSha ?? ''
    return this.callFindOrCreate({
      currentSha: sha,
      env: opts.env,
      key: opts.key,
      userEmail: opts.userEmail,
      value,
    })
  }
}
