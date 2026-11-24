/**
 * Which keyset a secret write encrypts to (plan 3.2; spec 7 writer rules;
 * decision 34). Pure apart from the injected prompt. Bead qfg-mol-hle.
 *
 * Order:
 *   1. no keysets in quonfig.json: error (never encrypt anywhere else);
 *   2. `--keyset`: must be a valid name, declared, and writable; reports a move
 *      when it differs from the inherited keyset;
 *   3. inherited (an update): used without a prompt; must still be declared;
 *   4. exactly one keyset declared: used;
 *   5. interactive with a prompt: the operator picks;
 *   6. otherwise: error listing the names. Never a guess.
 * "Exactly one" counts quonfig.json keysets, not the machine's env
 * (decision 34): a writer needs no private key.
 */
import {KEYSET_NAME_RE} from './qf1.js'
import {type WorkspaceKeyset, localKeysetStatus} from './workspace-keysets.js'

export type KeysetSource = 'flag' | 'inherited' | 'only' | 'prompt'

export type KeysetChoice = {
  /** Fingerprint of the write key. */
  fingerprint: string
  keyset: string
  /** Set when `--keyset` replaces the keyset the replaced value was on. */
  movedFrom?: string
  /** The write key as a `qf1-pub-` entry: what `encrypt` takes as `recipient`. */
  recipient: string
  source: KeysetSource
}

export type KeysetPromptOption = {
  /** What this machine holds for the keyset, for the operator; never key material. */
  annotation: string
  name: string
  writeFingerprint: string
}

export type ChooseKeysetInput = {
  /** For the prompt's annotations only. Read for declared keyset names, nothing else. */
  env?: Readonly<Record<string, string | undefined>>
  flagKeyset?: string
  /** The keyset of the value the write replaces (secret-doc `inheritedKeyset`). */
  inherited?: string
  interactive: boolean
  keysets: readonly WorkspaceKeyset[]
  /** Shows the options and returns the chosen keyset name. */
  prompt?: (options: KeysetPromptOption[]) => Promise<string>
}

export type KeysetChoiceErrorCode =
  'ambiguous' | 'invalid_keyset_name' | 'no_keysets' | 'stale_inherited' | 'unknown_keyset' | 'unwritable_keyset'

export class KeysetChoiceError extends Error {
  readonly code: KeysetChoiceErrorCode

  constructor(code: KeysetChoiceErrorCode, message: string) {
    super(message)
    this.name = 'KeysetChoiceError'
    this.code = code
  }
}

const NO_KEYSETS =
  'This workspace has no keysets. An admin adds one to quonfig.json ' +
  '(secrets.keysets.<QUONFIG_KEYSET_NAME>.publicKeys) or with `qfg secret create-keyset` (coming).'

/** JSON-quote a name that failed spec 2, so control characters cannot reach a terminal raw. */
const quoted = (name: string) => JSON.stringify(name)

function writable(
  keysets: readonly WorkspaceKeyset[],
  name: string,
): {fingerprint: string; keyset: string; recipient: string} {
  if (!KEYSET_NAME_RE.test(name)) {
    throw new KeysetChoiceError(
      'invalid_keyset_name',
      `keyset name ${quoted(name)} does not match ${KEYSET_NAME_RE.source}`,
    )
  }

  const keyset = keysets.find((k) => k.name === name)
  if (!keyset) {
    throw new KeysetChoiceError(
      'unknown_keyset',
      `${name} is not a keyset in this workspace; declared: ${keysets.map((k) => k.name).join(', ')}`,
    )
  }

  if (!keyset.writeKey.ok) {
    throw new KeysetChoiceError('unwritable_keyset', `cannot write to ${name}: ${keyset.writeKey.problem}`)
  }

  return {fingerprint: keyset.writeKey.fingerprint, keyset: name, recipient: keyset.writeKey.entry}
}

function annotation(keyset: WorkspaceKeyset, env: Readonly<Record<string, string | undefined>>): string {
  if (!keyset.writeKey.ok) return `cannot be written: ${keyset.writeKey.problem}`
  const local = localKeysetStatus(keyset.name, keyset.writeKey.fingerprint, env)
  switch (local.status) {
    case 'reads-write-key':
      return 'this machine can also read it'
    case 'holds-other-keys':
      return `this machine has ${keyset.name} but not key ${keyset.writeKey.fingerprint}`
    case 'invalid':
      return `${keyset.name} here is unreadable${local.entry === undefined ? '' : ` (entry ${local.entry})`}`
    default:
      return 'not on this machine'
  }
}

export async function chooseKeyset(input: ChooseKeysetInput): Promise<KeysetChoice> {
  const {flagKeyset, inherited, interactive, keysets, prompt} = input
  if (keysets.length === 0) throw new KeysetChoiceError('no_keysets', NO_KEYSETS)

  if (flagKeyset !== undefined) {
    const chosen = writable(keysets, flagKeyset)
    return inherited !== undefined && inherited !== chosen.keyset
      ? {...chosen, movedFrom: inherited, source: 'flag'}
      : {...chosen, source: 'flag'}
  }

  if (inherited !== undefined) {
    if (!keysets.some((k) => k.name === inherited)) {
      throw new KeysetChoiceError(
        'stale_inherited',
        `the current value is on ${KEYSET_NAME_RE.test(inherited) ? inherited : quoted(inherited)}, which quonfig.json no longer declares; pass --keyset`,
      )
    }

    return {...writable(keysets, inherited), source: 'inherited'}
  }

  if (keysets.length === 1) return {...writable(keysets, keysets[0].name), source: 'only'}

  if (interactive && prompt) {
    const env = input.env ?? {}
    const options = keysets.map((k) => ({
      annotation: annotation(k, env),
      name: k.name,
      writeFingerprint: k.writeKey.ok ? k.writeKey.fingerprint : '',
    }))
    return {...writable(keysets, await prompt(options)), source: 'prompt'}
  }

  throw new KeysetChoiceError('ambiguous', `Choose a keyset with --keyset: ${keysets.map((k) => k.name).join(', ')}`)
}

/** The stderr / confirm-prompt notice when `--keyset` moves a value to another keyset (plan 3.2 rule 2). */
export function movedKeysetNotice(key: string, scope: string, from: string, to: string): string {
  return `Moving ${key} (${scope}) from ${from} to ${to}: runtimes that hold only ${from} will fail to read it.`
}
