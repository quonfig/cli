/**
 * What `qfg create --secret` and `qfg set-default` (on a secret) write: the
 * decisions of plan 3.1 and 3.2 made against a workspace snapshot, with no
 * I/O of their own. The commands do the prompting, the network and the
 * printing. Bead qfg-mol-hle PR 3.
 *
 * The plaintext enters here once, is encrypted to the chosen keyset's write
 * key (`publicKeys[0]`, spec 7) and is used for nothing else but the redacted
 * summary (length and, for 12+ characters, the last four, as every other
 * redacted CLI display shows). No private key is read or needed.
 */
import {type RedactedSummary, redactedSummary} from '../util/redact.js'
import {type KeysetChoice, type KeysetPromptOption, chooseKeyset, movedKeysetNotice} from './choose-keyset.js'
import {encrypt} from './qf1.js'
import {
  inheritedKeyset,
  newSecretDocument,
  parseSecretDocument,
  secretPath,
  secretValue,
  serializeSecretDocument,
  setSecretScopeValue,
} from './secret-doc.js'
import {readWorkspaceKeysets} from './workspace-keysets.js'
import type {WorkspaceSnapshot} from './workspace-snapshot.js'
import {type SecretCommitMessage, type WorkspaceFileChange, secretCommitMessage} from './write-secret.js'

export type SecretRefusalCode = 'exists' | 'is_config' | 'not_found' | 'old_format' | 'other_family'

/** A write the commands refuse, with the exact text to show. Never carries a value. */
export class SecretRefusal extends Error {
  readonly code: SecretRefusalCode

  constructor(code: SecretRefusalCode, message: string) {
    super(message)
    this.name = 'SecretRefusal'
    this.code = code
  }
}

export type SecretWritePlan = {
  choice: KeysetChoice
  files: WorkspaceFileChange[]
  /** True when the workspace had no document in secrets/ before this write (spec 13.4). */
  firstSecret: boolean
  keptTargeting: number
  message: SecretCommitMessage
  /** The stderr / confirm notice when --keyset moves the value to another keyset. */
  movedNotice?: string
  path: string
  /** For display: md5 of the ciphertext, plaintext length and (12+ chars) last four. */
  redacted: RedactedSummary
  replacedTargeting: number
  /** `default` or the environment id. */
  scope: string
  seeded: boolean
  /** `configs/<key>.json` when an old-format copy of the key still exists there (plan Q9). */
  twin?: string
}

type SnapshotView = Pick<WorkspaceSnapshot, 'findKey' | 'hasSecrets' | 'readFile'>

export type PlanInput = {
  env?: Readonly<Record<string, string | undefined>>
  flagKeyset?: string
  interactive: boolean
  key: string
  plaintext: string
  prompt?: (options: KeysetPromptOption[]) => Promise<string>
  snapshot: SnapshotView
}

const FAMILY: Record<string, string> = {
  configs: 'config',
  'feature-flags': 'flag',
  'log-levels': 'log level',
  schemas: 'schema',
  'schemas-protected': 'schema',
  secrets: 'secret',
  segments: 'segment',
}

const familyOf = (dir: string) => FAMILY[dir] ?? dir

/** quonfig.json `environments`, when it is a list of strings. */
function workspaceEnvironments(snapshot: SnapshotView): string[] | undefined {
  try {
    const manifest = JSON.parse(snapshot.readFile('quonfig.json') ?? 'null') as {environments?: unknown}
    const envs = manifest?.environments
    return Array.isArray(envs) && envs.every((e) => typeof e === 'string') ? envs : undefined
  } catch {
    return undefined
  }
}

/** True when any rule value of a stored config document carries `decryptWith` (the old format). */
function hasOldFormatValue(text: string): boolean {
  let doc: {default?: {rules?: Array<{value?: unknown}>}; environments?: Array<{rules?: Array<{value?: unknown}>}>}
  try {
    doc = JSON.parse(text)
  } catch {
    return false
  }

  const rules = [...(doc?.default?.rules ?? []), ...(doc?.environments ?? []).flatMap((e) => e?.rules ?? [])]
  return rules.some((r) => {
    const v = r?.value as {decryptWith?: unknown} | undefined
    return typeof v?.decryptWith === 'string' && v.decryptWith.length > 0
  })
}

