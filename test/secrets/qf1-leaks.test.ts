/**
 * Spec 9.2: no qf1 error may carry a private key entry or any part of one, any
 * part of the keyset env var's value, or any part of the plaintext. Checked
 * over EVERY negative vector, key-entry case and writer case, and explicitly
 * on the non-UTF-8 decrypt path (bead qfg-mol-hle PR 1).
 *
 * The "surface" of an error is its message, String(), stack, JSON form,
 * util.inspect with hidden properties, and an explicit walk of every own
 * property (enumerable or not, string or symbol keyed) including the `cause`
 * chain, with byte arrays rendered as bytes. A secret leaks if any 8-character
 * piece of it, in any of its renderings (raw, latin1, hex in both cases,
 * spaced hex, base64, base64url, decimal lists), appears on that surface.
 * Secrets include the derived values spec 9.2 names: S, PRK, OKM, K and N.
 */
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import {inspect} from 'node:util'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {deriveKeyAndNonce, sealWithEphemeralKey, x25519} from '../../src/secrets/qf1-internal.js'
import {
  PRIVATE_KEY_PREFIX,
  PUBLIC_KEY_PREFIX,
  Qf1Error,
  decrypt,
  encrypt,
  formatPrivateKeyEntry,
  formatPublicKeyEntry,
  parseKeysetEnv,
  parsePrivateKeyEntry,
  parsePublicKeyEntry,
  parseQf1,
  publicKeyFromPrivate,
} from '../../src/secrets/qf1.js'

type Env = Record<string, string>
type Vectors = {
  keyEntryCases: Array<{expectedError?: string; input: string; keyset?: string; kind: string; name: string}>
  negative: Array<{ciphertext: string; env: Env; expectedError: string; name: string; note: string}>
  writerCases: Array<{
    ephemeralPrivateKeyHex: string
    expectedError: string
    keyset: string
    name: string
    plaintextUtf16CodeUnits: number[]
    recipientPublicKeyHex: string
  }>
}

const specDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spec')
const generator = (await import(pathToFileURL(path.join(specDir, 'generate-vectors.mjs')).href)) as {
  buildVectorsJson: () => string
}
const reference = (await import(pathToFileURL(path.join(specDir, 'reference.mjs')).href)) as {
  sealRaw: (input: {
    fingerprintField: string
    keysetField: string
    plaintextBytes: Buffer
    recipientPublicKey: Buffer
    sharedSecret: Buffer
    transmittedEphemeralPublicKey: Buffer
  }) => {ciphertext: string}
  x25519: (k: Buffer, u: Buffer) => Buffer
}
const vectors = JSON.parse(generator.buildVectorsJson()) as Vectors

/** The renderings of secret bytes: raw latin1, lossy UTF-8, hex (both cases, plain and spaced), base64, base64url, decimal lists. */
function renderings(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes)
  const decimal = [...b].map(String)
  const hex = b.toString('hex')
  return [
    b.toString('latin1'),
    b.toString('utf8'),
    hex,
    hex.toUpperCase(),
    hex.replaceAll(/(..)(?!$)/g, '$1 '),
    b.toString('base64'),
    b.toString('base64url'),
    decimal.join(','),
    decimal.join(', '),
  ]
}

/** Walk every own property (string and symbol keys, enumerable or not) and the cause chain. */
function walk(value: unknown, out: string[], seen: Set<unknown>): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }

  if (ArrayBuffer.isView(value)) {
    out.push(...renderings(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)))
    return
  }

  if (value instanceof ArrayBuffer) {
    out.push(...renderings(new Uint8Array(value)))
    return
  }

  if (typeof value !== 'object' && typeof value !== 'function') {
    out.push(String(value))
    return
  }

  if (seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    out.push(typeof key === 'symbol' ? String(key.description) : key)
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    let v: unknown = descriptor?.value
    if (descriptor && descriptor.get) {
      try {
        v = descriptor.get.call(value)
      } catch {
        v = undefined
      }
    }

    if (typeof v !== 'function' || key === 'toString') walk(typeof v === 'function' ? safeCall(v, value) : v, out, seen)
  }
}

function safeCall(fn: unknown, self: unknown): unknown {
  try {
    return (fn as (this: unknown) => unknown).call(self)
  } catch {
    return undefined
  }
}

