/**
 * The qf1 library against EVERY known-answer vector of the approved spec
 * (project/plans/secrets-qf1-spec.md section 14; bead qfg-mol-hle PR 1).
 *
 * The vectors are not committed. They are regenerated in memory from the
 * vendored test-only generator (test/secrets/spec/generate-vectors.mjs, which
 * derives every TEST key from a public label) and pinned by SHA-256 to the
 * approved `vectors.json`, so the cli repo holds no private-key literal and the
 * provenance is byte-exact. Every case gets its own `it`, named by the vector.
 */
import {expect} from 'chai'
import {createHash, hkdfSync} from 'node:crypto'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {
  HKDF_INFO,
  OKM_LENGTH,
  PRIVATE_KEY_PREFIX,
  PUBLIC_KEY_PREFIX,
  Qf1Error,
  buildAad,
  decrypt,
  deriveKeyAndNonce,
  encrypt,
  fingerprint,
  formatPrivateKeyEntry,
  formatPublicKeyEntry,
  hkdf,
  hkdfExpand,
  hkdfExtract,
  parseKeysetEnv,
  parsePrivateKeyEntry,
  parsePublicKeyEntry,
  parseQf1,
  publicKeyFromPrivate,
  x25519,
} from '../../src/secrets/qf1.js'

/** SHA-256 of project/plans/secrets-qf1/vectors.json as approved (Gate A, 2026-11-24, project 7449be4). */
const APPROVED_VECTORS_SHA256 = 'dd4ce106ca43f025c34de41bec765b144f13131375da499621c1098d5f22de5f'

type Env = Record<string, string>
type Positive = {
  aadAscii: string
  aadHex: string
  aesKeyHex: string
  blobHex: string
  ciphertext: string
  ciphertextAndTagHex: string
  ephemeralPrivateKeyHex: string
  ephemeralPublicKeyHex: string
  fingerprint: string
  hkdfInfoHex: string
  hkdfSaltHex: string
  keyset: string
  name: string
  nonceHex: string
  okmHex: string
  plaintext: string
  plaintextHex: string
  prkHex: string
  recipientPrivateKeyEntry: string
  recipientPublicKeyHex: string
  sharedSecretHex: string
}
type Vectors = {
  constants: {
    hkdfInfoAscii: string
    hkdfInfoHex: string
    keysetNamePattern: string
    okmLength: number
    privateKeyPrefix: string
    publicKeyPrefix: string
  }
  decryptOnly: Array<{ciphertext: string; env: Env; name: string; plaintext: string; plaintextHex: string}>
  keyEntryCases: Array<{
    expectedError?: string
    expectedFingerprints?: string[]
    expectedHex?: string
    input: string
    keyset?: string
    kind: 'envValue' | 'privateKeyEntry' | 'publicKeyEntry'
    name: string
  }>
  keysets: Array<{
    envValue: string
    keys: Array<{
      fingerprint: string
      label: string
      privateKeyEntry: string
      privateKeyHex: string
      publicKeyEntry: string
      publicKeyHex: string
    }>
    name: string
    publicKeys: string[]
  }>
  negative: Array<{ciphertext: string; env: Env; expectedError: string; mustReject: boolean; name: string}>
  positive: Positive[]
  positiveEnv: Env
  rfcChecks: {
    rfc5869_A_1: {infoHex: string; ikmHex: string; length: number; okmHex: string; prkHex: string; saltHex: string}
    rfc7748_6_1: {
      alicePrivateHex: string
      alicePublicHex: string
      bobPrivateHex: string
      bobPublicHex: string
      sharedSecretHex: string
    }
  }
  writerCases: Array<{
    ephemeralPrivateKeyHex: string
    expectedError: string
    keyset: string
    name: string
    plaintextUtf16CodeUnits: number[]
    recipientPublicKeyHex: string
  }>
}

const generatorUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'spec', 'generate-vectors.mjs'),
).href
const generator = (await import(generatorUrl)) as {buildVectorsJson: () => string}
const vectorsJson = generator.buildVectorsJson()
const vectors = JSON.parse(vectorsJson) as Vectors

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (h: string) => Buffer.from(h, 'hex')

/** Run `fn` and return the Qf1Error it throws; fail the test if it returns or throws anything else. */
function qf1ErrorOf(fn: () => unknown): Qf1Error {
  let result: unknown
  try {
    result = fn()
  } catch (error) {
    expect(error, String(error)).to.be.instanceOf(Qf1Error)
    return error as Qf1Error
  }

  expect.fail(`expected a Qf1Error, got a result: ${JSON.stringify(result)}`)
}

