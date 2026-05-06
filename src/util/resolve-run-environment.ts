/**
 * Resolve the auth/environment mode for `qfg run`.
 *
 * The rule is **binary and mutually exclusive** — never resolve in
 * precedence order, because a "match-only" exception drifts silently and
 * masks misconfiguration in CI.
 *
 *   Mode A — `QUONFIG_BACKEND_SDK_KEY` set:
 *     The SDK key encodes both project and environment. If `--environment`
 *     OR `QUONFIG_ENVIRONMENT` is also present, return an `error` — even
 *     if they would agree, because tolerating that case lets a stale env
 *     var quietly drift past us until the day it disagrees.
 *
 *   Mode B — no SDK key:
 *     Require EXACTLY ONE of `--environment` flag or `QUONFIG_ENVIRONMENT`
 *     env var. Both → error. Neither → error. There is no interactive
 *     prompt — `qfg run` is scripted, and prompting mid-`&&`-chain is
 *     worse UX than failing loud.
 *
 * Empty strings are treated as "unset" because shells routinely emit
 * `EXPORT_FOO=` when a var is declared but has no value, and silently
 * picking Mode A with an empty key would surface as a confusing 401 from
 * api-delivery much later.
 */

export interface ResolveRunEnvironmentInput {
  /** Value of the `--environment` flag (or undefined). */
  envFlag: string | undefined
  /** Value of `QUONFIG_ENVIRONMENT` env var (or undefined). */
  envFromEnvironment: string | undefined
  /** Value of `QUONFIG_BACKEND_SDK_KEY` (or undefined). */
  sdkKey: string | undefined
}

export type ResolveRunEnvironmentResult =
  | {mode: 'sdk-key'; sdkKey: string}
  | {mode: 'user'; environmentName: string}
  | {mode: 'error'; message: string}

export const RUN_MODE_AMBIGUOUS_ERROR =
  'qfg run: QUONFIG_BACKEND_SDK_KEY is set, which encodes the environment.\n' +
  'Remove --environment and unset QUONFIG_ENVIRONMENT, or remove the SDK key.'

export const RUN_MODE_NO_ENV_ERROR =
  'qfg run: no environment specified.\n' +
  'Either set QUONFIG_BACKEND_SDK_KEY (which encodes env) or\n' +
  'set QUONFIG_ENVIRONMENT / pass --environment after `qfg login`.'

export const RUN_MODE_BOTH_ENV_ERROR =
  'qfg run: pass exactly one of --environment or QUONFIG_ENVIRONMENT (both are set).'

const blank = (s: string | undefined): boolean => s === undefined || s === ''

export const resolveRunEnvironmentMode = (input: ResolveRunEnvironmentInput): ResolveRunEnvironmentResult => {
  const hasSdkKey = !blank(input.sdkKey)
  const hasFlag = !blank(input.envFlag)
  const hasEnvVar = !blank(input.envFromEnvironment)

  if (hasSdkKey) {
    if (hasFlag || hasEnvVar) {
      return {mode: 'error', message: RUN_MODE_AMBIGUOUS_ERROR}
    }

    return {mode: 'sdk-key', sdkKey: input.sdkKey as string}
  }

  if (hasFlag && hasEnvVar) {
    return {mode: 'error', message: RUN_MODE_BOTH_ENV_ERROR}
  }

  if (hasFlag) {
    return {mode: 'user', environmentName: input.envFlag as string}
  }

  if (hasEnvVar) {
    return {mode: 'user', environmentName: input.envFromEnvironment as string}
  }

  return {mode: 'error', message: RUN_MODE_NO_ENV_ERROR}
}
