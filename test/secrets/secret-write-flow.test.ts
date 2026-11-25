/**
 * The decisions `qfg create --secret` / `qfg set-default` make for a secret
 * write (plan 3.1, 3.2), against a real snapshot of a file:// workspace repo.
 * Bead qfg-mol-hle PR 3.
 */
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

import {KeysetChoiceError, type KeysetPromptOption} from '../../src/secrets/choose-keyset.js'
import {decrypt, encrypt} from '../../src/secrets/qf1.js'
import {
  newSecretDocument,
  secretValue,
  serializeSecretDocument,
  setSecretScopeValue,
} from '../../src/secrets/secret-doc.js'
import {SecretRefusal, planSecretCreate, planSecretUpdate} from '../../src/secrets/secret-write-flow.js'
import {type WorkspaceSnapshot, cloneWorkspaceSnapshot} from '../../src/secrets/workspace-snapshot.js'
import {validateFileMap} from '../../src/verify/validate.js'
import {bareWorkspaceRepo, configDoc, quonfigJson, testKey, tmpDir} from './plumbing-fixtures.js'

const PLAINTEXT = 'FAKE_FLOW_PLAINTEXT_value_0001'
const main = testKey()
const second = testKey()
const prod = testKey()
const always = [{operator: 'ALWAYS_TRUE'}]

const valueOn = (keyset: string, recipient: string, plaintext = 'old-value') =>
  secretValue(encrypt({keyset, plaintext, recipient}))

/** A stored secret with a production targeting rule and fallback on QUONFIG_KEYSET_PROD. */
function existingSecret(key: string): string {
  const doc = setSecretScopeValue(newSecretDocument(key), {value: valueOn('QUONFIG_KEYSET', main.publicEntry)}).document
  doc.environments = [
    {
      id: 'production',
      rules: [
        {
          criteria: [
            {operator: 'PROP_IS_ONE_OF', propertyName: 'user.key', valueToMatch: {type: 'string_list', value: ['u1']}},
          ],
          value: valueOn('QUONFIG_KEYSET_PROD', prod.publicEntry),
        },
        {criteria: always, value: valueOn('QUONFIG_KEYSET_PROD', prod.publicEntry)},
      ],
    },
  ]
  return serializeSecretDocument(doc)
}

const oldFormatConfig = (key: string) => {
  const doc = JSON.parse(configDoc(key))
  doc.default.rules[0].value = {
    confidential: true,
    decryptWith: 'quonfig.secrets.encryption.key',
    type: 'string',
    value: 'aaaa--bbbb--cccc',
  }
  return JSON.stringify(doc, null, 2)
}

const TWO_KEYSETS = quonfigJson({
  QUONFIG_KEYSET: {publicKeys: [main.publicEntry, second.publicEntry]},
  QUONFIG_KEYSET_PROD: {publicKeys: [prod.publicEntry]},
})

const ONE_KEYSET = quonfigJson({QUONFIG_KEYSET: {publicKeys: [main.publicEntry, second.publicEntry]}})

