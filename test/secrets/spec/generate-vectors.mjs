// TEST-ONLY COPY, NON-NORMATIVE. Vendored from the Quonfig project repo,
// plans/secrets-qf1/generate-vectors.mjs at commit 7449be4 (bead qfg-8seuf.2), for the cli's
// qf1 known-answer tests (bead qfg-mol-hle). The normative text is the spec,
// project/plans/secrets-qf1-spec.md. Not compiled (tsc includes src/ only) and
// not published (package.json "files" is /bin, /dist, /oclif.manifest.json).
// test/secrets/qf1-vectors.test.ts regenerates vectors.json from this copy and
// requires its SHA-256 to equal the approved spec file's, so any edit here
// that changed the output would fail that test.
//
// Edits in this copy (output unchanged, proven by the hash test):
//   - findFingerprintCollision checks the known first collision (label
//     indices 59381 and 122336, named in the vector's note) instead of
//     searching ~122k keys, which takes several seconds per run.
//   - gitleaks:allow on the published RFC 7748 / RFC 5869 test-vector lines.
//
// Generates plans/secrets-qf1/vectors.json, deterministically.
//
//   node plans/secrets-qf1/generate-vectors.mjs
//
// Every key here is a TEST KEY derived from a fixed label with SHA-256. None of
// them protects anything, and no real key or environment variable is read.
// Running this twice produces a byte-identical file; check-vectors.mjs
// enforces that.

import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

import * as qf1 from './reference.mjs'

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest()
const hex = (b) => Buffer.from(b).toString('hex')
const isAllZero = (b) => b.every((x) => x === 0)

const testPrivateKey = (label) => sha256(`qf1 test vector private key: ${label}`)
const testEphemeralKey = (label) => sha256(`qf1 test vector ephemeral key: ${label}`)

function keyRecord(label) {
  const priv = testPrivateKey(label)
  const pub = qf1.publicKeyFromPrivate(priv)
  return {
    label,
    privateKeyHex: hex(priv),
    privateKeyEntry: qf1.formatPrivateKeyEntry(priv),
    publicKeyHex: hex(pub),
    publicKeyEntry: qf1.formatPublicKeyEntry(pub),
    fingerprint: qf1.fingerprint(pub),
    priv,
    pub,
  }
}

// Little-endian 32-byte encoding of a non-negative integer below 2^256.
function le32(n) {
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse()
}
const P = 2n ** 255n - 19n

// Every small-order u-coordinate with the top bit clear (the encodings with the
// top bit set are already refused by the top-bit rule). Orders are of the
// Montgomery x-only point; p and p+1 are non-canonical encodings of 0 and 1.
const LOW_ORDER_POINTS = [
  {label: 'u=0 order 2', hex: hex(le32(0n))},
  {label: 'u=1 order 4', hex: hex(le32(1n))},
  {label: 'u=p-1 order 4', hex: hex(le32(P - 1n))},
  {label: 'order 8 a', hex: 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'},
  {label: 'order 8 b', hex: '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'},
  {label: 'u=p non-canonical 0', hex: hex(le32(P))},
  {label: 'u=p+1 non-canonical 1', hex: hex(le32(P + 1n))},
]
const slug = (label) => label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// Sets an unused trailing bit of an unpadded base64url string (n % 3 != 0).
function nonCanonical(b64) {
  const last = B64URL.indexOf(b64[b64.length - 1])
  const out = b64.slice(0, -1) + B64URL[last | 1]
  if (out === b64) throw new Error('could not make a non-canonical encoding')
  return out
}

function findFingerprintCollision() {
  // The original searches i = 0, 1, 2, ... for the first repeated fingerprint;
  // that search ends at the pair below. Verify the pair instead of searching.
  const first = 59381
  const second = 122336
  const pub = (i) => qf1.publicKeyFromPrivate(sha256(`qf1 test vector collision key: ${i}`))
  const a = pub(first)
  const b = pub(second)
  if (a.equals(b) || qf1.fingerprint(a) !== qf1.fingerprint(b)) throw new Error('known collision pair does not collide')
  return {fingerprint: qf1.fingerprint(a), first, second}
}

function asciiJson(value) {
  // Pure-ASCII JSON: every non-ASCII UTF-16 code unit is written as \uXXXX.
  return (
    JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) +
    '\n'
  )
}

