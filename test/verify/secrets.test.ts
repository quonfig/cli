/**
 * qfg-verify: the secrets family (bead qfg-8seuf.4, spec
 * project/plans/secrets-qf1-spec.md sections 2, 3, 4, 6.1, 10 and 11).
 *
 * The vectors in fixtures/qf1-verify-vectors.json are a reduced, public-only
 * copy of project/plans/secrets-qf1/vectors.json (TEST KEYS ONLY). The one spec
 * key-entry case whose input is a private key entry (public-given-private-entry)
 * is built at runtime below, so no private-key-shaped literal is in the repo.
 */
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  decodeBase64UrlStrict,
  isSmallOrder,
  parsePublicKeyEntry,
  parseQf1Keyless,
  parseQf1Structure,
  quoteUntrustedName,
  SECRET_VALUE_HINT,
} from '../../src/verify/secrets.js'
import {readFilesFromCommit, runHookChecks} from '../../src/verify/standalone.js'
import {validateFileMap, validateWorkspace} from '../../src/verify/validate.js'
import {isSmallOrderByLadder, x25519} from './x25519-oracle.js'

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

/** A valid public key entry's 43-character body, for prefix cases built at runtime. */
const VALID_PUBLIC_BODY = vectors.keysets[0].publicKeys[0].slice('qf1-pub-'.length)

/**
 * Public key entry inputs that must be rejected: the fixture's, plus cases
 * built here. `public-given-private-entry` mirrors the spec vector of that name
 * (a private entry where a public one belongs); its body is a public key body,
 * which is irrelevant to the check (the prefix decides).
 */
const INVALID_PUBLIC_ENTRIES: Array<{input: string; name: string}> = [
  ...vectors.publicKeyEntryCases.filter((c) => c.expectedError),
  {input: ['qf1', 'priv', VALID_PUBLIC_BODY].join('-'), name: 'public-given-private-entry'},
  {input: `QF1-PUB-${VALID_PUBLIC_BODY}`, name: 'public-uppercase-prefix'},
  {input: `qf2-pub-${VALID_PUBLIC_BODY}`, name: 'public-wrong-8-char-prefix'},
]

const P = 2n ** 255n - 19n
const leBytes = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v % 256n)
    v /= 256n
  }

  return out
}

/**
 * Deterministic 32-byte samples (mulberry32, fixed seed) so a failing random
 * case is reproducible: the failure message names the sample index.
 */
function seededBytes(seed: number, count: number): Uint8Array[] {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) & 0xff
  }

  return Array.from({length: count}, () => Uint8Array.from({length: 32}, next))
}

