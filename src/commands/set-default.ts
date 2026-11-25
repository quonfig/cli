import {Flags} from '@oclif/core'
import {ProvidedSource, ConfigValueType} from '@quonfig/node'

import {
  type ProposalChange,
  type ProposalDocumentType,
  type ProposeOptions,
  applyUpdateFields,
  failWithProposeHint,
  loadCrBase,
  parseProposeFlags,
  proposalTypeFor,
  proposeFlags,
  submitProposal,
} from '../change-requests/propose.js'
import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import {
  PROPOSE_SECRET_ERROR,
  SECRET_KEY_NAME_ERROR,
  SecretCommandError,
  VALUE_ARGV_WARNING,
  encryptedPhrase,
  jsonValue,
  cleanupQuietly,
  knownSecretFailure,
  mirrorSecretToDisk,
  openCommandSnapshot,
  pushPlan,
  readabilityNote,
  twinNotice,
} from '../secrets/secret-command.js'
import {secretPath} from '../secrets/secret-doc.js'
import {checkSecretUpdatable, oldFormatRefusal, planSecretUpdate} from '../secrets/secret-write-flow.js'
import getConfirmation, {confirmFlag} from '../ui/get-confirmation.js'
import getEnvironment from '../ui/get-environment.js'
import getKeyset from '../ui/get-keyset.js'
import getString from '../ui/get-string.js'
import autocomplete from '../util/autocomplete.js'
import {DURATION_FORMAT_HINT, isValidIsoDuration, parseDoubleValue, parseIntValue} from '../util/coerce.js'
import {checkmark} from '../util/color.js'
import {mapConfigValueToDto} from '../util/config-value-dto.js'
import {redactToken} from '../util/git-ops.js'
import isInteractive from '../util/is-interactive.js'
import nameArg from '../util/name-arg.js'
import {
  Rule,
  ScopedDocument,
  catchAllRule,
  countTargetingRules,
  keptTargetingNote,
  replacedTargetingNote,
  seedScopeRules,
  seededFromDefaultNote,
  upsertEnvRules,
  upsertFallbackRule,
} from '../util/rules.js'
import {RedactedSummary, redactedDisplay, redactedSummary} from '../util/redact.js'
import {notice} from '../util/stderr-notice.js'
import secretFlags, {SECRET_KEY_NAME_NOTE, Secret, parsedSecretFlags} from '../util/secret-flags.js'
import {INVALID_UTF8_INPUT, resolveValueSource, valueSourceFlags} from '../util/value-source.js'

/** Every stored rule value of a document, default and per-environment. */
const valuesOf = (doc: ScopedDocument) =>
  [...(doc.default?.rules ?? []), ...(doc.environments ?? []).flatMap((env) => env.rules ?? [])].map(
    (rule) => rule.value as {confidential?: boolean; decryptWith?: string; type?: string} | undefined,
  )

/** `1 targeting rule`, `2 targeting rules`. */
const plural = (n: number) => `${n} targeting rule${n === 1 ? '' : 's'}`

type ValueOrEnvVar = {envVar: string; value?: never} | {envVar?: never; value: string}
type StoredDocument = {commitSha: string} & ScopedDocument

/** How a --propose / --cr run sends its change (qfg-5bjew.37). */
interface ProposeContext {
  docType: ProposalDocumentType
  /** True when --cr <n> already changes this key: build on #n's version. */
  inRequest: boolean
  options: ProposeOptions
  /** "The version I read": main's commitSha, or #n's head when inRequest. */
  token: string
}

export default class SetDefault extends APICommand {
  static aliases = ['toggle']

  static args = {...nameArg}