/** Every rendering of the error a user, a log, a debugger or a JSON consumer could see. */
function surfaceOf(err: Qf1Error): string {
  const out: string[] = [err.message, String(err), err.stack ?? '', JSON.stringify(err) ?? '']
  out.push(inspect(err, {depth: Number.POSITIVE_INFINITY, showHidden: true}))
  walk(err, out, new Set())
  return out.join('\n')
}

/**
 * The derived secrets of a value a reader can open (spec 9.2): S, PRK, OKM,
 * K, N and the private key. Empty when the reader would stop before step 4 or
 * S is all zero (nothing secret was derived).
 */
function derivedSecrets(value: string, env: Env): Uint8Array[] {
  try {
    const parsed = parseQf1(value)
    const raw = Object.hasOwn(env, parsed.keyset) ? env[parsed.keyset] : undefined
    const key = parseKeysetEnv(parsed.keyset, raw).get(parsed.fingerprint)
    if (!key) return []
    const S = x25519(key.privateKey, parsed.ephemeralPublicKey)
    if (S.every((x) => x === 0)) return []
    const d = deriveKeyAndNonce(S, parsed.ephemeralPublicKey, key.publicKey)
    return [S, d.prk, d.okm, d.aesKey, d.nonce, key.privateKey]
  } catch {
    return []
  }
}

/** The secret material in a keyset env var value: each piece, its entry body, and its key bytes in every rendering. */
function envSecrets(value: string): string[] {
  const out: string[] = [value]
  for (const piece of value.split(',')) {
    out.push(piece)
    if (piece.trim().startsWith(PRIVATE_KEY_PREFIX)) {
      const body = piece.trim().slice(PRIVATE_KEY_PREFIX.length)
      out.push(body)
      try {
        out.push(...renderings(parsePrivateKeyEntry(piece.trim())))
      } catch {
        // not a valid entry: its text is still covered above
      }
    }
  }

  return out
}

function expectNoLeak(err: Qf1Error, secrets: string[], where: string): void {
  const surface = surfaceOf(err)
  for (const secret of secrets) {
    if (secret.length < 8) {
      // Too short for a piece test without false positives; require it not to appear verbatim unless trivial.
      if (secret.trim().length >= 4)
        expect(surface.includes(secret), `${where}: ${err.code} leaks a short secret`).to.be.false
      continue
    }

    for (let i = 0; i + 8 <= secret.length; i++) {
      const piece = secret.slice(i, i + 8)
      if (PRIVATE_KEY_PREFIX.includes(piece) || PUBLIC_KEY_PREFIX.includes(piece)) continue // fixed prefixes are not secret
      expect(surface.includes(piece), `${where}: ${err.code} leaks ${JSON.stringify(piece)}`).to.be.false
    }
  }
}

function qf1ErrorOf(fn: () => unknown): Qf1Error {
  try {
    fn()
  } catch (error) {
    expect(error, String(error)).to.be.instanceOf(Qf1Error)
    return error as Qf1Error
  }

  expect.fail('expected a Qf1Error')
}

