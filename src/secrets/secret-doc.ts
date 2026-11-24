/**
 * `secrets/<key>.json` documents (spec 10.2) for the CLI's writers. Bead
 * qfg-mol-hle.
 *
 * A secret is shaped like a config, with the storage restrictions of
 * decision 24: every rule value is `{type: "string", value: "qf1:...",
 * confidential: true}`; no `weighted_values`, no `provided`, no `variants`,
 * `sendToClientSdk` false or absent, never `decryptWith`.
 * `assertWritableSecretDocument` enforces those shape rules, and
 * `serializeSecretDocument` (the only way this module turns a document into
 * text) runs it. That is a shape guard, not the whole hook: what depends on
 * the rest of the workspace (the value's keyset and fingerprint declared in
 * quonfig.json, environment ids, pooled keys) is checked by
 * `pushWorkspaceFiles`' preflight, which runs the push hook's validator
 * (src/verify) before anything is sent. The guard is never looser than the
 * hook; it matches it member for member (`environments` may be absent, as
 * the hook allows; documents built here always have it).
 *
 * Rule edits reuse the shared rulebook in src/util/rules.ts, so a secret's
 * scope is edited exactly as `qfg set-default` edits a config's.
 */
import {type ValidationIssue, validateKey} from '../verify/validate.js'
import {
  type EnvRules,
  type Rule,
  catchAllRule,
  countTargetingRules,
  isCatchAllRule,
  seedScopeRules,
  upsertEnvRules,
  upsertFallbackRule,
} from '../util/rules.js'
import {Qf1Error, isQf1String, parseQf1} from './qf1.js'

export const SECRETS_DIR = 'secrets'
export const STORED_CONFIG_SCHEMA_URL = 'https://api.quonfig.com/schemas/v1/stored-config.json'

export type SecretValue = {confidential: true; type: 'string'; value: string}

export type SecretDocument = {
  $schema?: string
  access?: string
  default: {rules: Rule[]}
  environments: EnvRules[]
  key: string
  sendToClientSdk?: false
  tags?: unknown[]
  type: 'secret'
  valueType: 'string'
  variants?: []
  [member: string]: unknown
}

export class SecretDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretDocumentError'
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Refuse a key the push hook would refuse (Policy A, filesystem safety); the reasons are verify's. */
function checkKey(key: string): void {
  const issues: ValidationIssue[] = []
  if (typeof key === 'string') validateKey(key, 'key', issues)
  else issues.push({file: 'key', message: 'Key is not a string', severity: 'error'})
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    throw new SecretDocumentError(
      `cannot write secret key ${JSON.stringify(key)}: ${errors.map((i) => i.message).join('; ')}`,
    )
  }
}

/** `secrets/<key>.json`, for a key the push hook accepts. */
export function secretPath(key: string): string {
  checkKey(key)
  return `${SECRETS_DIR}/${key}.json`
}

/**
 * A new secret with no rules, in the member order of spec 10.2. `access` is
 * the tier the caller resolved for the workspace (default "standard").
 */
export function newSecretDocument(key: string, options: {access?: string} = {}): SecretDocument {
  checkKey(key)
  return {
    $schema: STORED_CONFIG_SCHEMA_URL,
    key,
    type: 'secret',
    valueType: 'string',
    sendToClientSdk: false,
    access: options.access ?? 'standard',
    tags: [],
    default: {rules: []},
    environments: [],
    variants: [],
  }
}

/** The stored form of one encrypted value. Accepts only a well-formed qf1 string (as `encrypt` returns). */
export function secretValue(qf1: string): SecretValue {
  try {
    if (!isQf1String(qf1)) throw new SecretDocumentError('')
    parseQf1(qf1)
  } catch (error) {
    if (!(error instanceof SecretDocumentError || error instanceof Qf1Error)) throw error
    // Never echo the input: a caller could have passed plaintext by mistake.
    const why = error instanceof Qf1Error ? ` (qf1 ${error.code})` : ''
    throw new SecretDocumentError(`a secret value must be a qf1 string from encrypt${why}`)
  }

  return {type: 'string', value: qf1, confidential: true}
}