const ephemeralOf = (ciphertext: string): Uint8Array =>
  new Uint8Array(Buffer.from(ciphertext.split(':')[3], 'base64url').subarray(0, 32))

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

  describe('small-order membership test agrees with the X25519 ladder (spec 6.1 definition)', () => {
    const agree = (u: Uint8Array, label: string) =>
      expect(isSmallOrder(u), `${label}: ${hex(u)}`).to.equal(isSmallOrderByLadder(u))

    it('on all seven top-bit-clear small-order encodings (0, 1, p-1, p, p+1, both order-8 points)', () => {
      const order8 = [
        325_606_250_916_557_431_795_983_626_356_110_631_294_008_115_727_848_805_560_023_387_167_927_233_504n,
        39_382_357_235_489_614_581_723_060_781_553_021_112_529_911_719_440_698_176_882_885_853_963_445_705_823n,
      ]
      for (const u of [0n, 1n, P - 1n, P, P + 1n, ...order8]) {
        expect(isSmallOrder(leBytes(u)), u.toString()).to.be.true
        agree(leBytes(u), u.toString())
      }
    })

    it('on every public key and ephemeral key in the vectors', () => {
      for (const c of vectors.publicKeyEntryCases) {
        const body = Buffer.from(c.input.slice(c.input.lastIndexOf('-') + 1), 'base64url')
        if (body.length === 32) agree(new Uint8Array(body), c.name)
      }

      for (const k of vectors.keysets) {
        for (const entry of k.publicKeys) agree(new Uint8Array(Buffer.from(entry.slice(8), 'base64url')), entry)
      }

      for (const c of [...vectors.positive, ...vectors.decryptOnly, ...vectors.negative]) {
        const parts = c.ciphertext.split(':')
        const blob = parts.length === 4 ? Buffer.from(parts[3], 'base64url') : Buffer.alloc(0)
        if (blob.length >= 32 && (blob[31] & 0x80) === 0) agree(ephemeralOf(c.ciphertext), c.name)
      }
    })

    it('on 300 seeded random top-bit-clear u, and on the neighbours of each small-order u', () => {
      // The structured cases (every small-order encoding, top-bit aliases,
      // neighbours, vector keys) carry the proof; this sample is a smoke test,
      // kept small because each ladder costs ~1-2 ms (CI timeout is 10 s).
      for (const [i, u] of seededBytes(0x51_f1_5e_ed, 300).entries()) {
        u[31] &= 0x7f
        agree(u, `seeded sample ${i}`)
      }

      for (const u of [2n, P - 2n, P + 2n, 2n ** 255n - 1n]) agree(leBytes(u), u.toString())

      // Top bit set: masked first, as X25519 does (callers reject these
      // encodings earlier, but the function must still match the definition).
      for (const u of [0n, 1n, P - 1n]) {
        const bytes = leBytes(u)
        bytes[31] |= 0x80
        agree(bytes, `${u} with top bit set`)
      }
    })
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

  it('truncates an unsupported version echoed in the reason', () => {
    const parsed = parseQf1Keyless(`qf${'9'.repeat(10_000)}:QUONFIG_KEYSET:00000000:AAAA`)
    expect(parsed.ok).to.be.false
    if (!parsed.ok) {
      expect(parsed.errorClass).to.equal('unsupported_version')
      expect(parsed.reason.length, parsed.reason.slice(0, 200)).to.be.below(120)
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

    for (const c of INVALID_PUBLIC_ENTRIES.filter((e) => !vectors.publicKeyEntryCases.some((v) => v.name === e.name))) {
      it(`rejects ${c.name} (built at runtime)`, () => {
        const parsed = parsePublicKeyEntry(c.input)
        expect(parsed.ok, JSON.stringify(parsed)).to.be.false
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

    for (const c of INVALID_PUBLIC_ENTRIES) {
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

    it('rejects secrets: null', () => {
      expectOneMatching(errors(workspace(doc, quonfigJson(null))), /quonfig\.json: .*"secrets" must be an object/)
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
      expectOneMatching(one(withDefault(weighted)), /default\.rules\[0]: weighted_values are not allowed in a secret/)
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

    it('still rejects a configs/ copy whose decryptWith value is not confidential: true', () => {
      const doc = configDoc('stripe.key', {
        default: {rules: [{criteria: always, value: {type: 'string', value: 'abc--def', decryptWith: 'k'}}]},
      })
      expectOneMatching(
        errors(workspace({'configs/stripe.key.json': doc, 'secrets/stripe.key.json': secretDoc('stripe.key')})),
        dupRe,
      )
    })

    it('counts RULE values only: a decryptWith inside weighted_values does not qualify the configs/ copy', () => {
      const encrypted = {type: 'string', value: 'abc--def', confidential: true, decryptWith: 'k'}
      const weighted = {type: 'weighted_values', value: {weightedValues: [{value: encrypted, weight: 100_000}]}}
      const doc = configDoc('stripe.key', {
        default: {rules: [{criteria: always, value: weighted}]},
        variants: [{value: encrypted}],
      })
      expectOneMatching(
        errors(workspace({'configs/stripe.key.json': doc, 'secrets/stripe.key.json': secretDoc('stripe.key')})),
        dupRe,
      )
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

  describe('unparseable quonfig.json (spec 11.5)', () => {
    const secretOnly = {'secrets/a.b.json': secretDoc('a.b')}
    const notDeclared = /not declared|not in quonfig\.json/
    const cannotCheck = /quonfig\.json: .*secrets\/ values cannot be checked/
    const errorList = (issues: Array<{file: string; message: string; severity: string}>) =>
      issues.filter((i) => i.severity === 'error').map((i) => `${i.file}: ${i.message}`)

    // Not `errors()`: on origin/main the two paths already differ for an
    // unparseable quonfig.json (the disk path also reports the missing
    // "environments" array), so each path is checked on its own here.
    const bothPaths = (map: Map<string, string>): string[][] => {
      const dir = writeToDisk(map)
      try {
        return [errorList(validateFileMap(map).issues), errorList(validateWorkspace(dir).issues)]
      } finally {
        fs.rmSync(dir, {force: true, recursive: true})
      }
    }

    const expectOneClearError = (list: string[]) => {
      expect(list.filter((e) => cannotCheck.test(e)).length, JSON.stringify(list)).to.equal(1)
      expect(list.filter((e) => notDeclared.test(e)).length, JSON.stringify(list)).to.equal(0)
    }

    it('gives ONE clear quonfig.json error, not a per-value "not declared", when secrets/ documents exist', () => {
      for (const list of bothPaths(new Map([...workspace(secretOnly, null), ['quonfig.json', '{not json']]))) {
        expectOneClearError(list)
      }
    })

    it('does the same when the hook passes it as options.quonfigJson', () => {
      expectOneClearError(errorList(validateFileMap(workspace(secretOnly, null), {quonfigJson: '{not json'}).issues))
    })

    it('still runs the qf1 grammar check on each value', () => {
      const doc = secretDoc('a.b', {
        default: {rules: [{criteria: always, value: secretValue('qf1:QUONFIG_KEYSET:XYZ:abc')}]},
        environments: [],
      })
      for (const list of bothPaths(new Map([...workspace({'secrets/a.b.json': doc}, null), ['quonfig.json', '{']]))) {
        expectOneClearError(list)
        expectOneMatching(list, /default\.rules\[0]: qf1 malformed/)
      }
    })

    for (const [label, content, reason] of [
      ['JSON null', 'null', /is not a JSON object/],
      ['a JSON array', '[]', /is not a JSON object/],
      ['an empty file', '', /is empty/],
      ['whitespace only', ' \n', /is empty/],
    ] as const) {
      it(`says quonfig.json ${String(reason).slice(1, -1)} for ${label}`, () => {
        for (const list of bothPaths(new Map([...workspace(secretOnly, null), ['quonfig.json', content]]))) {
          expectOneClearError(list)
          expectOneMatching(list, reason)
        }
      })
    }

    it('adds nothing when there are no secrets/ documents', () => {
      const configsOnly = workspace({'configs/x.json': configDoc('x')}, null)
      expect(validateFileMap(configsOnly, {quonfigJson: '{not json'}).issues).to.deep.equal([])
      for (const content of ['{not json', 'null', '[]', '']) {
        for (const list of bothPaths(new Map([...configsOnly, ['quonfig.json', content]]))) {
          expect(list.filter((e) => cannotCheck.test(e))).to.deep.equal([])
        }
      }
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

/**
 * qfg-mol-hle PR 1: parseQf1Keyless is split into parseQf1Structure (spec 3.5
 * steps 1-6) and the decision-37 small-order test, so a key-holding reader can
 * report keyset_missing / key_not_held (spec 8 steps 2-3) before
 * invalid_ephemeral_key (step 4). The split must not change what qfg-verify
 * decides. preSplitParseQf1Keyless is the function as merged in #116
 * (cli 55869fb), kept here verbatim as the oracle.
 */
const preSplitParseQf1Keyless = (() => {
  const KEYSET_NAME_RE = /^QUONFIG_KEYSET(?:_[\dA-Z]+)*$/
  const FINGERPRINT_RE = /^[\da-f]{8}$/
  const VERSION_PREFIX_RE = /^qf[1-9]\d*:/
  const B64URL_RE = /^[\w-]+$/
  const QF1_PREFIX = 'qf1:'
  const MIN_PAYLOAD_BYTES = 48
  function decodeBase64UrlStrict(text: string): undefined | Uint8Array {
    if (text.length === 0 || !B64URL_RE.test(text) || text.length % 4 === 1) return undefined
    const bytes = Buffer.from(text, 'base64url')
    if (bytes.toString('base64url') !== text) return undefined
    return new Uint8Array(bytes)
  }

  type R =
    | {ephemeralPublicKey: Uint8Array; fingerprint: string; keyset: string; ok: true}
    | {errorClass: string; ok: false; reason: string}
  const fail = (errorClass: string, reason: string): R => ({errorClass, ok: false, reason})
  const quoteName = (name: string): string => JSON.stringify(name.slice(0, 64))
  return (value: unknown): R => {
    if (typeof value !== 'string') return fail('malformed', 'value is not a string')
    if (!value.startsWith(QF1_PREFIX)) {
      return VERSION_PREFIX_RE.test(value)
        ? fail('unsupported_version', `version ${quoteName(value.slice(0, value.indexOf(':')))} is not supported`)
        : fail('malformed', 'value does not start with "qf1:"')
    }

    const fields = value.split(':')
    if (fields.length !== 4) return fail('malformed', `expected 4 colon-separated fields, found ${fields.length}`)
    const [, keyset, fingerprint, payloadText] = fields
    if (!KEYSET_NAME_RE.test(keyset)) {
      return fail('invalid_keyset_name', `keyset name ${quoteName(keyset)} does not match ${KEYSET_NAME_RE.source}`)
    }

    if (!FINGERPRINT_RE.test(fingerprint)) return fail('malformed', 'fingerprint is not 8 lowercase hex characters')
    const payload = decodeBase64UrlStrict(payloadText)
    if (!payload) return fail('malformed', 'payload is not canonical unpadded base64url')
    if (payload.length < MIN_PAYLOAD_BYTES) {
      return fail('malformed', `payload is ${payload.length} bytes; minimum is ${MIN_PAYLOAD_BYTES}`)
    }

    const ephemeralPublicKey = payload.subarray(0, 32)
    if ((ephemeralPublicKey[31] & 0x80) !== 0) return fail('malformed', 'ephemeral public key has the top bit set')
    if (isSmallOrder(ephemeralPublicKey)) {
      return fail('invalid_ephemeral_key', 'ephemeral public key is a point of small order')
    }

    return {ephemeralPublicKey, fingerprint, keyset, ok: true}
  }
})()

describe('verify: parseQf1Keyless split (qfg-mol-hle)', () => {
  const sample = positive('short-ascii').ciphertext
  const inputs: unknown[] = [
    ...vectors.positive.map((p) => p.ciphertext),
    ...vectors.decryptOnly.map((p) => p.ciphertext),
    ...vectors.negative.map((n) => n.ciphertext),
    undefined,
    null,
    42,
    {},
    '',
    'qf1:',
    'qf0:x',
    'qf12:QUONFIG_KEYSET:00000000:AAAA',
    `qf${'9'.repeat(10_000)}:QUONFIG_KEYSET:00000000:AAAA`,
    sample.slice(0, -1),
    sample + 'A',
    sample.replace('QUONFIG_KEYSET_TEST', 'QUONFIG_KEYSET_TEST\u0000'),
  ]

  it('parseQf1Keyless is unchanged on every fixture value', () => {
    for (const input of inputs) {
      const label = typeof input === 'string' ? input.slice(0, 80) : String(input)
      expect(parseQf1Keyless(input), label).to.deep.equal(preSplitParseQf1Keyless(input))
    }
  })

  it('parseQf1Structure leaves small-order E to the caller', () => {
    const lowOrder = vectors.negative.filter((n) => n.name.startsWith('ephemeral-low-order-'))
    expect(lowOrder).to.have.length(7)
    for (const n of lowOrder) {
      const keyless = parseQf1Keyless(n.ciphertext)
      expect(keyless.ok, n.name).to.be.false
      if (!keyless.ok) expect(keyless.errorClass).to.equal('invalid_ephemeral_key')
      const structure = parseQf1Structure(n.ciphertext)
      expect(structure.ok, n.name).to.be.true
      if (structure.ok) expect(isSmallOrder(structure.ephemeralPublicKey), n.name).to.be.true
    }
  })

  it('parseQf1Structure returns E, C || T and the AAD of spec 3.5 / 5.4', () => {
    for (const p of vectors.positive) {
      const parsed = parseQf1Structure(p.ciphertext)
      expect(parsed.ok, p.name).to.be.true
      if (!parsed.ok) continue
      const blob = Buffer.from(p.ciphertext.split(':')[3], 'base64url')
      expect(parsed.keyset).to.equal(p.keyset)
      expect(parsed.fingerprint).to.equal(p.fingerprint)
      expect(hex(parsed.ephemeralPublicKey)).to.equal(hex(blob.subarray(0, 32)))
      expect(hex(parsed.ciphertextAndTag)).to.equal(hex(blob.subarray(32)))
      expect(Buffer.from(parsed.aad).toString('latin1')).to.equal(`qf1:${p.keyset}:${p.fingerprint}:`)
    }
  })

  it('parseQf1Structure decides every keyless class but invalid_ephemeral_key exactly as parseQf1Keyless', () => {
    for (const input of inputs) {
      const keyless = parseQf1Keyless(input)
      const structure = parseQf1Structure(input)
      if (!keyless.ok && keyless.errorClass === 'invalid_ephemeral_key') {
        expect(structure.ok).to.be.true
      } else if (keyless.ok) {
        expect(structure.ok).to.be.true
      } else {
        expect(structure).to.deep.equal(keyless)
      }
    }
  })

  it('decodeBase64UrlStrict is canonical unpadded base64url (spec 3.4)', () => {
    expect(decodeBase64UrlStrict('')).to.equal(undefined)
    expect(decodeBase64UrlStrict('AA==')).to.equal(undefined)
    expect(decodeBase64UrlStrict('A')).to.equal(undefined)
    expect(decodeBase64UrlStrict('AB')).to.equal(undefined) // non-zero trailing bits
    expect(decodeBase64UrlStrict('+w')).to.equal(undefined)
    expect(hex(decodeBase64UrlStrict('_w')!)).to.equal('ff')
  })

  it('the hint for a bad secrets/ value names no command that does not exist', () => {
    const doc = secretDoc('a.b', {
      default: {rules: [{criteria: always, value: secretValue('qf1:QUONFIG_KEYSET:0000000:AAAA')}]},
      environments: [],
    })
    const {issues} = validateFileMap(workspace({'secrets/a.b.json': doc}), {validateValues: true})
    const issue = issues.find((i) => /qf1 malformed/.test(i.message))
    expect(issue, JSON.stringify(issues)).to.exist
    expect(issue!.suggestion).to.equal(SECRET_VALUE_HINT)
    expect(issue!.suggestion).not.to.match(/qfg secret set/)
  })

  it('the hint names the commands that write secrets, and each exists with that flag (qfg-mol-hle PR 3)', async () => {
    const named = [...SECRET_VALUE_HINT.matchAll(/`qfg ([a-z-]+) (--[a-z-]+)`/g)].map((m) => ({
      flag: m[2].slice(2),
      id: m[1],
    }))
    expect(named.map((n) => n.id)).to.deep.equal(['set-default', 'create'])
    const {Config} = await import('@oclif/core')
    const config = await Config.load({root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')})
    for (const {flag, id} of named) {
      const command = config.findCommand(id)
      expect(command, `qfg ${id} is not a command`).to.exist
      expect(Object.keys(command!.flags), `qfg ${id} has no --${flag}`).to.include(flag)
    }
  })
})

describe('verify: quoteUntrustedName escapes every code unit outside printable ASCII (spec 9.2, qfg-mol-hle)', () => {
  const PRINTABLE_ASCII = /^[ -~]*$/

  it('is JSON.stringify for ordinary ASCII names', () => {
    for (const name of [
      'QUONFIG_KEYSET',
      'HOME',
      'quonfig_keyset_test',
      '',
      'a"b\\c',
      'tab\there',
      'nl\nhere',
      '~!@#$%^&*()',
    ]) {
      expect(quoteUntrustedName(name), name).to.equal(JSON.stringify(name))
    }
  })

  it('maps every UTF-16 code unit to printable ASCII, escaping all outside 0x20-0x7E as \\uXXXX', () => {
    for (let code = 0; code <= 0xff_ff; code++) {
      const ch = String.fromCharCode(code) // eslint-disable-line unicorn/prefer-code-point -- code units are the point
      const quoted = quoteUntrustedName(`a${ch}b`)
      expect(PRINTABLE_ASCII.test(quoted), `U+${code.toString(16)}`).to.be.true
      if (code >= 0x20 && code <= 0x7e) {
        expect(quoted).to.equal(JSON.stringify(`a${ch}b`))
      } else if (code >= 0x80) {
        expect(quoted, `U+${code.toString(16)}`).to.equal(`"a\\u${code.toString(16).padStart(4, '0')}b"`)
      }
    }
  })

  it('escapes look-alikes and invisibles (NBSP, soft hyphen, zero-width, BOM, specials, variation and tag characters)', () => {
    expect(
      quoteUntrustedName('A\u00A0\u00AD\u200B\u200C\u200D\u2060\u2064\u206A\u206F\uFEFF\uFFF9\uFFFB\uFE0F\u{E0041}'),
    ).to.equal(
      '"A\\u00a0\\u00ad\\u200b\\u200c\\u200d\\u2060\\u2064\\u206a\\u206f\\ufeff\\ufff9\\ufffb\\ufe0f\\udb40\\udc41"',
    )
  })

  it('escapes DEL, C1 (including CSI), separators, bidi controls and surrogates', () => {
    expect(quoteUntrustedName('a\u007F\u009B\u2028\u202E\u2066\uD800b\u{1F511}')).to.equal(
      '"a\\u007f\\u009b\\u2028\\u202e\\u2066\\ud800b\\ud83d\\udd11"',
    )
  })

  it('truncates to 64 UTF-16 code units before quoting, escaping a pair split by the cut', () => {
    expect(quoteUntrustedName('X'.repeat(200))).to.equal(JSON.stringify('X'.repeat(64)))
    expect(quoteUntrustedName(`${'X'.repeat(63)}\u{1F511}tail`)).to.equal(`"${'X'.repeat(63)}\\ud83d"`)
  })

  it('is what parseQf1Keyless uses for an invalid keyset name', () => {
    const value = positive('short-ascii').ciphertext.replace('QUONFIG_KEYSET_TEST', 'QUONFIG_KEYSET_\u009B31m\u00A0')
    const parsed = parseQf1Keyless(value)
    expect(parsed.ok).to.be.false
    if (!parsed.ok) {
      expect(parsed.errorClass).to.equal('invalid_keyset_name')
      expect(parsed.reason).to.include('"QUONFIG_KEYSET_\\u009b31m\\u00a0"')
      expect(PRINTABLE_ASCII.test(parsed.reason)).to.be.true
    }
  })
})
