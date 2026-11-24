/**
 * The public qf1 module is the only one commands may import (bead
 * qfg-mol-hle PR 1). It must offer no deterministic path: no ephemeral-key
 * seam, no injectable randomness, no raw KDF/X25519 primitives, no live
 * internal buffers. Its export list is pinned EXACTLY (source and built dist):
 * adding an export, under any name, fails here until this list is updated on
 * purpose.
 */
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import * as qf1 from '../../src/secrets/qf1.js'

const PUBLIC_EXPORTS = [
  'FINGERPRINT_RE',
  'KEYSET_NAME_RE',
  'PRIVATE_KEY_PREFIX',
  'PUBLIC_KEY_PREFIX',
  'Qf1Error',
  'decrypt',
  'encrypt',
  'fingerprint',
  'formatPrivateKeyEntry',
  'formatPublicKeyEntry',
  'isQf1String',
  'keysetFingerprints',
  'mintKeypair',
  'parseKeysetEnv',
  'parsePrivateKeyEntry',
  'parsePublicKeyEntry',
  'parseQf1',
  'publicKeyFromPrivate',
]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('qf1 public API (qfg-mol-hle)', () => {
  it('exports exactly the pinned list (source)', () => {
    expect(Object.keys(qf1).sort()).to.deep.equal([...PUBLIC_EXPORTS].sort())
  })

  it('exports exactly the pinned list (built dist, what the published CLI ships)', async () => {
    const built = path.join(root, 'dist', 'secrets', 'qf1.js')
    expect(fs.existsSync(built), 'run yarn build first (CI builds before tests)').to.be.true
    const dist = (await import(pathToFileURL(built).href)) as Record<string, unknown>
    expect(Object.keys(dist).sort()).to.deep.equal([...PUBLIC_EXPORTS].sort())
  })

  it('encrypt and mintKeypair take exactly one argument', () => {
    expect(qf1.encrypt.length).to.equal(1)
    expect(qf1.mintKeypair.length).to.equal(1)
  })

  describe('extra arguments and properties are ignored (no hidden seam)', () => {
    const recipient = qf1.formatPublicKeyEntry(qf1.publicKeyFromPrivate(Buffer.alloc(32, 5)))
    const fixed = Buffer.alloc(32, 9)
    const extras = {ephemeralKey: fixed, ephemeralPrivateKey: fixed, random: () => fixed, rng: () => fixed, seed: fixed}
    const call = (...args: unknown[]) => (qf1.encrypt as (...a: unknown[]) => string)(...args)

    it('encrypt with a second argument still draws a fresh ephemeral key', () => {
      const input = {keyset: 'QUONFIG_KEYSET', plaintext: 'x', recipient}
      for (const second of [fixed, () => fixed, extras, {ephemeralPrivateKey: fixed}]) {
        expect(call(input, second)).not.to.equal(call(input, second))
      }
    })

    it('encrypt with extra properties still draws a fresh ephemeral key', () => {
      const input = {keyset: 'QUONFIG_KEYSET', plaintext: 'x', recipient, ...extras}
      expect(call(input)).not.to.equal(call(input))
      expect(call(input, extras)).not.to.equal(call(input, extras))
    })

    it('mintKeypair ignores an injected random source', () => {
      const mint = qf1.mintKeypair as (...a: unknown[]) => qf1.Keypair
      const fixedFp = qf1.fingerprint(qf1.publicKeyFromPrivate(fixed))
      const a = mint(new Set(), () => fixed, extras)
      const b = mint(new Set(), () => fixed, extras)
      expect(a.fingerprint).not.to.equal(b.fingerprint)
      expect([a.fingerprint, b.fingerprint]).not.to.include(fixedFp)
    })
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
