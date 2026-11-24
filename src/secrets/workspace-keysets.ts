/**
 * A workspace's keysets, read from its `quonfig.json` (spec 10.1), and what
 * this machine holds for each (bead qfg-mol-hle).
 *
 * Writing a secret needs only the keyset's FIRST public key, `publicKeys[0]`
 * (spec 7, 10.1). No private key is read, needed or held anywhere here:
 * `localKeysetStatus` reports fingerprints only, for the "this machine can
 * also read it" annotation.
 */
import {type ValidationIssue} from '../verify/validate.js'
import {readSecretsManifest} from '../verify/secrets.js'
import {KEYSET_NAME_RE, Qf1Error, keysetFingerprints, parsePublicKeyEntry, fingerprint} from './qf1.js'

/** The key a write encrypts to, or why this keyset cannot be written to. */
export type WriteKey = {entry: string; fingerprint: string; ok: true} | {ok: false; problem: string}

export type WorkspaceKeyset = {
  /** Fingerprints of every valid public key of the keyset, in file order. */
  fingerprints: string[]
  name: string
  /** `publicKeys[0]`, the write key (spec 10.1). */
  writeKey: WriteKey
}

export type WorkspaceKeysets = {
  /** Keysets with a valid name, in `quonfig.json` order. */
  keysets: WorkspaceKeyset[]
  /** Everything the push hook would report about `secrets` in this `quonfig.json`. */
  problems: string[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Read `secrets.keysets` from the text of a workspace's `quonfig.json`
 * (`undefined` when the file is missing). A keyset whose `publicKeys[0]` is
 * invalid is still listed, as unwritable, so a writer can name it and the
 * reason; a keyset with an invalid name is left out (spec 2: its name may
 * never be used) and reported in `problems`.
 */
export function readWorkspaceKeysets(quonfigJsonText?: string): WorkspaceKeysets {
  if (quonfigJsonText === undefined) return {keysets: [], problems: ['quonfig.json is missing']}

  // The push hook's own manifest check, so `problems` says what it would say.
  const issues: ValidationIssue[] = []
  const read = readSecretsManifest(quonfigJsonText, issues)
  if (read.keysets === null) return {keysets: [], problems: [`quonfig.json ${read.problem}`]}
  const problems = issues.map((i) => `${i.file}: ${i.message}`)

  const manifest = JSON.parse(quonfigJsonText) as Record<string, unknown>
  const secrets = manifest.secrets
  const declared = isPlainObject(secrets) && isPlainObject(secrets.keysets) ? secrets.keysets : {}
  const keysets: WorkspaceKeyset[] = []
  for (const [name, keyset] of Object.entries(declared)) {
    if (!KEYSET_NAME_RE.test(name)) continue
    const where = `quonfig.json secrets.keysets.${name}.publicKeys`
    const publicKeys = isPlainObject(keyset) && Array.isArray(keyset.publicKeys) ? keyset.publicKeys : []
    const fingerprints: string[] = []
    let writeKey: WriteKey = {ok: false, problem: `${where} is empty`}
    for (const [index, entry] of publicKeys.entries()) {
      let parsed: {entry: string; fingerprint: string} | {problem: string}
      try {
        parsed = {entry: entry as string, fingerprint: fingerprint(parsePublicKeyEntry(entry as string))}
      } catch (error) {
        // A public key entry is public; the message names only the place and the reason.
        const reason = error instanceof Qf1Error ? error.message.replace(/^qf1 invalid_key_entry: /, '') : 'is invalid'
        parsed = {problem: `${where}[${index}]: ${reason}`}
      }

      if ('fingerprint' in parsed && !fingerprints.includes(parsed.fingerprint)) fingerprints.push(parsed.fingerprint)
      if (index === 0) writeKey = 'fingerprint' in parsed ? {...parsed, ok: true} : {ok: false, problem: parsed.problem}
    }

    keysets.push({fingerprints, name, writeKey})
  }

  return {keysets, problems}
}

export type LocalKeysetStatus =
  | {entry?: number; status: 'invalid'}
  | {held: string[]; status: 'holds-other-keys' | 'reads-write-key'}
  | {status: 'absent'}

/**
 * What this machine holds for keyset `name`, given its write key's
 * fingerprint. Reads ONLY `env[name]`, and only when `name` is a valid keyset
 * name (spec 2). Returns fingerprints and an entry position, never any of the
 * variable's content.
 */
export function localKeysetStatus(
  name: string,
  writeFingerprint: string,
  env: Readonly<Record<string, string | undefined>>,
): LocalKeysetStatus {
  if (!KEYSET_NAME_RE.test(name)) return {status: 'absent'}
  const raw = Object.hasOwn(env, name) ? env[name] : undefined
  let held: string[]
  try {
    held = keysetFingerprints(name, raw)
  } catch (error) {
    if (!(error instanceof Qf1Error)) throw error
    if (error.code === 'keyset_missing') return {status: 'absent'}
    // keyset_invalid: a bad entry (by position) or two keys with one fingerprint (no position).
    return error.entry === undefined ? {status: 'invalid'} : {entry: error.entry, status: 'invalid'}
  }

  return {held, status: held.includes(writeFingerprint) ? 'reads-write-key' : 'holds-other-keys'}
}
