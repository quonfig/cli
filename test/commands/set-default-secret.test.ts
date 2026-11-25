/**
 * `qfg set-default` on a secret writes secrets/<key>.json through
 * configs.push (bead qfg-mol-hle PR 3, plan 3.1, 3.2, Q6, Q7, Q9). Runs the
 * built command (dist) against a fake server whose workspace repo is a real
 * file:// repo.
 */
import {expect, test} from '@oclif/test'

import {decrypt} from '../../src/secrets/qf1.js'
import {resetClientCache} from '../../src/util/get-client.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'
import {
  TWO_KEYSETS,
  allRequestText,
  keys,
  legacyWrites,
  oldFormatConfig,
  pushes,
  removeWorkspaces,
  resetState,
  restoreStdin,
  server,
  setStdin,
  state,
  storedSecret,
  workspace,
} from './secret-write-fixtures.js'

const PLAINTEXT = 'FAKE_SET_DEFAULT_secret_value_0077'
const MIGRATE =
  'db.password holds old-format encrypted values; move it with `qfg secret migrate` (coming) before changing it'

const sentDoc = () => JSON.parse(pushes()[0].files[0].afterJson)
const prodRules = () => sentDoc().environments.find((e: {id: string}) => e.id === 'production').rules

describe('set-default on a secret writes qf1 to secrets/ (qfg-mol-hle PR 3)', function () {
  this.timeout(30_000)
  before(() => {
    setupTestAuth()
    server.listen({onUnhandledRequest: 'error'})
  })
  beforeEach(() => {
    resetState()
    workspace({'quonfig.json': TWO_KEYSETS, 'secrets/db.password.json': storedSecret('db.password')})
    state.listed = [{key: 'db.password', type: 'secret', valueType: 'string'}]
  })
  afterEach(() => {
    expect(allRequestText(), 'no request may carry the plaintext').to.not.include(PLAINTEXT)
    expect(allRequestText(), 'nothing writes decryptWith').to.not.include('"decryptWith":"quonfig')
    expect(legacyWrites(), 'a secret never goes through the per-family update routes').to.deep.equal([])
    server.resetHandlers()
    resetClientCache()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
    removeWorkspaces()
  })

  test
    .do(() => setStdin(`${PLAINTEXT}\n`))
    .finally(restoreStdin)
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', '--value-stdin', '--confirm'])
    .it(
      'a secret the server lists is detected without --secret; the fallback is set, targeting kept, keyset inherited',
      (ctx) => {
        expect(pushes()).to.have.length(1)
        expect(pushes()[0].files.map((f: {kind: string; path: string}) => [f.kind, f.path])).to.deep.equal([
          ['modify', 'secrets/db.password.json'],
        ])
        expect(pushes()[0].message).to.equal(
          `qfg: set secret db.password (production) on QUONFIG_KEYSET_PROD ${keys.prod.fingerprint}`,
        )
        const rules = prodRules()
        expect(rules).to.have.length(2)
        expect(decrypt(rules[1].value.value, {QUONFIG_KEYSET_PROD: keys.prod.privateEntry})).to.equal(PLAINTEXT)
        expect(rules[1].value).to.deep.equal({confidential: true, type: 'string', value: rules[1].value.value})
        expect(ctx.stdout).to.match(
          new RegExp(
            `Set production fallback to \\[encrypted \\*{5}[\\da-f]{5}, ${PLAINTEXT.length} chars, ends …0077\\] on QUONFIG_KEYSET_PROD \\(key ${keys.prod.fingerprint}\\)\\. Kept 1 targeting rule\\(s\\)`,
          ),
        )
        expect(ctx.stdout + ctx.stderr).to.not.include(PLAINTEXT)
        expect(ctx.stderr).to.not.include('Moving')
      },
    )

  test
    .do(() => {
      state.listed = []
    })
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
    .it('a secret the server does not list (no rule 1 yet) is found in the snapshot', () => {
      expect(pushes()).to.have.length(1)
    })

  test
    .do(() => {
      state.listed = []
    })
    .stdout()
    .stderr()
    .command(['set-default', 'no.such.key', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
    .catch((error) => {
      expect(error.message).to.equal('Could not find config named no.such.key')
      expect(pushes()).to.deep.equal([])
    })
    .it('a key neither listed nor in secrets/ is still "not found"')

  test
    .stdout()
    .stderr()
    .command([
      'set-default',
      'db.password',
      '--environment=production',
      '--keyset',
      'QUONFIG_KEYSET',
      `--value=${PLAINTEXT}`,
      '--confirm',
      '--json',
    ])
    .it('--keyset different from the inherited keyset prints the move notice and reports movedFrom', (ctx) => {
      expect(ctx.stderr).to.include(
        'Moving db.password (production) from QUONFIG_KEYSET_PROD to QUONFIG_KEYSET: runtimes that hold only QUONFIG_KEYSET_PROD will fail to read it.',
      )
      const out = JSON.parse(ctx.stdout)
      expect(out).to.include({keysetSource: 'flag', movedFrom: 'QUONFIG_KEYSET_PROD', path: 'secrets/db.password.json'})
      expect(out.value).to.include({keyFingerprint: keys.main.fingerprint, keyset: 'QUONFIG_KEYSET'})
      expect(out.value).to.not.have.property('value')
      expect(prodRules()[1].value.value).to.match(new RegExp(`^qf1:QUONFIG_KEYSET:${keys.main.fingerprint}:`))
    })

  test
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--no-interactive'])
    .catch((error) => {
      expect(error.message).to.match(/Cannot prompt for confirmation in a non-interactive context/)
      expect(pushes()).to.deep.equal([])
    })
    .it('without --confirm, a non-interactive write errors instead of prompting or writing')

  test
    .stdout()
    .stderr()
    .command([
      'set-default',
      'db.password',
      '--environment=production',
      '--keyset',
      'QUONFIG_KEYSET',
      `--value=${PLAINTEXT}`,
      '--no-interactive',
    ])
    .catch((error) => {
      expect(error.message).to.match(/Cannot prompt for confirmation/)
      expect(pushes(), 'a keyset move is never silent').to.deep.equal([])
    })
    .it('a keyset move needs the same confirmation')

  test
    .stdout()
    .stderr()
    .command([
      'set-default',
      'db.password',
      '--environment=production',
      '--replace-targeting',
      `--value=${PLAINTEXT}`,
      '--no-interactive',
    ])
    .catch((error) => {
      expect(error.message).to.match(/Cannot prompt for confirmation/)
      expect(pushes()).to.deep.equal([])
    })
    .it('--replace-targeting without --confirm is refused non-interactively')

  test
    .stdout()
    .stderr()
    .command([
      'set-default',
      'db.password',
      '--environment=production',
      '--replace-targeting',
      `--value=${PLAINTEXT}`,
      '--confirm',
      '--json',
    ])
    .it('--replace-targeting --confirm collapses the scope and counts the rule it removed', (ctx) => {
      expect(prodRules()).to.have.length(1)
      expect(JSON.parse(ctx.stdout)).to.include({replacedTargetingRuleCount: 1})
    })

  test
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=[Default]', `--value=${PLAINTEXT}`, '--confirm'])
    .it('[Default] writes the default rules on their own keyset', () => {
      const rules = sentDoc().default.rules
      expect(rules).to.have.length(1)
      expect(decrypt(rules[0].value.value, {QUONFIG_KEYSET: keys.main.privateEntry})).to.equal(PLAINTEXT)
      expect(pushes()[0].message).to.equal(
        `qfg: set secret db.password (default) on QUONFIG_KEYSET ${keys.main.fingerprint}`,
      )
    })

  for (const [argv, message] of [
    [['--env-var=SOME_VAR'], 'secrets hold an encrypted value; --env-var does not apply to a secret'],
    [
      ['--no-confidential', `--value=${PLAINTEXT}`],
      'secrets are always confidential; --no-confidential does not apply',
    ],
    [
      ['--propose', `--value=${PLAINTEXT}`],
      'Change requests cannot carry secrets yet; write it directly with qfg set-default --secret (without --propose / --cr).',
    ],
    [
      ['--secret-key-name=quonfig.secrets.encryption.key', `--value=${PLAINTEXT}`],
      'qf1 secrets are encrypted to a keyset from quonfig.json; --secret-key-name no longer applies. Use --keyset.',
    ],
  ] as const) {
    test
      .stdout()
      .stderr()
      .command(['set-default', 'db.password', '--environment=production', '--confirm', ...argv])
      .catch((error) => {
        expect(error.message).to.equal(message)
        expect(pushes()).to.deep.equal([])
      })
      .it(`refuses ${argv[0]} on a secret`)
  }

  test
    .do(() => {
      workspace({'configs/plain.config.json': '{}', 'quonfig.json': TWO_KEYSETS})
      state.listed = [{key: 'plain.config', type: 'config', valueType: 'string'}]
    })
    .stdout()
    .stderr()
    .command([
      'set-default',
      'plain.config',
      '--environment=production',
      '--secret',
      `--value=${PLAINTEXT}`,
      '--confirm',
    ])
    .catch((error) => {
      expect(error.message).to.equal(
        'Failed to change default: plain.config is a config; secrets live in secrets/. Create a new key with `qfg create <new-key> --secret`.',
      )
      expect(pushes()).to.deep.equal([])
    })
    .it('--secret on a plain config is refused with the create hint')

  test
    .do(() => {
      workspace({
        'configs/db.password.json': JSON.stringify(oldFormatConfig('db.password')),
        'quonfig.json': TWO_KEYSETS,
      })
      state.listed = [{key: 'db.password', type: 'config', valueType: 'string'}]
      state.documents = {'db.password': oldFormatConfig('db.password')}
    })
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
    .catch((error) => {
      expect(error.message).to.equal(MIGRATE)
      expect(pushes()).to.deep.equal([])
    })
    .it('an old-format (decryptWith) config is refused with the migrate pointer (Q6)')

  test
    .do(() => {
      workspace({
        'configs/db.password.json': JSON.stringify(oldFormatConfig('db.password')),
        'quonfig.json': TWO_KEYSETS,
      })
      state.listed = [{key: 'db.password', type: 'config', valueType: 'string'}]
    })
    .stdout()
    .stderr()
    .command([
      'set-default',
      'db.password',
      '--environment=production',
      '--secret',
      `--value=${PLAINTEXT}`,
      '--confirm',
    ])
    .catch((error) => {
      expect(error.message).to.equal(`Failed to change default: ${MIGRATE}`)
      expect(pushes()).to.deep.equal([])
    })
    .it('--secret on an old-format config is refused the same way')

  test
    .do(() => {
      workspace({
        'configs/db.password.json': JSON.stringify(oldFormatConfig('db.password')),
        'quonfig.json': TWO_KEYSETS,
        'secrets/db.password.json': storedSecret('db.password'),
      })
      state.listed = [{key: 'db.password', type: 'config', valueType: 'string'}]
      state.documents = {'db.password': oldFormatConfig('db.password')}
    })
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
    .it('a key in both configs/ and secrets/ updates secrets/ and warns about the configs/ copy (Q9)', (ctx) => {
      expect(pushes()[0].files.map((f: {path: string}) => f.path)).to.deep.equal(['secrets/db.password.json'])
      expect(ctx.stderr).to.include(
        'Note: configs/db.password.json (old format, read by SDKs older than the minimum version) was not changed.',
      )
    })

  test
    .do(() => {
      state.push = {body: {json: {message: 'expected sha mismatch', status: 409}}, status: 409}
    })
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
    .catch((error) => {
      expect(error.message).to.equal(
        'Failed to change default: the workspace changed while writing; nothing was written; run the command again',
      )
    })
    .it('a 409 conflict says nothing was written and to run again')
})
