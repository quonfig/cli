/**
 * `qfg create --secret` writes a qf1 secret to secrets/ through configs.push
 * (bead qfg-mol-hle PR 3, plan 3.1). Runs the built command (dist) against a
 * fake server whose workspace repo is a real file:// repo.
 */
import {expect, test} from '@oclif/test'

import {decrypt} from '../../src/secrets/qf1.js'
import {resetClientCache} from '../../src/util/get-client.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'
import {
  ONE_KEYSET,
  TWO_KEYSETS,
  allRequestText,
  keys,
  legacyWrites,
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

const PLAINTEXT = 'FAKE_CREATE_SECRET_plaintext_0042'
const DOCS = 'https://docs.quonfig.com/docs/explanations/features/secret-management'
const ARGV_WARNING =
  'Warning: --value puts the secret in argv and shell history; prefer --value-stdin or --value-from-env.'

const sentDoc = () => JSON.parse(pushes()[0].files[0].afterJson)

describe('create --secret writes qf1 to secrets/ (qfg-mol-hle PR 3)', function () {
  this.timeout(30_000)
  before(() => {
    setupTestAuth()
    server.listen({onUnhandledRequest: 'error'})
  })
  beforeEach(() => {
    resetState()
    workspace({'quonfig.json': ONE_KEYSET})
  })
  afterEach(() => {
    expect(allRequestText(), 'no request may carry the plaintext').to.not.include(PLAINTEXT)
    expect(allRequestText(), 'nothing writes decryptWith').to.not.include('decryptWith')
    expect(legacyWrites(), 'a secret never goes through configs/create').to.deep.equal([])
    server.resetHandlers()
    resetClientCache()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
    removeWorkspaces()
  })

  test
    .do(() => {
      state.access = 'protected-env'
      setStdin(`${PLAINTEXT}\n`)
    })
    .finally(restoreStdin)
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', '--value-stdin'])
    .it('writes secrets/<key>.json via configs.push, to the FIRST public key, at the default tier', (ctx) => {
      expect(pushes()).to.have.length(1)
      const push = pushes()[0]
      expect(push.files.map((f: {kind: string; path: string}) => [f.kind, f.path])).to.deep.equal([
        ['add', 'secrets/stripe.key.json'],
      ])
      expect(push.message).to.equal(`qfg: create secret stripe.key on QUONFIG_KEYSET ${keys.main.fingerprint}`)
      const doc = sentDoc()
      expect(doc).to.include({access: 'protected-env', key: 'stripe.key', type: 'secret', valueType: 'string'})
      const value = doc.default.rules[0].value
      expect(value).to.deep.equal({confidential: true, type: 'string', value: value.value})
      expect(value.value).to.match(new RegExp(`^qf1:QUONFIG_KEYSET:${keys.main.fingerprint}:`))
      expect(decrypt(value.value, {QUONFIG_KEYSET: keys.main.privateEntry})).to.equal(PLAINTEXT)
      expect(ctx.stdout + ctx.stderr).to.not.include(PLAINTEXT)
      expect(ctx.stdout).to.match(
        new RegExp(
          `Created secret: stripe\\.key on QUONFIG_KEYSET \\(key ${keys.main.fingerprint}\\) \\[encrypted \\*{5}[\\da-f]{5}, ${PLAINTEXT.length} chars, ends …0042\\]`,
        ),
      )
    })

  test
    .do(() => {
      workspace({'quonfig.json': TWO_KEYSETS})
      process.env.QFG_PR3_SRC = PLAINTEXT
    })
    .finally(() => delete process.env.QFG_PR3_SRC)
    .stdout()
    .stderr()
    .command([
      'create',
      'stripe.key',
      '--secret',
      '--keyset',
      'QUONFIG_KEYSET_PROD',
      '--value-from-env=QFG_PR3_SRC',
      '--json',
    ])
    .it('--keyset picks the keyset; --json reports keyset, key fingerprint and a redacted value', (ctx) => {
      const out = JSON.parse(ctx.stdout)
      expect(out).to.include({
        commitSha: 'c'.repeat(40),
        key: 'stripe.key',
        keysetSource: 'flag',
        path: 'secrets/stripe.key.json',
      })
      expect(out.value).to.include({
        encrypted: true,
        keyFingerprint: keys.prod.fingerprint,
        keyset: 'QUONFIG_KEYSET_PROD',
      })
      expect(out.value).to.not.have.property('value')
      expect(sentDoc().default.rules[0].value.value).to.match(/^qf1:QUONFIG_KEYSET_PROD:/)
      expect(ctx.stdout + ctx.stderr).to.not.include(PLAINTEXT)
    })

  test
    .do(() => workspace({'quonfig.json': TWO_KEYSETS}))
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`, '--no-interactive'])
    .catch((error) => {
      expect(error.message).to.equal(
        'Failed to create secret: Choose a keyset with --keyset: QUONFIG_KEYSET, QUONFIG_KEYSET_PROD',
      )
      expect(pushes()).to.deep.equal([])
    })
    .it('two keysets, non-interactive, no --keyset: an error naming them, never a guess')

  test
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .it('--value still works with a warning that argv is visible (Q3)', (ctx) => {
      expect(ctx.stderr).to.include(ARGV_WARNING)
      expect(pushes()).to.have.length(1)
    })

  test
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .it(
      'the first secret in a workspace prints the minimum-SDK notice once, with the docs link, after success',
      (ctx) => {
        expect(ctx.stderr).to.include(
          `This is the first secret in workspace workspace-123. Backend SDKs read secrets only from a minimum version; an older SDK returns the encrypted text as the value. Versions: ${DOCS}`,
        )
        expect(ctx.stderr.split(DOCS)).to.have.length(2)
        expect(ctx.stdout).to.include('Created secret:')
      },
    )

  test
    .do(() => workspace({'quonfig.json': TWO_KEYSETS, 'secrets/db.password.json': storedSecret('db.password')}))
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', '--keyset', 'QUONFIG_KEYSET', `--value=${PLAINTEXT}`, '--json'])
    .it('no notice when secrets/ already had a document', (ctx) => {
      expect(ctx.stderr).to.not.include(DOCS)
      expect(JSON.parse(ctx.stdout)).to.not.have.property('firstSecretInWorkspace')
    })

  test
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`, '--json'])
    .it('--json marks the first secret', (ctx) => {
      expect(JSON.parse(ctx.stdout).firstSecretInWorkspace).to.equal(true)
    })

  test
    .env({QUONFIG_KEYSET: undefined})
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .it('tells a machine without the keyset that it cannot read the value, and that this is fine', (ctx) => {
      expect(ctx.stderr).to.include(
        'This machine cannot read QUONFIG_KEYSET values (no QUONFIG_KEYSET here). That is expected: writing needs no private key.',
      )
    })

  for (const [files, message] of [
    [
      {'configs/Stripe.Key.json': '{}'},
      'stripe.key already exists (as a config named Stripe.Key; keys are case-insensitive)',
    ],
    [{'feature-flags/stripe.key.json': '{}'}, 'stripe.key already exists (as a flag)'],
    [{'secrets/stripe.key.json': storedSecret('stripe.key')}, 'stripe.key already exists (as a secret)'],
  ] as const) {
    test
      .do(() => workspace({'quonfig.json': ONE_KEYSET, ...files}))
      .stdout()
      .stderr()
      .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
      .catch((error) => {
        expect(error.message).to.equal(`Failed to create secret: ${message}`)
        expect(pushes()).to.deep.equal([])
      })
      .it(`refuses a key that already exists: ${message}`)
  }

  test
    .do(() => workspace({'quonfig.json': '{"workspace": "acme-test", "environments": ["Production"]}'}))
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .catch((error) => {
      expect(error.message).to.match(/^Failed to create secret: This workspace has no keysets/)
      expect(pushes()).to.deep.equal([])
    })
    .it('a workspace with no keysets is refused')

  test
    .do(() => {
      state.access = 503
    })
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .catch((error) => {
      expect(error.message).to.equal(
        "Failed to create secret: could not read the workspace's default access tier for new items (HTTP 503); nothing was written",
      )
      expect(state.requests.map((r) => new URL(r.url).pathname)).to.not.include.members([
        '/api/v1/gitea/token',
        '/api/v1/configs/push',
      ])
    })
    .it('fails the create when the default-tier lookup fails, before any snapshot or write')

  test
    .do(() => {
      state.push = {
        body: {
          json: {
            data: {
              denials: [
                {
                  path: 'secrets/stripe.key.json',
                  reason: 'access tier protected-env requires',
                  requiredPermission: 'configs.access.protected-env',
                },
              ],
            },
            message: 'forbidden',
          },
        },
        status: 403,
      }
      state.access = 'protected-env'
    })
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .catch((error) => {
      expect(error.message).to.equal(
        'Failed to create secret: you do not have permission to write this secret; nothing was written. the server refused the write:\n  secrets/stripe.key.json: access tier protected-env requires (needs configs.access.protected-env)',
      )
      expect(pushes(), 'never retried at a lower tier').to.have.length(1)
      expect(JSON.parse(pushes()[0].files[0].afterJson).access).to.equal('protected-env')
    })
    .it('a tier denial is reported as it is and not retried at another tier')

  test
    .do(() => {
      state.push = {
        body: {json: {message: 'Path not allowed by push allow-list: secrets/stripe.key.json'}},
        status: 400,
      }
    })
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
    .catch((error) => {
      expect(error.message).to.match(
        /^Failed to create secret: this Quonfig server does not support secrets\/ yet, so nothing was written\./,
      )
    })
    .it('a server without secrets/ support gets an actionable message')

  test
    .stdout()
    .stderr()
    .command([
      'create',
      'stripe.key',
      '--secret',
      '--secret-key-name=quonfig.secrets.encryption.key',
      `--value=${PLAINTEXT}`,
    ])
    .catch((error) => {
      expect(error.message).to.equal(
        'qf1 secrets are encrypted to a keyset from quonfig.json; --secret-key-name no longer applies. Use --keyset.',
      )
      expect(state.requests).to.deep.equal([])
    })
    .it('--secret-key-name with --secret is an error (Q4)')

  test
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`, '--propose'])
    .catch((error) => {
      expect(error.message).to.match(/^qfg create --propose cannot carry --secret/)
      expect(state.requests).to.deep.equal([])
    })
    .it('--propose with --secret is still refused')

  test
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--type=string', '--keyset', 'QUONFIG_KEYSET', `--value=${PLAINTEXT}`])
    .catch((error) => {
      expect(error.message).to.equal('--keyset applies only to secrets: add --secret')
    })
    .it('--keyset without --secret is an error')
})
