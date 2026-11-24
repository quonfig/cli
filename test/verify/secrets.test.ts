/**
 * qfg-verify: the secrets family (bead qfg-8seuf.4, spec
 * project/plans/secrets-qf1-spec.md sections 2, 3, 4, 6.1, 10 and 11).
 *
 * The vectors in fixtures/qf1-verify-vectors.json are a reduced, public-only
 * copy of project/plans/secrets-qf1/vectors.json (TEST KEYS ONLY).
 */
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {isSmallOrder, parsePublicKeyEntry, parseQf1Keyless, x25519} from '../../src/verify/secrets.js'
import {readFilesFromCommit, runHookChecks} from '../../src/verify/standalone.js'
import {validateFileMap, validateWorkspace} from '../../src/verify/validate.js'

type Vectors = {
  decryptOnly: Array<{ciphertext: string; name: string}>
  keysets: Array<{fingerprints: string[]; name: string; publicKeys: string[]}>
  negative: Array<{ciphertext: string; expectedError: string; name: string}>
  positive: Array<{ciphertext: string; fingerprint: string; keyset: string; name: string}>
  publicKeyEntryCases: Array<{expectedError?: string; expectedHex?: string; input: string; name: string}>
}

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const vectors = JSON.parse(fs.readFileSync(path.join(fixtures, 'qf1-verify-vectors.json'), 'utf8')) as Vectors

/** The error classes a keyless parser can decide (spec 3.5 steps 1-6, decision 37). */
const KEYLESS_CLASSES = new Set(['invalid_ephemeral_key', 'invalid_keyset_name', 'malformed', 'unsupported_version'])

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))

const positive = (name: string) => vectors.positive.find((p) => p.name === name)!
const negative = (name: string) => vectors.negative.find((n) => n.name === name)!
const publicCase = (name: string) => vectors.publicKeyEntryCases.find((c) => c.name === name)!

const VALID_KEYSETS = Object.fromEntries(vectors.keysets.map((k) => [k.name, {publicKeys: k.publicKeys}]))

const always = [{operator: 'ALWAYS_TRUE'}]
const secretValue = (value: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  value,
  confidential: true,
  ...extra,
})

function secretDoc(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    type: 'secret',
    valueType: 'string',
    sendToClientSdk: false,
    default: {rules: [{criteria: always, value: secretValue(positive('bare-default-keyset').ciphertext)}]},
    environments: [
      {
        id: 'production',
        rules: [{criteria: always, value: secretValue(positive('two-key-keyset-write-key').ciphertext)}],
      },
    ],
    variants: [],
    ...overrides,
  }
}

function configDoc(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    type: 'config',
    valueType: 'string',
    default: {rules: [{criteria: always, value: {type: 'string', value: 'plain'}}]},
    environments: [],
    variants: [],
    ...overrides,
  }
}

/** An old-style encrypted config (the copy the temporary exception allows). */
function legacyEncryptedConfig(key: string): Record<string, unknown> {
  return configDoc(key, {
    default: {
      rules: [
        {
          criteria: always,
          value: {type: 'string', value: 'abc--def--ghi', confidential: true, decryptWith: 'quonfig.secrets.key'},
        },
      ],
    },
  })
}

function quonfigJson(secrets?: unknown): Record<string, unknown> {
  return secrets === undefined
    ? {environments: ['production', 'staging']}
    : {environments: ['production', 'staging'], secrets}
}

function workspace(entries: Record<string, unknown>, manifest: unknown = quonfigJson({keysets: VALID_KEYSETS})) {
  const map = new Map<string, string>()
  if (manifest !== null) map.set('quonfig.json', JSON.stringify(manifest))
  for (const [p, content] of Object.entries(entries)) {
    map.set(p, typeof content === 'string' ? content : JSON.stringify(content))
  }

  return map
}

function writeToDisk(map: Map<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-secrets-'))
  for (const [rel, content] of map) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
    fs.writeFileSync(path.join(dir, rel), content)
  }

  return dir
}

