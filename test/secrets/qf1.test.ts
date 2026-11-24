/**
 * qf1 library behaviour beyond the known-answer vectors (bead qfg-mol-hle PR 1;
 * spec project/plans/secrets-qf1-spec.md sections 6.2, 7, 8 and 9.2).
 *
 * Every key here is a throwaway derived at run time from a public label; no
 * private-key literal is committed.
 */
import {expect} from 'chai'
import {createHash, randomBytes} from 'node:crypto'

import {
  Qf1Error,
  decrypt,
  encrypt,
  fingerprint,
  formatPrivateKeyEntry,
  formatPublicKeyEntry,
  isQf1String,
  mintKeypair,
  parseKeysetEnv,
  parsePublicKeyEntry,
  parseQf1,
  publicKeyFromPrivate,
} from '../../src/secrets/qf1.js'

const label = (s: string) => createHash('sha256').update(`qfg-mol-hle qf1.test.ts key: ${s}`).digest()

const privA = label('A')
const pubA = publicKeyFromPrivate(privA)
const entryA = formatPrivateKeyEntry(privA)
const privB = label('B')
const pubB = publicKeyFromPrivate(privB)
const entryB = formatPrivateKeyEntry(privB)

/** The order-8 point of spec 6.1 (vector `ephemeral-low-order-order-8-a`). */
const ORDER_8 = Buffer.from('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex')
const NON_CANONICAL_9 = (() => {
  const b = Buffer.alloc(32, 0xff)
  b[0] = 0xed + 9 // p + 9 = 2^255 - 19 + 9, little-endian
  b[31] = 0x7f
  return b
})()

function qf1ErrorOf(fn: () => unknown): Qf1Error {
  try {
    fn()
  } catch (error) {
    expect(error, String(error)).to.be.instanceOf(Qf1Error)
    return error as Qf1Error
  }

  expect.fail('expected a Qf1Error')
}

const encryptErrorCode = (input: Parameters<typeof encrypt>[0]): string => qf1ErrorOf(() => encrypt(input)).code

/** Seal a value under `keyset` with an arbitrary E, as the vectors' sealRaw does: here E is a small-order point. */
function lowOrderValueTo(keyset: string, fp: string): string {
  // Any authentic-looking payload works: the reader must stop before GCM.
  const payload = Buffer.concat([ORDER_8, Buffer.alloc(16 + 5, 7)])
  return `qf1:${keyset}:${fp}:${payload.toString('base64url')}`
}