async function encryptTo(input: PlanInput, inherited?: string) {
  const keysets = readWorkspaceKeysets(input.snapshot.readFile('quonfig.json')).keysets
  const choice = await chooseKeyset({
    env: input.env,
    flagKeyset: input.flagKeyset,
    inherited,
    interactive: input.interactive,
    keysets,
    prompt: input.prompt,
  })
  const ciphertext = encrypt({keyset: choice.keyset, plaintext: input.plaintext, recipient: choice.recipient})
  return {
    choice,
    redacted: redactedSummary({ciphertext, plaintext: input.plaintext}),
    value: secretValue(ciphertext),
  }
}

/** `qfg create <key> --secret`: a new `secrets/<key>.json` with the value as its default fallback. */
export async function planSecretCreate(input: {access: string} & PlanInput): Promise<SecretWritePlan> {
  const {key, snapshot} = input
  const path = secretPath(key)
  const existing = snapshot.findKey(key)[0]
  if (existing) {
    const named = existing.key === key ? '' : ` named ${existing.key}; keys are case-insensitive`
    throw new SecretRefusal('exists', `${key} already exists (as a ${familyOf(existing.dir)}${named})`)
  }

  const firstSecret = !snapshot.hasSecrets()
  const {choice, redacted, value} = await encryptTo(input)
  const result = setSecretScopeValue(newSecretDocument(key, {access: input.access}), {value})
  return {
    choice,
    files: [{afterJson: serializeSecretDocument(result.document), path}],
    firstSecret,
    keptTargeting: 0,
    message: secretCommitMessage({fingerprint: choice.fingerprint, key, keyset: choice.keyset, verb: 'create'}),
    path,
    redacted,
    replacedTargeting: 0,
    scope: 'default',
    seeded: false,
  }
}

/**
 * `qfg set-default <key>` on a secret: one scope's fallback (or, with
 * `replaceTargeting`, the whole scope) gets the new value. The keyset is
 * inherited from the value being replaced unless `flagKeyset` names another
 * (then `movedNotice` says so). The document's access tier is never changed.
 */
export async function planSecretUpdate(
  input: {envName?: string; replaceTargeting: boolean} & PlanInput,
): Promise<SecretWritePlan> {
  const {envName, key, snapshot} = input
  const path = secretPath(key)
  const configCopy = `configs/${key}.json`
  const text = snapshot.readFile(path)
  if (text === undefined) {
    const config = snapshot.readFile(configCopy)
    if (config !== undefined && hasOldFormatValue(config)) {
      throw new SecretRefusal(
        'old_format',
        `${key} holds old-format encrypted values; move it with \`qfg secret migrate\` (coming) before changing it`,
      )
    }

    if (config !== undefined) {
      throw new SecretRefusal(
        'is_config',
        `${key} is a config; secrets live in secrets/. Create a new key with \`qfg create <new-key> --secret\`.`,
      )
    }

    const other = snapshot.findKey(key)[0]
    if (other?.dir === 'secrets') {
      throw new SecretRefusal('not_found', `Could not find a secret named ${key}; did you mean ${other.key}?`)
    }

    if (other) {
      const named = other.key === key ? '' : ` named ${other.key}`
      throw new SecretRefusal('other_family', `${key} is not a secret: it exists as a ${familyOf(other.dir)}${named}`)
    }

    throw new SecretRefusal('not_found', `Could not find a secret named ${key}`)
  }

  const doc = parseSecretDocument(text, key)
  const scope = envName ?? 'default'
  const {choice, redacted, value} = await encryptTo(input, inheritedKeyset(doc, envName))
  const result = setSecretScopeValue(doc, {
    envName,
    environments: workspaceEnvironments(snapshot),
    replaceTargeting: input.replaceTargeting,
    value,
  })
  return {
    choice,
    files: [{afterJson: serializeSecretDocument(result.document), path}],
    firstSecret: false,
    keptTargeting: result.keptTargeting,
    message: secretCommitMessage({fingerprint: choice.fingerprint, key, keyset: choice.keyset, scope, verb: 'set'}),
    movedNotice: choice.movedFrom ? movedKeysetNotice(key, scope, choice.movedFrom, choice.keyset) : undefined,
    path,
    redacted,
    replacedTargeting: result.replacedTargeting,
    scope,
    seeded: result.seeded,
    twin: snapshot.readFile(configCopy) === undefined ? undefined : configCopy,
  }
}