describe('secret write planning (qfg-mol-hle PR 3)', function () {
  this.timeout(30_000)
  let root: string
  const snapshots: WorkspaceSnapshot[] = []

  async function snapshotOf(files: Record<string, string>): Promise<WorkspaceSnapshot> {
    const repo = bareWorkspaceRepo(fs.mkdtempSync(path.join(root, 'r-')), files)
    const snap = await cloneWorkspaceSnapshot(pathToFileURL(repo.bare).href, {tmpRoot: root})
    snapshots.push(snap)
    return snap
  }

  const noPrompt = async (): Promise<string> => {
    throw new Error('must not prompt')
  }

  async function refusal(p: Promise<unknown>): Promise<Error> {
    try {
      await p
    } catch (error) {
      return error as Error
    }

    return expect.fail('expected a refusal')
  }

  const hookErrors = (snap: WorkspaceSnapshot, path: string, afterJson: string) => {
    const files = snap.documents()
    files.set(path, afterJson)
    return validateFileMap(files, {quonfigJson: snap.readFile('quonfig.json'), validateValues: true}).issues.filter(
      (i) => i.severity === 'error',
    )
  }

  beforeEach(() => {
    root = tmpDir('qfg-flow-test-')
  })

  afterEach(async () => {
    for (const s of snapshots.splice(0)) await s.cleanup()
    fs.rmSync(root, {force: true, maxRetries: 3, recursive: true})
  })

  describe('create', () => {
    it('writes secrets/<key>.json on the only keyset, to its FIRST public key, at the given access tier', async () => {
      const snap = await snapshotOf({'quonfig.json': ONE_KEYSET})
      const plan = await planSecretCreate({
        access: 'protected-env',
        interactive: false,
        key: 'stripe.key',
        plaintext: PLAINTEXT,
        prompt: noPrompt,
        snapshot: snap,
      })
      expect(plan.path).to.equal('secrets/stripe.key.json')
      expect(plan.choice).to.include({fingerprint: main.fingerprint, keyset: 'QUONFIG_KEYSET', source: 'only'})
      expect(plan.firstSecret).to.equal(true)
      expect(plan.message.text).to.equal(`qfg: create secret stripe.key on QUONFIG_KEYSET ${main.fingerprint}`)
      const doc = JSON.parse((plan.files[0] as {afterJson: string}).afterJson)
      expect(doc).to.include({access: 'protected-env', key: 'stripe.key', type: 'secret', valueType: 'string'})
      const value = doc.default.rules[0].value
      expect(value).to.have.keys(['confidential', 'type', 'value'])
      expect(value.confidential).to.equal(true)
      expect(value.value).to.match(new RegExp(`^qf1:QUONFIG_KEYSET:${main.fingerprint}:`))
      expect(decrypt(value.value, {QUONFIG_KEYSET: main.privateEntry})).to.equal(PLAINTEXT)
      expect(JSON.stringify(plan)).to.not.include(PLAINTEXT)
      expect(plan.redacted).to.include({encrypted: true, last4: '0001', length: PLAINTEXT.length})
      expect(hookErrors(snap, plan.path, (plan.files[0] as {afterJson: string}).afterJson)).to.deep.equal([])
    })

    it('--keyset picks the keyset; two keysets without it and without a prompt is an error listing them', async () => {
      const snap = await snapshotOf({'quonfig.json': TWO_KEYSETS})
      const base = {access: 'standard', key: 'stripe.key', plaintext: PLAINTEXT, snapshot: snap}
      const plan = await planSecretCreate({...base, flagKeyset: 'QUONFIG_KEYSET_PROD', interactive: false})
      expect(plan.choice).to.include({keyset: 'QUONFIG_KEYSET_PROD', source: 'flag'})
      const err = await refusal(planSecretCreate({...base, interactive: false, prompt: noPrompt}))
      expect(err).to.be.instanceOf(KeysetChoiceError)
      expect(err.message).to.equal('Choose a keyset with --keyset: QUONFIG_KEYSET, QUONFIG_KEYSET_PROD')
    })

    it('interactive with two keysets prompts, with what this machine can read', async () => {
      const snap = await snapshotOf({'quonfig.json': TWO_KEYSETS})
      let shown: KeysetPromptOption[] = []
      const plan = await planSecretCreate({
        access: 'standard',
        env: {QUONFIG_KEYSET: main.privateEntry},
        interactive: true,
        key: 'stripe.key',
        plaintext: PLAINTEXT,
        async prompt(options) {
          shown = options
          return 'QUONFIG_KEYSET_PROD'
        },
        snapshot: snap,
      })
      expect(plan.choice.source).to.equal('prompt')
      expect(shown).to.deep.equal([
        {annotation: 'this machine can also read it', name: 'QUONFIG_KEYSET', writeFingerprint: main.fingerprint},
        {annotation: 'not on this machine', name: 'QUONFIG_KEYSET_PROD', writeFingerprint: prod.fingerprint},
      ])
    })

    it('refuses a key that exists in any family, case-insensitively', async () => {
      const snap = await snapshotOf({
        'configs/Stripe.Key.json': configDoc('Stripe.Key'),
        'quonfig.json': ONE_KEYSET,
        'secrets/db.password.json': existingSecret('db.password'),
      })
      const base = {access: 'standard', interactive: false, plaintext: PLAINTEXT, snapshot: snap}
      const a = await refusal(planSecretCreate({...base, key: 'stripe.key'}))
      expect(a).to.be.instanceOf(SecretRefusal)
      expect(a.message).to.equal('stripe.key already exists (as a config named Stripe.Key; keys are case-insensitive)')
      const b = await refusal(planSecretCreate({...base, key: 'db.password'}))
      expect(b.message).to.equal('db.password already exists (as a secret)')
    })

    it('a workspace without keysets is refused, and nothing is encrypted anywhere else', async () => {
      const snap = await snapshotOf({'quonfig.json': quonfigJson()})
      const err = await refusal(
        planSecretCreate({access: 'standard', interactive: false, key: 'k', plaintext: PLAINTEXT, snapshot: snap}),
      )
      expect(err).to.be.instanceOf(KeysetChoiceError)
      expect(err.message).to.match(/^This workspace has no keysets/)
    })

    it('firstSecret is false when secrets/ already holds a document', async () => {
      const snap = await snapshotOf({
        'quonfig.json': TWO_KEYSETS,
        'secrets/db.password.json': existingSecret('db.password'),
      })
      const plan = await planSecretCreate({
        access: 'standard',
        flagKeyset: 'QUONFIG_KEYSET',
        interactive: false,
        key: 'stripe.key',
        plaintext: PLAINTEXT,
        snapshot: snap,
      })
      expect(plan.firstSecret).to.equal(false)
    })
  })

  describe('fix round of the PR 3a validation (qfg-mol-hle)', () => {
    const base = {access: 'standard', interactive: false, key: 'stripe.key', plaintext: PLAINTEXT}

    it('N10: refuses when quonfig.json secrets have problems (duplicate fingerprints, unknown member)', async () => {
      for (const manifest of [
        quonfigJson({QUONFIG_KEYSET: {publicKeys: [main.publicEntry, main.publicEntry]}}),
        quonfigJson({QUONFIG_KEYSET: {extra: true, publicKeys: [main.publicEntry]}}),
      ]) {
        const snap = await snapshotOf({'quonfig.json': manifest})
        const err = (await refusal(planSecretCreate({...base, snapshot: snap}))) as SecretRefusal
        expect(err).to.be.instanceOf(SecretRefusal)
        expect(err.code).to.equal('keysets_invalid')
        expect(err.message).to.match(
          /^quonfig.json secrets cannot be used, so no secret can be written:\n {2}quonfig.json: /,
        )
      }
    })

    it('an unparseable quonfig.json is reported as such, not as "no keysets", and its content is never shown', async () => {
      const snap = await snapshotOf({'quonfig.json': '{"workspace": "SENTINEL-CONTENT", oops'})
      const err = await refusal(planSecretCreate({...base, snapshot: snap}))
      expect(err.message).to.include('quonfig.json is not valid JSON')
      expect(err.message).to.not.include('SENTINEL-CONTENT')
      expect(err.message).to.not.include('no keysets')
    })

    it('N11: an old-format value only inside an environment rule is detected', async () => {
      const doc = JSON.parse(oldFormatConfig('env.only'))
      doc.environments = [{id: 'production', rules: [{criteria: always, value: doc.default.rules[0].value}]}]
      doc.default.rules[0].value = {type: 'string', value: 'plain'}
      const snap = await snapshotOf({'configs/env.only.json': JSON.stringify(doc), 'quonfig.json': ONE_KEYSET})
      const err = (await refusal(
        planSecretUpdate({
          interactive: false,
          key: 'env.only',
          plaintext: PLAINTEXT,
          replaceTargeting: false,
          snapshot: snap,
        }),
      )) as SecretRefusal
      expect(err.code).to.equal('old_format')
    })

    it('N11: an update never reports firstSecret', async () => {
      const snap = await snapshotOf({
        'quonfig.json': TWO_KEYSETS,
        'secrets/db.password.json': existingSecret('db.password'),
      })
      const plan = await planSecretUpdate({
        interactive: false,
        key: 'db.password',
        plaintext: PLAINTEXT,
        replaceTargeting: false,
        snapshot: snap,
      })
      expect(plan.firstSecret).to.equal(false)
    })
  })

  describe('update', () => {
    const files = () => ({
      'quonfig.json': TWO_KEYSETS,
      'secrets/db.password.json': existingSecret('db.password'),
    })

    it('sets the production fallback, keeps the targeting rule, inherits its keyset without prompting', async () => {
      const snap = await snapshotOf(files())
      const plan = await planSecretUpdate({
        envName: 'production',
        interactive: true,
        key: 'db.password',
        plaintext: PLAINTEXT,
        prompt: noPrompt,
        replaceTargeting: false,
        snapshot: snap,
      })
      expect(plan.choice).to.include({keyset: 'QUONFIG_KEYSET_PROD', source: 'inherited'})
      expect(plan.choice.movedFrom).to.equal(undefined)
      expect(plan.keptTargeting).to.equal(1)
      expect(plan.message.text).to.equal(
        `qfg: set secret db.password (production) on QUONFIG_KEYSET_PROD ${prod.fingerprint}`,
      )
      const afterJson = (plan.files[0] as {afterJson: string}).afterJson
      const doc = JSON.parse(afterJson)
      const rules = doc.environments[0].rules
      expect(rules).to.have.length(2)
      expect(decrypt(rules[1].value.value, {QUONFIG_KEYSET_PROD: prod.privateEntry})).to.equal(PLAINTEXT)
      expect(decrypt(rules[0].value.value, {QUONFIG_KEYSET_PROD: prod.privateEntry})).to.equal('old-value')
      expect(doc.access).to.equal('standard')
      expect(hookErrors(snap, plan.path, afterJson)).to.deep.equal([])
    })

    it('--keyset different from the inherited keyset moves the value, and says so', async () => {
      const snap = await snapshotOf(files())
      const plan = await planSecretUpdate({
        envName: 'production',
        flagKeyset: 'QUONFIG_KEYSET',
        interactive: false,
        key: 'db.password',
        plaintext: PLAINTEXT,
        replaceTargeting: false,
        snapshot: snap,
      })
      expect(plan.choice.movedFrom).to.equal('QUONFIG_KEYSET_PROD')
      expect(plan.movedNotice).to.equal(
        'Moving db.password (production) from QUONFIG_KEYSET_PROD to QUONFIG_KEYSET: runtimes that hold only QUONFIG_KEYSET_PROD will fail to read it.',
      )
    })

    it('--replace-targeting collapses the scope and counts what it removed', async () => {
      const snap = await snapshotOf(files())
      const plan = await planSecretUpdate({
        envName: 'production',
        interactive: false,
        key: 'db.password',
        plaintext: PLAINTEXT,
        replaceTargeting: true,
        snapshot: snap,
      })
      expect(plan.replacedTargeting).to.equal(1)
      expect(JSON.parse((plan.files[0] as {afterJson: string}).afterJson).environments[0].rules).to.have.length(1)
    })

    it('an environment quonfig.json does not list is refused', async () => {
      const snap = await snapshotOf(files())
      const err = await refusal(
        planSecretUpdate({
          envName: 'qa',
          interactive: false,
          key: 'db.password',
          plaintext: PLAINTEXT,
          replaceTargeting: false,
          snapshot: snap,
        }),
      )
      expect(err.message).to.equal('"qa" is not an environment of this workspace (production, staging)')
    })

    it('refuses an old-format config, a plain config, another family and a missing key, each with its own text', async () => {
      const snap = await snapshotOf({
        'configs/legacy.secret.json': oldFormatConfig('legacy.secret'),
        'configs/plain.config.json': configDoc('plain.config'),
        'feature-flags/a.flag.json': configDoc('a.flag').replace('"type": "config"', '"type": "feature_flag"'),
        'quonfig.json': ONE_KEYSET,
        'secrets/DB.password.json': existingSecret('DB.password'),
      })
      const base = {interactive: false, plaintext: PLAINTEXT, replaceTargeting: false, snapshot: snap}
      const cases: Array<[string, string, string]> = [
        [
          'legacy.secret',
          'old_format',
          'legacy.secret holds old-format encrypted values; move it with `qfg secret migrate` (coming) before changing it',
        ],
        [
          'plain.config',
          'is_config',
          'plain.config is a config; secrets live in secrets/. Create a new key with `qfg create <new-key> --secret`.',
        ],
        ['a.flag', 'other_family', 'a.flag is not a secret: it exists as a flag'],
        ['db.password', 'not_found', 'Could not find a secret named db.password; did you mean DB.password?'],
        ['no.such.key', 'not_found', 'Could not find a secret named no.such.key'],
      ]
      for (const [key, code, message] of cases) {
        const err = (await refusal(planSecretUpdate({...base, key}))) as SecretRefusal
        expect(err, key).to.be.instanceOf(SecretRefusal)
        expect(err.code, key).to.equal(code)
        expect(err.message, key).to.equal(message)
      }
    })

    it('names the configs/ copy of a key that exists in both directories (the transition twin)', async () => {
      const snap = await snapshotOf({
        'configs/db.password.json': oldFormatConfig('db.password'),
        ...files(),
      })
      const plan = await planSecretUpdate({
        interactive: false,
        key: 'db.password',
        plaintext: PLAINTEXT,
        replaceTargeting: false,
        snapshot: snap,
      })
      expect(plan.twin).to.equal('configs/db.password.json')
      expect(plan.choice).to.include({keyset: 'QUONFIG_KEYSET', source: 'inherited'})
    })

    it('a value on a keyset quonfig.json no longer declares needs --keyset', async () => {
      const snap = await snapshotOf({
        'quonfig.json': quonfigJson({QUONFIG_KEYSET_PROD: {publicKeys: [prod.publicEntry]}}),
        'secrets/db.password.json': existingSecret('db.password'),
      })
      const err = await refusal(
        planSecretUpdate({
          interactive: false,
          key: 'db.password',
          plaintext: PLAINTEXT,
          replaceTargeting: false,
          snapshot: snap,
        }),
      )
      expect(err.message).to.equal(
        'the current value is on QUONFIG_KEYSET, which quonfig.json no longer declares; pass --keyset',
      )
    })
  })
})