export function buildVectors() {
  // ---- Keysets ----
  const kTest = keyRecord('QUONFIG_KEYSET_TEST/1')
  const kDefault = keyRecord('QUONFIG_KEYSET/1')
  const kProdNew = keyRecord('QUONFIG_KEYSET_TEST_PROD/new')
  const kProdOld = keyRecord('QUONFIG_KEYSET_TEST_PROD/old')

  const keysets = [
    {name: 'QUONFIG_KEYSET_TEST', keys: [kTest], envValue: kTest.privateKeyEntry},
    {name: 'QUONFIG_KEYSET', keys: [kDefault], envValue: kDefault.privateKeyEntry},
    {
      name: 'QUONFIG_KEYSET_TEST_PROD',
      // publicKeys order in quonfig.json: write key first.
      keys: [kProdNew, kProdOld],
      // Env order is irrelevant; this one is reversed, padded with whitespace
      // around entries, and ends with an empty entry, all of which are legal.
      envValue: ` ${kProdOld.privateKeyEntry} ,\n${kProdNew.privateKeyEntry},`,
    },
  ]
  const positiveEnv = Object.fromEntries(keysets.map((k) => [k.name, k.envValue]))

  // At least one test private key has bits that X25519 clamping changes, so an
  // implementation that forgets to clamp fails.
  const needsClamp = (p) => (p[0] & 7) !== 0 || (p[31] & 0x80) !== 0 || (p[31] & 0x40) === 0
  if (![kTest, kDefault, kProdNew, kProdOld].some((k) => needsClamp(k.priv))) throw new Error('no key exercises clamping')

  // ---- Positive cases ----
  const longValue = Array.from(
    {length: 24},
    (_, i) => `line ${String(i + 1).padStart(2, '0')}: The quick brown fox jumps over the lazy dog 0123456789.`,
  ).join('\n')
  const positiveSpecs = [
    {name: 'short-ascii', key: kTest, keyset: 'QUONFIG_KEYSET_TEST', plaintext: 'hello'},
    {name: 'empty-string', key: kTest, keyset: 'QUONFIG_KEYSET_TEST', plaintext: ''},
    {name: 'multibyte-utf8', key: kTest, keyset: 'QUONFIG_KEYSET_TEST', plaintext: 'p\u00e4ssw\u00f6rd \u65e5\u672c\u8a9e \u{1F511}'},
    {name: 'leading-bom-kept', key: kTest, keyset: 'QUONFIG_KEYSET_TEST', plaintext: '\ufeffbom stays'},
    {name: 'json-special-chars', key: kTest, keyset: 'QUONFIG_KEYSET_TEST', plaintext: 'a"b\\c\nd\te:f,g qf1:x'},
    {name: 'long-value', key: kTest, keyset: 'QUONFIG_KEYSET_TEST', plaintext: longValue},
    {name: 'bare-default-keyset', key: kDefault, keyset: 'QUONFIG_KEYSET', plaintext: 'sk_test_default_keyset_value'},
    {name: 'two-key-keyset-write-key', key: kProdNew, keyset: 'QUONFIG_KEYSET_TEST_PROD', plaintext: 'written with the first public key'},
    {name: 'two-key-keyset-older-key', key: kProdOld, keyset: 'QUONFIG_KEYSET_TEST_PROD', plaintext: 'written before rotation'},
  ]

  const positive = positiveSpecs.map((spec) => {
    const {ciphertext, trace: t} = qf1.encrypt({
      plaintext: spec.plaintext,
      keyset: spec.keyset,
      publicKey: spec.key.pub,
      ephemeralPrivateKey: testEphemeralKey(spec.name),
    })
    return {
      name: spec.name,
      keyset: spec.keyset,
      fingerprint: t.fingerprint,
      recipientPublicKeyHex: hex(spec.key.pub),
      recipientPrivateKeyEntry: spec.key.privateKeyEntry,
      plaintext: spec.plaintext,
      plaintextHex: hex(Buffer.from(spec.plaintext, 'utf8')),
      ephemeralPrivateKeyHex: hex(testEphemeralKey(spec.name)),
      ephemeralPublicKeyHex: hex(t.ephemeralPublicKey),
      sharedSecretHex: hex(t.sharedSecret),
      hkdfSaltHex: hex(t.hkdfSalt),
      hkdfInfoHex: hex(t.hkdfInfo),
      prkHex: hex(t.prk),
      okmHex: hex(t.okm),
      aesKeyHex: hex(t.aesKey),
      nonceHex: hex(t.nonce),
      aadAscii: t.aad.toString('latin1'),
      aadHex: hex(t.aad),
      ciphertextAndTagHex: hex(t.ciphertextAndTag),
      blobHex: hex(t.blob),
      ciphertext,
    }
  })
  const byName = Object.fromEntries(positive.map((p) => [p.name, p]))

  // Seal to kTest with every writer check bypassed (sealRaw), so a value is
  // authentic except for the one rule a case is about. The defaults reproduce
  // an honest writer; each case overrides one thing.
  function sealToTest(label, {keysetField = 'QUONFIG_KEYSET_TEST', plaintextBytes = Buffer.from('hello'), ephemeral, sharedSecret, recipient = kTest, fingerprintField} = {}) {
    const e = testEphemeralKey(label)
    return qf1.sealRaw({
      keysetField,
      fingerprintField: fingerprintField ?? recipient.fingerprint,
      transmittedEphemeralPublicKey: ephemeral ?? qf1.publicKeyFromPrivate(e),
      sharedSecret: sharedSecret ?? qf1.x25519(e, recipient.pub),
      recipientPublicKey: recipient.pub,
      plaintextBytes,
    }).ciphertext
  }

  // ---- Decrypt-only positive cases (cannot come from an honest writer) ----
  const nonCanonicalNine = le32(P + 9n) // u = p + 9, reduces to the base point 9
  const sNine = qf1.x25519(kTest.priv, nonCanonicalNine)
  if (!sNine.equals(qf1.x25519(kTest.priv, le32(9n)))) throw new Error('non-canonical u not reduced')
  const decryptOnly = [
    {
      name: 'ephemeral-non-canonical-u-accepted',
      ciphertext: sealToTest('ephemeral-non-canonical-u', {ephemeral: nonCanonicalNine, sharedSecret: sNine}),
      env: positiveEnv,
      plaintext: 'hello',
      plaintextHex: hex(Buffer.from('hello')),
      note: 'E encodes u = p + 9 (non-canonical, top bit clear). Per RFC 7748 the reader reduces it mod p, so S = X25519(priv_r, 9). The HKDF salt uses the 32 transmitted bytes. MUST decrypt.',
    },
  ]

  // ---- Negative cases ----
  const hello = byName['short-ascii']
  const [, , helloFp, helloB64] = hello.ciphertext.split(':')
  const helloBlob = Buffer.from(hello.blobHex, 'hex')
  const withBlob = (blob) => `qf1:QUONFIG_KEYSET_TEST:${helloFp}:${qf1.b64urlEncode(blob)}`
  const flip = (buf, index, mask) => {
    const b = Buffer.from(buf)
    b[index] ^= mask
    return b
  }

  const negative = []
  const neg = (name, ciphertext, expectedError, note, env = positiveEnv, mustReject = false) =>
    negative.push({name, ciphertext, env, expectedError, mustReject, note})
  // mustReject: the value is authentic except for the one rule; an
  // implementation that skips that rule would DECRYPT it successfully.
  const reject = (name, ciphertext, expectedError, note, env = positiveEnv) => neg(name, ciphertext, expectedError, note, env, true)

  // Grammar
  neg('version-qf2', 'qf2' + hello.ciphertext.slice(3), 'unsupported_version', 'a later format version; refuse it, do not guess')
  reject('version-uppercase', 'QF1' + hello.ciphertext.slice(3), 'malformed', 'the version prefix is case-sensitive')
  neg('legacy-ct-iv-tag', 'deadbeef--00112233445566778899aabb--00112233445566778899aabbccddeeff', 'malformed', 'the old format is not read')
  neg('too-few-fields', `qf1:QUONFIG_KEYSET_TEST:${helloFp}`, 'malformed', 'three fields')
  neg('extra-field', hello.ciphertext + ':extra', 'malformed', 'five fields')
  reject('trailing-colon', hello.ciphertext + ':', 'malformed', 'five fields, the last empty; split functions that drop trailing empty fields would accept this')
  reject('trailing-double-colon', hello.ciphertext + '::', 'malformed', 'six fields, the last two empty')
  reject('leading-whitespace', ' ' + hello.ciphertext, 'malformed', 'no trimming')
  reject('trailing-newline', hello.ciphertext + '\n', 'malformed', 'no trimming; the payload field ends in LF')
  neg('fingerprint-uppercase', `qf1:QUONFIG_KEYSET_TEST:${helloFp.toUpperCase()}:${helloB64}`, 'malformed', 'fingerprint hex is lowercase only')
  neg('fingerprint-7-chars', `qf1:QUONFIG_KEYSET_TEST:${helloFp.slice(0, 7)}:${helloB64}`, 'malformed', 'fingerprint is exactly 8 hex characters')
  neg('fingerprint-trailing-newline', `qf1:QUONFIG_KEYSET_TEST:${helloFp}\n:${helloB64}`, 'malformed', 'full-string match: a pattern whose $ also matches before a final LF would accept this field')
  neg('blob-padded', hello.ciphertext + '=', 'malformed', 'base64url padding is not allowed')
  neg('blob-standard-alphabet', `qf1:QUONFIG_KEYSET_TEST:${helloFp}:+${helloB64.slice(1)}`, 'malformed', "'+' and '/' are not base64url")
  reject('blob-non-canonical', `qf1:QUONFIG_KEYSET_TEST:${helloFp}:${nonCanonical(helloB64)}`, 'malformed', 'non-zero unused trailing bits')
  neg('blob-empty', `qf1:QUONFIG_KEYSET_TEST:${helloFp}:`, 'malformed', 'empty payload')
  neg('blob-truncated-47-bytes', withBlob(helloBlob.subarray(0, 47)), 'malformed', 'payload shorter than 48 bytes')
  neg('blob-length-mod-4-is-1', `qf1:QUONFIG_KEYSET_TEST:${helloFp}:${helloB64}AA`, 'malformed', 'impossible base64 length (73 characters)')
  {
    const e = testEphemeralKey('ephemeral-top-bit-set')
    const E = qf1.publicKeyFromPrivate(e)
    const Et = flip(E, 31, 0x80)
    const S = qf1.x25519(e, kTest.pub)
    if (!qf1.x25519(kTest.priv, Et).equals(S)) throw new Error('top-bit masking assumption failed')
    reject(
      'ephemeral-top-bit-set',
      sealToTest('ephemeral-top-bit-set', {ephemeral: Et, sharedSecret: S}),
      'malformed',
      'E byte 31 has bit 0x80 set; the tag is valid with the HKDF salt over the transmitted bytes, so a reader that only masks the bit would decrypt it',
    )
  }

  // Keyset name rule: refused before any env var is read. Each value is
  // genuinely encrypted under that name (AAD included) and the env holds the
  // key under that name, so a reader without the rule would decrypt it.
  const badNames = [
    'QUONFIG_KEYSETX',
    'QUONFIG_KEYSET_',
    'QUONFIG_KEYSET__TEST',
    'QUONFIG_KEYSET_test',
    'quonfig_keyset_test',
    'HOME',
    'QUONFIG_KEYSET_TEST\n',
    'HOME\nQUONFIG_KEYSET',
    'QUONFIG_KEYSET_TEST\nHOME',
  ]
  for (const bad of badNames) {
    reject(
      `keyset-name-${slug(bad.replace(/\n/g, ' LF '))}`,
      sealToTest(`keyset-name:${bad}`, {keysetField: bad}),
      'invalid_keyset_name',
      'keyset name does not match ^QUONFIG_KEYSET(_[A-Z0-9]+)*$ as a full-string match; the env var is never read',
      {...positiveEnv, [bad]: kTest.privateKeyEntry},
    )
  }
  neg('keyset-name-empty', `qf1::${helloFp}:${helloB64}`, 'invalid_keyset_name', 'empty keyset field')

  // Env var problems
  const envWithout = (name) => Object.fromEntries(Object.entries(positiveEnv).filter(([k]) => k !== name))
  neg('keyset-missing', hello.ciphertext, 'keyset_missing', 'QUONFIG_KEYSET_TEST is unset', envWithout('QUONFIG_KEYSET_TEST'))
  neg('keyset-empty-string', hello.ciphertext, 'keyset_missing', 'set to the empty string', {...positiveEnv, QUONFIG_KEYSET_TEST: ''})
  neg('keyset-only-separators', hello.ciphertext, 'keyset_missing', 'only commas and whitespace', {...positiveEnv, QUONFIG_KEYSET_TEST: ' , ,\n'})
  reject('keyset-bad-entry', hello.ciphertext, 'keyset_invalid', 'one unparseable entry invalidates the keyset', {
    ...positiveEnv,
    QUONFIG_KEYSET_TEST: `${kTest.privateKeyEntry},qf1-priv-short`,
  })
  neg('keyset-holds-public-entry', hello.ciphertext, 'keyset_invalid', 'a public key entry in the env var', {
    ...positiveEnv,
    QUONFIG_KEYSET_TEST: kTest.publicKeyEntry,
  })
  const otherWhitespace = [
    {label: 'vertical-tab', ch: '\u000b'},
    {label: 'form-feed', ch: '\u000c'},
    {label: 'nbsp', ch: '\u00a0'},
    {label: 'u2028', ch: '\u2028'},
  ]
  for (const {label, ch} of otherWhitespace) {
    reject(`keyset-entry-trailing-${label}`, hello.ciphertext, 'keyset_invalid', `entry ends in U+${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}; only space, tab, CR and LF are stripped, so a platform trim() would wrongly accept it`, {
      ...positiveEnv,
      QUONFIG_KEYSET_TEST: kTest.privateKeyEntry + ch,
    })
  }
  const collision = findFingerprintCollision()
  const c1 = sha256(`qf1 test vector collision key: ${collision.first}`)
  const c2 = sha256(`qf1 test vector collision key: ${collision.second}`)
  const collisionCt = qf1.encrypt({
    plaintext: 'collision',
    keyset: 'QUONFIG_KEYSET_TEST_COLLISION',
    publicKey: qf1.publicKeyFromPrivate(c1),
    ephemeralPrivateKey: testEphemeralKey('fingerprint-collision'),
  }).ciphertext
  reject(
    'keyset-fingerprint-collision',
    collisionCt,
    'keyset_invalid',
    `two different keys share fingerprint ${collision.fingerprint} (labels "qf1 test vector collision key: ${collision.first}" and "...: ${collision.second}"); the value is encrypted to the first`,
    {...positiveEnv, QUONFIG_KEYSET_TEST_COLLISION: `${qf1.formatPrivateKeyEntry(c1)},${qf1.formatPrivateKeyEntry(c2)}`},
  )

  // Lookup
  const heldFps = new Set([kTest, kDefault, kProdNew, kProdOld].map((k) => k.fingerprint))
  if (heldFps.has('00000000')) throw new Error('test key fingerprint is 00000000')
  neg('fingerprint-not-held', `qf1:QUONFIG_KEYSET_TEST:00000000:${helloB64}`, 'key_not_held', 'no held key has this fingerprint')
  neg(
    'fingerprint-from-other-keyset',
    `qf1:QUONFIG_KEYSET_TEST:${kDefault.fingerprint}:${helloB64}`,
    'key_not_held',
    'lookup is (keyset, fingerprint); a key held under another keyset does not count',
  )
  reject(
    'trial-decryption-unknown-fingerprint',
    sealToTest('trial-decryption-unknown-fingerprint', {fingerprintField: '00000000'}),
    'key_not_held',
    'sealed to the held QUONFIG_KEYSET_TEST key, but the header (and so the AAD) carries fingerprint 00000000; a reader that tries every held key would decrypt it',
  )
  reject(
    'cross-keyset-lookup',
    sealToTest('cross-keyset-lookup', {recipient: kDefault}),
    'key_not_held',
    'sealed to the QUONFIG_KEYSET key under the header name QUONFIG_KEYSET_TEST with that key\'s fingerprint; both env vars are set; a reader that searches every keyset would decrypt it',
  )

  // All-zero shared secret. Each value is sealed with S = 32 zero bytes, so a
  // reader that skips the all-zero check would derive the same key and decrypt.
  for (const {label, hex: pointHex} of LOW_ORDER_POINTS) {
    const point = Buffer.from(pointHex, 'hex')
    if (!isAllZero(qf1.x25519(kTest.priv, point))) throw new Error(`${label} is not low order`)
    reject(
      `ephemeral-low-order-${slug(label)}`,
      sealToTest(`low-order:${label}`, {ephemeral: point, sharedSecret: Buffer.alloc(32)}),
      'invalid_ephemeral_key',
      `E is the small-order point ${label}; X25519 output is all zero; the tag is valid for S = 0`,
    )
  }

  // Authentication
  neg('tampered-ciphertext-byte', withBlob(flip(helloBlob, 32, 0x01)), 'decrypt_failed', 'first ciphertext byte flipped')
  neg('tampered-tag-byte', withBlob(flip(helloBlob, helloBlob.length - 1, 0x01)), 'decrypt_failed', 'last tag byte flipped')
  const tamperedEph = flip(helloBlob, 0, 0x01)
  if (isAllZero(qf1.x25519(kTest.priv, tamperedEph.subarray(0, 32)))) throw new Error('tampered ephemeral key is low order')
  neg('tampered-ephemeral-key', withBlob(tamperedEph), 'decrypt_failed', 'bit 0 of the ephemeral public key flipped')
  neg(
    'tampered-header-keyset',
    `qf1:QUONFIG_KEYSET_TEST_COPY:${helloFp}:${helloB64}`,
    'decrypt_failed',
    'header keyset renamed; the runtime holds the right key under the new name, so only the AAD catches it',
    {...positiveEnv, QUONFIG_KEYSET_TEST_COPY: kTest.privateKeyEntry},
  )
  const older = byName['two-key-keyset-older-key']
  neg(
    'tampered-header-fingerprint',
    older.ciphertext.replace(`:${kProdOld.fingerprint}:`, `:${kProdNew.fingerprint}:`),
    'decrypt_failed',
    'header fingerprint changed to another key the runtime holds',
  )
  for (const [label, bytesHex] of [
    ['invalid-utf8-plaintext', '666ffffe'],
    ['utf8-encoded-surrogate', '61eda08062'],
    ['utf8-overlong-nul', '61c08062'],
  ]) {
    reject(
      label,
      sealToTest(label, {plaintextBytes: Buffer.from(bytesHex, 'hex')}),
      'decrypt_failed',
      `authentic ciphertext whose plaintext bytes ${bytesHex} are not well-formed UTF-8; a lossy decoder would return a string`,
    )
  }

  // ---- Writer cases (encrypt must refuse) ----
  const writerCases = [
    {
      name: 'lone-surrogate-plaintext',
      keyset: 'QUONFIG_KEYSET_TEST',
      recipientPublicKeyHex: kTest.publicKeyHex,
      ephemeralPrivateKeyHex: hex(testEphemeralKey('writer-lone-surrogate')),
      plaintextUtf16CodeUnits: [0x61, 0xd800, 0x62],
      expectedError: 'invalid_plaintext',
      note: 'UTF-16 string "a", U+D800 (unpaired), "b". A UTF-16 platform would otherwise encode U+FFFD.',
    },
    {
      name: 'low-order-recipient',
      keyset: 'QUONFIG_KEYSET_TEST',
      recipientPublicKeyHex: LOW_ORDER_POINTS[3].hex,
      ephemeralPrivateKeyHex: hex(testEphemeralKey('writer-low-order')),
      plaintextUtf16CodeUnits: [0x68, 0x69],
      expectedError: 'invalid_public_key',
      note: 'recipient public key is an order-8 point; S would be all zero',
    },
    {
      name: 'non-canonical-recipient',
      keyset: 'QUONFIG_KEYSET_TEST',
      recipientPublicKeyHex: hex(nonCanonicalNine),
      ephemeralPrivateKeyHex: hex(testEphemeralKey('writer-non-canonical')),
      plaintextUtf16CodeUnits: [0x68, 0x69],
      expectedError: 'invalid_public_key',
      note: 'recipient public key u = p + 9 is not canonical',
    },
    {
      name: 'keyset-name-home',
      keyset: 'HOME',
      recipientPublicKeyHex: kTest.publicKeyHex,
      ephemeralPrivateKeyHex: hex(testEphemeralKey('writer-home')),
      plaintextUtf16CodeUnits: [0x68, 0x69],
      expectedError: 'invalid_keyset_name',
      note: 'writers refuse a keyset name outside the rule',
    },
  ]

  // ---- Key entry cases ----
  const privBody = kTest.privateKeyEntry.slice(qf1.PRIVATE_KEY_PREFIX.length)
  const pubBody = kTest.publicKeyEntry.slice(qf1.PUBLIC_KEY_PREFIX.length)
  // A second encoding of kTest's private key that clamps to the same scalar.
  const clampTwin = flip(kTest.priv, 0, kTest.priv[0] & 1 ? 0x02 : 0x01)
  if (!qf1.publicKeyFromPrivate(clampTwin).equals(kTest.pub)) throw new Error('clamp twin differs')
  const keyEntryCases = [
    {name: 'private-valid', kind: 'privateKeyEntry', input: kTest.privateKeyEntry, expectedHex: kTest.privateKeyHex},
    {name: 'private-uppercase-prefix', kind: 'privateKeyEntry', input: 'QF1-PRIV-' + privBody, expectedError: 'invalid_key_entry'},
    {name: 'private-padded', kind: 'privateKeyEntry', input: kTest.privateKeyEntry + '=', expectedError: 'invalid_key_entry'},
    {name: 'private-42-chars', kind: 'privateKeyEntry', input: kTest.privateKeyEntry.slice(0, -1), expectedError: 'invalid_key_entry'},
    {name: 'private-non-canonical', kind: 'privateKeyEntry', input: qf1.PRIVATE_KEY_PREFIX + nonCanonical(privBody), expectedError: 'invalid_key_entry'},
    {name: 'private-hex-body', kind: 'privateKeyEntry', input: qf1.PRIVATE_KEY_PREFIX + kTest.privateKeyHex, expectedError: 'invalid_key_entry'},
    {name: 'private-given-public-entry', kind: 'privateKeyEntry', input: kTest.publicKeyEntry, expectedError: 'invalid_key_entry'},
    {name: 'public-valid', kind: 'publicKeyEntry', input: kTest.publicKeyEntry, expectedHex: kTest.publicKeyHex},
    {name: 'public-given-private-entry', kind: 'publicKeyEntry', input: kTest.privateKeyEntry, expectedError: 'invalid_key_entry'},
    {name: 'public-non-canonical-base64', kind: 'publicKeyEntry', input: qf1.PUBLIC_KEY_PREFIX + nonCanonical(pubBody), expectedError: 'invalid_key_entry'},
    {name: 'public-non-canonical-u', kind: 'publicKeyEntry', input: qf1.formatPublicKeyEntry(nonCanonicalNine), expectedError: 'invalid_key_entry'},
    ...LOW_ORDER_POINTS.map(({label, hex: pointHex}) => ({
      name: `public-low-order-${slug(label)}`,
      kind: 'publicKeyEntry',
      input: qf1.formatPublicKeyEntry(Buffer.from(pointHex, 'hex')),
      expectedError: 'invalid_key_entry',
    })),
    {name: 'public-top-bit-set', kind: 'publicKeyEntry', input: qf1.formatPublicKeyEntry(flip(kTest.pub, 31, 0x80)), expectedError: 'invalid_key_entry'},
    {
      name: 'env-whitespace-order-trailing-comma',
      kind: 'envValue',
      keyset: 'QUONFIG_KEYSET_TEST_PROD',
      input: keysets[2].envValue,
      expectedFingerprints: [kProdNew.fingerprint, kProdOld.fingerprint],
    },
    {
      name: 'env-tab-and-crlf',
      kind: 'envValue',
      keyset: 'QUONFIG_KEYSET_TEST_PROD',
      input: `\t${kProdNew.privateKeyEntry}\r\n,\r\n${kProdOld.privateKeyEntry}\t`,
      expectedFingerprints: [kProdNew.fingerprint, kProdOld.fingerprint],
    },
    {
      name: 'env-same-key-twice',
      kind: 'envValue',
      keyset: 'QUONFIG_KEYSET_TEST',
      input: `${kTest.privateKeyEntry},${kTest.privateKeyEntry}`,
      expectedFingerprints: [kTest.fingerprint],
    },
    {
      name: 'env-clamp-equivalent-entries',
      kind: 'envValue',
      keyset: 'QUONFIG_KEYSET_TEST',
      input: `${kTest.privateKeyEntry},${qf1.formatPrivateKeyEntry(clampTwin)}`,
      expectedFingerprints: [kTest.fingerprint],
      note: 'two different entries that clamp to the same scalar have the same public key: one key, not a collision',
    },
    {name: 'env-empty', kind: 'envValue', keyset: 'QUONFIG_KEYSET_TEST', input: '', expectedError: 'keyset_missing'},
    {name: 'env-inner-whitespace', kind: 'envValue', keyset: 'QUONFIG_KEYSET_TEST', input: qf1.PRIVATE_KEY_PREFIX + ' ' + privBody, expectedError: 'keyset_invalid'},
    {
      name: 'env-semicolon-separator',
      kind: 'envValue',
      keyset: 'QUONFIG_KEYSET_TEST_PROD',
      input: `${kProdNew.privateKeyEntry};${kProdOld.privateKeyEntry}`,
      expectedError: 'keyset_invalid',
    },
    ...otherWhitespace.map(({label, ch}) => ({
      name: `env-leading-${label}`,
      kind: 'envValue',
      keyset: 'QUONFIG_KEYSET_TEST',
      input: ch + kTest.privateKeyEntry,
      expectedError: 'keyset_invalid',
    })),
  ]

  const strip = ({label, priv, pub, ...rest}) => ({label, ...rest})
  return {
    WARNING:
      'TEST KEYS ONLY. Every private key in this file is a throwaway test key derived from a fixed public label. ' +
      'Never use one for real data. See spec section 14 before copying this file into a gitleaks-gated repo.',
    spec: 'project/plans/secrets-qf1-spec.md',
    format: 'qf1',
    constants: {
      hkdfInfoAscii: qf1.HKDF_INFO.toString('ascii'),
      hkdfInfoHex: hex(qf1.HKDF_INFO),
      okmLength: qf1.OKM_LENGTH,
      privateKeyPrefix: qf1.PRIVATE_KEY_PREFIX,
      publicKeyPrefix: qf1.PUBLIC_KEY_PREFIX,
      keysetNamePattern: '^QUONFIG_KEYSET(_[A-Z0-9]+)*$',
    },
    rfcChecks: {
      rfc7748_6_1: {
        alicePrivateHex: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', // gitleaks:allow
        alicePublicHex: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', // gitleaks:allow
        bobPrivateHex: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb', // gitleaks:allow
        bobPublicHex: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f', // gitleaks:allow
        sharedSecretHex: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742', // gitleaks:allow
      },
      rfc5869_A_1: {
        ikmHex: '0b'.repeat(22), // gitleaks:allow
        saltHex: '000102030405060708090a0b0c', // gitleaks:allow
        infoHex: 'f0f1f2f3f4f5f6f7f8f9', // gitleaks:allow
        length: 42,
        prkHex: '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5', // gitleaks:allow
        okmHex: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865', // gitleaks:allow
      },
    },
    keysets: keysets.map((k) => ({
      name: k.name,
      publicKeys: k.keys.map((r) => r.publicKeyEntry),
      envValue: k.envValue,
      keys: k.keys.map(strip),
    })),
    positiveEnv,
    positive,
    decryptOnly,
    negative,
    writerCases,
    keyEntryCases,
  }
}

export function buildVectorsJson() {
  return asciiJson(buildVectors())
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors.json')
  writeFileSync(out, buildVectorsJson())
  console.log(`wrote ${out}`)
}
