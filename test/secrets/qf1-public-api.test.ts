/**
 * The public qf1 module is the only one commands may import (bead
 * qfg-mol-hle PR 1). It must offer no deterministic path: no ephemeral-key
 * seam, no injectable randomness, no raw KDF/X25519 primitives.
 */
import {expect} from 'chai'

import * as qf1 from '../../src/secrets/qf1.js'

describe('qf1 public API (qfg-mol-hle)', () => {
  it('exports no seam and no raw primitive', () => {
    const exported = Object.keys(qf1)
    for (const name of [
      'sealWithEphemeralKey',
      'mintKeypairWith',
      'parseKeysetEnvWith',
      'x25519',
      'hmacSha256',
      'hkdf',
      'hkdfExtract',
      'hkdfExpand',
      'deriveKeyAndNonce',
      'buildAad',
    ]) {
      expect(exported, name).not.to.include(name)
    }
  })

  it('encrypt and mintKeypair take exactly one argument', () => {
    expect(qf1.encrypt.length).to.equal(1)
    expect(qf1.mintKeypair.length).to.equal(1)
  })

  it('exports what later commands need', () => {
    for (const name of [
      'encrypt',
      'decrypt',
      'parseQf1',
      'isQf1String',
      'parseKeysetEnv',
      'keysetFingerprints',
      'parsePrivateKeyEntry',
      'parsePublicKeyEntry',
      'formatPrivateKeyEntry',
      'formatPublicKeyEntry',
      'publicKeyFromPrivate',
      'fingerprint',
      'mintKeypair',
      'Qf1Error',
      'FINGERPRINT_RE',
      'KEYSET_NAME_RE',
    ]) {
      expect(Object.keys(qf1), name).to.include(name)
    }
  })

  it('keysetFingerprints returns only fingerprints, sorted, never key material', () => {
    const a = qf1.formatPrivateKeyEntry(Buffer.alloc(32, 1))
    const b = qf1.formatPrivateKeyEntry(Buffer.alloc(32, 2))
    const fps = qf1.keysetFingerprints('QUONFIG_KEYSET', `${b},${a}`)
    const expected = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)].map((k) => qf1.fingerprint(qf1.publicKeyFromPrivate(k)))
    expect(fps).to.deep.equal(expected.sort())
    expect(fps.every((fp) => qf1.FINGERPRINT_RE.test(fp))).to.be.true
  })
})