export type ScopeWrite = {
  /** Environment id; undefined for the `default` block. */
  envName?: string
  /**
   * The workspace's environment ids (quonfig.json `environments`). When
   * given, an `envName` outside it is refused.
   */
  environments?: readonly string[]
  /** Collapse the scope to one unconditional rule (set-default --replace-targeting). */
  replaceTargeting?: boolean
  value: SecretValue
}

export type ScopeWriteResult = {
  document: SecretDocument
  /** Targeting rules left in place (surgical write). */
  keptTargeting: number
  /** Targeting rules removed by `replaceTargeting`. */
  replacedTargeting: number
  /** True when an environment without rules of its own started from a copy of default. */
  seeded: boolean
}

/**
 * Set one scope's fallback to `value`, exactly as `qfg set-default` does for a
 * config: surgical by default (targeting rules kept), `replaceTargeting`
 * collapses the scope, and an environment with no block starts from a copy
 * of `default.rules`. Never mutates `doc`.
 */
export function setSecretScopeValue(doc: SecretDocument, write: ScopeWrite): ScopeWriteResult {
  if (write.envName !== undefined) {
    if (typeof write.envName !== 'string' || write.envName.length === 0 || write.envName === 'default') {
      throw new SecretDocumentError(
        `${JSON.stringify(write.envName)} is not an environment name; leave envName unset to write the default rules`,
      )
    }

    if (write.environments && !write.environments.includes(write.envName)) {
      throw new SecretDocumentError(
        `${JSON.stringify(write.envName)} is not an environment of this workspace (${write.environments.join(', ')})`,
      )
    }
  }

  const value = secretValue(write.value?.value) // re-checked: only a qf1 value object can be stored
  const next = structuredClone(doc)
  const {rules, seeded} = seedScopeRules(next, write.envName)
  const targeting = countTargetingRules(rules)
  const newRules = write.replaceTargeting ? [catchAllRule(value)] : upsertFallbackRule(rules, value)
  if (write.envName) next.environments = upsertEnvRules(next.environments ?? [], write.envName, newRules)
  else next.default = {...next.default, rules: newRules}
  return {
    document: next,
    keptTargeting: write.replaceTargeting ? 0 : targeting,
    replacedTargeting: write.replaceTargeting ? targeting : 0,
    seeded,
  }
}

export type SecretValueEntry = {
  fingerprint: string
  keyset: string
  ruleIndex: number
  /** `default` or the environment id. */
  scope: string
  value: string
}

function scopes(doc: Pick<SecretDocument, 'default' | 'environments'>): Array<{rules: Rule[]; scope: string}> {
  return [
    {rules: doc.default?.rules ?? [], scope: 'default'},
    ...(doc.environments ?? []).map((e) => ({rules: e.rules ?? [], scope: e.id})),
  ]
}

const qf1Of = (value: unknown): undefined | {fingerprint: string; keyset: string; value: string} => {
  const v = isPlainObject(value) ? value.value : undefined
  if (!isQf1String(v)) return undefined
  try {
    const {fingerprint, keyset} = parseQf1(v)
    return {fingerprint, keyset, value: v}
  } catch {
    return undefined
  }
}

/** Every well-formed qf1 rule value of a document, with where it sits. */
export function secretValuesOf(doc: Pick<SecretDocument, 'default' | 'environments'>): SecretValueEntry[] {
  const out: SecretValueEntry[] = []
  for (const {rules, scope} of scopes(doc)) {
    for (const [ruleIndex, rule] of rules.entries()) {
      const parsed = qf1Of(rule?.value)
      if (parsed) out.push({...parsed, ruleIndex, scope})
    }
  }

  return out
}

/**
 * The keyset of the value a write to `envName` (undefined = default) would
 * replace (plan 3.2 rule 3): the scope's catch-all fallback value; for an
 * environment with no rules of its own, default's fallback (the scope is
 * seeded from default). When that position holds no qf1 value, the single
 * keyset every qf1 value in the document uses, else nothing.
 */