/** Count of generated `it`s per category, checked by the coverage guard at the end. */
const generated: Record<string, number> = {}
const count = (category: string) => {
  generated[category] = (generated[category] ?? 0) + 1
}

describe('qf1 vectors (spec section 14, qfg-mol-hle)', () => {
  it('regenerated vectors are byte-identical to the approved spec file', () => {
    expect(createHash('sha256').update(vectorsJson, 'utf8').digest('hex')).to.equal(APPROVED_VECTORS_SHA256)
  })

  it('constants match spec 5.1 and 6.1', () => {
    expect(Buffer.from(HKDF_INFO).toString('ascii')).to.equal(vectors.constants.hkdfInfoAscii)
    expect(hex(HKDF_INFO)).to.equal(vectors.constants.hkdfInfoHex)
    expect(OKM_LENGTH).to.equal(vectors.constants.okmLength)
    expect(PRIVATE_KEY_PREFIX).to.equal(vectors.constants.privateKeyPrefix)
    expect(PUBLIC_KEY_PREFIX).to.equal(vectors.constants.publicKeyPrefix)
  })

  describe('rfcChecks', () => {
    it('RFC 7748 6.1 x25519', () => {
      count('rfcChecks')
      const r = vectors.rfcChecks.rfc7748_6_1
      expect(hex(publicKeyFromPrivate(fromHex(r.alicePrivateHex)))).to.equal(r.alicePublicHex)
      expect(hex(publicKeyFromPrivate(fromHex(r.bobPrivateHex)))).to.equal(r.bobPublicHex)
      expect(hex(x25519(fromHex(r.alicePrivateHex), fromHex(r.bobPublicHex)))).to.equal(r.sharedSecretHex)
      expect(hex(x25519(fromHex(r.bobPrivateHex), fromHex(r.alicePublicHex)))).to.equal(r.sharedSecretHex)
    })

    it('RFC 5869 A.1 hkdf', () => {
      count('rfcChecks')
      const r = vectors.rfcChecks.rfc5869_A_1
      const prk = hkdfExtract(fromHex(r.saltHex), fromHex(r.ikmHex))
      expect(hex(prk)).to.equal(r.prkHex)
      expect(hex(hkdfExpand(prk, fromHex(r.infoHex), r.length))).to.equal(r.okmHex)
      expect(hex(hkdf(fromHex(r.saltHex), fromHex(r.ikmHex), fromHex(r.infoHex), r.length))).to.equal(r.okmHex)
    })
  })

  describe('keysets', () => {
    for (const ks of vectors.keysets) {
      it(`${ks.name}: entries, public keys and fingerprints agree; envValue parses to every key`, () => {
        count('keysets')
        for (const k of ks.keys) {
          const priv = parsePrivateKeyEntry(k.privateKeyEntry)
          expect(hex(priv)).to.equal(k.privateKeyHex)
          expect(formatPrivateKeyEntry(priv)).to.equal(k.privateKeyEntry)
          const pub = publicKeyFromPrivate(priv)
          expect(hex(pub)).to.equal(k.publicKeyHex)
          expect(formatPublicKeyEntry(pub)).to.equal(k.publicKeyEntry)
          expect(hex(parsePublicKeyEntry(k.publicKeyEntry))).to.equal(k.publicKeyHex)
          expect(fingerprint(pub)).to.equal(k.fingerprint)
        }

        expect(ks.publicKeys).to.deep.equal(ks.keys.map((k) => k.publicKeyEntry))
        const held = parseKeysetEnv(ks.name, ks.envValue)
        expect([...held.keys()].sort()).to.deep.equal(ks.keys.map((k) => k.fingerprint).sort())
      })
    }
  })

  describe('positive', () => {
    for (const p of vectors.positive) {
      it(`${p.name}: encrypt with the vector's ephemeral key reproduces every intermediate and the ciphertext`, () => {
        count('positive-encrypt')
        const ephemeralPrivate = fromHex(p.ephemeralPrivateKeyHex)
        const recipient = fromHex(p.recipientPublicKeyHex)
        expect(hex(Buffer.from(p.plaintext, 'utf8'))).to.equal(p.plaintextHex)
        expect(hex(publicKeyFromPrivate(parsePrivateKeyEntry(p.recipientPrivateKeyEntry)))).to.equal(
          p.recipientPublicKeyHex,
        )
        expect(fingerprint(recipient)).to.equal(p.fingerprint)

        const E = publicKeyFromPrivate(ephemeralPrivate)
        expect(hex(E), 'E').to.equal(p.ephemeralPublicKeyHex)
        const S = x25519(ephemeralPrivate, recipient)
        expect(hex(S), 'S').to.equal(p.sharedSecretHex)
        const d = deriveKeyAndNonce(S, E, recipient)
        expect(hex(d.hkdfSalt), 'salt').to.equal(p.hkdfSaltHex)
        expect(hex(HKDF_INFO), 'info').to.equal(p.hkdfInfoHex)
        expect(hex(d.prk), 'PRK').to.equal(p.prkHex)
        expect(hex(d.okm), 'OKM').to.equal(p.okmHex)
        expect(hex(d.aesKey), 'K').to.equal(p.aesKeyHex)
        expect(hex(d.nonce), 'N').to.equal(p.nonceHex)
        const aad = buildAad(p.keyset, p.fingerprint)
        expect(hex(aad), 'AAD').to.equal(p.aadHex)
        expect(Buffer.from(aad).toString('latin1')).to.equal(p.aadAscii)

        const ciphertext = encrypt({
          ephemeralPrivateKey: ephemeralPrivate,
          keyset: p.keyset,
          plaintext: p.plaintext,
          publicKey: recipient,
        })
        expect(ciphertext, 'qf1 string').to.equal(p.ciphertext)
        const parsed = parseQf1(ciphertext)
        expect(hex(parsed.ciphertextAndTag), 'C || T').to.equal(p.ciphertextAndTagHex)
        expect(hex(Buffer.concat([parsed.ephemeralPublicKey, parsed.ciphertextAndTag])), 'blob').to.equal(p.blobHex)
      })

      it(`${p.name}: decrypts with positiveEnv`, () => {
        count('positive-decrypt')
        expect(decrypt(p.ciphertext, vectors.positiveEnv)).to.equal(p.plaintext)
      })
    }
  })

  describe('decryptOnly', () => {
    for (const d of vectors.decryptOnly) {
      it(`${d.name}: decrypts with its env`, () => {
        count('decryptOnly')
        const plaintext = decrypt(d.ciphertext, d.env)
        expect(plaintext).to.equal(d.plaintext)
        expect(hex(Buffer.from(plaintext, 'utf8'))).to.equal(d.plaintextHex)
      })
    }
  })

  describe('negative', () => {
    for (const n of vectors.negative) {
      const tag = n.mustReject ? ' (mustReject)' : ''
      it(`${n.name}: fails with ${n.expectedError}${tag}`, () => {
        count('negative')
        if (n.mustReject) count('mustReject')
        const err = qf1ErrorOf(() => decrypt(n.ciphertext, n.env))
        expect(err.code, err.message).to.equal(n.expectedError)
        expect(err.message.startsWith(`qf1 ${n.expectedError}: `), err.message).to.be.true
      })
    }
  })

  describe('writerCases', () => {
    for (const w of vectors.writerCases) {
      it(`${w.name}: encrypt fails with ${w.expectedError}`, () => {
        count('writerCases')
        // Code units, not code points: a lone surrogate must survive as one.
        const plaintext = String.fromCharCode(...w.plaintextUtf16CodeUnits) // eslint-disable-line unicorn/prefer-code-point
        expect(plaintext.length).to.equal(w.plaintextUtf16CodeUnits.length)
        const err = qf1ErrorOf(() =>
          encrypt({
            ephemeralPrivateKey: fromHex(w.ephemeralPrivateKeyHex),
            keyset: w.keyset,
            plaintext,
            publicKey: fromHex(w.recipientPublicKeyHex),
          }),
        )
        expect(err.code, err.message).to.equal(w.expectedError)
      })
    }
  })

  describe('keyEntryCases', () => {
    for (const c of vectors.keyEntryCases) {
      const want = c.expectedError ?? (c.expectedHex ? `bytes ${c.expectedHex.slice(0, 8)}...` : 'fingerprints')
      it(`${c.kind}/${c.name}: ${want}`, () => {
        count(`keyEntryCases-${c.kind}`)
        const run = (): Uint8Array | string[] => {
          switch (c.kind) {
            case 'privateKeyEntry': {
              return parsePrivateKeyEntry(c.input)
            }

            case 'publicKeyEntry': {
              return parsePublicKeyEntry(c.input)
            }

            case 'envValue': {
              return [...parseKeysetEnv(c.keyset!, c.input).keys()]
            }
          }
        }

        if (c.expectedError) {
          expect(qf1ErrorOf(run).code).to.equal(c.expectedError)
        } else if (c.expectedHex) {
          expect(hex(run() as Uint8Array)).to.equal(c.expectedHex)
        } else {
          expect([...(run() as string[])].sort()).to.deep.equal([...c.expectedFingerprints!].sort())
        }
      })
    }
  })

  describe('RFC vectors beyond vectors.json', () => {
    const range = (from: number, to: number) => Buffer.from(Array.from({length: to - from + 1}, (_, i) => from + i))

    // RFC 5869 appendix A.2 and A.3 (published test vectors, SHA-256 cases).
    const rfc5869 = [
      {
        name: 'A.2 (long inputs)',
        ikm: range(0x00, 0x4f),
        salt: range(0x60, 0xaf),
        info: range(0xb0, 0xff),
        length: 82,
        prkHex: '06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244', // gitleaks:allow
        okmHex:
          'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87', // gitleaks:allow
      },
      {
        name: 'A.3 (empty salt and info)',
        ikm: Buffer.alloc(22, 0x0b),
        salt: Buffer.alloc(0),
        info: Buffer.alloc(0),
        length: 42,
        prkHex: '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04', // gitleaks:allow
        okmHex: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8', // gitleaks:allow
      },
    ]
    for (const r of rfc5869) {
      it(`RFC 5869 ${r.name} hkdf, and agrees with crypto.hkdfSync`, () => {
        count('rfcExtra')
        expect(hex(hkdfExtract(r.salt, r.ikm))).to.equal(r.prkHex)
        const okm = hkdf(r.salt, r.ikm, r.info, r.length)
        expect(hex(okm)).to.equal(r.okmHex)
        expect(hex(new Uint8Array(hkdfSync('sha256', r.ikm, r.salt, r.info, r.length)))).to.equal(r.okmHex)
      })
    }

    it('hkdf agrees with crypto.hkdfSync on the qf1 parameters of every positive vector', () => {
      count('rfcExtra')
      for (const p of vectors.positive) {
        const okm = hkdfSync('sha256', fromHex(p.sharedSecretHex), fromHex(p.hkdfSaltHex), HKDF_INFO, OKM_LENGTH)
        expect(hex(new Uint8Array(okm)), p.name).to.equal(p.okmHex)
      }
    })

    // RFC 7748 section 5.2 (published test vectors).
    it('RFC 7748 5.2 x25519 single-step vectors', () => {
      count('rfcExtra')
      const cases = [
        [
          'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4', // gitleaks:allow
          'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c', // gitleaks:allow
          'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552', // gitleaks:allow
        ],
        [
          '4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d', // gitleaks:allow
          'e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493', // gitleaks:allow
          '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957', // gitleaks:allow
        ],
      ]
      for (const [k, u, out] of cases) expect(hex(x25519(fromHex(k), fromHex(u)))).to.equal(out)
    })

    it('RFC 7748 5.2 x25519 iterated 1 and 1000 times', () => {
      count('rfcExtra')
      let k: Uint8Array = Buffer.alloc(32)
      k[0] = 9
      let u: Uint8Array = Buffer.from(k)
      for (let i = 1; i <= 1000; i++) {
        const next = x25519(k, u)
        u = k
        k = next
        if (i === 1) expect(hex(k)).to.equal('422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079') // gitleaks:allow
      }

      expect(hex(k)).to.equal('684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51') // gitleaks:allow
    })
  })

  after('every vector in the file is exercised', () => {
    const kinds = (kind: string) => vectors.keyEntryCases.filter((c) => c.kind === kind).length
    const expected = {
      keysets: vectors.keysets.length,
      'positive-encrypt': vectors.positive.length,
      'positive-decrypt': vectors.positive.length,
      decryptOnly: vectors.decryptOnly.length,
      negative: vectors.negative.length,
      mustReject: vectors.negative.filter((n) => n.mustReject).length,
      writerCases: vectors.writerCases.length,
      'keyEntryCases-privateKeyEntry': kinds('privateKeyEntry'),
      'keyEntryCases-publicKeyEntry': kinds('publicKeyEntry'),
      'keyEntryCases-envValue': kinds('envValue'),
      rfcChecks: 2,
      rfcExtra: 5,
    }
    // The spec's counts as approved; a change to the file must be a deliberate change here too.
    expect({
      positive: vectors.positive.length,
      decryptOnly: vectors.decryptOnly.length,
      negative: vectors.negative.length,
      mustReject: expected.mustReject,
      writerCases: vectors.writerCases.length,
      keyEntryCases: vectors.keyEntryCases.length,
    }).to.deep.equal({positive: 9, decryptOnly: 1, negative: 58, mustReject: 34, writerCases: 4, keyEntryCases: 30})
    // Under --grep / --fgrep only some tests run, so the per-test counts are partial.
    const filtered = process.argv.some((a) => /^(-g|-f|--grep|--fgrep)(=|$)/.test(a))
    if (!filtered) expect(generated).to.deep.equal(expected)
  })
})
