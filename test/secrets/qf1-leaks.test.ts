/**
 * Spec 9.2: no qf1 error may carry a private key entry or any part of one, any
 * part of the keyset env var's value, or any part of the plaintext. Checked
 * over EVERY negative vector, key-entry case and writer case, and explicitly
 * on the non-UTF-8 decrypt path (bead qfg-mol-hle PR 1).
 *
 * The "surface" of an error is its message, String(), stack, JSON form and
 * every enumerable field. A secret leaks if any 8-character piece of it, in
 * any of its usual renderings, appears on that surface.
 */
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {sealWithEphemeralKey} from '../../src/secrets/qf1-internal.js'
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
  publicKeyFromPrivate,
} from '../../src/secrets/qf1.js'

type Env = Record<string, string>
type Vectors = {
  keyEntryCases: Array<{expectedError?: string; input: string; keyset?: string; kind: string; name: string}>
  negative: Array<{ciphertext: string; env: Env; name: string; note: string}>
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

/** Every rendering of the error a user, a log or a JSON consumer could see. */
function surfaceOf(err: Qf1Error): string {
  return [
    err.message,
    String(err),
    err.stack ?? '',
    JSON.stringify(err),
    JSON.stringify(Object.entries(err)),
    ...Object.values(err).map(String),
  ].join('\n')
}

/** The renderings of secret bytes: raw latin1, lossy UTF-8, hex (both cases), base64 and base64url. */
function renderings(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes)
  return [
    b.toString('latin1'),
    b.toString('utf8'),
    b.toString('hex'),
    b.toString('hex').toUpperCase(),
    b.toString('base64'),
    b.toString('base64url'),
  ]
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
      expectNoLeak(err, [...renderings(plaintextBytes), ...envSecrets(env.QUONFIG_KEYSET_LEAK)], 'non-utf8')
    })
  })
})