describe('qf1 errors never leak secrets (spec 9.2, qfg-mol-hle)', () => {
  describe('every negative vector', () => {
    for (const n of vectors.negative) {
      it(n.name, () => {
        const err = qf1ErrorOf(() => decrypt(n.ciphertext, n.env))
        const secrets = Object.values(n.env).flatMap((v) => envSecrets(v))
        // The non-UTF-8 vectors name their plaintext bytes in the note.
        const bytesHex = /plaintext bytes ([\da-f]+)/.exec(n.note)?.[1]
        if (bytesHex) secrets.push(...renderings(Buffer.from(bytesHex, 'hex')))
        secrets.push('hello') // every sealed negative vector encrypts "hello"
        const derived = derivedSecrets(n.ciphertext, n.env)
        // Where the reader derived keys (every decrypt_failed vector), S, PRK, OKM, K and N are checked too.
        if (n.expectedError === 'decrypt_failed') expect(derived, 'derived secrets').to.have.length(6)
        for (const bytes of derived) secrets.push(...renderings(bytes))
        expectNoLeak(err, secrets, n.name)
      })
    }
  })

  describe('every key-entry case that fails', () => {
    for (const c of vectors.keyEntryCases.filter((k) => k.expectedError)) {
      it(`${c.kind}/${c.name}`, () => {
        const err = qf1ErrorOf(() => {
          if (c.kind === 'privateKeyEntry') return parsePrivateKeyEntry(c.input)
          if (c.kind === 'publicKeyEntry') return parsePublicKeyEntry(c.input)
          return parseKeysetEnv(c.keyset!, c.input)
        })
        expectNoLeak(err, envSecrets(c.input), c.name)
      })
    }
  })

  describe('every writer case', () => {
    for (const w of vectors.writerCases) {
      it(w.name, () => {
        const plaintext = String.fromCharCode(...w.plaintextUtf16CodeUnits) // eslint-disable-line unicorn/prefer-code-point
        const ephemeral = Buffer.from(w.ephemeralPrivateKeyHex, 'hex')
        const publicKey = Buffer.from(w.recipientPublicKeyHex, 'hex')
        const secrets = [plaintext, ...renderings(ephemeral), ...renderings(Buffer.from(plaintext, 'utf8'))]
        expectNoLeak(
          qf1ErrorOf(() => sealWithEphemeralKey({keyset: w.keyset, plaintext, publicKey}, ephemeral)),
          secrets,
          w.name,
        )
        const recipient = formatPublicKeyEntry(publicKey)
        expectNoLeak(
          qf1ErrorOf(() => encrypt({keyset: w.keyset, plaintext, recipient})),
          secrets,
          w.name,
        )
      })
    }

    it('a private entry passed as the recipient is never echoed', () => {
      const privateKey = Buffer.alloc(32, 0x01) // top bit clear: only the prefix check refuses it
      const recipient = formatPrivateKeyEntry(privateKey)
      const err = qf1ErrorOf(() => encrypt({keyset: 'QUONFIG_KEYSET', plaintext: 'x', recipient}))
      expect(err.code).to.equal('invalid_public_key')
      expectNoLeak(err, [recipient, ...envSecrets(recipient)], 'private entry as recipient')
    })

    it('a long invalid plaintext is not echoed', () => {
      const plaintext = `SENTINEL-WRITER-PLAINTEXT-${'z'.repeat(40)}\uD800`
      const recipient = formatPublicKeyEntry(publicKeyFromPrivate(Buffer.alloc(32, 3)))
      const err = qf1ErrorOf(() => encrypt({keyset: 'QUONFIG_KEYSET', plaintext, recipient}))
      expect(err.code).to.equal('invalid_plaintext')
      expectNoLeak(err, [plaintext.slice(0, -1)], 'long plaintext')
    })
  })

  describe('the non-UTF-8 decrypt_failed path', () => {
    // Authentic ciphertext (reference sealRaw skips writer checks) whose
    // plaintext bytes are long, distinctive and not well-formed UTF-8.
    const priv = Buffer.alloc(32, 0x11)
    const pub = Buffer.from(publicKeyFromPrivate(priv))
    const ephemeral = Buffer.alloc(32, 0x22)
    const plaintextBytes = Buffer.concat([
      Buffer.from('SENTINEL-NON-UTF8-PLAINTEXT-0123456789', 'latin1'),
      Buffer.from([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80]),
      Buffer.from('-TAIL-abcdefghijklmnop', 'latin1'),
    ])
    const fp = createHash('sha256').update(pub).digest('hex').slice(0, 8) // spec 4, computed independently
    const ciphertext = reference.sealRaw({
      fingerprintField: fp,
      keysetField: 'QUONFIG_KEYSET_LEAK',
      plaintextBytes,
      recipientPublicKey: pub,
      sharedSecret: reference.x25519(ephemeral, pub),
      transmittedEphemeralPublicKey: Buffer.from(publicKeyFromPrivate(ephemeral)),
    }).ciphertext

    it('fails decrypt_failed without the plaintext bytes in raw, hex, base64 or latin1 form', () => {
      const env = {QUONFIG_KEYSET_LEAK: formatPrivateKeyEntry(priv)}
      const err = qf1ErrorOf(() => decrypt(ciphertext, env))
      expect(err.code).to.equal('decrypt_failed')
      const derived = derivedSecrets(ciphertext, env)
      expect(derived).to.have.length(6)
      expectNoLeak(
        err,
        [
          ...renderings(plaintextBytes),
          ...envSecrets(env.QUONFIG_KEYSET_LEAK),
          ...derived.flatMap((b) => renderings(b)),
        ],
        'non-utf8',
      )
    })
  })
})