/**
 * Errors from BOTH validate paths (the in-memory file map the hook uses and the
 * disk walk `qfg verify` uses). They must agree as sets; duplicate-key messages
 * list files in path order, so compare sorted.
 */
function errors(map: Map<string, string>): string[] {
  const fromMap = validateFileMap(map, {validateValues: true})
    .issues.filter((i) => i.severity === 'error')
    .map((i) => `${i.file}: ${i.message}`)
  const dir = writeToDisk(map)
  try {
    const fromDisk = validateWorkspace(dir, {validateValues: true})
      .issues.filter((i) => i.severity === 'error')
      .map((i) => `${i.file}: ${i.message}`)
    const norm = (list: string[]) => list.map((e) => e.slice(e.indexOf(': ') + 2)).sort()
    expect(norm(fromDisk), 'disk path must agree with the file-map path').to.deep.equal(norm(fromMap))
  } finally {
    fs.rmSync(dir, {force: true, recursive: true})
  }

  return fromMap
}

const expectOneMatching = (list: string[], re: RegExp) =>
  expect(
    list.some((e) => re.test(e)),
    `expected an error matching ${re}, got ${JSON.stringify(list)}`,
  ).to.be.true

describe('verify: qf1 keyless primitives (qfg-8seuf.4)', () => {
  it('x25519 reproduces RFC 7748 section 6.1', () => {
    // RFC 7748 6.1 published test values (public, not secrets).
    const alicePriv = fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a') // gitleaks:allow
    const bobPub = fromHex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f') // gitleaks:allow
    const base = new Uint8Array(32)
    base[0] = 9
    expect(hex(x25519(alicePriv, base))).to.equal('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
    expect(hex(x25519(alicePriv, bobPub))).to.equal('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742')
  })

  it('isSmallOrder is false for every real public key in the vectors', () => {
    for (const keyset of vectors.keysets) {
      for (const entry of keyset.publicKeys) {
        const body = new Uint8Array(Buffer.from(entry.slice('qf1-pub-'.length), 'base64url'))
        expect(isSmallOrder(body), entry).to.be.false
      }
    }
  })

  describe('parseQf1Keyless against vectors.json', () => {
    for (const p of [...vectors.positive, ...vectors.decryptOnly]) {
      it(`accepts ${p.name}`, () => {
        const parsed = parseQf1Keyless(p.ciphertext)
        expect(parsed.ok, JSON.stringify(parsed)).to.be.true
        const expected = vectors.positive.find((v) => v.name === p.name)
        if (parsed.ok && expected) {
          expect(parsed.keyset).to.equal(expected.keyset)
          expect(parsed.fingerprint).to.equal(expected.fingerprint)
        }
      })
    }

    for (const n of vectors.negative) {
      if (KEYLESS_CLASSES.has(n.expectedError)) {
        it(`rejects ${n.name} as ${n.expectedError}`, () => {
          const parsed = parseQf1Keyless(n.ciphertext)
          expect(parsed.ok).to.be.false
          if (!parsed.ok) expect(parsed.errorClass).to.equal(n.expectedError)
        })
      } else {
        it(`parses ${n.name} (${n.expectedError} needs a key, not decidable keylessly)`, () => {
          expect(parseQf1Keyless(n.ciphertext).ok).to.be.true
        })
      }
    }
  })

  describe('parsePublicKeyEntry against vectors.json keyEntryCases', () => {
    for (const c of vectors.publicKeyEntryCases) {
      it(`${c.expectedError ? 'rejects' : 'accepts'} ${c.name}`, () => {
        const parsed = parsePublicKeyEntry(c.input)
        if (c.expectedError) {
          expect(parsed.ok, JSON.stringify(parsed)).to.be.false
        } else {
          expect(parsed.ok).to.be.true
          if (parsed.ok) expect(hex(parsed.publicKey)).to.equal(c.expectedHex)
        }
      })
    }

    it('derives each vector keyset fingerprint from its public key entry', () => {
      for (const keyset of vectors.keysets) {
        const fps = keyset.publicKeys.map((entry) => {
          const parsed = parsePublicKeyEntry(entry)
          return parsed.ok ? parsed.fingerprint : 'invalid'
        })
        expect(fps).to.deep.equal(keyset.fingerprints)
      }
    })
  })
})

describe('verify: secrets family (qfg-8seuf.4)', () => {
  describe('type and directory (spec 11.2)', () => {
    it('accepts the spec 10.2 example document in secrets/', () => {
      const map = workspace({'secrets/stripe.webhook.secret.json': secretDoc('stripe.webhook.secret')})
      expect(errors(map)).to.deep.equal([])
      expect(validateFileMap(map).filesChecked, 'secrets/ must be validated, not skipped').to.equal(1)
    })

    it('accepts every positive vector as a value, each in its own environment scope', () => {
      const doc = secretDoc('all.vectors', {
        default: {rules: vectors.positive.map((p) => ({criteria: always, value: secretValue(p.ciphertext)}))},
        environments: [
          {id: 'staging', rules: [{criteria: always, value: secretValue(vectors.decryptOnly[0].ciphertext)}]},
        ],
      })
      const map = workspace({'secrets/all.vectors.json': doc})
      expect(errors(map)).to.deep.equal([])
      expect(validateFileMap(map).filesChecked, 'secrets/ must be validated, not skipped').to.equal(1)
    })

    it('rejects a non-secret type in secrets/', () => {
      const doc = {...configDoc('a.b'), type: 'config'}
      expectOneMatching(errors(workspace({'secrets/a.b.json': doc})), /Type "config" in directory "secrets"/)
    })

    it('rejects type secret outside secrets/', () => {
      expectOneMatching(
        errors(workspace({'configs/a.b.json': secretDoc('a.b')})),
        /Type "secret" in directory "configs" \(expected "config"\)/,
      )
    })

    it('the hook reads secrets/ files from the pushed commit', () => {
      const dir = gitRepo()
      writeJson(dir, 'secrets/a.b.json', secretDoc('a.b'))
      writeJson(dir, 'quonfig.json', quonfigJson({keysets: VALID_KEYSETS}))
      const oid = commit(dir)
      expect([...readFilesFromCommit(oid, dir).keys()]).to.deep.equal(['secrets/a.b.json'])
    })
  })

  describe('quonfig.json secrets.keysets (spec 10.1, 11.1)', () => {
    const doc = {'secrets/a.b.json': secretDoc('a.b')}

    it('accepts a workspace without a secrets member', () => {
      expect(errors(workspace({'configs/x.json': configDoc('x')}, quonfigJson()))).to.deep.equal([])
    })

    it('accepts an empty keysets object', () => {
      expect(errors(workspace({'configs/x.json': configDoc('x')}, quonfigJson({keysets: {}})))).to.deep.equal([])
    })

    for (const bad of ['QUONFIG_KEYSETX', 'QUONFIG_KEYSET_', 'QUONFIG_KEYSET__A', 'QUONFIG_KEYSET_prod', 'HOME', '']) {
      it(`rejects keyset name ${JSON.stringify(bad)}`, () => {
        const keysets = {...VALID_KEYSETS, [bad]: {publicKeys: VALID_KEYSETS.QUONFIG_KEYSET.publicKeys}}
        expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /quonfig\.json: .*keyset name/)
      })
    }

    it('rejects a keyset name with a trailing LF', () => {
      const keysets = {...VALID_KEYSETS, 'QUONFIG_KEYSET_TEST\n': {publicKeys: VALID_KEYSETS.QUONFIG_KEYSET.publicKeys}}
      expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /quonfig\.json: .*keyset name/)
    })

    it('rejects an empty publicKeys list', () => {
      const keysets = {...VALID_KEYSETS, QUONFIG_KEYSET_EMPTY: {publicKeys: []}}
      expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /QUONFIG_KEYSET_EMPTY.*non-empty/)
    })

    it('rejects a keyset with no publicKeys member', () => {
      const keysets = {...VALID_KEYSETS, QUONFIG_KEYSET_NONE: {}}
      expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /QUONFIG_KEYSET_NONE.*publicKeys/)
    })

    for (const c of vectors.publicKeyEntryCases.filter((v) => v.expectedError)) {
      it(`rejects public key entry ${c.name}`, () => {
        const keysets = {...VALID_KEYSETS, QUONFIG_KEYSET_BAD: {publicKeys: [c.input]}}
        expectOneMatching(
          errors(workspace(doc, quonfigJson({keysets}))),
          /quonfig\.json: .*QUONFIG_KEYSET_BAD.*publicKeys\[0].*invalid_key_entry/,
        )
      })
    }

    it('rejects a small-order public key specifically', () => {
      const keysets = {
        ...VALID_KEYSETS,
        QUONFIG_KEYSET_BAD: {publicKeys: [publicCase('public-low-order-order-8-a').input]},
      }
      expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /small order/)
    })

    it('rejects a duplicate entry (identical entries share a fingerprint)', () => {
      const entry = VALID_KEYSETS.QUONFIG_KEYSET.publicKeys[0]
      const keysets = {...VALID_KEYSETS, QUONFIG_KEYSET: {publicKeys: [entry, entry]}}
      expectOneMatching(
        errors(workspace(doc, quonfigJson({keysets}))),
        /QUONFIG_KEYSET.*duplicate fingerprint 6a65019a/,
      )
    })

    it('rejects a non-string public key entry', () => {
      const keysets = {...VALID_KEYSETS, QUONFIG_KEYSET_BAD: {publicKeys: [42]}}
      expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /QUONFIG_KEYSET_BAD.*publicKeys\[0]/)
    })

    it('rejects an unknown member inside secrets', () => {
      expectOneMatching(
        errors(workspace(doc, quonfigJson({keysets: VALID_KEYSETS, rotation: {}}))),
        /quonfig\.json: .*unknown member "rotation"/,
      )
    })

    it('rejects an unknown member inside a keyset', () => {
      const keysets = {...VALID_KEYSETS, QUONFIG_KEYSET: {...VALID_KEYSETS.QUONFIG_KEYSET, writeKey: 0}}
      expectOneMatching(errors(workspace(doc, quonfigJson({keysets}))), /quonfig\.json: .*unknown member "writeKey"/)
    })

    it('rejects secrets that is not an object, and keysets that is not an object', () => {
      expectOneMatching(errors(workspace(doc, quonfigJson([]))), /quonfig\.json: .*"secrets" must be an object/)
      expectOneMatching(
        errors(workspace(doc, quonfigJson({keysets: []}))),
        /quonfig\.json: .*"secrets\.keysets" must be an object/,
      )
      expectOneMatching(
        errors(workspace(doc, quonfigJson({}))),
        /quonfig\.json: .*"secrets\.keysets" must be an object/,
      )
    })
  })

  describe('documents in secrets/ (spec 10.2, 11.3)', () => {
    const one = (doc: Record<string, unknown>, manifest?: unknown) =>
      errors(workspace({[`secrets/${doc.key}.json`]: doc}, manifest))

    const withDefault = (value: unknown, extra: Record<string, unknown> = {}) =>
      secretDoc('a.b', {default: {rules: [{criteria: always, value}]}, environments: [], ...extra})

    it('rejects a valueType other than string', () => {
      expectOneMatching(one(secretDoc('a.b', {valueType: 'json'})), /Secret must have valueType "string"/)
    })

    it('rejects sendToClientSdk true; accepts it absent', () => {
      expectOneMatching(one(secretDoc('a.b', {sendToClientSdk: true})), /Secret must not set sendToClientSdk to true/)
      const doc = secretDoc('a.b')
      delete doc.sendToClientSdk
      expect(one(doc)).to.deep.equal([])
    })

    it('accepts variants absent', () => {
      const doc = secretDoc('a.b')
      delete doc.variants
      expect(one(doc)).to.deep.equal([])
    })

    it('rejects non-empty variants', () => {
      expectOneMatching(
        one(secretDoc('a.b', {variants: [{value: secretValue(positive('short-ascii').ciphertext)}]})),
        /Secret must not have variants/,
      )
    })

    it('rejects a value without confidential: true', () => {
      const value = {type: 'string', value: positive('short-ascii').ciphertext}
      expectOneMatching(one(withDefault(value)), /default\.rules\[0].*confidential: true/)
      expectOneMatching(one(withDefault({...value, confidential: false})), /default\.rules\[0].*confidential: true/)
    })

    it('rejects decryptWith on a secret value', () => {
      expectOneMatching(
        one(withDefault(secretValue(positive('short-ascii').ciphertext, {decryptWith: 'some.key'}))),
        /default\.rules\[0].*decryptWith/,
      )
    })

    it('rejects a weighted value', () => {
      const weighted = {
        type: 'weighted_values',
        value: {weightedValues: [{value: secretValue(positive('short-ascii').ciphertext), weight: 100_000}]},
      }
      expectOneMatching(one(withDefault(weighted)), /default\.rules\[0].*weighted_values/)
    })

    it('rejects a provided value', () => {
      const provided = {type: 'provided', value: {source: 'ENV_VAR', lookup: 'STRIPE_KEY'}, confidential: true}
      expectOneMatching(one(withDefault(provided)), /default\.rules\[0].*provided/)
    })

    it('rejects a plain (non-qf1) string', () => {
      expectOneMatching(one(withDefault(secretValue('hunter2'))), /default\.rules\[0].*malformed/)
    })

    const keylessNegatives = vectors.negative.filter((n) => KEYLESS_CLASSES.has(n.expectedError))
    for (const n of keylessNegatives) {
      it(`rejects vector ${n.name} as ${n.expectedError}`, () => {
        const list = one(withDefault(secretValue(n.ciphertext)))
        expectOneMatching(list, new RegExp(`default\\.rules\\[0\\].*${n.expectedError}`))
      })
    }

    it('names the file, scope, rule index, keyset and fingerprint when the keyset is not declared', () => {
      const ct = positive('short-ascii').ciphertext // QUONFIG_KEYSET_TEST / b3f48931
      const others = Object.fromEntries(
        Object.entries(VALID_KEYSETS).filter(([name]) => name !== 'QUONFIG_KEYSET_TEST'),
      )
      const doc = secretDoc('a.b', {
        environments: [{id: 'production', rules: [{criteria: always, value: secretValue(ct)}]}],
      })
      expectOneMatching(
        one(doc, quonfigJson({keysets: others})),
        /^secrets\/a\.b\.json: environments\[production]\.rules\[0]: .*keyset QUONFIG_KEYSET_TEST.*not declared/,
      )
      expectOneMatching(one(doc, quonfigJson({keysets: others})), /b3f48931/)
    })

    it('rejects every value when quonfig.json has no secrets member at all', () => {
      expectOneMatching(one(secretDoc('a.b'), quonfigJson()), /keyset QUONFIG_KEYSET .*not declared/)
    })

    it('rejects a fingerprint not in the keyset publicKeys (a value on a retired key)', () => {
      // QUONFIG_KEYSET_TEST_PROD with only the write key left: the older-key value is stale.
      const older = positive('two-key-keyset-older-key')
      const keysets = {
        ...VALID_KEYSETS,
        QUONFIG_KEYSET_TEST_PROD: {publicKeys: [VALID_KEYSETS.QUONFIG_KEYSET_TEST_PROD.publicKeys[0]]},
      }
      expectOneMatching(
        one(withDefault(secretValue(older.ciphertext)), quonfigJson({keysets})),
        new RegExp(`default\\.rules\\[0\\]: .*fingerprint ${older.fingerprint}.*QUONFIG_KEYSET_TEST_PROD`),
      )
    })

    it('rejects a value whose ephemeral key is small order (decision 37)', () => {
      expectOneMatching(
        one(withDefault(secretValue(negative('ephemeral-low-order-order-8-b').ciphertext))),
        /invalid_ephemeral_key/,
      )
    })

    it('rejects a non-string value type even when valueType is string', () => {
      expectOneMatching(one(withDefault({type: 'bool', value: true, confidential: true})), /default\.rules\[0]/)
    })
  })

  describe('qf1 values outside secrets/ (spec 11.4)', () => {
    const ct = positive('short-ascii').ciphertext

    it('rejects a qf1 rule value in configs/', () => {
      const doc = configDoc('a.b', {default: {rules: [{criteria: always, value: {type: 'string', value: ct}}]}})
      expectOneMatching(
        errors(workspace({'configs/a.b.json': doc})),
        /^configs\/a\.b\.json: default\.rules\[0]: .*qf1 values belong in secrets\//,
      )
    })

    it('rejects a truncated qf1: prefix in a feature flag environment rule', () => {
      const doc = {
        key: 'f',
        type: 'feature_flag',
        valueType: 'string',
        default: {rules: [{criteria: always, value: {type: 'string', value: 'off'}}]},
        environments: [{id: 'production', rules: [{criteria: always, value: {type: 'string', value: 'qf1:'}}]}],
        variants: [],
      }
      expectOneMatching(
        errors(workspace({'feature-flags/f.json': doc})),
        /environments\[production]\.rules\[0]: .*qf1 values belong in secrets\//,
      )
    })

    it('rejects a qf1 weighted-value variant value', () => {
      const variants = [{value: {type: 'string', value: ct}}, {value: {type: 'string', value: 'b'}}]
      const weighted = {
        type: 'weighted_values',
        value: {
          weightedValues: [
            {value: {type: 'string', value: ct}, weight: 50_000},
            {value: {type: 'string', value: 'b'}, weight: 50_000},
          ],
        },
      }
      const doc = configDoc('a.b', {default: {rules: [{criteria: always, value: weighted}]}, variants})
      const list = errors(workspace({'configs/a.b.json': doc}))
      expectOneMatching(list, /default\.rules\[0]\.weightedValues\[0]: .*qf1 values belong in secrets\//)
      expectOneMatching(list, /variants\[0]: .*qf1 values belong in secrets\//)
    })

    it('rejects a qf1 top-level variant value', () => {
      const doc = configDoc('a.b', {variants: [{value: {type: 'string', value: ct}}]})
      expectOneMatching(errors(workspace({'configs/a.b.json': doc})), /variants\[0]: .*qf1 values belong in secrets\//)
    })

    it('does not flag a string that merely contains qf1: later on', () => {
      const doc = configDoc('a.b', {default: {rules: [{criteria: always, value: {type: 'string', value: 'x qf1:'}}]}})
      expect(errors(workspace({'configs/a.b.json': doc}))).to.deep.equal([])
    })
  })

  describe('duplicate keys across families, temporary exception (spec 11.6)', () => {
    const dupRe = /Duplicate key "stripe\.key"|differ only by case/

    it('allows configs/K (with decryptWith) beside secrets/K', () => {
      const map = workspace({
        'configs/stripe.key.json': legacyEncryptedConfig('stripe.key'),
        'secrets/stripe.key.json': secretDoc('stripe.key'),
      })
      expect(errors(map)).to.deep.equal([])
      expect(validateFileMap(map).filesChecked, 'both copies must be validated').to.equal(2)
    })

    it('still rejects configs/K without a decryptWith value beside secrets/K', () => {
      const map = workspace({
        'configs/stripe.key.json': configDoc('stripe.key'),
        'secrets/stripe.key.json': secretDoc('stripe.key'),
      })
      expectOneMatching(errors(map), dupRe)
    })

    it('still rejects confidential without decryptWith (empty decryptWith) in the configs copy', () => {
      const doc = configDoc('stripe.key', {
        default: {
          rules: [{criteria: always, value: {type: 'string', value: 'x', confidential: true, decryptWith: ''}}],
        },
      })
      expectOneMatching(
        errors(workspace({'configs/stripe.key.json': doc, 'secrets/stripe.key.json': secretDoc('stripe.key')})),
        dupRe,
      )
    })

    it('still rejects secrets/K beside feature-flags/K', () => {
      const flag = {...legacyEncryptedConfig('stripe.key'), type: 'feature_flag'}
      const map = workspace({
        'feature-flags/stripe.key.json': flag,
        'secrets/stripe.key.json': secretDoc('stripe.key'),
      })
      expectOneMatching(errors(map), dupRe)
    })

    it('still rejects case-differing keys across configs/ and secrets/', () => {
      const map = workspace({
        'configs/Stripe.Key.json': legacyEncryptedConfig('Stripe.Key'),
        'secrets/stripe.key.json': secretDoc('stripe.key'),
      })
      expectOneMatching(errors(map), /differ only by case/)
    })

    it('still rejects a three-way collision (configs + secrets + feature-flags)', () => {
      const flag = {...configDoc('stripe.key'), type: 'feature_flag'}
      const map = workspace({
        'configs/stripe.key.json': legacyEncryptedConfig('stripe.key'),
        'feature-flags/stripe.key.json': flag,
        'secrets/stripe.key.json': secretDoc('stripe.key'),
      })
      expectOneMatching(errors(map), dupRe)
    })
  })

  describe('pre-receive hook: a quonfig.json-only change re-checks secrets/ (spec 11.5, decision 21)', () => {
    it('rejects removing a public key that values in secrets/ still use', () => {
      const dir = gitRepo()
      writeJson(dir, 'quonfig.json', quonfigJson({keysets: VALID_KEYSETS}))
      writeJson(dir, 'secrets/a.b.json', secretDoc('a.b'))
      const first = commit(dir)

      const lines: string[] = []
      const run = (oldOid: string, newOid: string) =>
        runHookChecks([{newOid, oldOid, refName: 'refs/heads/main'}], {
          cwd: dir,
          env: {},
          log: (l) => lines.push(l),
          logErr: (l) => lines.push(l),
        })

      // The first commit (on a non-main ref, so the append-only rule is not involved) is valid.
      expect(
        runHookChecks([{newOid: first, oldOid: '0'.repeat(40), refName: 'refs/heads/x'}], {
          cwd: dir,
          env: {},
          log: (l) => lines.push(l),
          logErr: (l) => lines.push(l),
        }),
      ).to.equal(0, lines.join('\n'))

      // Retire the write key of QUONFIG_KEYSET_TEST_PROD: the production value is still on it.
      const keysets = {
        ...VALID_KEYSETS,
        QUONFIG_KEYSET_TEST_PROD: {publicKeys: [VALID_KEYSETS.QUONFIG_KEYSET_TEST_PROD.publicKeys[1]]},
      }
      writeJson(dir, 'quonfig.json', quonfigJson({keysets}))
      const second = commit(dir)
      lines.length = 0
      expect(run(first, second)).to.equal(1)
      expect(lines.join('\n')).to.match(/fingerprint 9a37dd78.*QUONFIG_KEYSET_TEST_PROD/)
    })
  })
})

// ── git helpers (real repos, as standalone.test.ts does) ──────────────────

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-secrets-hook-'))
  execFileSync('git', ['init', '--quiet'], {cwd: dir})
  execFileSync('git', ['config', 'user.email', 'test@quonfig.test'], {cwd: dir})
  execFileSync('git', ['config', 'user.name', 'test'], {cwd: dir})
  return dir
}

function writeJson(dir: string, rel: string, content: unknown): void {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(content, null, 2))
}

function commit(dir: string): string {
  execFileSync('git', ['add', '-A'], {cwd: dir})
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {cwd: dir})
  return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: dir, encoding: 'utf8'}).trim()
}