describe('qf1 library (qfg-mol-hle)', () => {
  describe('encrypt', () => {
    it('draws a fresh ephemeral key per call; both values decrypt', () => {
      const a = encrypt({keyset: 'QUONFIG_KEYSET_X', plaintext: 'same input', publicKey: pubA})
      const b = encrypt({keyset: 'QUONFIG_KEYSET_X', plaintext: 'same input', publicKey: pubA})
      expect(a).not.to.equal(b)
      expect(Buffer.from(parseQf1(a).ephemeralPublicKey).equals(parseQf1(b).ephemeralPublicKey)).to.be.false
      const env = {QUONFIG_KEYSET_X: entryA}
      expect(decrypt(a, env)).to.equal('same input')
      expect(decrypt(b, env)).to.equal('same input')
    })

    it('names the keyset and the recipient fingerprint in the header', () => {
      const v = encrypt({keyset: 'QUONFIG_KEYSET_PROD', plaintext: '', publicKey: pubA})
      expect(v.startsWith(`qf1:QUONFIG_KEYSET_PROD:${fingerprint(pubA)}:`)).to.be.true
      expect(decrypt(v, {QUONFIG_KEYSET_PROD: entryA})).to.equal('')
    })

    it('refuses an injected ephemeral key outside NODE_ENV=test', () => {
      const saved = process.env.NODE_ENV
      try {
        for (const mode of ['production', 'development', undefined]) {
          if (mode === undefined) delete process.env.NODE_ENV
          else process.env.NODE_ENV = mode
          expect(() =>
            encrypt({ephemeralPrivateKey: label('e'), keyset: 'QUONFIG_KEYSET', plaintext: 'x', publicKey: pubA}),
          ).to.throw(/ephemeral key may only be injected in tests/)
        }
      } finally {
        process.env.NODE_ENV = saved
      }

      expect(
        encrypt({ephemeralPrivateKey: label('e'), keyset: 'QUONFIG_KEYSET', plaintext: 'x', publicKey: pubA}),
      ).to.equal(encrypt({ephemeralPrivateKey: label('e'), keyset: 'QUONFIG_KEYSET', plaintext: 'x', publicKey: pubA}))
    })

    describe('writer check order (spec 7 step 1, decision 47)', () => {
      const lone = 'a\uD800b'
      const cases: Array<{expected: string; keyset: string; name: string; plaintext: string; publicKey: Uint8Array}> = [
        {
          expected: 'invalid_keyset_name',
          keyset: 'HOME',
          name: 'bad name before bad key',
          plaintext: lone,
          publicKey: NON_CANONICAL_9,
        },
        {
          expected: 'invalid_public_key',
          keyset: 'QUONFIG_KEYSET',
          name: 'non-canonical key before bad plaintext',
          plaintext: lone,
          publicKey: NON_CANONICAL_9,
        },
        {
          expected: 'invalid_public_key',
          keyset: 'QUONFIG_KEYSET',
          name: 'top bit before bad plaintext',
          plaintext: lone,
          publicKey: Buffer.from(pubA).map((x, i) => (i === 31 ? x | 0x80 : x)),
        },
        {
          expected: 'invalid_public_key',
          keyset: 'QUONFIG_KEYSET',
          name: 'wrong length before bad plaintext',
          plaintext: lone,
          publicKey: pubA.subarray(0, 31),
        },
        {
          expected: 'invalid_plaintext',
          keyset: 'QUONFIG_KEYSET',
          name: 'bad plaintext before the small-order check',
          plaintext: lone,
          publicKey: ORDER_8,
        },
        {
          expected: 'invalid_public_key',
          keyset: 'QUONFIG_KEYSET',
          name: 'small order last',
          plaintext: 'ok',
          publicKey: ORDER_8,
        },
      ]
      for (const c of cases) {
        it(`${c.name}: ${c.expected}`, () => {
          expect(encryptErrorCode(c)).to.equal(c.expected)
        })
      }

      it('rejects every lone surrogate position and accepts paired surrogates', () => {
        for (const bad of ['\uD800', '\uDC00', 'x\uDBFF', '\uDFFFx', '\uDC00\uD800', '\uD83D\u{1F511}']) {
          expect(encryptErrorCode({keyset: 'QUONFIG_KEYSET', plaintext: bad, publicKey: pubA})).to.equal(
            'invalid_plaintext',
          )
        }

        const ok = 'key \u{1F511} \u{1F511}'
        expect(
          decrypt(encrypt({keyset: 'QUONFIG_KEYSET', plaintext: ok, publicKey: pubA}), {QUONFIG_KEYSET: entryA}),
        ).to.equal(ok)
      })
    })
  })

  describe('decrypt', () => {
    const value = encrypt({keyset: 'QUONFIG_KEYSET_PROD', plaintext: 'top secret', publicKey: pubA})

    it('reads only the env var named by the keyset', () => {
      const touched: string[] = []
      const target: Record<string, string> = {HOME: '/home/x', QUONFIG_KEYSET: entryA, QUONFIG_KEYSET_PROD: entryA}
      const env = new Proxy(target, {
        get(t, p) {
          touched.push(`get:${String(p)}`)
          return Reflect.get(t, p)
        },
        getOwnPropertyDescriptor(t, p) {
          touched.push(`own:${String(p)}`)
          return Reflect.getOwnPropertyDescriptor(t, p)
        },
        has(t, p) {
          touched.push(`has:${String(p)}`)
          return Reflect.has(t, p)
        },
        ownKeys(t) {
          touched.push('ownKeys')
          return Reflect.ownKeys(t)
        },
      })
      expect(decrypt(value, env)).to.equal('top secret')
      expect(touched.length).to.be.greaterThan(0)
      expect(
        touched.every((t) => t.endsWith(':QUONFIG_KEYSET_PROD')),
        touched.join(' '),
      ).to.be.true
    })

    it('never reads an inherited (prototype) property as the keyset', () => {
      const env = Object.create({QUONFIG_KEYSET_PROD: entryA}) as Record<string, string>
      expect(qf1ErrorOf(() => decrypt(value, env)).code).to.equal('keyset_missing')
    })

    it('never reads process.env when an env is passed', () => {
      const saved = process.env.QUONFIG_KEYSET_PROD
      process.env.QUONFIG_KEYSET_PROD = entryA
      try {
        expect(qf1ErrorOf(() => decrypt(value, {})).code).to.equal('keyset_missing')
        expect(decrypt(value)).to.equal('top secret') // the default env is process.env
      } finally {
        if (saved === undefined) delete process.env.QUONFIG_KEYSET_PROD
        else process.env.QUONFIG_KEYSET_PROD = saved
      }
    })

    it('an invalid keyset name never reaches the env (spec 2)', () => {
      const touched: string[] = []
      const env = new Proxy({HOME: entryA} as Record<string, string>, {
        getOwnPropertyDescriptor(t, p) {
          touched.push(String(p))
          return Reflect.getOwnPropertyDescriptor(t, p)
        },
        get(t, p) {
          touched.push(String(p))
          return Reflect.get(t, p)
        },
      })
      const forged = value.replace('QUONFIG_KEYSET_PROD', 'HOME')
      expect(qf1ErrorOf(() => decrypt(forged, env)).code).to.equal('invalid_keyset_name')
      expect(touched).to.deep.equal([])
    })

    describe('reader order: keyset lookup before the small-order check (spec 8 steps 2-4)', () => {
      const fpA = fingerprint(pubA)
      const lowOrder = lowOrderValueTo('QUONFIG_KEYSET_PROD', fpA)

      it('keyset_missing when the keyset is not held', () => {
        expect(qf1ErrorOf(() => decrypt(lowOrder, {})).code).to.equal('keyset_missing')
      })

      it('keyset_invalid when the keyset env var is broken', () => {
        expect(qf1ErrorOf(() => decrypt(lowOrder, {QUONFIG_KEYSET_PROD: 'nope'})).code).to.equal('keyset_invalid')
      })

      it('key_not_held when the keyset holds other keys', () => {
        expect(qf1ErrorOf(() => decrypt(lowOrder, {QUONFIG_KEYSET_PROD: entryB})).code).to.equal('key_not_held')
      })

      it('invalid_ephemeral_key only once the key is held', () => {
        expect(qf1ErrorOf(() => decrypt(lowOrder, {QUONFIG_KEYSET_PROD: entryA})).code).to.equal(
          'invalid_ephemeral_key',
        )
      })
    })
  })

  describe('error text (spec 9.2)', () => {
    const fpA = fingerprint(pubA)
    const fpB = fingerprint(pubB)
    const value = encrypt({keyset: 'QUONFIG_KEYSET_PROD', plaintext: 'SENTINEL-PLAINTEXT-0001', publicKey: pubA})

    it('key_not_held names the keyset, the needed fingerprint and the held ones, sorted', () => {
      const privC = label('C')
      const fpC = fingerprint(publicKeyFromPrivate(privC))
      const err = qf1ErrorOf(() => decrypt(value, {QUONFIG_KEYSET_PROD: `${formatPrivateKeyEntry(privC)},${entryB}`}))
      const held = [fpB, fpC].sort()
      expect(err.message).to.equal(
        `qf1 key_not_held: value is encrypted to QUONFIG_KEYSET_PROD fingerprint ${fpA}; this machine holds QUONFIG_KEYSET_PROD fingerprints [${held.join(', ')}]`,
      )
      expect(err).to.include({code: 'key_not_held', fingerprint: fpA, keyset: 'QUONFIG_KEYSET_PROD'})
      expect(err.held).to.deep.equal(held)
    })

    it('keyset_missing names the keyset and fingerprint', () => {
      expect(qf1ErrorOf(() => decrypt(value, {})).message).to.equal(
        `qf1 keyset_missing: value is encrypted to QUONFIG_KEYSET_PROD fingerprint ${fpA}; this machine has no QUONFIG_KEYSET_PROD`,
      )
    })

    it('keyset_invalid names the entry by 1-based position only', () => {
      const bad = 'qf1-priv-NOT-A-KEY-but-SENTINEL-ENTRY-TEXT'
      const err = qf1ErrorOf(() => decrypt(value, {QUONFIG_KEYSET_PROD: ` ${entryA} ,,${bad}, ${entryB}`}))
      expect(err.message).to.equal('qf1 keyset_invalid: QUONFIG_KEYSET_PROD entry 2 is not a qf1 private key')
      expect(err).to.include({code: 'keyset_invalid', keyset: 'QUONFIG_KEYSET_PROD', entry: 2})
    })

    it('keyset_invalid for a collision names the keyset and the fingerprint', () => {
      // The pair the spec's generator finds (vector keyset-fingerprint-collision), derived from its public labels.
      const c = (i: number) => createHash('sha256').update(`qf1 test vector collision key: ${i}`).digest()
      const [c1, c2] = [c(59_381), c(122_336)]
      const fp = fingerprint(publicKeyFromPrivate(c1))
      expect(fingerprint(publicKeyFromPrivate(c2))).to.equal(fp)
      const err = qf1ErrorOf(() =>
        parseKeysetEnv('QUONFIG_KEYSET_X', `${formatPrivateKeyEntry(c1)},${formatPrivateKeyEntry(c2)}`),
      )
      expect(err.message).to.equal(
        `qf1 keyset_invalid: QUONFIG_KEYSET_X holds two different keys with fingerprint ${fp}`,
      )
      expect(err).to.include({code: 'keyset_invalid', fingerprint: fp, keyset: 'QUONFIG_KEYSET_X'})
    })

    it('invalid_keyset_name quotes the name truncated to 64 with control characters escaped', () => {
      const name = `HOME\n${'X'.repeat(100)}`
      const forged = value.replace('QUONFIG_KEYSET_PROD', name)
      const err = qf1ErrorOf(() => decrypt(forged, {}))
      expect(err.code).to.equal('invalid_keyset_name')
      expect(err.message).to.include(JSON.stringify(name.slice(0, 64)))
      expect(err.message).not.to.include('\n')
    })

    it('decrypt_failed names the keyset and fingerprint', () => {
      const tampered = value.slice(0, -2) + (value.at(-2) === 'A' ? 'B' : 'A') + value.slice(-1)
      const err = qf1ErrorOf(() => decrypt(tampered, {QUONFIG_KEYSET_PROD: entryA}))
      expect(err.code).to.equal('decrypt_failed')
      expect(err.message).to.equal(
        `qf1 decrypt_failed: authentication failed for QUONFIG_KEYSET_PROD fingerprint ${fpA}`,
      )
    })

    it('never contains the entry, the env value, the plaintext or key bytes, in the message or any field', () => {
      const env = {QUONFIG_KEYSET_PROD: `${entryB}`}
      // Entry bodies (the fixed 9-character prefix is not secret), the plaintext, and the raw key bytes.
      const secretsToHide = [
        entryA.slice(9),
        entryB.slice(9),
        'SENTINEL-PLAINTEXT-0001',
        Buffer.from(privA).toString('hex'),
        Buffer.from(privB).toString('hex'),
        Buffer.from(privA).toString('base64'),
      ]
      const errors = [
        qf1ErrorOf(() => decrypt(value, env)),
        qf1ErrorOf(() => decrypt(value, {QUONFIG_KEYSET_PROD: `${entryA}\u000B`})),
        qf1ErrorOf(() => decrypt(value, {QUONFIG_KEYSET_PROD: `${entryA},${entryA.slice(0, -1)}`})),
        qf1ErrorOf(() => decrypt(value.slice(0, -4) + 'AAAA', {QUONFIG_KEYSET_PROD: entryA})),
        qf1ErrorOf(() => parseKeysetEnv('QUONFIG_KEYSET_PROD', `${entryA}\u00A0`)),
        qf1ErrorOf(() =>
          encrypt({keyset: 'QUONFIG_KEYSET', plaintext: 'SENTINEL-PLAINTEXT-0001\uD800', publicKey: pubA}),
        ),
        qf1ErrorOf(() => parsePublicKeyEntry(entryA)),
      ]
      for (const err of errors) {
        const surface = [
          err.message,
          String(err),
          err.stack ?? '',
          JSON.stringify(err),
          JSON.stringify(Object.entries(err)),
        ].join('\n')
        for (const hidden of secretsToHide) {
          for (let i = 0; i + 8 <= hidden.length; i++) {
            const piece = hidden.slice(i, i + 8)
            expect(surface.includes(piece), `${err.code} leaks ${JSON.stringify(piece)}`).to.be.false
          }
        }
      }
    })
  })

  describe('parseKeysetEnv (spec 6.2)', () => {
    const fpA = fingerprint(pubA)
    const fpB = fingerprint(pubB)
    const fps = (value: string) => [...parseKeysetEnv('QUONFIG_KEYSET', value).keys()].sort()
    const code = (value: string | undefined) => qf1ErrorOf(() => parseKeysetEnv('QUONFIG_KEYSET', value)).code

    it('unset, empty, or only separators is keyset_missing', () => {
      for (const v of [undefined, '', ',', ' , ,\n', '\r\n\t'])
        expect(code(v), JSON.stringify(v)).to.equal('keyset_missing')
    })

    it('splits on comma, strips only space, tab, CR and LF, and drops empty pieces', () => {
      expect(fps(`\r\n ${entryA}\t,,\n${entryB} \r\n,`)).to.deep.equal([fpA, fpB].sort())
    })

    it('does not use String.prototype.trim (other whitespace makes the keyset invalid)', () => {
      for (const ch of ['\u000B', '\u000C', '\u00A0', '\u2028', '\u2029', '\uFEFF', '\u3000', '\u0085']) {
        expect(code(`${entryA}${ch}`), `U+${ch.codePointAt(0)!.toString(16)}`).to.equal('keyset_invalid')
        expect(code(`${ch}${entryA}`), `U+${ch.codePointAt(0)!.toString(16)}`).to.equal('keyset_invalid')
      }
    })

    it('collapses duplicates and clamp-equivalent entries', () => {
      const twin = Buffer.from(privA)
      twin[0] ^= 0x01 // low bits are cleared by clamping
      expect(fingerprint(publicKeyFromPrivate(twin))).to.equal(fpA)
      expect(fps(`${entryA},${entryA},${formatPrivateKeyEntry(twin)}`)).to.deep.equal([fpA])
      const held = parseKeysetEnv('QUONFIG_KEYSET', `${entryA}`)
      expect(Buffer.from(held.get(fpA)!.publicKey).equals(pubA)).to.be.true
      expect(Buffer.from(held.get(fpA)!.privateKey).equals(privA)).to.be.true
    })

    it('a public entry or a ; separator is keyset_invalid', () => {
      expect(code(formatPublicKeyEntry(pubA))).to.equal('keyset_invalid')
      expect(code(`${entryA};${entryB}`)).to.equal('keyset_invalid')
    })
  })

  describe('mintKeypair (spec 4, decision 42)', () => {
    it('returns a key whose fingerprint is not taken', () => {
      const k = mintKeypair(new Set())
      expect(k.privateKey).to.have.length(32)
      expect(Buffer.from(publicKeyFromPrivate(k.privateKey)).equals(k.publicKey)).to.be.true
      expect(k.fingerprint).to.equal(fingerprint(k.publicKey))
    })

    it('redraws on a fingerprint collision', () => {
      const draws = [privA, privA, privB]
      let calls = 0
      const k = mintKeypair(new Set([fingerprint(pubA)]), (n) => {
        expect(n).to.equal(32)
        return Buffer.from(draws[calls++])
      })
      expect(calls).to.equal(3)
      expect(k.fingerprint).to.equal(fingerprint(pubB))
    })

    it('uses the CSPRNG by default (distinct keys)', () => {
      expect(mintKeypair(new Set()).fingerprint).not.to.equal(mintKeypair(new Set()).fingerprint)
      expect(randomBytes).to.be.a('function')
    })
  })

  describe('isQf1String', () => {
    it('is true only for strings starting qf1:', () => {
      expect(isQf1String('qf1:anything')).to.be.true
      expect(isQf1String('qf1:')).to.be.true
      for (const v of ['QF1:x', ' qf1:x', 'qf2:x', 'qf1', '', undefined, null, 1, {value: 'qf1:x'}]) {
        expect(isQf1String(v), JSON.stringify(v)).to.be.false
      }
    })
  })
})
