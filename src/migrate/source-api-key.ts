/**
 * Decision D8 (project/plans/migrator-launch-darkly.md §9.1): the `qfg migrate`
 * command's API-key flag is generalized from the launch-specific `--api-key` /
 * `LAUNCH_API_KEY` into a provider-agnostic `--source-api-key` /
 * `QUONFIG_MIGRATE_API_KEY`, with a per-provider env fallback. `--api-key` /
 * `LAUNCH_API_KEY` stay as deprecated aliases for the `launch` source.
 *
 * Precedence (highest first):
 *   1. `--source-api-key` flag   (oclif also fills it from QUONFIG_MIGRATE_API_KEY)
 *   2. `--api-key` flag          (oclif also fills it from LAUNCH_API_KEY; deprecated)
 *   3. per-provider env var      (LAUNCHDARKLY_API_KEY, FLAGSMITH_API_KEY, ...)
 */

/**
 * Per-provider env-var fallback, lowest precedence. Keyed by `--from` value so
 * every supported source has an obvious, source-named env var. `launch`'s entry
 * is redundant with the `--api-key` flag's own `env: LAUNCH_API_KEY` binding,
 * but is kept so the map is a complete record of every provider's env var.
 */
export const PROVIDER_API_KEY_ENV: Record<string, string> = {
  flagsmith: 'FLAGSMITH_API_KEY',
  launch: 'LAUNCH_API_KEY',
  launchdarkly: 'LAUNCHDARKLY_API_KEY',
}

export interface SourceApiKeyInput {
  /** `--api-key` flag value (oclif also fills this from LAUNCH_API_KEY). Deprecated alias. */
  apiKeyFlag?: string
  /** Process env, injectable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** `--from` value — selects the per-provider env-var fallback. */
  from: string
  /** `--source-api-key` flag value (oclif also fills this from QUONFIG_MIGRATE_API_KEY). */
  sourceApiKeyFlag?: string
}

/** Resolve the source API key from flags + env, or `undefined` if none is configured. */
export function resolveSourceApiKey(input: SourceApiKeyInput): string | undefined {
  if (input.sourceApiKeyFlag) return input.sourceApiKeyFlag
  if (input.apiKeyFlag) return input.apiKeyFlag

  const env = input.env ?? process.env
  const providerEnv = PROVIDER_API_KEY_ENV[input.from]
  if (providerEnv && env[providerEnv]) return env[providerEnv]

  return undefined
}

/** One-line guidance for the "no key configured" error, naming every accepted input. */
export function missingSourceApiKeyMessage(from: string): string {
  const providerEnv = PROVIDER_API_KEY_ENV[from]
  const providerHint = providerEnv ? ` For --from ${from} you can also set ${providerEnv}.` : ''
  return (
    '--source-api-key is required (or set QUONFIG_MIGRATE_API_KEY).' +
    providerHint +
    ' The legacy --api-key / LAUNCH_API_KEY flag still works for --from launch.'
  )
}