  static description = `Set the fallback value for a flag or config in one environment.

The fallback is the unconditional rule at the end of the environment's rule
list: what users receive when no targeting rule matches. Targeting rules and
percentage rollouts above it are kept, and the command tells you how many.
If the environment has no rules of its own yet, they are copied from the
flag's default rules first, so inherited targeting is kept too.

To turn a flag on or off for EVERYONE, including users matched by targeting
rules, add --replace-targeting. This deletes the environment's targeting
rules (they stay in git history).

To set a percentage rollout (gradual rollout / A/B test / canary deploy) instead:
  qfg set-rollout my.flag --environment production --true-percent 20

Secrets (--secret, or any key stored in secrets/) are encrypted on this machine
to a keyset from quonfig.json; writing needs no private key. A new value keeps
the keyset of the value it replaces; --keyset moves it to another keyset (with
a warning that runtimes holding only the old keyset can no longer read it).
Secrets are STRING-ONLY. To store a JSON secret, make it a string secret
holding the JSON and JSON.parse it in your app. The CLI never prints a secret's
plaintext; it shows the keyset, its key fingerprint and a redacted summary like
[encrypted *****3fa9c, 51 chars, ends …a1b2]. Secrets cannot be proposed in a
change request yet, and a key still holding old-format encrypted values must be
moved with qfg secret migrate (coming) before it can be changed.
Rotate a secret without the value entering argv / shell history:
  pbpaste | qfg set-default stripe.api-key --environment production --secret --value-stdin --confirm
  qfg set-default stripe.api-key --environment production --secret --value-from-env STRIPE_API_KEY --confirm
(--env-var is different: it stores NO value and tells the SDK to read one from
that env var at runtime.)

To see all current values and rules for a flag:
  qfg info my.flag

To PROPOSE the change instead of applying it (a change request: NOT LIVE
until someone with rights merges it; works with a read-only key):
  qfg set-default my.flag --environment production --value true --propose
  qfg set-default other.flag --environment production --value true --cr 12   # add to your #12
Agents: never merge a change request you did not author without a human telling you to.

To target specific organizations or users, write rules on their KEY
(organization.key, user.key), not a slug or email; find a key from a name with:
  qfg contexts search organization formhealth`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag.name                                          # prompts for value and env',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=true --environment=staging',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=false --environment=production --replace-targeting   # kill-switch: off for everyone',
    '# Rotate a secret without the value entering argv:',
    'pbpaste | <%= config.bin %> <%= command.id %> my.secret --environment=production --secret --value-stdin --confirm',
    '<%= config.bin %> <%= command.id %> my.secret --environment=production --secret --value-from-env=MY_SECRET --confirm',
    '# Write the [Default] rules (inherited by every environment without its own):',
    '<%= config.bin %> <%= command.id %> my.secret --environment="[Default]" --secret --value-from-env=MY_SECRET --confirm',
    '<%= config.bin %> <%= command.id %> my.config.name --env-var=MY_ENV_VAR_NAME --environment=production',
    '# For a percentage rollout, use set-rollout instead:',
    '<%= config.bin %> set-rollout my.flag.name --environment production --true-percent 20',
    '# For per-user / per-property targeting (e.g. user.email == X), edit JSON directly:',
    '<%= config.bin %> pull && <%= config.bin %> config-schema',
  ]

  static flags = {
    confidential: Flags.boolean({
      allowNo: true,
      description:
        'mark the value as confidential. Auto-detected when the key already holds a confidential value; pass --no-confidential to store it in the clear',
    }),
    'env-var': Flags.string({
      description:
        'store no value: the SDK reads it from this env var at RUNTIME. To read a value from a local env var NOW, use --value-from-env',
    }),
    environment: Flags.string({
      description:
        'environment to change, e.g. production. Use "[Default]" for the default rules that every environment without its own rules inherits',
    }),
    'replace-targeting': Flags.boolean({
      default: false,
      description:
        "set the value for EVERYONE: delete this environment's targeting rules instead of keeping them (they stay in git history)",
    }),
    value: Flags.string({
      description:
        "new default value (for secrets prefer --value-stdin / --value-from-env). An empty value is allowed with --value=''",
    }),
    ...valueSourceFlags,
    ...confirmFlag,
    ...secretFlags('encrypt the value of this item (string-only; the CLI never prints the plaintext)'),
    ...proposeFlags,
  }

  static writesHostedWorkspace = true

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(SetDefault)

    const secret = parsedSecretFlags(flags)
    if (secret.selected && secret.keyNameGiven) return this.err(SECRET_KEY_NAME_ERROR)

    if (secret.keyNameGiven && !secret.selected) notice(SECRET_KEY_NAME_NOTE)

    // qfg-5bjew.37: --propose / --cr <n> send the same document to
    // changeRequests.propose instead of the update route.
    const propose = parseProposeFlags(flags)
    if (!propose.ok) return this.err(propose.error)
    const proposeOptions = propose.options

    if (flags['env-var'] && flags.value) {
      return this.err('cannot specify both --env-var and --value')
    }

    if (flags['env-var'] && secret.selected) {
      return this.err('cannot specify both --env-var and --secret')
    }

    // qfg-38lp: --value / --value-stdin / --value-from-env all resolve here.
    let invalidUtf8 = false
    const valueSource = await resolveValueSource(flags, {
      onInvalidUtf8() {
        invalidUtf8 = true
      },
    })
    if (!valueSource.ok) {
      return this.err(valueSource.error ? valueSource.message : 'Value is required')
    }

    if (flags.confidential === true && secret.selected) {
      console.warn("Note: --confidential is implied when using --secret, so you don't need to specify both.")
    }

    // Validate required arguments before making API calls
    if (!args.name && !isInteractive(flags)) {
      return this.err("'name' argument is required when interactive mode isn't available.")
    }

    if (!flags.environment && !isInteractive(flags)) {
      return this.err("'environment' is required when interactive mode isn't available.")
    }

    // Fetch all configs from metadata endpoint
    const metadataRequest = await this.apiClient.post('/api/v1/metadata/list', {workspaceId: this.workspaceId})

    if (!metadataRequest.ok) {
      const errorMsg = metadataRequest.error?.error || `Failed to fetch configs: ${metadataRequest.status}`
      return this.err(errorMsg, {serverError: metadataRequest.error})
    }

    interface ConfigMetadata {
      description: string
      id: string
      key: string
      name: string
      type: string
      valueType: string
      version: string
    }

    interface ConfigMetadataResponse {
      configs: ConfigMetadata[]
    }

    const metadataResponse = metadataRequest.json as unknown as ConfigMetadataResponse
    const configs = metadataResponse.configs

    // Get the key - from args or prompt
    let key = args.name

    if (!key && isInteractive(flags)) {
      const configKeys = configs.map((c) => c.key)
      const selectedKey = await autocomplete({
        message: 'Which item would you like to change the default for?',
        source: configKeys,
      })
      if (selectedKey) {
        key = selectedKey
      }
    }

    if (!key) {
      return this.err("'name' argument is required when interactive mode isn't available.")
    }

    const config = configs.find((c) => c.key === key)

    // qfg-38lp: secrets are string-only end to end. Say so here instead of
    // letting the server answer with a bare 422.
    if (secret.selected && config && config.type !== 'secret' && config.valueType.toLowerCase() !== 'string') {
      return this.err(
        `secrets are string-only; ${key} is type ${config.valueType}. ` +
          'Store JSON (or any structured value) as a string secret instead — e.g. ' +
          '`qfg create <new-key> --type string --secret --value-stdin < value.json` — and JSON.parse it in your app.',
        {key, phase: 'validation', valueType: config.valueType},
      )
    }

    // A secret lives in secrets/ and is written there (qfg-mol-hle). A key
    // the server does not list may still be one: a server that does not list
    // secrets yet (app-quonfig rule 1) leaves them out, so the snapshot decides.
    const secretWrite = {flags, invalidUtf8, key, proposeOptions, secret, value: valueSource.value}
    if (secret.selected || config?.type === 'secret') return this.setSecret({...secretWrite, mode: 'explicit'})
    if (!config) return this.setSecret({...secretWrite, mode: 'unlisted'})

    this.verboseLog('Selected config:', config)

    // Fetch the stored document ONCE. It drives encryption auto-detection,
    // the targeting-rule count in the confirmation prompt, the rules the write
    // is applied to, and the commitSha for optimistic concurrency.
    const detailRequest = await this.apiClient.post('/api/v1/metadata/getByKey', {
      workspaceId: this.workspaceId,
      key,
    })

    if (!detailRequest.ok) {
      return this.err(`Failed to fetch config details: ${detailRequest.status}`)
    }

    let currentConfig = detailRequest.json as unknown as StoredDocument
    this.verboseLog('Config details:', currentConfig)

    // Auto-detect from EVERY stored rule value, default and per-environment
    // (qfg-r3a47): an update to an encrypted or confidential key must not
    // silently store the new value in the clear.
    const storedValues = valuesOf(currentConfig)

    // An old-format (decryptWith) value is never written again (qfg-mol-hle,
    // plan Q6). The key may already have a secrets/ copy (the transition
    // twin), which is what a write updates; otherwise the write is refused.
    if (storedValues.some((value) => value?.decryptWith)) {
      return this.setSecret({...secretWrite, mode: 'old-format'})
    }

    if (secret.keyset !== undefined) return this.err('--keyset applies only to secrets')

    let proposeContext: ProposeContext | undefined
    if (proposeOptions) {
      const docType = proposalTypeFor(config.type)
      if (!docType) return this.err(`Cannot propose a change to ${key}: proposals cover flags, configs and log levels.`)
      let token = currentConfig.commitSha
      let inRequest = false
      if (proposeOptions.changeRequest !== undefined) {
        const base = await loadCrBase(this, proposeOptions.changeRequest, docType, key)
        if (base.inRequest) {
          // #n already changes this key: build on #n's version of it.
          currentConfig = {...(base.document as ScopedDocument), commitSha: base.headSha}
          token = base.headSha
          inRequest = true
        }
      }

      proposeContext = {docType, inRequest, options: proposeOptions, token}
    }

    // With --cr <n> the write is based on #n's version of the key, so its
    // values decide too (validator B1): an old-format value in either copy
    // refuses the write, and a confidential value in #n keeps it confidential.
    const baseValues = proposeContext?.inRequest ? valuesOf(currentConfig) : storedValues
    if (baseValues.some((value) => value?.decryptWith)) return this.err(oldFormatRefusal(key), {key})

    let confidential = flags.confidential === true
    if (
      flags.confidential === undefined &&
      !secret.selected &&
      baseValues.some((value) => value?.confidential && value.type !== 'provided')
    ) {
      confidential = true
      this.logToStderr(
        `Note: ${key} already holds a confidential value, so the new value is stored confidential too. ` +
          'Pass --no-confidential to store it in the clear.',
      )
    }

    // Get the environment
    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to change the default for?',
      providedEnvironment: flags.environment,
    })

    this.verboseLog({environment})

    if (!environment) {
      return
    }

    // The scope this write targets: one environment's rule list, or the
    // document's `default` block when the user picked [Default].
    // environment.name is the slug stored in git files (e.g. "production");
    // environment.id is the DB UUID and is never written to git files.
    const envName = environment.id === '' ? undefined : environment.name
    const replaceTargeting = flags['replace-targeting']
    const scope = seedScopeRules(currentConfig, envName)

    // A --replace-targeting write does NOT seed from default: there is nothing
    // in that environment to replace, and the default rules it inherits are
    // not being deleted, so reporting them as "replaced" would be a lie.
    const targetingRuleCount = replaceTargeting && scope.seeded ? 0 : countTargetingRules(scope.rules)

    const keptPhrase =
      targetingRuleCount > 0 ? ` (${targetingRuleCount} targeting rule${targetingRuleCount === 1 ? '' : 's'} kept)` : ''
    const deletePhrase = targetingRuleCount > 0 ? `, deleting ${targetingRuleCount} targeting rule(s)` : ''
    const confirmMessage = (valuePhrase: string): string =>
      replaceTargeting
        ? `Confirm: set ${key} in ${environment.name} to ${valuePhrase} for EVERYONE${deletePhrase}?`
        : `Confirm: set the fallback for ${key} in ${environment.name} to ${valuePhrase}?${keptPhrase}`

    // Get the value
    if (flags['env-var']) {
      if (
        !proposeContext &&
        !(await getConfirmation({flags, message: confirmMessage(`be provided by \`${flags['env-var']}\``)}))
      ) {
        return
      }

      return this.submitChange({
        confidential,
        config,
        currentConfig,
        envName,
        envVar: flags['env-var'],
        environment,
        key,
        proposeContext,
        replaceTargeting,
        scope,
        secret,
        targetingRuleCount,
      })
    }

    let value = valueSource.value

    // A secret / confidential value is masked while typed and never shown.
    const hideValue = secret.selected || confidential

    if (!value && isInteractive(flags)) {
      value = await getString({
        allowBlank: true,
        mask: hideValue,
        message: hideValue ? 'Secret value (input is masked)' : 'Default value',
      })
    }

    if (value === undefined) {
      return this.err('Value is required')
    }

    const promptPhrase = hideValue
      ? redactedDisplay(redactedSummary({encrypted: secret.selected, plaintext: value}))
      : `\`${value}\``

    // Nothing goes live with --propose, so there is nothing to confirm.
    if (!proposeContext && !(await getConfirmation({flags, message: confirmMessage(promptPhrase)}))) {
      return
    }

    return this.submitChange({
      confidential,
      config,
      currentConfig,
      envName,
      environment,
      key,
      proposeContext,
      replaceTargeting,
      scope,
      secret,
      targetingRuleCount,
      value,
    })
  }

  /**
   * The proposal entry for this write. Normally the whole document the live
   * write would have produced, with the commitSha it was read at. When --cr
   * <n> already changes this key, the server will not replace the whole
   * document there (Q15), so a plain fallback value goes as the semantic
   * set_flag / set_config instead, applied to #n's version.
   */
  private proposalChange({
    config,
    configValue,
    currentConfig,
    envName,
    envVar,
    key,
    proposeContext,
    replaceTargeting,
    secretOrConfidential,
    updateFields,
  }: {
    config: {type: string}
    configValue: Record<string, unknown>
    currentConfig: StoredDocument
    envName: string | undefined
    envVar: string | undefined
    key: string
    proposeContext: ProposeContext
    replaceTargeting: boolean
    secretOrConfidential: boolean
    updateFields: Record<string, unknown>
  }): ProposalChange {
    const semantic =
      proposeContext.inRequest &&
      envVar === undefined &&
      !secretOrConfidential &&
      (config.type === 'feature_flag' || config.type === 'config')
    if (semantic) {
      return {
        op: config.type === 'feature_flag' ? 'set_flag' : 'set_config',
        key,
        environment: envName ?? 'default',
        value: configValue.value,
        ...(replaceTargeting ? {replaceTargeting: true} : {}),
        expectedCommitSha: proposeContext.token,
      }
    }

    return {
      op: 'set_document',
      type: proposeContext.docType,
      key,
      document: applyUpdateFields(currentConfig, updateFields),
      expectedCommitSha: proposeContext.token,
    }
  }

  /** Why a secret write cannot take these flags, or undefined. */
  private secretFlagRefusal(
    flags: {confidential?: boolean; 'env-var'?: string},
    proposeOptions: ProposeOptions | undefined,
    secret: Secret,
  ): string | undefined {
    if (flags['env-var']) return 'secrets hold an encrypted value; --env-var does not apply to a secret'
    if (flags.confidential === false) return 'secrets are always confidential; --no-confidential does not apply'
    if (proposeOptions) return PROPOSE_SECRET_ERROR
    if (secret.keyNameGiven) return SECRET_KEY_NAME_ERROR
    return undefined
  }

  /**
   * `qfg set-default` on a secret (plan 3.1): the scope's fallback (or the
   * whole scope, with --replace-targeting) gets a value encrypted to the
   * keyset of the value it replaces, unless --keyset names another; written
   * to secrets/<key>.json in one commit locked to a fresh snapshot. Confirmed
   * like any set-default (the prompt names keyset, key fingerprint and any
   * keyset move) unless --confirm; never prompts non-interactively.
   *
   * `mode`: `explicit` (--secret, or the server lists the key as a secret);
   * `unlisted` (the server does not list the key: only a secrets/ file makes
   * it one); `old-format` (the server's copy holds decryptWith values: only a
   * secrets/ twin can be written).
   */
  private async setSecret({
    flags,
    key,
    mode,
    proposeOptions,
    invalidUtf8,
    secret,
    value: givenValue,
  }: {
    flags: {
      confidential?: boolean
      confirm?: boolean
      'env-var'?: string
      environment?: string
      interactive?: boolean
      profile?: string
      'replace-targeting': boolean
      value?: string
      workspace?: string
    }
    key: string
    /** --value-stdin read bytes that are not UTF-8 (refused for a secret, S3). */
    invalidUtf8: boolean
    mode: 'explicit' | 'old-format' | 'unlisted'
    proposeOptions: ProposeOptions | undefined
    secret: Secret
    value: string | undefined
  }): Promise<JsonObj | void> {
    const fallbackText = mode === 'unlisted' ? `Could not find config named ${key}` : oldFormatRefusal(key)
    const refusal = this.secretFlagRefusal(flags, proposeOptions, secret)
    if (mode === 'explicit' && refusal) return this.err(refusal, {key})

    let target: Awaited<ReturnType<typeof openCommandSnapshot>>
    try {
      target = await openCommandSnapshot(this, flags.workspace ?? flags.profile)
    } catch (error) {
      const why =
        error instanceof SecretCommandError ? error.message : redactToken(String((error as Error)?.message ?? error))
      if (mode !== 'explicit') {
        this.verboseLog('secrets', `workspace snapshot failed: ${why}`)
        // N3: say the secrets/ lookup could not run (no token, URL or detail).
        const unchecked =
          mode === 'unlisted' ? ' (secrets/ could not be checked: qfg could not read the workspace repo)' : ''
        return this.err(`${fallbackText}${unchecked}`, {key})
      }

      return this.err(`Failed to change default: could not read the workspace to write the secret: ${why}`, {key})
    }

    try {
      if (mode !== 'explicit' && target.snapshot.readFile(secretPath(key)) === undefined) {
        return this.err(fallbackText, {key})
      }

      if (refusal) return this.err(refusal, {key})
      if (invalidUtf8) return this.err(INVALID_UTF8_INPUT, {key})
      return await this.writeSecretScope({flags, givenValue, key, secret, target})
    } catch (error) {
      const known = knownSecretFailure(error)
      if (known === undefined) throw error
      return this.err(`Failed to change default: ${known}`, {key})
    } finally {
      await cleanupQuietly(this, target.snapshot)
    }
  }

  private async submitChange({
    confidential,
    config,
    currentConfig,
    envName,
    envVar,
    environment,
    key,
    proposeContext,
    replaceTargeting,
    scope,
    secret,
    targetingRuleCount,
    value,
  }: {
    confidential: boolean
    config: {type: string; valueType: string; version: string}
    currentConfig: StoredDocument
    envName: string | undefined
    environment: {id: string; name: string}
    key: string
    proposeContext?: ProposeContext
    replaceTargeting: boolean
    scope: {rules: Rule[]; seeded: boolean}
    secret: Secret
    targetingRuleCount: number
  } & ValueOrEnvVar) {
    const typeMapping: Record<string, string> = {
      bool: 'bool',
      string: 'string',
      int: 'int',
      double: 'double',
      string_list: 'stringList',
      json: 'json',
      limit_definition: 'limitDefinition',
      duration: 'duration',
      int_range: 'intRange',
    }

    const type = typeMapping[config.valueType.toLowerCase()] || config.valueType

    let configValue: Record<string, unknown>
    // How the new value is named in the prompt and the report — `\`true\``, or
    // "be provided by `MY_ENV_VAR`" — plus any (encrypted)/(confidential) note.
    let valuePhrase: string
    let modifiers = ''
    // Set whenever the value must not be printed (secret or confidential), qfg-38lp.
    let redacted: RedactedSummary | undefined
    // How the value may appear in an error message.
    let shownValue: string | undefined = value

    if (envVar === undefined) {
      valuePhrase = `\`${value}\``

      if (confidential && !secret.selected) {
        redacted = redactedSummary({plaintext: value})
        valuePhrase = redactedDisplay(redacted)
        shownValue = valuePhrase
      }

      // A secret never reaches this point (setSecret writes secrets/); the
      // old encrypted (decryptWith) write path is gone (qfg-mol-hle).
      {
        // Parse the value based on type and build value object
        let variantValue: unknown = value
        let variantType: string = type

        switch (type) {
          case 'stringList': {
            variantValue = value.split(',')
            variantType = 'string_list'

            break
          }
          case 'bool': {
            const lowerValue = value.toLowerCase()
            if (lowerValue !== 'true' && lowerValue !== 'false') {
              return this.err(`'${shownValue}' is not a valid value for ${key}`)
            }
            variantValue = lowerValue === 'true'

            break
          }
          case 'int': {
            // Shared strict grammar with qfg create (qfg-2agi.23).
            variantValue = parseIntValue(value)
            if (variantValue === undefined) {
              return this.err(`Invalid default value for int: ${shownValue}`)
            }

            break
          }
          case 'double': {
            variantValue = parseDoubleValue(value)
            if (variantValue === undefined) {
              return this.err(`Invalid default value for double: ${shownValue}`)
            }

            break
          }
          case 'json': {
            try {
              variantValue = JSON.parse(value)
            } catch {
              return this.err(`Invalid JSON value: ${shownValue}`)
            }

            break
          }
          case 'string': {
            variantValue = value

            break
          }
          case 'duration': {
            // Stored verbatim as the ISO 8601 string; no conversions (qfg-2agi.3).
            if (!isValidIsoDuration(value)) {
              return this.err(`Invalid value for duration: ${shownValue}. ${DURATION_FORMAT_HINT}`)
            }

            break
          }
          // No default
        }

        configValue = {
          type: variantType,
          value: variantValue,
        }
      }
    } else {
      // ValueSchema discriminates on `type`; provided values are
      // {type: 'provided', value: {source, lookup}}. See qfg-84df.
      configValue = mapConfigValueToDto(
        {provided: {lookup: envVar, source: ProvidedSource.EnvVar}},
        ConfigValueType.String,
      )
      valuePhrase = `be provided by \`${envVar}\``
    }

    if (confidential && !secret.selected) {
      configValue.confidential = true
      // the redacted display already says "confidential"
      if (!redacted) modifiers += ' (confidential)'
    }

    // Surgical by default (qfg-qjdm): the fallback rule's value is replaced
    // in place and every targeting rule around it is kept. --replace-targeting
    // is the explicit opt-in to collapsing the scope to a single unconditional
    // rule — the behavior this command used to have without saying so.
    const newRules = replaceTargeting ? [catchAllRule(configValue)] : upsertFallbackRule(scope.rules, configValue)

    // For [Default] (envName undefined), update default.rules.
    // For a specific environment, upsert the environments array.
    const updateFields: Record<string, unknown> = envName
      ? {environments: upsertEnvRules(currentConfig.environments ?? [], envName, newRules)}
      : {default: {rules: newRules}}

    this.verboseLog('Update fields:', JSON.stringify(updateFields, null, 2))

    if (proposeContext) {
      return submitProposal(this, {
        changes: [
          this.proposalChange({
            config,
            configValue,
            currentConfig,
            envName,
            envVar,
            key,
            proposeContext,
            replaceTargeting,
            secretOrConfidential: secret.selected || confidential,
            updateFields,
          }),
        ],
        key,
        options: proposeContext.options,
      })
    }

    // Route to the correct update endpoint based on config type.
    let request: Awaited<ReturnType<typeof this.apiClient.post>>

    if (config.type === 'feature_flag') {
      request = await this.apiClient.post('/api/v1/flags/update', {
        workspaceId: this.workspaceId,
        flagKey: key,
        flag: updateFields,
        expectedCommitSha: currentConfig.commitSha,
      })
    } else if (config.type === 'log_level') {
      request = await this.apiClient.post('/api/v1/logLevels/update', {
        workspaceId: this.workspaceId,
        logLevelKey: key,
        logLevel: updateFields,
        expectedCommitSha: currentConfig.commitSha,
      })
    } else {
      request = await this.apiClient.post('/api/v1/configs/update', {
        workspaceId: this.workspaceId,
        configKey: key,
        config: updateFields,
        expectedCommitSha: currentConfig.commitSha,
      })
    }

    if (request.ok) {
      // Always say what happened to the targeting rules — the whole point of
      // qfg-97z9 was that this command changed them silently.
      const scopeLabel = envName ?? 'the default'
      const sentences = replaceTargeting
        ? [
            `Set ${scopeLabel} to ${valuePhrase}${modifiers} for everyone.`,
            replacedTargetingNote(targetingRuleCount, currentConfig.commitSha),
          ]
        : [
            `Set ${scopeLabel} fallback to ${valuePhrase}${modifiers}.`,
            scope.seeded && envName ? seededFromDefaultNote(envName) : '',
            keptTargetingNote(targetingRuleCount),
          ]

      this.log(`${checkmark} ${sentences.filter(Boolean).join(' ')}`)

      const counts: JsonObj = replaceTargeting
        ? {
            previousCommitSha: currentConfig.commitSha,
            ...(targetingRuleCount > 0 ? {replacedTargetingRuleCount: targetingRuleCount} : {}),
          }
        : targetingRuleCount > 0
          ? {keptTargetingRuleCount: targetingRuleCount}
          : {}

      return {
        environment: {
          id: environment.id,
          name: environment.name,
        },
        key,
        success: true,
        // qfg-38lp: a secret/confidential value is reported redacted, never verbatim.
        value: redacted ?? value,
        ...counts,
      }
    }

    this.verboseLog(request.error)

    const errMsg =
      request.status === 400
        ? `Failed to change default: ${request.status} -- is ${shownValue || envVar} a valid value?`
        : request.status === 403 && request.serverMessage
          ? `Failed to change default: ${request.status}: ${request.serverMessage}`
          : `Failed to change default: ${request.status}`

    // qfg-5bjew.37 (rule 2.11): a refused write can be proposed instead.
    if (request.status === 403) {
      return failWithProposeHint(
        this,
        errMsg,
        {key, serverError: request.error},
        {
          maskValue: secret.selected || confidential,
        },
      )
    }

    return this.err(errMsg, {key, serverError: request.error})
  }

  private async writeSecretScope({
    flags,
    givenValue,
    key,
    secret,
    target,
  }: {
    flags: {
      confirm?: boolean
      environment?: string
      interactive?: boolean
      'replace-targeting': boolean
      value?: string
    }
    givenValue: string | undefined
    key: string
    secret: Secret
    target: Awaited<ReturnType<typeof openCommandSnapshot>>
  }): Promise<JsonObj | void> {
    // Refuse what does not depend on the environment or the value before prompting for either (N7).
    await checkSecretUpdatable({flagKeyset: secret.keyset, key, snapshot: target.snapshot})
    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to change the default for?',
      providedEnvironment: flags.environment,
    })
    if (!environment) return
    const envName = environment.id === '' ? undefined : environment.name

    if (flags.value !== undefined) notice(VALUE_ARGV_WARNING)
    let plaintext = givenValue
    if (plaintext === undefined && isInteractive(flags)) {
      plaintext = await getString({allowBlank: true, mask: true, message: 'Secret value (input is masked)'})
    }

    if (plaintext === undefined) return this.err('Value is required', {key})

    const replaceTargeting = flags['replace-targeting']
    const plan = await planSecretUpdate({
      env: process.env,
      envName,
      flagKeyset: secret.keyset,
      interactive: isInteractive(flags),
      key,
      plaintext,
      prompt: (options) => getKeyset(options),
      replaceTargeting,
      snapshot: target.snapshot,
    })
    // A --replace-targeting write into a scope seeded from default deletes
    // nothing of its own (the default rules stay), as for a config.
    const replaced = plan.seeded ? 0 : plan.replacedTargeting
    if (plan.movedNotice) notice(plan.movedNotice)

    const phrase = encryptedPhrase(plan)
    const question = replaceTargeting
      ? `Confirm: set ${key} in ${environment.name} to ${phrase} for EVERYONE${replaced > 0 ? `, deleting ${plural(replaced)}` : ''}?`
      : `Confirm: set the fallback for ${key} in ${environment.name} to ${phrase}?${plan.keptTargeting > 0 ? ` (${plural(plan.keptTargeting)} kept)` : ''}`
    const message = plan.movedNotice ? `${question} ${plan.movedNotice}` : question
    if (!(await getConfirmation({flags, message}))) return

    const commitSha = await pushPlan(plan, target)
    await mirrorSecretToDisk(this, key, (plan.files[0] as {afterJson: string}).afterJson, 'Update')
    const scopeLabel = envName ?? 'the default'
    const sentences = replaceTargeting
      ? [`Set ${scopeLabel} to ${phrase} for everyone.`, replacedTargetingNote(replaced, target.snapshot.headSha)]
      : [
          `Set ${scopeLabel} fallback to ${phrase}.`,
          plan.seeded && envName ? seededFromDefaultNote(envName) : '',
          keptTargetingNote(plan.keptTargeting),
        ]
    this.log(`${checkmark} ${sentences.filter(Boolean).join(' ')}`)
    if (plan.twin) notice(twinNotice(plan.twin))
    const readability = readabilityNote(plan.choice, process.env)
    if (readability) notice(readability)

    const counts: JsonObj = replaceTargeting
      ? {previousCommitSha: target.snapshot.headSha, ...(replaced > 0 ? {replacedTargetingRuleCount: replaced} : {})}
      : plan.keptTargeting > 0
        ? {keptTargetingRuleCount: plan.keptTargeting}
        : {}
    return {
      commitSha,
      environment: {id: environment.id, name: environment.name},
      key,
      keysetSource: plan.choice.source,
      ...(plan.choice.movedFrom ? {movedFrom: plan.choice.movedFrom} : {}),
      path: plan.path,
      scope: plan.scope,
      success: true,
      value: jsonValue(plan),
      ...counts,
    }
  }
}
