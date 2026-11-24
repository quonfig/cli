/**
 * qf1: the CLI's secret value format, PUBLIC API (bead qfg-mol-hle). This is
 * the only qf1 module commands may import. Normative spec:
 * project/plans/secrets-qf1-spec.md (APPROVED 2026-11-24, Gate A).
 *
 *   qf1:<KEYSET>:<FINGERPRINT>:<base64url(E || C || T)>
 *
 * Nothing here can produce a deterministic ciphertext or key: `encrypt` draws a
 * fresh ephemeral key from node:crypto for every value and `mintKeypair`
 * draws from node:crypto only. The deterministic seams and the raw KDF/X25519
 * primitives the known-answer tests need live in ./qf1-internal.ts, which this
 * module does not re-export.
 */
import {randomBytes} from 'node:crypto'

import {
  type Keypair,
  Qf1Error,
  checkWriterKeysetName,
  decodePublicKeyEntryForWriter,
  mintKeypairWith,
  parseKeysetEnv,
  sealWithEphemeralKey,
} from './qf1-internal.js'

export {
  type EnvLookup,
  FINGERPRINT_RE,
  type HeldKey,
  KEYSET_NAME_RE,
  type Keypair,
  PRIVATE_KEY_PREFIX,
  PUBLIC_KEY_PREFIX,
  Qf1Error,
  type Qf1ErrorCode,
  type Qf1ErrorFields,
  type Qf1Parsed,
  decrypt,
  fingerprint,
  formatPrivateKeyEntry,
  formatPublicKeyEntry,
  isQf1String,
  parseKeysetEnv,
  parsePrivateKeyEntry,
  parsePublicKeyEntry,
  parseQf1,
  publicKeyFromPrivate,
} from './qf1-internal.js'

export type EncryptInput = {
  /** Keyset name (spec 2), for example QUONFIG_KEYSET_PROD. */
  keyset: string
  plaintext: string
  /**
   * The recipient as a `qf1-pub-` public key ENTRY, normally
   * `quonfig.json` `secrets.keysets.<keyset>.publicKeys[0]`. Taking the entry
   * (not raw bytes) means a private key cannot be passed by mistake.
   */
  recipient: string
}

/**
 * Encrypt a plaintext string to one public key of a keyset (spec 7). Needs no
 * private key. A fresh 32-byte ephemeral key is drawn for every call.
 * Throws Qf1Error: invalid_keyset_name, invalid_public_key, invalid_plaintext.
 */
export function encrypt(input: EncryptInput): string {
  if (typeof input !== 'object' || input === null) {
    // spec 7 step 1 starts with the keyset name, and there is none. The argument is never echoed.
    throw new Qf1Error('invalid_keyset_name', 'encrypt needs {keyset, plaintext, recipient}; no keyset name was given')
  }

  const {keyset, plaintext, recipient} = input
  checkWriterKeysetName(keyset) // spec 7 step 1 starts with the name, before the recipient is read
  const publicKey = decodePublicKeyEntryForWriter(recipient)
  return sealWithEphemeralKey({keyset, plaintext, publicKey}, new Uint8Array(randomBytes(32)))
}

/**
 * A new random keypair for a keyset whose current fingerprints are
 * `existingFingerprints`: redrawn on a fingerprint collision (decision 42).
 */
export function mintKeypair(existingFingerprints: ReadonlySet<string>): Keypair {
  return mintKeypairWith(existingFingerprints, (size) => randomBytes(size))
}

/**
 * The fingerprints a keyset env var value holds, sorted (spec 6.2). For
 * callers that need only which keys are present (status displays): no key
 * material leaves this function. Throws Qf1Error keyset_missing / keyset_invalid.
 */
export function keysetFingerprints(keyset: string, value: string | undefined): string[] {
  return [...parseKeysetEnv(keyset, value).keys()].sort()
}
