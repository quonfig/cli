/**
 * Keysets read from a workspace's quonfig.json (spec 10.1) and what this
 * machine holds for them (bead qfg-mol-hle PR 2).
 */
import {expect} from 'chai'

import {formatPublicKeyEntry} from '../../src/secrets/qf1.js'
import {localKeysetStatus, readWorkspaceKeysets} from '../../src/secrets/workspace-keysets.js'
import {quonfigJson, testKey} from './plumbing-fixtures.js'

describe('readWorkspaceKeysets (spec 10.1, qfg-mol-hle)', () => {
  const a = testKey()
  const b = testKey()
  const c = testKey()

  it('reads keysets in file order with publicKeys[0] as the write key', () => {
    const text = quonfigJson({
      QUONFIG_KEYSET_PROD: {publicKeys: [a.publicEntry, b.publicEntry]},
      QUONFIG_KEYSET: {publicKeys: [c.publicEntry]},
    })
    const {keysets, problems} = readWorkspaceKeysets(text)
    expect(problems).to.deep.equal([])
    expect(keysets.map((k) => k.name)).to.deep.equal(['QUONFIG_KEYSET_PROD', 'QUONFIG_KEYSET'])
    const [prod, dflt] = keysets
    expect(prod.writeKey).to.deep.equal({entry: a.publicEntry, fingerprint: a.fingerprint, ok: true})
    expect(prod.fingerprints).to.deep.equal([a.fingerprint, b.fingerprint])
    expect(dflt.writeKey).to.deep.equal({entry: c.publicEntry, fingerprint: c.fingerprint, ok: true})
  })

  it('marks a keyset whose publicKeys[0] is invalid as unwritable, naming the place and the reason', () => {
    const topBit = new Uint8Array(32).fill(7)
    topBit[31] = 0x80
    const text = quonfigJson({QUONFIG_KEYSET_BAD: {publicKeys: [formatPublicKeyEntry(topBit), a.publicEntry]}})
    const {keysets, problems} = readWorkspaceKeysets(text)
    expect(keysets).to.have.length(1)
    expect(keysets[0].writeKey.ok).to.equal(false)
    expect(keysets[0].writeKey).to.deep.include({
      problem: 'quonfig.json secrets.keysets.QUONFIG_KEYSET_BAD.publicKeys[0]: public key entry has the top bit set',
    })
    expect(keysets[0].fingerprints).to.deep.equal([a.fingerprint])
    expect(problems.join('\n')).to.include('publicKeys[0]: invalid_key_entry')
  })

  it('marks a keyset with an empty publicKeys list as unwritable', () => {
    const {keysets} = readWorkspaceKeysets(quonfigJson({QUONFIG_KEYSET: {publicKeys: []}}))
    expect(keysets[0].writeKey).to.deep.equal({
      ok: false,
      problem: 'quonfig.json secrets.keysets.QUONFIG_KEYSET.publicKeys is empty',
    })
  })

  it('leaves out a keyset with an invalid name and reports it', () => {
    const {keysets, problems} = readWorkspaceKeysets(quonfigJson({HOME: {publicKeys: [a.publicEntry]}}))
    expect(keysets).to.deep.equal([])
    expect(problems.join('\n')).to.include('keyset name "HOME" does not match')
  })

  it('no secrets member, or no quonfig.json at all, means no keysets', () => {
    expect(readWorkspaceKeysets(quonfigJson()).keysets).to.deep.equal([])
    const missing = readWorkspaceKeysets()
    expect(missing.keysets).to.deep.equal([])
    expect(missing.problems).to.deep.equal(['quonfig.json is missing'])
  })

  it('unparseable quonfig.json: no keysets, one problem', () => {
    const r = readWorkspaceKeysets('{not json')
    expect(r.keysets).to.deep.equal([])
    expect(r.problems).to.deep.equal(['quonfig.json is not valid JSON'])
  })

  it('returns no key material beyond public entries and fingerprints', () => {
    const text = quonfigJson({QUONFIG_KEYSET: {publicKeys: [a.publicEntry]}})
    const json = JSON.stringify(readWorkspaceKeysets(text))
    expect(json).to.not.include('qf1-priv-')
    expect(json).to.not.include(Buffer.from(a.privateKey).toString('base64url'))
  })
})

/** An env whose every property access (get, has, own-property lookup, key listing) is recorded. */
function recordingEnv(values: Record<string, string>, read: string[]): Record<string, string> {
  return new Proxy(values, {
    get(target, prop) {
      read.push(String(prop))
      return target[prop as string]
    },
    getOwnPropertyDescriptor(target, prop) {
      read.push(String(prop))
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
    has(target, prop) {
      read.push(String(prop))
      return prop in target
    },
    ownKeys(target) {
      read.push('<ownKeys>')
      return Reflect.ownKeys(target)
    },
  })
}

describe('localKeysetStatus (qfg-mol-hle)', () => {
  const write = testKey()
  const other = testKey()

  it('reads-write-key when the env var holds the write key', () => {
    const env = {QUONFIG_KEYSET_PROD: `${other.privateEntry}, ${write.privateEntry}`}
    expect(localKeysetStatus('QUONFIG_KEYSET_PROD', write.fingerprint, env)).to.deep.equal({
      held: [other.fingerprint, write.fingerprint].sort(),
      status: 'reads-write-key',
    })
  })

  it('holds-other-keys when the env var holds only other keys', () => {
    const env = {QUONFIG_KEYSET_PROD: other.privateEntry}
    expect(localKeysetStatus('QUONFIG_KEYSET_PROD', write.fingerprint, env)).to.deep.equal({
      held: [other.fingerprint],
      status: 'holds-other-keys',
    })
  })

  it('absent when the env var is unset, empty or only separators', () => {
    for (const env of [{}, {QUONFIG_KEYSET_PROD: ''}, {QUONFIG_KEYSET_PROD: ' , \n'}]) {
      expect(localKeysetStatus('QUONFIG_KEYSET_PROD', write.fingerprint, env)).to.deep.equal({status: 'absent'})
    }
  })

  it('invalid names the entry position only, never its text', () => {
    const env = {QUONFIG_KEYSET_PROD: `${write.privateEntry},not-a-key-SENTINEL-TEXT`}
    const status = localKeysetStatus('QUONFIG_KEYSET_PROD', write.fingerprint, env)
    expect(status).to.deep.equal({entry: 2, status: 'invalid'})
    expect(JSON.stringify(status)).to.not.include('SENTINEL')
  })

  it('reads only the variable named by the keyset', () => {
    const read: string[] = []
    const env = recordingEnv({HOME: '/home/x', QUONFIG_KEYSET_PROD: write.privateEntry}, read)
    localKeysetStatus('QUONFIG_KEYSET_PROD', write.fingerprint, env)
    expect([...new Set(read)]).to.deep.equal(['QUONFIG_KEYSET_PROD'])
  })

  it('reads only an own property: a keyset on the env prototype is absent', () => {
    const env = Object.create({QUONFIG_KEYSET_PROD: write.privateEntry}) as Record<string, string>
    expect(env.QUONFIG_KEYSET_PROD, 'inherited, visible to a plain lookup').to.equal(write.privateEntry)
    expect(localKeysetStatus('QUONFIG_KEYSET_PROD', write.fingerprint, env)).to.deep.equal({status: 'absent'})
  })

  it('an invalid keyset name never reads the environment', () => {
    const read: string[] = []
    const env = recordingEnv({HOME: '/home/x'}, read)
    expect(localKeysetStatus('HOME', write.fingerprint, env)).to.deep.equal({status: 'absent'})
    expect(read).to.deep.equal([])
  })
})