export function inheritedKeyset(
  doc: Pick<SecretDocument, 'default' | 'environments'>,
  envName?: string,
): string | undefined {
  const {rules} = seedScopeRules(doc, envName)
  const fallback = rules.find((rule) => isCatchAllRule(rule))
  const atPosition = fallback ? qf1Of(fallback.value) : undefined
  if (atPosition) return atPosition.keyset
  const used = new Set(secretValuesOf(doc).map((v) => v.keyset))
  return used.size === 1 ? [...used][0] : undefined
}

function refuse(why: string): never {
  throw new SecretDocumentError(`refusing to write a secret document: ${why}`)
}

/**
 * Throws SecretDocumentError unless `doc` is a secret the push hook accepts
 * on shape (spec 10.2, decision 24). Messages name the member and the rule,
 * never a value.
 */
export function assertWritableSecretDocument(doc: unknown): asserts doc is SecretDocument {
  if (!isPlainObject(doc)) return refuse('it is not a JSON object')
  if (doc.type !== 'secret') refuse(`it must have type "secret", got ${JSON.stringify(doc.type)}`)
  if (doc.valueType !== 'string') refuse(`it must have valueType "string", got ${JSON.stringify(doc.valueType)}`)
  checkKey(doc.key as string)
  if (Object.hasOwn(doc, 'sendToClientSdk') && doc.sendToClientSdk !== false) {
    refuse('sendToClientSdk must be false or absent; secrets are never sent to client SDKs')
  }

  if (Object.hasOwn(doc, 'variants') && !(Array.isArray(doc.variants) && doc.variants.length === 0)) {
    refuse('variants must be empty or absent')
  }

  if (!isPlainObject(doc.default) || !Array.isArray(doc.default.rules)) refuse('default.rules must be an array')
  if (Object.hasOwn(doc, 'environments') && !Array.isArray(doc.environments)) refuse('environments must be an array')
  for (const env of (doc.environments ?? []) as unknown[]) {
    if (!isPlainObject(env) || typeof env.id !== 'string' || !Array.isArray(env.rules ?? [])) {
      refuse('every environment needs a string id and a rules array')
    }
  }

  for (const {rules, scope} of scopes(doc as SecretDocument)) {
    for (const [i, rule] of rules.entries()) {
      const where = `${scope} rule ${i}`
      const v = isPlainObject(rule) ? rule.value : undefined
      if (!isPlainObject(v)) refuse(`${where} has no value object`)
      const value = v as Record<string, unknown>
      if (value.type === 'weighted_values') refuse(`${where}: weighted_values are not allowed in a secret`)
      if (value.type === 'provided') refuse(`${where}: provided values are not allowed in a secret`)
      if (value.type !== 'string') refuse(`${where}: a secret value must have type "string"`)
      if (Object.hasOwn(value, 'decryptWith')) refuse(`${where}: decryptWith must not appear on a secret value`)
      if (value.confidential !== true) refuse(`${where}: a secret value must set confidential: true`)
      const parsed = qf1Of(value)
      if (!parsed) refuse(`${where}: the value is not a qf1 string`)
    }
  }
}

/** The document as the server writes it: `JSON.stringify(doc, null, 2)`, no trailing newline. Refuses forbidden shapes. */
export function serializeSecretDocument(doc: SecretDocument): string {
  assertWritableSecretDocument(doc)
  return JSON.stringify(doc, null, 2)
}

/** Parse `secrets/<key>.json` text read from a snapshot. Refuses anything that is not this key's secret. */
export function parseSecretDocument(text: string, key: string): SecretDocument {
  const file = secretPath(key)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new SecretDocumentError(`${file} is not valid JSON`)
  }

  if (!isPlainObject(doc)) throw new SecretDocumentError(`${file} is not a JSON object`)
  if (doc.type !== 'secret') throw new SecretDocumentError(`${file} has type ${JSON.stringify(doc.type)}, not "secret"`)
  if (doc.key !== key) throw new SecretDocumentError(`${file} holds key ${JSON.stringify(doc.key)}`)
  return doc as SecretDocument
}
