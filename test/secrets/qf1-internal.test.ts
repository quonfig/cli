/**
 * The internal qf1 module (src/secrets/qf1-internal.ts): the deterministic
 * seams and the paths that only a stub can reach (bead qfg-mol-hle PR 1).
 * Only tests and src/secrets/qf1.ts may import it.
 */
import {expect} from 'chai'
import {createHash} from 'node:crypto'

import {Qf1Error, formatPrivateKeyEntry, formatPublicKeyEntry, publicKeyFromPrivate} from '../../src/secrets/qf1.js'
import {parseKeysetEnvWith, sealWithEphemeralKey, x25519} from '../../src/secrets/qf1-internal.js'

const label = (s: string) => createHash('sha256').update(`qfg-mol-hle qf1-internal.test.ts key: ${s}`).digest()
const priv = label('A')
/** A stand-in that throws `error` (keeps the callbacks shallow). */
const thrower = (error: unknown) => (): never => {
  throw error
}

const pub = publicKeyFromPrivate(priv)

describe('qf1 internal module (qfg-mol-hle)', () => {
  describe('sealWithEphemeralKey', () => {
    it('is deterministic for a given ephemeral key and needs no environment switch', () => {
      const input = {keyset: 'QUONFIG_KEYSET', plaintext: 'x', publicKey: pub}
      const saved = process.env.NODE_ENV
      try {
        process.env.NODE_ENV = 'production'
        expect(sealWithEphemeralKey(input, label('e'))).to.equal(sealWithEphemeralKey(input, label('e')))
      } finally {
        if (saved === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = saved
      }
    })

    it('refuses an ephemeral key that is not 32 bytes', () => {
      const input = {keyset: 'QUONFIG_KEYSET', plaintext: 'x', publicKey: pub}
      expect(() => sealWithEphemeralKey(input, label('e').subarray(0, 31))).to.throw(/32 bytes/)
    })
  })

  describe('parseKeysetEnvWith: only an invalid_key_entry becomes keyset_invalid', () => {
    const entry = formatPrivateKeyEntry(priv)

    it('an unexpected error from the entry parser propagates unchanged', () => {
      const boom = new TypeError('boom from the parser')
      expect(() => parseKeysetEnvWith(thrower(boom), 'QUONFIG_KEYSET', entry)).to.throw(boom)
    })

    it('a Qf1Error with another code propagates unchanged', () => {
      const other = new Qf1Error('malformed', 'not an entry problem')
      expect(() => parseKeysetEnvWith(thrower(other), 'QUONFIG_KEYSET', entry)).to.throw(other)
    })

    it('an invalid_key_entry becomes keyset_invalid naming the position', () => {
      let err: unknown
      try {
        parseKeysetEnvWith(thrower(new Qf1Error('invalid_key_entry', 'bad')), 'QUONFIG_KEYSET', `${entry}`)
      } catch (error) {
        err = error
      }

      expect(err).to.be.instanceOf(Qf1Error)
      expect(err).to.include({code: 'keyset_invalid', entry: 1, keyset: 'QUONFIG_KEYSET'})
    })
  })

  describe('x25519 maps only the OpenSSL all-zero refusal (spec 5.2)', () => {
    const u = publicKeyFromPrivate(label('B'))

    it('ERR_OSSL_FAILED_DURING_DERIVATION becomes 32 zero bytes', () => {
      const refusal = Object.assign(new Error('failed during derivation'), {code: 'ERR_OSSL_FAILED_DURING_DERIVATION'})
      const out = x25519(priv, u, thrower(refusal))
      expect(Buffer.from(out).equals(Buffer.alloc(32))).to.be.true
    })

    it('any other error propagates', () => {
      for (const other of [
        new Error('something else'),
        Object.assign(new Error('other openssl'), {code: 'ERR_OSSL_EVP_UNSUPPORTED'}),
        'a thrown string',
      ]) {
        let caught: unknown = 'nothing thrown'
        try {
          x25519(priv, u, thrower(other))
        } catch (error) {
          caught = error
        }

        expect(caught).to.equal(other)
      }
    })

    it('a real small-order input reaches the mapped refusal on this platform', () => {
      const order8 = Buffer.from('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex')
      expect(Buffer.from(x25519(priv, order8)).equals(Buffer.alloc(32))).to.be.true
      expect(formatPublicKeyEntry(pub).startsWith('qf1-pub-')).to.be.true
    })
  })
})
